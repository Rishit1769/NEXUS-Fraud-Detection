from __future__ import annotations

import hashlib
from pathlib import Path

import pandas as pd

from .features import message_feature_frame, url_feature_frame, url_lexical_frame
from .llm_features import cached_llm_frame

# Direction augmentation templates. Training corpora contain ~0 examples of
# "share your OTP" (attacker asking) vs "your OTP is NNNNNN" (your own
# notification), so the direction features can never be learned. These
# varied templates teach the distinction; probe texts are never copied.
_SHARE_REQUEST_TEMPLATES = [
    "Bank officer here, share your {secret} immediately to stop the transaction",
    "Your account will be blocked today, send me your {secret} for verification",
    "KYC update required, tell me your {secret} now or services stop",
    "This is customer support, provide your {secret} to unblock the account",
    "Security alert, we need your {secret} to confirm your identity",
    "Your card is locked, reply with your {secret} to reactivate it",
]
_CODE_RECEIPT_TEMPLATES = [
    "Your OTP for {service} login is {code}. Do not share it with anyone.",
    "Your verification code is {code}. It expires in 10 minutes.",
    "{service} code: {code}. Never share this code with anyone calling you.",
    "Your login code for {service} is {code}. Do not forward this SMS.",
]
_NO_SHARE_ADVICE_TEMPLATES = [
    "Banks will never ask for your OTP or password. Beware of fraud calls.",
    "Never share your OTP, PIN or CVV with anyone. Stay alert, report fraud.",
    "Reminder: we will never call you asking for your card details.",
]


def _augment_message_direction(seed: int = 42) -> tuple[list[str], list[str]]:
    """Synthetic (text, label) rows teaching request-vs-receipt direction."""
    import random

    rng = random.Random(seed)
    secrets = ["OTP", "password", "PIN", "CVV", "card number", "account details"]
    services = ["Swiggy", "HDFC", "Gmail", "WhatsApp", "IRCTC", "Amazon"]
    texts: list[str] = []
    labels: list[str] = []
    for _ in range(300):
        texts.append(rng.choice(_SHARE_REQUEST_TEMPLATES).format(secret=rng.choice(secrets)))
        labels.append("smishing")
    for _ in range(200):
        texts.append(
            rng.choice(_CODE_RECEIPT_TEMPLATES).format(
                service=rng.choice(services), code=f"{rng.randint(100000, 999999)}"
            )
        )
        labels.append("ham")
    for _ in range(100):
        texts.append(rng.choice(_NO_SHARE_ADVICE_TEMPLATES))
        labels.append("ham")
    return texts, labels


# Scam-shape augmentation. Probe misses showed whole fraud shapes with no
# near-neighbor in the corpora (stranded-relative, utility-threat, job-fee,
# parcel-fee, manager-verify) plus benign transactional shapes the model
# false-alarms on (order-shipped, bill-split, appointment). Varied templates
# (never probe copies) teach both sides.
_SCAM_SHAPE_PHISH = [
    "Hi {rel} this is my new number, lost my phone. Transfer Rs.{amt} urgently, keep it secret",
    "Your {util} bill is overdue, {service} cut tonight. Call now and share card details",
    "{brand} job offer: earn Rs.{amt}/day from home, pay Rs.{fee} joining fee first",
    "Your parcel is held, pay Rs.{fee} {channel} fee now and share the screenshot",
    "{role} here, share the code you just received to block the fraud transfer",
    "Your {brand} order could not be delivered, pay Rs.{fee} redelivery fee at {link}",
    "Your account shows unusual login, verify with your {secret} at {link} now",
]
_SCAM_SHAPE_BENIGN = [
    "Your {brand} order {oid} has shipped and arrives {day}. Track it in the app.",
    "The {meal} bill was Rs.{amt}, your share is Rs.{share}. {upi} me when free.",
    "Reminder: {appt} appointment {day} at {time}. Reply YES to confirm or call to reschedule.",
    "Your {util} bill of Rs.{amt} is due on {day}. Pay anytime on the app, no rush.",
]


def _augment_scam_shapes(seed: int = 7) -> tuple[list[str], list[str]]:
    import random

    rng = random.Random(seed)
    texts: list[str] = []
    labels: list[str] = []
    rels = ["mom", "dad", "bro", "uncle", "beta"]
    utils = ["electricity", "gas", "water", "phone"]
    brands = ["Flipkart", "Amazon", "Paytm", "SBI", "HDFC", "Jio"]
    roles = ["Bank manager", "Support agent", "KYC officer", "Delivery agent"]
    for _ in range(420):
        texts.append(
            rng.choice(_SCAM_SHAPE_PHISH).format(
                rel=rng.choice(rels),
                amt=rng.choice(["5000", "10000", "15000", "20000", "25000"]),
                util=rng.choice(utils),
                service=rng.choice(["connection", "supply", "line"]),
                fee=rng.choice(["99", "149", "250", "499", "500"]),
                channel=rng.choice(["UPI", "card", "netbanking"]),
                role=rng.choice(roles),
                brand=rng.choice(brands),
                secret=rng.choice(["OTP", "PIN", "password"]),
                link=rng.choice(["http://bit.ly/x1", "https://verify-now.tk"]),
            )
        )
        labels.append("smishing")
    for _ in range(280):
        texts.append(
            rng.choice(_SCAM_SHAPE_BENIGN).format(
                brand=rng.choice(brands),
                oid=f"#402-{rng.randint(1000000, 9999999)}",
                day=rng.choice(["Thursday", "Monday", "tomorrow"]),
                meal=rng.choice(["dinner", "lunch"]),
                amt=rng.choice(["1200", "2400", "800"]),
                share=rng.choice(["400", "800", "600"]),
                upi=rng.choice(["UPI", "GPay"]),
                appt=rng.choice(["dentist", "doctor", "salon"]),
                time=rng.choice(["10am", "4pm"]),
                util=rng.choice(utils),
            )
        )
        labels.append("ham")
    return texts, labels

# Generic real-world benign path shapes. PhiUSIIL benign rows are bare
# domains (0% have paths), so without augmentation any URL with a path
# scores phish. Grafting these onto sampled benign domains teaches
# "path != phish". Templates carry no fraud signal by themselves.
BENIGN_PATH_TEMPLATES = [
    "/search?q={q}",
    "/questions/{n}",
    "/wiki/{w}",
    "/gp/your-account/order-history",
    "/mail/u/0/#inbox",
    "/watch?v={v}",
    "/products/{p}",
    "/blog/{y}/{m}/{slug}",
    "/docs/guides/{g}",
    "/s/{q}",
    "/u/{user}/releases",
    "/p/{photo}",
    "/article/{slug}",
    "/category/{c}/page/{n}",
    # Longer multi-segment shapes (repo pages, Q&A with slugs, deep docs):
    # without these, any long legitimate path still scores phish.
    "/{user}/{repo}/tree/main/{slug}",
    "/questions/{n}/{slug}-explained-in-detail",
    "/docs/{g}/{slug}/advanced-configuration",
    "/gp/your-account/order-history/ref=ppx_hzod_title_dt_b_fed_asin_title",
    "/trends/explore?q={q}&geo=IN",
]


def _augment_benign_with_paths(frame: pd.DataFrame, seed: int = 42) -> pd.DataFrame:
    """Append benign-with-path rows sampled from benign bare domains."""
    import random

    rng = random.Random(seed)
    benign = frame[pd.to_numeric(frame["label"], errors="coerce") == 1]
    if benign.empty:
        return frame
    domains = (
        benign.get("Domain", benign["URL"]).fillna("").astype(str)
    )
    domains = domains[domains.str.contains(r"\.", na=False)].drop_duplicates()
    n_add = min(30_000, len(domains) * 2)
    if n_add == 0:
        return frame
    sampled = domains.sample(n=n_add, replace=True, random_state=seed)
    words = ["guide", "help", "news", "update", "review", "video", "photo", "docs"]
    rows = []
    for i, domain in enumerate(sampled):
        domain = str(domain).strip().lower()
        if not domain or " " in domain:
            continue
        # Half the rows: strip www. — PhiUSIIL benign rows almost always
        # carry www./subdomains while phish are bare hosts, so without this
        # any bare-domain URL (github.com/...) scores phish.
        if i % 2 == 0 and domain.startswith("www."):
            domain = domain[4:]
        t = rng.choice(BENIGN_PATH_TEMPLATES)
        path = t.format(
            q=rng.choice(["hello", "weather", "news", "help"]),
            n=rng.randint(1000, 999999),
            w=rng.choice(["Phishing", "India", "Cricket"]),
            v="dQw4w9WgXcQ",
            p=rng.choice(words),
            y=rng.randint(2015, 2026),
            m=rng.randint(1, 12),
            slug=rng.choice(words),
            g=rng.choice(words),
            user=rng.choice(["alice", "bob"]),
            repo=rng.choice(["opencode", "docs", "app"]),
            photo="abc123",
            c=rng.choice(words),
        )
        rows.append({"URL": f"https://{domain}{path}", "Domain": domain, "label": 1})
    if not rows:
        return frame
    return pd.concat([frame, pd.DataFrame(rows)], ignore_index=True)


def load_url_data(path: Path, llm_features_path: Path | None = None) -> tuple[pd.DataFrame, pd.Series, pd.Series]:
    """Served URL head: lexical-only features from the raw URL string.

    (The page-level PhiUSIIL numerics via url_feature_frame remain available
    for enrichment experiments, but they can never be supplied at inference
    for an arbitrary pasted link, so the served head trains on lexical only.)
    """
    frame = pd.read_csv(path, encoding_errors="replace")
    if "label" not in frame.columns or "URL" not in frame.columns:
        raise ValueError("URL dataset must contain URL and label columns")
    # PhiUSIIL representative rows establish 0=phishing and 1=benign.
    frame = _augment_benign_with_paths(frame)
    target = (pd.to_numeric(frame["label"], errors="coerce") == 0).astype(int)
    features = url_lexical_frame(frame["URL"])
    if llm_features_path:
        features = pd.concat([features, cached_llm_frame(frame["URL"], llm_features_path)], axis=1)
    groups = frame.get("Domain", frame["URL"]).fillna("").astype(str).str.lower()
    return features, target, groups


def load_message_texts(
    dataset_path: Path, sms_path: Path | None = None
) -> tuple[list[str], pd.Series, pd.Series]:
    """Raw (texts, labels, groups) for message training, incl. augmentation."""
    frame = pd.read_csv(dataset_path, encoding_errors="replace")
    if not {"LABEL", "TEXT"}.issubset(frame.columns):
        raise ValueError("Message dataset must contain LABEL and TEXT columns")
    texts = frame["TEXT"].fillna("").astype(str).tolist()
    labels = frame["LABEL"].fillna("").astype(str).str.lower().isin({"spam", "smishing", "url"}).astype(int)
    aug_texts, aug_labels = _augment_message_direction()
    shape_texts, shape_labels = _augment_scam_shapes()
    aug_texts = aug_texts + shape_texts
    aug_labels = aug_labels + shape_labels
    texts = texts + aug_texts
    labels = pd.concat(
        [labels, pd.Series([1 if lab != "ham" else 0 for lab in aug_labels])],
        ignore_index=True,
    )
    groups = pd.Series([hashlib.sha256(text.lower().strip().encode()).hexdigest() for text in texts])

    if sms_path and sms_path.exists():
        rows: list[tuple[str, str]] = []
        for line in sms_path.read_text(encoding="utf-8", errors="replace").splitlines():
            label, separator, text = line.partition("\t")
            if separator:
                rows.append((label.lower(), text))
        if rows:
            extra_texts = [text for _, text in rows]
            texts = texts + extra_texts
            labels = pd.concat([labels, pd.Series([int(label == "spam") for label, _ in rows])], ignore_index=True)
            groups = pd.concat(
                [groups, pd.Series([hashlib.sha256(text.lower().strip().encode()).hexdigest() for text in extra_texts])],
                ignore_index=True,
            )

    return texts, labels.reset_index(drop=True), groups.reset_index(drop=True)


def load_message_data(
    dataset_path: Path,
    sms_path: Path | None = None,
    llm_features_path: Path | None = None,
) -> tuple[pd.DataFrame, pd.Series, pd.Series]:
    texts, labels, groups = load_message_texts(dataset_path, sms_path)
    frames = [pd.DataFrame(message_feature_frame(pd.Series(texts)))]
    if llm_features_path:
        frames.append(cached_llm_frame(pd.Series(texts), llm_features_path))
    return pd.concat(frames, ignore_index=True), labels, groups
