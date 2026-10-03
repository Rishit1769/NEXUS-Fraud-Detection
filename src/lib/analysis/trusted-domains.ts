/**
 * Versioned roots for major, owner-controlled services that are safe to use
 * as a URL-model false-positive guard. This is deliberately not an
 * allow-list for the whole internet: unknown domains still go through every
 * deterministic and model check.
 */
export const TRUSTED_DOMAIN_REGISTRY_VERSION = "2026-10-03.1";

export const TRUSTED_ROOT_DOMAINS = new Set([
  "google.com", "gmail.com", "google.co.in", "youtube.com",
  "microsoft.com", "outlook.com", "office.com", "live.com", "azure.com",
  "apple.com", "icloud.com", "amazon.com", "amazon.in", "aws.amazon.com",
  "meta.com", "facebook.com", "instagram.com", "whatsapp.com",
  "linkedin.com", "github.com", "gitlab.com", "bitbucket.org",
  "wikipedia.org", "reddit.com", "x.com", "twitter.com",
  "netflix.com", "spotify.com", "discord.com", "slack.com", "zoom.us",
  "paypal.com", "stripe.com", "adobe.com", "dropbox.com", "notion.so",
  "openai.com", "cloudflare.com", "stackoverflow.com", "stackexchange.com",
  "hdfcbank.com", "sbi.co.in", "onlinesbi.sbi", "icicibank.com",
  "axisbank.com", "kotak.com", "pnbindia.in", "canarabank.com",
  "irctc.co.in", "telegram.org", "signal.org",
]);

export function isTrustedRootDomain(host: string | null | undefined): boolean {
  const normalized = host?.toLowerCase().replace(/^www\./, "") ?? "";
  return [...TRUSTED_ROOT_DOMAINS].some(
    (domain) => normalized === domain || normalized.endsWith(`.${domain}`)
  );
}
