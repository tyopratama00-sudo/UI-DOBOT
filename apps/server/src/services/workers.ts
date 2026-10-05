import { promises as fs } from 'node:fs';
import type { Logger } from 'pino';
import type { PrismaClient } from '@photobooth/database';
import type { LocalStorageProvider, StorageProvider } from '@photobooth/storage';
import type { WebhookInput } from '@photobooth/payments';
import { WebhookValidationError } from '@photobooth/payments';
import { UNPAID_STATES, type SessionState } from '@photobooth/shared';
import { logEvent } from '../logger';
import type { DeviceLog } from './device-log';
import type { SessionEngine } from './engine';
import type { HardwareManager } from './hardware';
import type { HealthService } from './health';
import type { SettingsService } from './settings';

// ---------------------------------------------------------------- payments

/** Webhook entry point (authoritative) — every call is recorded in WebhookEvent. */
export async function processWebhook(
  deps: { prisma: PrismaClient; hardware: HardwareManager; engine: SessionEngine; log: Logger },
  provider: string,
  input: WebhookInput,
): Promise<{ ok: boolean; status: number; message: string }> {
  const { prisma, hardware, engine, log } = deps;
  if (provider !== hardware.payment.name) return { ok: false, status: 404, message: 'Unknown provider' };
  let parsedBody: unknown = input.body;
  if (parsedBody === undefined || typeof parsedBody === 'string') {
    try {
      parsedBody = JSON.parse(input.rawBody || '{}');
    } catch {
      parsedBody = { raw: input.rawBody.slice(0, 2000) };
    }
  }
  try {
    const result = await hardware.payment.handleWebhook({ ...input, body: parsedBody });
    const ev = await prisma.webhookEvent.create({ data: { provider, orderId: result.orderId, signatureValid: true, payload: parsedBody as never } });
    await engine.applyPayment(result.orderId, result, 'webhook');
    await prisma.webhookEvent.update({ where: { id: ev.id }, data: { processed: true } });
    return { ok: true, status: 200, message: 'OK' };
  } catch (err) {
    const invalid = err instanceof WebhookValidationError;
    await prisma.webhookEvent
      .create({ data: { provider, signatureValid: !invalid, payload: parsedBody as never, error: (err as Error).message.slice(0, 500) } })
      .catch(() => undefined);
    log.warn({ event: 'webhook_rejected', provider, err: (err as Error).message }, 'payment webhook rejected');
    return invalid ? { ok: false, status: 401, message: 'Invalid signature' } : { ok: false, status: 500, message: 'Processing failed' };
  }
}

/**
 * Server-side reconciliation: asks the gateway about pending payments so a lost
 * webhook (booth behind NAT, network blip) never leaves a paying customer stuck.
 */
export class PaymentReconciler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly hardware: HardwareManager,
    private readonly engine: SessionEngine,
    private readonly log: Logger,
  ) {}

  start(intervalMs = 4000) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const pending = await this.prisma.payment.findMany({
        where: { status: 'PENDING', createdAt: { gte: new Date(Date.now() - 3 * 3600_000) } },
        take: 20,
        orderBy: { createdAt: 'desc' },
      });
      for (const p of pending) {
        try {
          const r = await this.hardware.payment.checkPayment(p.providerTransactionId, p.orderId);
          if (r.status !== 'PENDING') await this.engine.applyPayment(p.orderId, r, 'poll');
          else if (p.expiresAt.getTime() < Date.now() - 20_000) await this.engine.applyPayment(p.orderId, { status: 'EXPIRED', raw: { reason: 'expired_locally' } }, 'poll');
        } catch (err) {
          this.log.debug({ event: 'payment_check_failed', orderId: p.orderId, err: (err as Error).message }, 'payment check failed');
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

// ---------------------------------------------------------------- uploads (offline queue)

export class UploadQueue {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: LocalStorageProvider,
    private readonly remote: StorageProvider | null,
    private readonly health: HealthService,
    private readonly log: Logger,
    private readonly devices: DeviceLog,
  ) {}

  async start(intervalMs = 3000) {
    if (!this.remote) return;
    await this.prisma.uploadJob.updateMany({ where: { status: 'UPLOADING' }, data: { status: 'PENDING' } });
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.busy || !this.remote) return;
    if (this.health.internetDown()) return; // wait for connectivity, keep the queue
    this.busy = true;
    try {
      const jobs = await this.prisma.uploadJob.findMany({ where: { status: 'PENDING', nextAttemptAt: { lte: new Date() } }, take: 4, orderBy: { createdAt: 'asc' } });
      for (const job of jobs) {
        await this.prisma.uploadJob.update({ where: { id: job.id }, data: { status: 'UPLOADING', attempts: { increment: 1 } } });
        try {
          await this.remote.put(job.key, await this.store.getBuffer(job.localPath), job.contentType);
          await this.prisma.uploadJob.update({ where: { id: job.id }, data: { status: 'DONE', error: null } });
        } catch (err) {
          const attempts = job.attempts + 1;
          const delay = Math.min(600, 5 * 2 ** Math.min(attempts, 7)) * 1000;
          await this.prisma.uploadJob.update({
            where: { id: job.id },
            data: { status: attempts >= 60 ? 'FAILED' : 'PENDING', nextAttemptAt: new Date(Date.now() + delay), error: (err as Error).message.slice(0, 300) },
          });
          logEvent(this.log, 'upload_failed', { sessionId: job.sessionId, key: job.key, attempts, err: (err as Error).message }, 'warn');
          if (attempts === 1 || attempts % 10 === 0) await this.devices.warn('storage', 'upload_failed', `Upload ${job.key} failed (attempt ${attempts})`, { sessionId: job.sessionId });
          break; // probably offline: back off the whole batch
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

// ---------------------------------------------------------------- reaper / safety nets

export class SessionReaper {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private lastRetention = 0;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly engine: SessionEngine,
    private readonly hardware: HardwareManager,
    private readonly settings: SettingsService,
    private readonly store: LocalStorageProvider,
    private readonly retentionDays: number,
    private readonly log: Logger,
  ) {}

  start(intervalMs = 30_000) {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.expireUnpaid();
      await this.autoCompleteAbandoned();
      await this.finishStaleQr();
      if (Date.now() - this.lastRetention > 3600_000) {
        this.lastRetention = Date.now();
        await this.purgeOldFiles();
      }
    } catch (err) {
      this.log.error({ err }, 'reaper_failed');
    } finally {
      this.busy = false;
    }
  }

  private async expireUnpaid() {
    const list = await this.prisma.session.findMany({
      where: { status: { in: [...UNPAID_STATES] as SessionState[] as never[] }, expiresAt: { lt: new Date() } },
      include: { payments: true },
      take: 20,
    });
    for (const s of list) {
      await this.engine.mutex.run(s.id, async () => {
        const fresh = await this.prisma.session.findUnique({ where: { id: s.id }, include: { payments: true } });
        if (!fresh || !UNPAID_STATES.has(fresh.status as SessionState)) return;
        for (const p of fresh.payments.filter((x) => x.status === 'PENDING')) {
          const r = await this.hardware.payment.checkPayment(p.providerTransactionId, p.orderId).catch(() => null);
          if (r?.status === 'PAID') return; // the reconciler will apply it
          await this.prisma.payment.update({ where: { id: p.id }, data: { status: 'EXPIRED' } });
        }
        await this.prisma.$transaction([
          this.prisma.session.update({ where: { id: s.id }, data: { status: 'EXPIRED', finishedAt: new Date(), version: { increment: 1 } } }),
          this.prisma.sessionEvent.create({ data: { sessionId: s.id, event: 'EXPIRE', fromStatus: fresh.status, toStatus: 'EXPIRED' } }),
        ]);
        logEvent(this.log, 'session_expired', { sessionId: s.id, from: fresh.status });
      });
    }
  }

  private async autoCompleteAbandoned() {
    const cutoff = new Date(Date.now() - Math.max(15 * 60_000, this.settings.get().timeouts.selectionSeconds * 3000));
    const list = await this.prisma.session.findMany({
      where: { status: { in: ['REVIEW', 'FRAME_SELECTION', 'PHOTO_SELECTION', 'EDITING', 'FINAL_PREVIEW'] }, lastActivityAt: { lt: cutoff } },
      take: 5,
    });
    for (const s of list) await this.engine.autoComplete(s.id, 'server_inactivity').catch((err) => this.log.warn({ err, sessionId: s.id }, 'auto_complete_failed'));
    // RENDERING sessions whose pipeline died with the process.
    const rendering = await this.prisma.session.findMany({ where: { status: 'RENDERING', updatedAt: { lt: new Date(Date.now() - 60_000) } }, take: 5 });
    for (const s of rendering) void this.engine.runOutputPipeline(s.id);
    const galleries = await this.prisma.session.findMany({ where: { status: { in: ['PRINT_SUCCESS', 'PRINT_FAILED'] }, updatedAt: { lt: new Date(Date.now() - 30_000) } }, take: 5 });
    for (const s of galleries) await this.engine.generateGallery(s.id).catch(() => undefined);
  }

  private async finishStaleQr() {
    const cutoff = new Date(Date.now() - (this.settings.get().timeouts.qrSeconds + 600) * 1000);
    const list = await this.prisma.session.findMany({ where: { status: 'QR_READY', lastActivityAt: { lt: cutoff } }, take: 20 });
    for (const s of list) await this.engine.command(s.id, { type: 'finish' }).catch(() => undefined);
  }

  private async purgeOldFiles() {
    if (this.retentionDays <= 0) return;
    const cutoff = new Date(Date.now() - this.retentionDays * 86400_000);
    const list = await this.prisma.session.findMany({
      where: {
        status: { in: ['FINISHED', 'CANCELLED', 'EXPIRED'] },
        createdAt: { lt: cutoff },
        OR: [{ galleryExpiresAt: null }, { galleryExpiresAt: { lt: new Date() } }],
        photos: { some: {} },
      },
      select: { id: true },
      take: 50,
    });
    for (const s of list) {
      const dir = this.store.resolve(`sessions/${s.id}`);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      await this.prisma.photo.deleteMany({ where: { sessionId: s.id } });
      this.log.info({ event: 'retention_purge', sessionId: s.id }, 'session files purged by retention policy');
    }
  }
}
