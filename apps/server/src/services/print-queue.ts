import type { Logger } from 'pino';
import type { PrintJob, PrismaClient } from '@photobooth/database';
import { PrinterError } from '@photobooth/printer';
import type { LocalStorageProvider } from '@photobooth/storage';
import { logEvent } from '../logger';
import { sleep } from '../util/mutex';
import type { EventBus } from './bus';
import type { DeviceLog } from './device-log';
import type { SessionEngine } from './engine';
import type { HardwareManager } from './hardware';
import type { SettingsService } from './settings';

/**
 * Persistent print queue (PrintJob table). Lifecycle:
 *   QUEUED → PRINTING → COMPLETED
 *                    ↘ RETRYING (backoff) → PRINTING … → FAILED (admin retry)
 * Jobs are processed one at a time and tracked until the printer reports the
 * outcome. The customer is informed on the first failure (session continues to
 * the QR code) while the job keeps retrying in the background.
 */
export class PrintQueue {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly hardware: HardwareManager,
    private readonly settings: SettingsService,
    private readonly store: LocalStorageProvider,
    private readonly engine: SessionEngine,
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly devices: DeviceLog,
  ) {}

  async recoverInterrupted() {
    const stuck = await this.prisma.printJob.findMany({ where: { status: { in: ['PRINTING', 'RENDERING'] } } });
    for (const job of stuck) {
      await this.prisma.printJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', errorCode: 'PRINT_INTERRUPTED', error: 'Interrupted by a server restart — verify the printer output and retry from the admin panel', finishedAt: new Date() },
      });
      await this.devices.warn('printer', 'print_interrupted', `Print job ${job.id} interrupted by restart`, { sessionId: job.sessionId });
      if (!job.isReprint) await this.engine.onPrintOutcome(job.sessionId, false, 'PRINT_FAILED').catch(() => undefined);
    }
  }

  start(intervalMs = 1000) {
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.busy) await sleep(50);
  }

  async tick(): Promise<boolean> {
    if (this.busy || this.stopped) return false;
    this.busy = true;
    try {
      const job = await this.prisma.printJob.findFirst({
        where: { status: { in: ['QUEUED', 'RETRYING'] }, nextAttemptAt: { lte: new Date() } },
        orderBy: { createdAt: 'asc' },
      });
      if (!job) return false;
      await this.process(job);
      return true;
    } catch (err) {
      this.log.error({ err }, 'print_queue_tick_failed');
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async setProgress(job: PrintJob, progress: number) {
    await this.prisma.printJob.update({ where: { id: job.id }, data: { progress } });
    this.bus.emitSession(job.sessionId);
  }

  private async process(job: PrintJob) {
    const claimed = await this.prisma.printJob.updateMany({
      where: { id: job.id, status: job.status },
      data: { status: 'PRINTING', attempts: { increment: 1 }, startedAt: job.startedAt ?? new Date(), progress: 0, error: null, errorCode: null },
    });
    if (claimed.count !== 1) return;
    const attempt = job.attempts + 1;
    this.bus.emitSession(job.sessionId);
    const cfg = this.settings.get().printer;
    const printer = this.hardware.printer;
    logEvent(this.log, 'print_started', { sessionId: job.sessionId, jobId: job.id, attempt, copies: job.copies, driver: printer.driver });

    try {
      let fileKey = job.filePath;
      if (!fileKey || !(await this.store.exists(fileKey))) {
        await this.prisma.printJob.update({ where: { id: job.id }, data: { status: 'RENDERING' } });
        fileKey = (await this.engine.adminRerender(job.sessionId)).printKey;
        await this.prisma.printJob.update({ where: { id: job.id }, data: { status: 'PRINTING', filePath: fileKey } });
      }
      const handle = await printer.print(this.store.resolve(fileKey), job.copies, {
        widthPx: cfg.widthPx,
        heightPx: cfg.heightPx,
        dpi: cfg.dpi,
        documentName: `RobotPhotobooth-${job.id}-${attempt}`,
      });
      await this.prisma.printJob.update({ where: { id: job.id }, data: { providerJobId: handle.id, printer: handle.printer } });

      const deadline = Date.now() + Math.max(120_000, job.copies * cfg.secondsPerCopy * 3000);
      let lastProgress = -1;
      for (;;) {
        await sleep(700);
        const current = await this.prisma.printJob.findUnique({ where: { id: job.id } });
        if (!current || current.status === 'CANCELLED') {
          await printer.cancel(handle.id).catch(() => undefined);
          return;
        }
        const st = await printer.getJobStatus(handle.id);
        if (st.progress !== lastProgress) {
          lastProgress = st.progress;
          await this.setProgress(job, Math.min(99, st.progress));
        }
        if (st.state === 'completed') break;
        if (st.state === 'failed') throw new PrinterError(st.errorCode ?? 'PRINT_FAILED', st.error ?? 'Print failed');
        if (Date.now() > deadline) throw new PrinterError('PRINT_FAILED', 'Print job timed out');
      }

      await this.prisma.printJob.update({ where: { id: job.id }, data: { status: 'COMPLETED', progress: 100, finishedAt: new Date(), error: null, errorCode: null } });
      logEvent(this.log, 'print_success', { sessionId: job.sessionId, jobId: job.id, attempt, copies: job.copies });
      await this.devices.info('printer', 'print_success', `Printed ${job.copies} cop${job.copies > 1 ? 'ies' : 'y'}`, { sessionId: job.sessionId, jobId: job.id });
      this.bus.emitSession(job.sessionId);
      if (!job.isReprint) await this.engine.onPrintOutcome(job.sessionId, true);
    } catch (err) {
      const code = err instanceof PrinterError ? err.code : 'PRINT_FAILED';
      const final = attempt >= job.maxAttempts;
      const backoffMs = Math.min(10 * 60_000, 20_000 * 2 ** (attempt - 1));
      await this.prisma.printJob.update({
        where: { id: job.id },
        data: {
          status: final ? 'FAILED' : 'RETRYING',
          nextAttemptAt: new Date(Date.now() + backoffMs),
          error: (err as Error).message.slice(0, 500),
          errorCode: code,
          finishedAt: final ? new Date() : null,
        },
      });
      logEvent(this.log, 'print_failed', { sessionId: job.sessionId, jobId: job.id, attempt, final, code, err: (err as Error).message }, 'error');
      await this.devices.error('printer', 'print_failed', `${code}: ${(err as Error).message}`, { sessionId: job.sessionId, jobId: job.id, attempt, final });
      this.bus.emitSession(job.sessionId);
      // Tell the customer right away; the queue keeps retrying in the background.
      if (!job.isReprint && attempt === 1) await this.engine.onPrintOutcome(job.sessionId, false, code);
    }
  }

  /** Admin retry: only for jobs that are not currently being printed. */
  async retry(jobId: string): Promise<boolean> {
    const r = await this.prisma.printJob.updateMany({
      where: { id: jobId, status: { in: ['FAILED', 'RETRYING', 'CANCELLED'] } },
      data: { status: 'QUEUED', attempts: 0, nextAttemptAt: new Date(), error: null, errorCode: null, finishedAt: null },
    });
    return r.count === 1;
  }

  async cancel(jobId: string) {
    const job = await this.prisma.printJob.findUnique({ where: { id: jobId } });
    if (!job || ['COMPLETED', 'CANCELLED'].includes(job.status)) return;
    await this.prisma.printJob.update({ where: { id: jobId }, data: { status: 'CANCELLED', finishedAt: new Date() } });
    if (job.providerJobId) await this.hardware.printer.cancel(job.providerJobId).catch(() => undefined);
    this.bus.emitSession(job.sessionId);
  }
}
