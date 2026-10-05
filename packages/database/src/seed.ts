/**
 * Seeds the first admin account from ADMIN_USERNAME / ADMIN_PASSWORD.
 * The server performs the same check at boot, so running this is optional.
 */
import { scryptSync, randomBytes } from 'node:crypto';
import { prisma } from './index';

function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function main() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.error('ADMIN_PASSWORD is not set; refusing to create an admin without a password.');
    process.exit(1);
  }
  const existing = await prisma.adminUser.findUnique({ where: { username } });
  if (existing) {
    console.log(`Admin "${username}" already exists – nothing to do.`);
    return;
  }
  await prisma.adminUser.create({ data: { username, passwordHash: hashPassword(password) } });
  console.log(`Admin "${username}" created.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
