import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

export interface AiConfig {
  provider: string;
  apiKey?: string;
  baseUrl: string;
  model: string;
}

const DEFAULT_PROVIDER = "opencode";
const DEFAULT_MODEL = "deepseek-v4.1-flash";

const DEFAULT_BASE_URLS: Record<string, string> = {
  opencode: "https://opencode.ai/zen/go/v1",
  zen: "https://opencode.ai/zen/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

/** Admin-managed AI explanation provider. DB SystemSetting wins, env is the default. */
export async function getAiConfig(): Promise<AiConfig | null> {
  let settings: { key: string; value: string }[] = [];
  try {
    settings = await prisma.systemSetting.findMany({
      where: { key: { in: ["ai.provider", "ai.api_key", "ai.base_url", "ai.model"] } },
      select: { key: true, value: true },
    });
  } catch {
    // DB unavailable (build/migrate) — fall back to env only.
  }
  const get = (key: string) => settings.find((s) => s.key === key)?.value || undefined;

  const provider = get("ai.provider") ?? env.AI_PROVIDER ?? DEFAULT_PROVIDER;
  const apiKey = get("ai.api_key") ?? env.AI_API_KEY ?? undefined;
  const baseUrl =
    get("ai.base_url") ??
    env.AI_BASE_URL ??
    DEFAULT_BASE_URLS[provider] ??
    DEFAULT_BASE_URLS[DEFAULT_PROVIDER];
  const model = get("ai.model") ?? env.AI_MODEL ?? DEFAULT_MODEL;

  if (!apiKey) return null;
  return { provider, apiKey, baseUrl, model };
}

/** Current settings for the admin console (API key masked). */
export async function getAiSettingsForAdmin(): Promise<{
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
}> {
  let settings: { key: string; value: string }[] = [];
  try {
    settings = await prisma.systemSetting.findMany({
      where: { key: { in: ["ai.provider", "ai.api_key", "ai.base_url", "ai.model"] } },
      select: { key: true, value: true },
    });
  } catch {
    // DB unavailable — env only.
  }
  const get = (key: string) => settings.find((s) => s.key === key)?.value || undefined;
  const provider = get("ai.provider") ?? env.AI_PROVIDER ?? DEFAULT_PROVIDER;
  const hasKey = !!(get("ai.api_key") ?? env.AI_API_KEY);
  return {
    provider,
    baseUrl:
      get("ai.base_url") ??
      env.AI_BASE_URL ??
      DEFAULT_BASE_URLS[provider] ??
      DEFAULT_BASE_URLS[DEFAULT_PROVIDER],
    model: get("ai.model") ?? env.AI_MODEL ?? DEFAULT_MODEL,
    apiKeyConfigured: hasKey,
  };
}

/** Persist admin-chosen provider settings. Empty apiKey keeps the existing key. */
export async function saveAiSettings(
  input: { provider: string; baseUrl?: string; model?: string; apiKey?: string },
  updatedBy?: string | null
): Promise<void> {
  const provider = input.provider.trim().slice(0, 64) || DEFAULT_PROVIDER;
  const baseUrl = (input.baseUrl?.trim() || DEFAULT_BASE_URLS[provider] || DEFAULT_BASE_URLS[DEFAULT_PROVIDER]).slice(0, 512);
  const model = (input.model?.trim() || DEFAULT_MODEL).slice(0, 128);
  await prisma.$transaction([
    prisma.systemSetting.upsert({
      where: { key: "ai.provider" },
      create: { key: "ai.provider", value: provider, updatedBy: updatedBy ?? null },
      update: { value: provider, updatedBy: updatedBy ?? null },
    }),
    prisma.systemSetting.upsert({
      where: { key: "ai.base_url" },
      create: { key: "ai.base_url", value: baseUrl, updatedBy: updatedBy ?? null },
      update: { value: baseUrl, updatedBy: updatedBy ?? null },
    }),
    prisma.systemSetting.upsert({
      where: { key: "ai.model" },
      create: { key: "ai.model", value: model, updatedBy: updatedBy ?? null },
      update: { value: model, updatedBy: updatedBy ?? null },
    }),
    ...(input.apiKey?.trim()
      ? [
          prisma.systemSetting.upsert({
            where: { key: "ai.api_key" },
            create: { key: "ai.api_key", value: input.apiKey.trim(), updatedBy: updatedBy ?? null },
            update: { value: input.apiKey.trim(), updatedBy: updatedBy ?? null },
          }),
        ]
      : []),
  ]);
}
