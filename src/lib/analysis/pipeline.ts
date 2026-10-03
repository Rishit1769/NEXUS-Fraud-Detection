import { AnalysisStatus, AnalysisResult, Prisma } from "@prisma/client";
import { env } from "@/lib/env";
import { getAiConfig } from "@/lib/ai-provider";
import { prisma } from "@/lib/prisma";
import { extractUrls } from "@/lib/url-extraction";
import { explainWithAi } from "@/lib/ai-explain";
import { predictWithModel } from "@/lib/model-api";
import { analyzeMessage } from "./engine";
import { scoreToRiskLevel } from "./rules";
import { maybeEscalate } from "./escalation";
import type { ProviderUrlCheck } from "./types";

export interface PipelineOptions {
  conversationId: string;
  idempotencyKey: string;
  providerChecks?: ProviderUrlCheck[];
  workflowId?: string;
  executionId?: string;
  /** Optional explicit message content when the latest USER message cannot be inferred. */
  messageContent?: string;
}

function fallbackSummary(score: number, riskLevel: string, evidence: { description: string }[]): string {
  const top = evidence.slice(0, 3).map((e) => e.description);
  const lead = `This message scored ${score}/100 (${riskLevel} risk).`;
  if (top.length === 0) {
    return `${lead} No strong scam signals were detected, but stay alert for unexpected requests.`;
  }
  return `${lead} Reasons: ${top.join(" ")}`;
}

function riskRank(level: string): number {
  return { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 }[level] ?? 0;
}

const AI_RISK_LEVELS = new Set(["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);

/** Final policy stage: the LLM owns the user-facing result when available. */
function combineFinalDecision(input: {
  deterministicScore: number;
  ai?: { proposedScore: number; proposedRiskLevel: string } | null;
}): { score: number; riskLevel: ReturnType<typeof scoreToRiskLevel> } {
  if (!input.ai) {
    return {
      score: input.deterministicScore,
      riskLevel: scoreToRiskLevel(input.deterministicScore),
    };
  }
  const score = Math.max(0, Math.min(100, Math.round(input.ai.proposedScore)));
  const riskLevel = AI_RISK_LEVELS.has(input.ai.proposedRiskLevel)
    ? (input.ai.proposedRiskLevel as ReturnType<typeof scoreToRiskLevel>)
    : scoreToRiskLevel(score);
  return { score, riskLevel };
}

/**
 * Runs the layered analysis pipeline for a conversation:
 * 1. deterministic signals + rules (always)
 * 2. optional AI explanation (source of the final user-facing score)
 * 3. persistence of the result, indicators, and URL checks
 * 4. automatic escalation of HIGH/CRITICAL or model-rule disagreement
 *
 * Idempotent per idempotencyKey: a second call with the same key returns the
 * existing completed result without re-running the pipeline.
 */
export async function runAnalysisPipeline(
  opts: PipelineOptions
): Promise<AnalysisResult> {
  const existingJob = await prisma.analysisJob.findUnique({
    where: { idempotencyKey: opts.idempotencyKey },
    include: { result: true },
  });

  if (existingJob?.result && existingJob.status === AnalysisStatus.COMPLETED) {
    return existingJob.result;
  }

  const job =
    existingJob ??
    (await prisma.analysisJob.create({
      data: {
        conversationId: opts.conversationId,
        idempotencyKey: opts.idempotencyKey,
        status: AnalysisStatus.PENDING,
        errorDetails: opts.workflowId
          ? { workflowId: opts.workflowId, executionId: opts.executionId }
          : undefined,
      },
    }));

  await prisma.analysisJob.update({
    where: { id: job.id },
    data: { attempts: { increment: 1 } },
  });

  try {
    const conversation = await prisma.conversation.findUniqueOrThrow({
      where: { id: opts.conversationId },
      include: {
        messages: {
          where: { sender: "USER" },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        extractedUrls: true,
      },
    });

    const message =
      opts.messageContent !== undefined
        ? { content: opts.messageContent }
        : (conversation.messages[0] ?? { content: "" });

    const urls = opts.messageContent
      ? extractUrls(opts.messageContent)
      : conversation.extractedUrls;

    const deterministic = analyzeMessage({
      text: message.content,
      urls,
      providerChecks: opts.providerChecks,
    });

    // Stage 2: LLM analysis. It receives deterministic evidence as grounded
    // context and produces the user-facing decision before XGBoost runs.
    const aiConfig = await getAiConfig();
    const ai = aiConfig
      ? await explainWithAi({
          text: message.content,
          urls,
          deterministic,
          sessionId: opts.conversationId,
        })
      : null;

    // Stage 3: optional trained model. The current XGBoost artifacts were
    // trained on message/URL features, so the LLM result is passed as
    // structured context for traceability but is not treated as a model
    // feature until a model is explicitly retrained for that schema.
    const model = await predictWithModel({
      requestId: job.id,
      text: message.content,
      urls,
      llmAnalysis: ai
        ? {
            proposedRiskLevel: ai.proposedRiskLevel,
            proposedScore: ai.proposedScore,
            confidence: ai.confidence,
          }
        : null,
    });

    // Stage 4: final policy. The LLM owns the final answer; deterministic and
    // XGBoost outputs remain persisted for grounding, audit, and comparison.
    const finalDecision = combineFinalDecision({
      deterministicScore: deterministic.score,
      ai,
    });

    const providerResults: Record<string, unknown> = {};
    if (opts.workflowId || opts.executionId) {
      providerResults.workflow = {
        workflowId: opts.workflowId,
        executionId: opts.executionId,
      };
    }
    if (model) {
      providerResults.xgboost = {
        status: "ok",
        message: model.message,
        urls: model.urls,
      };
    } else if (env.MODEL_API_URL) {
      providerResults.xgboost = {
        status: "unavailable",
        note: "Model API did not return a prediction; deterministic result used.",
      };
    }
    if (ai) {
      providerResults.ai = {
        status: "ok",
        model: ai.modelVersion,
        aiSuggestion: {
          riskLevel: ai.proposedRiskLevel,
          score: ai.proposedScore,
          confidence: ai.confidence,
        },
        disagreement: ai.disagreement,
      };
    } else if (aiConfig) {
      providerResults.ai = {
        status: "unavailable",
        note: "AI explanation was not produced; deterministic result used.",
      };
    }

    const summary =
      ai?.summary ??
      fallbackSummary(finalDecision.score, finalDecision.riskLevel, deterministic.evidence);

    const result = await prisma.$transaction(async (tx) => {
      const created = await tx.analysisResult.create({
        data: {
          conversation: { connect: { id: opts.conversationId } },
          job: { connect: { id: job.id } },
          status: AnalysisStatus.COMPLETED,
          riskLevel: finalDecision.riskLevel as AnalysisResult["riskLevel"],
          score: finalDecision.score,
          deterministicScore: deterministic.score,
          confidence:
            ai?.confidence ??
            (model?.message?.calibrated ? model.message.probability : null),
          summary,
          evidence: deterministic.evidence as unknown as Prisma.InputJsonValue,
          safeNextSteps: deterministic.safeNextSteps as unknown as Prisma.InputJsonValue,
          limitations: (ai?.limitations ?? []) as unknown as Prisma.InputJsonValue,
          providerResults: providerResults as unknown as Prisma.InputJsonValue,
          modelVersion:
            model?.message?.modelVersion ?? ai?.modelVersion ?? deterministic.modelVersion,
          ruleVersion: deterministic.ruleVersion,
          completedAt: new Date(),
          indicators: {
            create: deterministic.evidence.map((e) => ({
              type: e.type,
              severity: e.severity,
              description: e.description,
            })),
          },
          urlChecks: opts.providerChecks
            ? {
                create: opts.providerChecks.map((c) => ({
                  urlHash: c.urlHash,
                  provider: c.provider,
                  status: "CHECKED",
                  verdict: c.verdict,
                  score: c.score ?? null,
                  reason: c.reason,
                })),
              }
            : undefined,
        },
      });

      await tx.analysisJob.update({
        where: { id: job.id },
        data: { status: AnalysisStatus.COMPLETED },
      });

      return created;
    });

    // Layer 5: human review. Escalate high/critical automatically and on
    // material model-rule disagreement.
    await maybeEscalate({
      conversationId: opts.conversationId,
      userId: conversation.userId,
      riskLevel: finalDecision.riskLevel,
      reason:
        finalDecision.riskLevel === "HIGH" || finalDecision.riskLevel === "CRITICAL"
          ? "Automatically escalated based on risk level."
          : undefined,
      autoReason: ai?.disagreement
        ? `Model-rule disagreement: AI suggested ${ai.proposedRiskLevel} (${ai.proposedScore}/100) while the rule engine scored ${deterministic.score}/100 (${deterministic.riskLevel}).`
        : model?.message && riskRank(model.message.riskLevel) > riskRank(deterministic.riskLevel)
          ? `XGBoost raised the result: model predicted ${model.message.riskLevel} (${Math.round(model.message.probability * 100)}%) while deterministic rules scored ${deterministic.score}/100 (${deterministic.riskLevel}).`
          : undefined,
    });

    return result;
  } catch (error) {
    await prisma.analysisJob.update({
      where: { id: job.id },
      data: {
        status: AnalysisStatus.FAILED,
        errorDetails: {
          message: error instanceof Error ? error.message : String(error),
        },
      },
    });
    throw error;
  }
}
