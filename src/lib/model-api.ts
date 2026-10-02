import { z } from "zod";
import { env } from "@/lib/env";
import type { ExtractedUrlLike } from "@/lib/analysis/types";

const featureSchema = z.object({
  name: z.string(),
  value: z.number(),
  importance: z.number(),
  direction: z.enum(["risk_increasing", "risk_decreasing", "unknown"]),
});

const predictionSchema = z.object({
  task: z.enum(["message", "url", "transaction"]),
  modelVersion: z.string(),
  featureVersion: z.string(),
  probability: z.number().min(0).max(1),
  calibrated: z.boolean(),
  riskLevel: z.enum(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  topFeatures: z.array(featureSchema),
});

const responseSchema = z.object({
  requestId: z.string(),
  message: predictionSchema.nullable(),
  urls: z.array(predictionSchema),
  transaction: predictionSchema.nullable().optional(),
});

export type ModelPrediction = z.infer<typeof predictionSchema>;

/** Raw transaction payload as accepted by the model API. */
export interface TransactionPayload {
  Amount: number;
  Time?: string;
  Year?: number;
  Month?: number;
  Day?: number;
  Zip?: string | number | null;
  MCC?: number;
  "Use Chip"?: string;
  "Merchant State"?: string;
  "Errors?"?: string;
}

export async function predictWithModel(input: {
  requestId: string;
  text: string;
  urls: ExtractedUrlLike[];
  /** Structured output from the preceding LLM stage. The current trained
   * model does not use these fields as features, but receives them for
   * traceability and future retraining with LLM-derived features. */
  llmAnalysis?: {
    proposedRiskLevel: string;
    proposedScore: number;
    confidence: number;
  } | null;
}): Promise<{ message: ModelPrediction | null; urls: ModelPrediction[] } | null> {
  if (!env.MODEL_API_URL) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.MODEL_API_TIMEOUT_MS);

  try {
    const response = await fetch(`${env.MODEL_API_URL.replace(/\/$/, "")}/v1/predict`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.MODEL_API_SECRET ? { "x-model-api-key": env.MODEL_API_SECRET } : {}),
      },
      body: JSON.stringify({
        requestId: input.requestId,
        text: input.text,
        urls: input.urls.map((url) => url.normalizedUrl),
        llmAnalysis: input.llmAnalysis ?? undefined,
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    return responseSchema.parse(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Score a single transaction with the XGBoost transaction head (optional, non-fatal). */
export async function predictTransaction(input: {
  requestId: string;
  transaction: TransactionPayload;
  llmAnalysis?: {
    proposedRiskLevel: string;
    proposedScore: number;
    confidence: number;
  } | null;
}): Promise<ModelPrediction | null> {
  if (!env.MODEL_API_URL) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.MODEL_API_TIMEOUT_MS);

  try {
    const response = await fetch(`${env.MODEL_API_URL.replace(/\/$/, "")}/v1/predict`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.MODEL_API_SECRET ? { "x-model-api-key": env.MODEL_API_SECRET } : {}),
      },
      body: JSON.stringify({
        requestId: input.requestId,
        transaction: input.transaction,
        llmAnalysis: input.llmAnalysis ?? undefined,
      }),
      signal: controller.signal,
      cache: "no-store",
    });

    if (!response.ok) {
      return null;
    }

    const parsed = responseSchema.parse(await response.json());
    return parsed.transaction ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
