/** Provision the NEXUS authority account used for escalated reports.
 *
 * This is an Officer account with ADMIN access so it can use the protected
 * investigation portal and resolve escalated incidents. It is intentionally
 * idempotent and updates the password on each explicit seed run.
 */
import bcrypt from "bcryptjs";
import { OfficerRole, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = "authority@nexus.com";
  const password = process.env.AUTHORITY_PASSWORD;
  if (!password) {
    throw new Error("AUTHORITY_PASSWORD is required and must not be committed to the repository");
  }
  const passwordHash = await bcrypt.hash(password, 12);

  const authority = await prisma.officer.upsert({
    where: { email },
    update: {
      name: "NEXUS Authority",
      passwordHash,
      role: OfficerRole.ADMIN,
    },
    create: {
      email,
      name: "NEXUS Authority",
      passwordHash,
      role: OfficerRole.ADMIN,
    },
  });

  console.log(`Authority ready: ${authority.email} (${authority.role}) — id ${authority.id}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
