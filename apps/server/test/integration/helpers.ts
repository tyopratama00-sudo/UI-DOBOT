import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import type { FastifyInstance } from 'fastify';
import { createPrismaClient, type PrismaClient } from '@photobooth/database';
import type { SessionSnapshot } from '@photobooth/shared';
import { buildApp } from '../../src/app';
import { createContext, ensureAdmin, type AppContext } from '../../src/context';
import { loadEnv } from '../../src/env';

export function testDbUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  loadEnv({ DATABASE_URL: process.env.DATABASE_URL || 'postgresql://localhost/photobooth' });
  const base = process.env.DATABASE_URL!;
  const u = new URL(base);
  u.pathname = u.pathname.replace(/\/?([^/]+)$/, (_m, db) => `/${db}_test`);
  return u.toString();
}

export async function truncateAll(prisma: PrismaClient) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "SessionEvent","Edit","Photo","PrintJob","UploadJob","Payment","Session","WebhookEvent","DeviceEvent","AppSetting","AdminUser" RESTART IDENTITY CASCADE',
  );
}

export interface TestApp {
  ctx: AppContext;
  app: FastifyInstance;
  prisma: PrismaClient;
  storage: string;
  close(): Promise<void>;
}

export async function createTestApp(overrides: Record<string, string> = {}): Promise<TestApp> {
  const url = testDbUrl();
  const prisma = createPrismaClient(url);
  await truncateAll(prisma);
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-it-'));
  const env = loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    STORAGE_PATH: storage,
    PAYMENT_PROVIDER: 'mock',
    MOCK_WEBHOOK_SECRET: 'it-secret',
    CAMERA_DRIVER: 'mock',
    ROBOT_DRIVER: 'mock',
    PRINTER_DRIVER: 'mock',
    STORAGE_PROVIDER: 'local',
    PHOTO_ANGLES: '3',
    SHOTS_PER_ANGLE: '2',
    RETAKE_LIMIT: '2',
    PRINT_SECONDS_PER_COPY: '1',
    INTERNET_CHECK_URL: 'http://127.0.0.1:9/',
    CRITICAL_COMPONENTS: 'database,storage,camera,robot,printer,payment',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'test-password-123',
    BOOTH_DEVICE_KEY: '',
    APP_URL: 'http://booth.test',
    PUBLIC_GALLERY_URL: 'https://photo.example.com',
    LOG_LEVEL: 'silent',
    ...overrides,
  });
  const ctx = await createContext(env, { prisma, log: pino({ level: 'silent' }) });
  await ensureAdmin(ctx);
  const app = await buildApp(ctx, { serveStatic: false });
  await app.ready();
  ctx.printQueue.start(150);
  return {
    ctx,
    app,
    prisma,
    storage,
    async close() {
      await ctx.printQueue.stop();
      ctx.health.stop();
      await ctx.hardware.shutdown();
      await app.close();
      await prisma.$disconnect();
      await fs.rm(storage, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** A booth client talking to the in-process server (fastify.inject). */
export class BoothClient {
  id = '';
  token = '';
  constructor(private readonly app: FastifyInstance) {}

  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(this.token ? { 'x-session-token': this.token } : {}), ...headers },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.statusCode, json: res.body ? (JSON.parse(res.body) as any) : null, raw: res };
  }

  async start(): Promise<SessionSnapshot> {
    const r = await this.req('POST', '/api/sessions', {});
    if (r.status !== 201) throw new Error(`create failed ${r.status} ${JSON.stringify(r.json)}`);
    this.id = r.json.session.id;
    this.token = r.json.token;
    return r.json.session;
  }

  async get(): Promise<SessionSnapshot> {
    return (await this.req('GET', `/api/sessions/${this.id}`)).json;
  }

  cmd(c: object, requestId: string = randomUUID()) {
    return this.req('POST', `/api/sessions/${this.id}/commands`, c, { 'x-request-id': requestId });
  }

  async ok(c: object): Promise<SessionSnapshot> {
    const r = await this.cmd(c);
    if (r.status !== 200) throw new Error(`${JSON.stringify(c)} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  }

  async pay(ctx: AppContext, quantity = 1, status: 'PAID' | 'FAILED' | 'EXPIRED' = 'PAID') {
    const p = await this.req('POST', `/api/sessions/${this.id}/payment`, { quantity });
    if (p.status !== 200) throw new Error(`payment ${p.status} ${JSON.stringify(p.json)}`);
    const payment = await ctx.prisma.payment.findFirstOrThrow({ where: { sessionId: this.id, status: 'PENDING' } });
    const hook = ctx.hardware.mockPayment!.buildWebhook(payment.orderId, status, payment.amount);
    const w = await this.app.inject({ method: 'POST', url: '/api/payments/webhook/mock', headers: hook.headers, payload: hook.rawBody });
    return { webhookStatus: w.statusCode, payment };
  }

  /** Runs the capture choreography the booth performs. */
  async captureAll(retakeAngle: number | null = null): Promise<SessionSnapshot> {
    let s = await this.get();
    const angles = retakeAngle === null ? [...Array(s.plan.angles).keys()] : [retakeAngle];
    for (const a of angles) {
      await this.ok({ type: 'move', angle: a });
      for (let k = 0; k < s.plan.shotsPerAngle; k++) {
        await this.ok({ type: 'countdown', angle: a, shot: k });
        await this.ok({ type: 'capture', angle: a, shot: k });
        s = await this.ok({ type: k + 1 < s.plan.shotsPerAngle ? 'next_shot' : 'angle_done' });
      }
    }
    return s;
  }

  async waitFor(pred: (s: SessionSnapshot) => boolean, label: string, ms = 60000): Promise<SessionSnapshot> {
    const end = Date.now() + ms;
    for (;;) {
      const s = await this.get();
      if (pred(s)) return s;
      if (Date.now() > end) throw new Error(`timeout waiting for ${label}; status=${s.status} print=${JSON.stringify(s.print)}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

export async function adminToken(app: FastifyInstance): Promise<string> {
  const r = await app.inject({ method: 'POST', url: '/api/admin/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ username: 'admin', password: 'test-password-123' }) });
  return JSON.parse(r.body).token;
}

export async function admin(app: FastifyInstance, token: string, method: string, url: string, body?: unknown) {
  const r = await app.inject({
    method: method as 'GET',
    url,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : null };
}
