import { extractSignals, hasExcessivePunctuation, isShouting } from "./signals";
import type {
  AnalysisInput,
  AnalysisSignal,
  EvidenceItem,
  EvidenceSeverity,
  RuleResult,
} from "./types";

/**
 * Layer 3 of the fraud-detection engine: a versioned, explainable rule set.
 *
 * Each rule produces points and a human-readable description. The scoring
 * model mirrors the product blueprint:
 *
 *   credential_or_otp_request       +45
 *   payment_or_bank_request         +20
 *   urgent_threat_language          +15
 *   brand_host_mismatch             +20
 *   shortened_or_redirect_url       +10
 *   punycode_or_lookalike_domain    +20
 *   known_bad_reputation             +40   (provider-backed)
 *   new_or_low-reputation_domain    +15   (provider-backed)
 *   safe_known_domain               -20   (provider-backed)
 *   verified_internal_sender        -10   (provider-backed)
 *
 * Provider-backed rules only fire when the caller supplies provider results.
 */

export const RULE_SET_VERSION = "1.0.0";

interface Rule {
  id: string;
  points: number;
  severity: EvidenceSeverity;
  evaluate: (input: AnalysisInput, signals: AnalysisSignal[]) => number;
  describe: (input: AnalysisInput) => string;
}

const SHORTENER_HOSTS = new Set([
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "is.gd",
  "cutt.ly",
  "rb.gy",
  "shorturl.at",
  "tiny.cc",
  "ow.ly",
  "buff.ly",
  "rebrand.ly",
  "s.id",
  "gg.gg",
]);

const KNOWN_BRAND_DOMAINS: Record<string, string[]> = {
  hdfc: ["hdfcbank.com"],
  sbi: ["sbi.co.in", "onlinesbi.sbi", "sbi.in"],
  icici: ["icicibank.com"],
  axis: ["axisbank.com"],
  paypal: ["paypal.com"],
  amazon: ["amazon.in", "amazon.com"],
  netflix: ["netflix.com"],
  whatsapp: ["whatsapp.com"],
  instagram: ["instagram.com"],
  google: ["google.com", "gmail.com"],
  microsoft: ["microsoft.com"],
  apple: ["apple.com"],
  telegram: ["telegram.org"],
  irctc: ["irctc.co.in"],
};

/** Domains for which the URL model must not override a clean result. */
export function isKnownSafeHost(host: string | null | undefined): boolean {
  const normalized = host?.toLowerCase().replace(/^www\./, "") ?? "";
  return Object.values(KNOWN_BRAND_DOMAINS)
    .flat()
    .some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

function hasSignal(signals: AnalysisSignal[], type: string): boolean {
  return signals.some((s) => s.type === type);
}

function findHostMismatch(input: AnalysisInput): boolean {
  if (input.urls.length === 0) {
    return false;
  }
  const text = input.text.toLowerCase();
  const brand = Object.keys(KNOWN_BRAND_DOMAINS).find((name) =>
    text.includes(name)
  );
  if (!brand) {
    return false;
  }
  const allowed = KNOWN_BRAND_DOMAINS[brand];
  return input.urls.some((u) => {
    const host = u.host?.toLowerCase() ?? "";
    return !allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
  });
}

function hasPunycodeOrLookalike(input: AnalysisInput): boolean {
  return input.urls.some((u) => {
    const host = u.host?.toLowerCase() ?? "";
    if (host.includes("xn--")) {
      return true;
    }
    // Lookalike characters outside the ASCII letter range in the host.
    for (const ch of host) {
      const code = ch.charCodeAt(0);
      if (code > 127 && /[a-z]/.test(ch)) {
        return true;
      }
    }
    // IP-address hosts are a classic phishing signal.
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  });
}

function hasShortenedUrl(input: AnalysisInput): boolean {
  return input.urls.some((u) => {
    const host = u.host?.toLowerCase() ?? "";
    return SHORTENER_HOSTS.has(host);
  });
}

function providerVerdict(
  input: AnalysisInput,
  verdict: "malicious" | "suspicious"
): boolean {
  return (input.providerChecks ?? []).some((c) => c.verdict === verdict);
}

function providerClean(input: AnalysisInput): boolean {
  const checks = input.providerChecks ?? [];
  return checks.length > 0 && checks.every((c) => c.verdict === "clean");
}

export const RULES: Rule[] = [
  {
    id: "credential_or_otp_request",
    points: 45,
    severity: "high",
    evaluate: (_, s) => (hasSignal(s, "credential_or_otp_request") ? 45 : 0),
    describe: () => "The message requests credentials, OTPs, PINs, or card details.",
  },
  {
    id: "payment_or_bank_request",
    points: 20,
    severity: "high",
    evaluate: (_, s) => (hasSignal(s, "payment_or_bank_request") ? 20 : 0),
    describe: () => "The message involves payments, transfers, refunds, or bank details.",
  },
  {
    id: "urgent_threat_language",
    points: 15,
    severity: "medium",
    evaluate: (_, s) => (hasSignal(s, "urgent_threat_language") ? 15 : 0),
    describe: () => "The message uses urgency or threats (suspension, legal action).",
  },
  {
    id: "impersonation_claim",
    points: 10,
    severity: "medium",
    evaluate: (_, s) => (hasSignal(s, "impersonation_claim") ? 10 : 0),
    describe: () => "The message claims to be from a bank, company, or support team.",
  },
  {
    id: "prize_or_reward",
    points: 15,
    severity: "medium",
    evaluate: (_, s) => (hasSignal(s, "prize_or_reward") ? 15 : 0),
    describe: () => "The message promises a prize, lottery, or free reward.",
  },
  {
    id: "channel_switch_request",
    points: 15,
    severity: "medium",
    evaluate: (_, s) => (hasSignal(s, "channel_switch_request") ? 15 : 0),
    describe: () => "The message asks to move to a private channel or install an app.",
  },
  {
    id: "suspicious_attachment",
    points: 10,
    severity: "medium",
    evaluate: (_, s) => (hasSignal(s, "suspicious_attachment") ? 10 : 0),
    describe: () => "The message references an executable or sideloadable file.",
  },
  {
    id: "secrecy_pressure",
    points: 10,
    severity: "medium",
    evaluate: (_, s) => (hasSignal(s, "secrecy_pressure") ? 10 : 0),
    describe: () => "The message pressures the recipient to keep it secret.",
  },
  {
    id: "excessive_punctuation",
    points: 5,
    severity: "low",
    evaluate: (i) =>
      hasExcessivePunctuation(i.text) || isShouting(i.text) ? 5 : 0,
    describe: () => "The message uses excessive punctuation or all-caps emphasis.",
  },
  {
    id: "shortened_or_redirect_url",
    points: 10,
    severity: "medium",
    evaluate: (i) => (hasShortenedUrl(i) ? 10 : 0),
    describe: () => "The message contains a URL shortener or redirect link.",
  },
  {
    id: "punycode_or_lookalike_domain",
    points: 20,
    severity: "high",
    evaluate: (i) => (hasPunycodeOrLookalike(i) ? 20 : 0),
    describe: () => "The message contains a punycode, lookalike, or IP-address domain.",
  },
  {
    id: "brand_host_mismatch",
    points: 20,
    severity: "high",
    evaluate: (i) => (findHostMismatch(i) ? 20 : 0),
    describe: () => "A brand is named in the message but the link host does not match its real domain.",
  },
  {
    id: "known_bad_reputation",
    points: 40,
    severity: "critical",
    evaluate: (i) => (providerVerdict(i, "malicious") ? 40 : 0),
    describe: () => "A reputation provider flagged a URL as malicious.",
  },
  {
    id: "suspicious_provider_verdict",
    points: 15,
    severity: "medium",
    evaluate: (i) => (providerVerdict(i, "suspicious") ? 15 : 0),
    describe: () => "A reputation provider flagged a URL as suspicious.",
  },
  {
    id: "new_or_low_reputation_domain",
    points: 15,
    severity: "medium",
    evaluate: () => 0,
    describe: () => "A URL points to a new or low-reputation domain.",
  },
  {
    id: "safe_known_domain",
    points: -20,
    severity: "info",
    evaluate: (i) => (providerClean(i) ? -20 : 0),
    describe: () => "All checked URLs are known-clean per reputation providers.",
  },
  {
    id: "verified_internal_sender",
    points: -10,
    severity: "info",
    evaluate: () => 0,
    describe: () => "The sender is a verified internal contact.",
  },
];

const SEVERITY_SCORE: Record<EvidenceSeverity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export function scoreToRiskLevel(score: number): "UNKNOWN" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  const clamped = Math.max(0, Math.min(100, score));
  if (clamped <= 19) return "LOW";
  if (clamped <= 44) return "MEDIUM";
  if (clamped <= 69) return "HIGH";
  return "CRITICAL";
}

export function runRules(input: AnalysisInput): {
  score: number;
  riskLevel: "UNKNOWN" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  ruleResults: RuleResult[];
  evidence: EvidenceItem[];
} {
  const signals = extractSignals(input.text);
  const ruleResults: RuleResult[] = [];
  const evidence: EvidenceItem[] = [];

  for (const rule of RULES) {
    const points = rule.evaluate(input, signals);
    if (points !== 0) {
      ruleResults.push({
        ruleId: rule.id,
        points,
        matched: true,
        description: rule.describe(input),
      });
      evidence.push({
        type: rule.id,
        severity: rule.severity,
        description: rule.describe(input),
      });
    }
  }

  const score = ruleResults.reduce((sum, r) => sum + r.points, 0);
  const clamped = Math.max(0, Math.min(100, score));

  // Keep evidence ordered by severity, most severe first.
  evidence.sort(
    (a, b) => SEVERITY_SCORE[b.severity] - SEVERITY_SCORE[a.severity]
  );

  return {
    score: clamped,
    riskLevel: scoreToRiskLevel(clamped),
    ruleResults,
    evidence,
  };
}
