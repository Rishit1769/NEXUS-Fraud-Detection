import type { AnalysisSignal } from "./types";

/**
 * Layer 1 of the fraud-detection engine: deterministic message signals.
 * These are pure text heuristics — no network calls, no AI.
 * Every signal carries a human-readable description so results are explainable.
 */

const CREDENTIAL_PATTERNS: RegExp[] = [
  // A credential word by itself is not a request: "Your OTP is 123456. Do
  // not share it" is a normal security notification. Require an action
  // verb near the credential instead.
  /\b(share|send|provide|tell|give|forward|reply with|enter|type|confirm|verify)\b.{0,60}\b(otp|one[- ]?time[- ]?password|verification code|secure code|auth code|password|passcode|pass word|pin|cvv|cvc|card number|debit card|credit card|account details|bank details|internet banking|netbanking|kyc|aadhaar|pan card|passport number|identity proof)\b/i,
  /\b(otp|one[- ]?time[- ]?password|verification code|secure code|auth code|password|passcode|pin|cvv|cvc|card number|account details|bank details)\b.{0,40}\b(share|send|provide|tell|give|forward)\b/i,
  /\b(need|require|request)\b.{0,40}\b(your )?(otp|verification code|password|passcode|pin|cvv|card number|account details|bank details)\b/i,
];

const PAYMENT_PATTERNS: RegExp[] = [
  /\b(money transfer|wire transfer|transfer (the )?money|send money)\b/i,
  /\b(refund|reimbursement|processing fee|activation fee|delivery fee)\b/i,
  /\b(payment failed|payment pending|pay now|make payment)\b/i,
  /\b(bank account|upi|gpay|phonepe|paytm|netbanking)\b/i,
  /\b(tax refund|lottery winnings|prize money|cash prize|gift card)\b/i,
];

const URGENCY_PATTERNS: RegExp[] = [
  /\b(immediately|right now|within (an? )?\d+ (hour|minute|day)|asap)\b/i,
  /\b(action required|urgent action|final warning|last warning)\b/i,
  /\b(account (will be|is (about to be|going to be)) (blocked|suspended|deactivated|closed|disabled|terminated))\b/i,
  /\b(legal action|police case|court case|arrest|penalty|fine)\b/i,
  /\b(don'?t ignore|act now|respond now)\b/i,
];

const IMPERSONATION_PATTERNS: RegExp[] = [
  /\b(HDFC|SBI|ICICI|Axis|Kotak|Yes Bank|PNB|Canara|RBI|PayPal|Amazon|Flipkart|Netflix|WhatsApp|Instagram|Meta|Google|Microsoft|Apple|Telegram|IRCTC|India Post|FedEx|DHL|BlueDart)\b/i,
  /\b(support team|customer care|customer support|security team|fraud department|helpdesk|service desk)\b/i,
  /\b(official (bank|partner|agent)|authorized (agent|representative))\b/i,
];

const CHANNEL_SWITCH_PATTERNS: RegExp[] = [
  /\b(message|contact|text|ping) me (on|at) (telegram|signal|whatsapp|instagram|snapchat)\b/i,
  /\b(switch|move|continue) (to|on) (telegram|signal|whatsapp)\b/i,
  /\b(private chat|dm me|direct message)\b/i,
  /\b(download (this |the )?app|install (this |the )?apk|click (this |the )?link to (install|download))\b/i,
];

const ATTACHMENT_PATTERNS: RegExp[] = [
  /\b\w+\.(apk|exe|scr|bat|cmd|jar|msi|vbs|js)\b/i,
  /\b(apk|exe|scr|bat|cmd|jar|msi|vbs)\s+(file|app|update|software)\b/i,
  /\b(attach(ed|ment)?)\b.+\b(apk|exe|scr|bat|cmd|jar|msi|vbs)\b/i,
];

const PRIZE_PATTERNS: RegExp[] = [
  /\b(you (have )?won|winner|congratulations!? you)\b/i,
  /\b(lottery|jackpot|prize|giveaway|cash reward)\b/i,
  /\b(claim your|to claim|redeem your)\b/i,
  /\b(free (iphone|mobile|laptop|gift|reward|voucher))\b/i,
];

const SECRET_PRESSURE_PATTERNS: RegExp[] = [
  /\b(don'?t (tell|share|inform) (anyone|anybody|the bank|the police))\b/i,
  /\b(keep (it )?secret|confidential|do not share)\b/i,
  /\b(only you can|you alone|nobody else)\b/i,
];

const SAFE_CREDENTIAL_NOTIFICATION =
  /\b(your|the)\s+(otp|one[- ]?time[- ]?password|verification code)\b.{0,50}\b(do not|never)\s+share\b/i;

/** True when the text contains heavy punctuation or shouting. */
export function hasExcessivePunctuation(text: string): boolean {
  return /!{3,}/.test(text) || /!{2,}\s*[A-Z]/.test(text);
}

export function isShouting(text: string): boolean {
  const letters = text.replace(/[^a-zA-Z]/g, "");
  const upper = text.replace(/[^A-Z]/g, "");
  return letters.length > 12 && upper.length / letters.length > 0.6;
}

export function extractSignals(text: string): AnalysisSignal[] {
  const signals: AnalysisSignal[] = [];
  const push = (type: string, description: string) =>
    signals.push({ type, description });

  if (
    !SAFE_CREDENTIAL_NOTIFICATION.test(text) &&
    CREDENTIAL_PATTERNS.some((re) => re.test(text))
  ) {
    push(
      "credential_or_otp_request",
      "The message asks for an OTP, password, PIN, card, or identity details."
    );
  }

  if (PAYMENT_PATTERNS.some((re) => re.test(text))) {
    push(
      "payment_or_bank_request",
      "The message involves payments, refunds, transfers, or bank account details."
    );
  }

  if (URGENCY_PATTERNS.some((re) => re.test(text))) {
    push(
      "urgent_threat_language",
      "The message uses urgency or threats such as account suspension or legal action."
    );
  }

  if (IMPERSONATION_PATTERNS.some((re) => re.test(text))) {
    push(
      "impersonation_claim",
      "The message claims to be from a known bank, company, or support team."
    );
  }

  if (PRIZE_PATTERNS.some((re) => re.test(text))) {
    push(
      "prize_or_reward",
      "The message promises a prize, lottery, or free reward."
    );
  }

  if (CHANNEL_SWITCH_PATTERNS.some((re) => re.test(text))) {
    push(
      "channel_switch_request",
      "The message asks to move the conversation to another private channel or install an app."
    );
  }

  if (ATTACHMENT_PATTERNS.some((re) => re.test(text))) {
    push(
      "suspicious_attachment",
      "The message references a file with an executable or sideloadable extension."
    );
  }

  if (SECRET_PRESSURE_PATTERNS.some((re) => re.test(text))) {
    push(
      "secrecy_pressure",
      "The message pressures the recipient to keep it secret from others."
    );
  }

  if (hasExcessivePunctuation(text)) {
    push(
      "excessive_punctuation",
      "The message uses excessive punctuation or all-caps emphasis."
    );
  }

  if (isShouting(text)) {
    push(
      "excessive_capitalization",
      "The message is written mostly in capital letters."
    );
  }

  return signals;
}
