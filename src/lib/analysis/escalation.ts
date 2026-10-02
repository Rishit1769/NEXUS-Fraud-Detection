import { IncidentOrigin, IncidentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Layer 5 of the fraud-detection engine: human review escalation.
 *
 * Creates an IncidentReport (origin AUTO) when a case needs officer
 * attention: HIGH/CRITICAL risk, or an explicit reason (e.g. model-rule
 * disagreement). Never duplicates an open report for the same
 * conversation or transaction check. Exactly one of conversationId /
 * transactionCheckId must be set.
 */
export async function maybeEscalate(params: {
  conversationId?: string | null;
  transactionCheckId?: string | null;
  userId?: string | null;
  riskLevel?: string;
  reason?: string;
  autoReason?: string;
}): Promise<{ id: string } | null> {
  const needsReview =
    params.reason !== undefined ||
    params.riskLevel === "HIGH" ||
    params.riskLevel === "CRITICAL";

  if (!needsReview) {
    return null;
  }

  if (!params.conversationId && !params.transactionCheckId) {
    throw new Error("maybeEscalate requires a conversationId or transactionCheckId");
  }

  const existing = await prisma.incidentReport.findFirst({
    where: {
      conversationId: params.conversationId ?? undefined,
      transactionCheckId: params.transactionCheckId ?? undefined,
      status: { in: [IncidentStatus.PENDING, IncidentStatus.INVESTIGATING] },
    },
    select: { id: true },
  });

  if (existing) {
    const authority = await prisma.officer.findUnique({
      where: { email: "authority@nexus.com" },
      select: { id: true },
    });
    if (authority) {
      await prisma.incidentAssignment.upsert({
        where: { incidentReportId: existing.id },
        update: { officerId: authority.id },
        create: {
          incidentReportId: existing.id,
          officerId: authority.id,
          assignedBy: "SYSTEM:AUTHORITY_ROUTING",
        },
      });
    }
    return existing;
  }

  const authority = await prisma.officer.findUnique({
    where: { email: "authority@nexus.com" },
    select: { id: true },
  });

  return prisma.incidentReport.create({
    data: {
      conversationId: params.conversationId ?? null,
      transactionCheckId: params.transactionCheckId ?? null,
      userId: params.userId ?? null,
      reason:
        params.reason ??
        "Automatically escalated based on risk analysis.",
      origin: IncidentOrigin.AUTO,
      autoReason: params.autoReason ?? null,
      assignments: authority
        ? { create: { officerId: authority.id, assignedBy: "SYSTEM:AUTHORITY_ROUTING" } }
        : undefined,
    },
    select: { id: true },
  });
}
