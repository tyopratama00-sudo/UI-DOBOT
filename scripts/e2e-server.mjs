#!/usr/bin/env node
/**
 * Starts an isolated server for Playwright:
 *  - dedicated test database (TEST_DATABASE_URL or <DATABASE_URL>_test), migrated + emptied
 *  - mock payment / camera / robot / printer, fast UI timings
 *  - port 8090, storage in ./storage-e2e
 * Builds the booth/admin bundles first if they are missing.
 */
import { execSync, spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
config({ path: path.join(root, '.env') });

function testDbUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = u.pathname.replace(/\/?([^/]+)$/, (_m, db) => `/${db}_test`);
  return u.toString();
}

const DATABASE_URL = testDbUrl();
const run = (cmd, cwd = root, env = {}) => execSync(cmd, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });

if (!existsSync(path.join(root, 'apps/booth/dist/index.html'))) run('npm run build -w @photobooth/booth');
if (!existsSync(path.join(root, 'apps/admin/dist/index.html'))) run('npm run build -w @photobooth/admin');

run('npx prisma migrate deploy', path.join(root, 'packages/database'), { DATABASE_URL, PRISMA_HIDE_UPDATE_MESSAGE: '1' });
const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
await prisma.$executeRawUnsafe(
  'TRUNCATE "SessionEvent","Edit","Photo","PrintJob","UploadJob","Payment","Session","WebhookEvent","DeviceEvent","AppSetting","AdminUser" RESTART IDENTITY CASCADE',
);
await prisma.$disconnect();
rmSync(path.join(root, 'storage-e2e'), { recursive: true, force: true });

const child = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'apps/server/src/index.ts'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: '8090',
    APP_URL: 'http://localhost:8090',
    PUBLIC_GALLERY_URL: 'http://localhost:8090',
    DATABASE_URL,
    STORAGE_PATH: './storage-e2e',
    LOG_DIR: './logs-e2e',
    LOG_LEVEL: 'warn',
    PAYMENT_PROVIDER: 'mock',
    CAMERA_DRIVER: 'mock',
    ROBOT_DRIVER: 'mock',
    PRINTER_DRIVER: 'mock',
    PRINT_SECONDS_PER_COPY: '1',
    TIMING_SCALE: '0.15',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'e2e-password-123',
    BOOTH_DEVICE_KEY: '',
    INTERNET_CHECK_URL: 'http://127.0.0.1:9/',
  },
});
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
