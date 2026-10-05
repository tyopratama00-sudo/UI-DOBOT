import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDbUrl } from './helpers';

/** Applies the Prisma migrations to the dedicated test database. */
export default function setup() {
  const url = testDbUrl();
  const dbDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/database');
  execSync('npx prisma migrate deploy', { cwd: dbDir, env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' }, stdio: 'pipe' });
}
