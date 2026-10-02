import { ConversationStatus } from "@prisma/client";
import { z } from "zod";
import { jsonError, jsonOk, parseJsonError } from "@/lib/api";
import { getSession } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

const reportSchema = z.object({
  reason: z.string().trim().min(10, "Report reason must be at least 10 characters").max(2000),
});

type Params = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, { params }: Params) {
  const session = await getSession();

  if (!session) {
    return jsonError("Unauthorized", 401);
  }

  try {
    const { id } = await params;
    const body = reportSchema.parse(await request.json());
    const conversation = await prisma.conversation.findFirst({
      where: { id, userId: session.userId },
      select: { id: true },
    });

    if (!conversation) {
      return jsonError("Conversation not found", 404);
    }

    const authority = await prisma.officer.findUnique({
      where: { email: "authority@nexus.com" },
      select: { id: true },
    });

    const report = await prisma.$transaction(async (tx) => {
      // Duplicate-report protection: one open report per conversation.
      const existing = await tx.incidentReport.findFirst({
        where: {
          conversationId: id,
          status: { in: ["PENDING", "INVESTIGATING"] },
        },
        select: { id: true },
      });

      if (existing) {
        throw new DuplicateReportError(existing.id);
      }

      const created = await tx.incidentReport.create({
        data: {
          conversationId: id,
          userId: session.userId,
          reason: body.reason,
          assignments: authority
            ? { create: { officerId: authority.id, assignedBy: "SYSTEM:USER_ESCALATION" } }
            : undefined,
        },
      });

      await tx.conversation.update({
        where: { id },
        data: { status: ConversationStatus.REPORTED },
      });

      return created;
    });

    await logAudit({
      actorType: "USER",
      actorId: session.userId,
      action: "incident.reported",
      targetType: "conversation",
      targetId: id,
      metadata: { reportId: report.id },
    });

    return jsonOk({ report }, { status: 201 });
  } catch (error) {
    if (error instanceof DuplicateReportError) {
      return jsonError(
        "This conversation already has an open report with an officer.",
        409
      );
    }
    return jsonError(parseJsonError(error), 400);
  }
}

class DuplicateReportError extends Error {
  constructor(public readonly reportId: string) {
    super("duplicate report");
    this.name = "DuplicateReportError";
  }
}
