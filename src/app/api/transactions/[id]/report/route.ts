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

/** POST /api/transactions/[id]/report — escalate a check to an officer. */
export async function POST(request: Request, { params }: Params) {
  const session = await getSession();
  if (!session) {
    return jsonError("Unauthorized", 401);
  }

  try {
    const { id } = await params;
    const body = reportSchema.parse(await request.json());
    const check = await prisma.transactionCheck.findFirst({
      where: { id, userId: session.userId },
      select: { id: true },
    });
    if (!check) {
      return jsonError("Transaction check not found", 404);
    }

    const authority = await prisma.officer.findUnique({
      where: { email: "authority@nexus.com" },
      select: { id: true },
    });

    const existing = await prisma.incidentReport.findFirst({
      where: {
        transactionCheckId: id,
        status: { in: ["PENDING", "INVESTIGATING"] },
      },
      select: { id: true },
    });
    if (existing) {
      return jsonError("This transaction already has an open report with an officer.", 409);
    }

    const report = await prisma.incidentReport.create({
      data: {
        transactionCheckId: id,
        userId: session.userId,
        reason: body.reason,
        assignments: authority
          ? { create: { officerId: authority.id, assignedBy: "SYSTEM:USER_ESCALATION" } }
          : undefined,
      },
    });

    await logAudit({
      actorType: "USER",
      actorId: session.userId,
      action: "incident.reported",
      targetType: "transaction",
      targetId: id,
      metadata: { reportId: report.id },
    });

    return jsonOk({ report }, { status: 201 });
  } catch (error) {
    return jsonError(parseJsonError(error), 400);
  }
}
