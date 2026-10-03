import { describe, expect, it } from "vitest";
import { analyzeMessage } from "../engine";
import { runRules, scoreToRiskLevel } from "../rules";
import { extractSignals } from "../signals";

describe("extractSignals", () => {
  it("detects OTP requests", () => {
    const signals = extractSignals(
      "Your HDFC account is blocked. Share the OTP sent to your phone to reactivate it immediately."
    );
    expect(signals.some((s) => s.type === "credential_or_otp_request")).toBe(true);
    expect(signals.some((s) => s.type === "urgent_threat_language")).toBe(true);
    expect(signals.some((s) => s.type === "impersonation_claim")).toBe(true);
  });

  it("detects a direct OTP request but not a normal OTP notification", () => {
    expect(
      extractSignals("Please send your OTP to complete the verification.")
        .some((s) => s.type === "credential_or_otp_request")
    ).toBe(true);
    expect(
      extractSignals("Your OTP is 123456. Do not share it with anyone.")
        .some((s) => s.type === "credential_or_otp_request")
    ).toBe(false);
  });

  it("detects prize scams", () => {
    const signals = extractSignals(
      "Congratulations! You have won a free iPhone. Pay a small processing fee to claim your prize."
    );
    expect(signals.some((s) => s.type === "prize_or_reward")).toBe(true);
    expect(signals.some((s) => s.type === "payment_or_bank_request")).toBe(true);
  });

  it("detects channel switching", () => {
    const signals = extractSignals(
      "This is the support team. Please message me on Telegram to continue."
    );
    expect(signals.some((s) => s.type === "channel_switch_request")).toBe(true);
  });

  it("detects secrecy pressure", () => {
    const signals = extractSignals(
      "Do not tell anyone about this. Only you can save your account."
    );
    expect(signals.some((s) => s.type === "secrecy_pressure")).toBe(true);
  });

  it("detects suspicious attachments", () => {
    const signals = extractSignals("Download the attached APK file to update.");
    expect(signals.some((s) => s.type === "suspicious_attachment")).toBe(true);
  });

  it("detects shouting", () => {
    const signals = extractSignals("YOUR ACCOUNT WILL BE CLOSED TODAY ACT NOW");
    expect(signals.some((s) => s.type === "excessive_capitalization")).toBe(true);
  });

  it("returns no signals for a benign message", () => {
    const signals = extractSignals(
      "Hi! Are we still meeting for coffee tomorrow at 5?"
    );
    expect(signals).toHaveLength(0);
  });
});

describe("runRules / scoring", () => {
  it("maps scores to risk levels per the blueprint thresholds", () => {
    expect(scoreToRiskLevel(0)).toBe("LOW");
    expect(scoreToRiskLevel(19)).toBe("LOW");
    expect(scoreToRiskLevel(20)).toBe("MEDIUM");
    expect(scoreToRiskLevel(44)).toBe("MEDIUM");
    expect(scoreToRiskLevel(45)).toBe("HIGH");
    expect(scoreToRiskLevel(69)).toBe("HIGH");
    expect(scoreToRiskLevel(70)).toBe("CRITICAL");
    expect(scoreToRiskLevel(150)).toBe("CRITICAL");
  });

  it("scores a classic OTP-phishing message as HIGH or CRITICAL", () => {
    const result = runRules({
      text: "Your HDFC account will be blocked in 24 hours. Share your OTP now to verify. Don't tell anyone.",
      urls: [],
    });
    expect(result.score).toBeGreaterThanOrEqual(45);
    expect(["HIGH", "CRITICAL"]).toContain(result.riskLevel);
  });

  it("scores a direct OTP request as HIGH", () => {
    const result = runRules({ text: "Please send your OTP", urls: [] });
    expect(result.score).toBe(45);
    expect(result.riskLevel).toBe("HIGH");
  });

  it("adds points for shortened URLs", () => {
    const result = runRules({
      text: "Claim your refund here: https://bit.ly/3xYz9qA",
      urls: [
        {
          rawUrl: "https://bit.ly/3xYz9qA",
          normalizedUrl: "https://bit.ly/3xYz9qA",
          normalizedHash: "abc",
          host: "bit.ly",
        },
      ],
    });
    expect(
      result.ruleResults.some((r) => r.ruleId === "shortened_or_redirect_url")
    ).toBe(true);
  });

  it("flags punycode and IP-address hosts", () => {
    const puny = runRules({
      text: "Sign in at https://xn--hdfcbank-zqb.com",
      urls: [
        {
          rawUrl: "https://xn--hdfcbank-zqb.com",
          normalizedUrl: "https://xn--hdfcbank-zqb.com",
          normalizedHash: "a",
          host: "xn--hdfcbank-zqb.com",
        },
      ],
    });
    expect(
      puny.ruleResults.some((r) => r.ruleId === "punycode_or_lookalike_domain")
    ).toBe(true);

    const ip = runRules({
      text: "Verify at http://203.0.113.10/login",
      urls: [
        {
          rawUrl: "http://203.0.113.10/login",
          normalizedUrl: "http://203.0.113.10/login",
          normalizedHash: "b",
          host: "203.0.113.10",
        },
      ],
    });
    expect(
      ip.ruleResults.some((r) => r.ruleId === "punycode_or_lookalike_domain")
    ).toBe(true);
  });

  it("flags brand/host mismatch", () => {
    const result = runRules({
      text: "Amazon order delayed, confirm here: https://amazon-refunds-claims.com",
      urls: [
        {
          rawUrl: "https://amazon-refunds-claims.com",
          normalizedUrl: "https://amazon-refunds-claims.com",
          normalizedHash: "c",
          host: "amazon-refunds-claims.com",
        },
      ],
    });
    expect(
      result.ruleResults.some((r) => r.ruleId === "brand_host_mismatch")
    ).toBe(true);
  });

  it("does not flag a known brand domain as mismatch", () => {
    const result = runRules({
      text: "Your Amazon order shipped: https://www.amazon.in/gp/your-account",
      urls: [
        {
          rawUrl: "https://www.amazon.in/gp/your-account",
          normalizedUrl: "https://www.amazon.in/gp/your-account",
          normalizedHash: "d",
          host: "www.amazon.in",
        },
      ],
    });
    expect(
      result.ruleResults.some((r) => r.ruleId === "brand_host_mismatch")
    ).toBe(false);
  });

  it("applies provider-backed reputation rules", () => {
    const result = runRules({
      text: "Check this: https://evil.example.net",
      urls: [
        {
          rawUrl: "https://evil.example.net",
          normalizedUrl: "https://evil.example.net",
          normalizedHash: "e",
          host: "evil.example.net",
        },
      ],
      providerChecks: [
        {
          urlHash: "e",
          provider: "test",
          verdict: "malicious",
          score: 95,
        },
      ],
    });
    expect(result.score).toBeGreaterThanOrEqual(40);
    expect(
      result.ruleResults.some((r) => r.ruleId === "known_bad_reputation")
    ).toBe(true);
  });

  it("subtracts points for known-clean provider results", () => {
    const result = runRules({
      text: "Our website: https://example.com",
      urls: [
        {
          rawUrl: "https://example.com",
          normalizedUrl: "https://example.com",
          normalizedHash: "f",
          host: "example.com",
        },
      ],
      providerChecks: [{ urlHash: "f", provider: "test", verdict: "clean" }],
    });
    expect(result.score).toBe(0);
  });
});

describe("analyzeMessage", () => {
  it("returns a complete, explainable result", () => {
    const result = analyzeMessage({
      text: "Your SBI account is suspended. Share your OTP immediately to reactivate. Message me on Telegram for help.",
      urls: [],
    });
    expect(result.modelVersion).toContain("nexus-deterministic-rules");
    expect(result.ruleVersion).toBe("1.0.0");
    expect(result.evidence.length).toBeGreaterThan(0);
    expect(result.safeNextSteps.length).toBeGreaterThan(0);
    expect(["HIGH", "CRITICAL"]).toContain(result.riskLevel);
  });

  it("gives a low-risk result with safe next steps for benign mail", () => {
    const result = analyzeMessage({
      text: "Hi Rishit, the design review is at 3pm tomorrow. Bring your laptop.",
      urls: [],
    });
    expect(result.riskLevel).toBe("LOW");
    expect(result.safeNextSteps.length).toBeGreaterThan(0);
  });
});
