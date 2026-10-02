import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z
    .string({ required_error: "DATABASE_URL is required" })
    .min(1, "DATABASE_URL is required"),
  AUTH_SECRET: z
    .string({ required_error: "AUTH_SECRET is required" })
    .min(32, "AUTH_SECRET must be at least 32 characters"),
  NEXT_PUBLIC_APP_NAME: z.string().default("NEXUS Fraud Detection"),
  /** AI explanation provider (OpenAI-compatible chat/completions).
   *  Defaults to OpenCode's Go gateway; admin can override at runtime via
   *  SystemSetting, env is the fallback. */
  AI_PROVIDER: z.string().default("opencode"),
  AI_API_KEY: z.string().optional(),
  AI_BASE_URL: z.string().url().optional(),
  AI_MODEL: z.string().default("deepseek-v4.1-flash"),
  /** Optional Redis URL for distributed rate limits and job locks. */
  REDIS_URL: z.string().optional(),
  /** Optional internal FastAPI XGBoost prediction service. */
  MODEL_API_URL: z.string().url().optional(),
  MODEL_API_SECRET: z.string().min(16).optional(),
  MODEL_API_TIMEOUT_MS: z.coerce.number().int().positive().max(10000).default(1500),
});

export const env = envSchema.parse({
  DATABASE_URL: process.env.DATABASE_URL,
  AUTH_SECRET: process.env.AUTH_SECRET,
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
  AI_PROVIDER: process.env.AI_PROVIDER,
  AI_API_KEY: process.env.AI_API_KEY,
  AI_BASE_URL: process.env.AI_BASE_URL,
  AI_MODEL: process.env.AI_MODEL,
  REDIS_URL: process.env.REDIS_URL,
  MODEL_API_URL: process.env.MODEL_API_URL,
  MODEL_API_SECRET: process.env.MODEL_API_SECRET,
  MODEL_API_TIMEOUT_MS: process.env.MODEL_API_TIMEOUT_MS,
});
