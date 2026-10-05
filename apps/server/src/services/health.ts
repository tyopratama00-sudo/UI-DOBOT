import type { Logger } from 'pino';
import type { PrismaClient } from '@photobooth/database';
import type { LocalStorageProvider, StorageProvider } from '@photobooth/storage';
import type { ComponentHealth, HealthReport } from '@photobooth/shared';
import type { Env } from '../env';
import type { DeviceLog } from './device-log';
import type { HardwareManager } from './hardware';
import type { SettingsService } from './settings';

type Name = keyof HealthReport['components'];

/**
 * Hardware & dependency health. Refreshed in the background; new sessions (and
 * therefore new payments) are refused while any critical component is down, and
 * the booth shows its maintenance screen.
 */
export class HealthService {
  private report: HealthReport | null = null;
  private timer: NodeJS.Timeout | null = null;
  private paymentCache: { at: number; value: ComponentHealth } | null = null;
  private internetCache: { at: number; value: ComponentHealth } | null = null;
  private lastStatus = new Map<string, string>();
  private refreshing: Promise<HealthReport> | null = null;

  constructor(
    private readonly env: Env,
    private readonly prisma: PrismaClient,
    private readonly hardware: HardwareManager,
    private readonly settings: SettingsService,
    private readonly store: LocalStorageProvider,
    private readonly remote: StorageProvider | null,
    private readonly log: Logger,
    private readonly devices: DeviceLog,
  ) {}

  start(intervalMs = 10_000) {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  internetDown(): boolean {
    return this.internetCache?.value.status === 'down';
  }

  async get(fresh = false): Promise<HealthReport> {
    if (fresh || !this.report || Date.now() - new Date(this.report.checkedAt).getTime() > 30_000) return this.refresh();
    return this.report;
  }

  async acceptingSessions(): Promise<{ ok: boolean; reason: string }> {
    const r = await this.get();
    const down = (Object.entries(r.components) as [Name, ComponentHealth][]).filter(([, c]) => c.critical && c.status === 'down');
    return down.length ? { ok: false, reason: down.map(([n, c]) => `${n}: ${c.message}`).join('; ') } : { ok: true, reason: '' };
  }

  refresh(): Promise<HealthReport> {
    if (!this.refreshing) {
      this.refreshing = this.compute().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private c(name: Name, status: ComponentHealth['status'], message: string, detail?: Record<string, unknown>): ComponentHealth {
    return { status, critical: this.env.criticalComponents.has(name), message, detail };
  }

  private async withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
  }

  private async compute(): Promise<HealthReport> {
    const settings = this.settings.get();
    const [database, storage, camera, robot, printer, payment, internet] = await Promise.all([
      this.withTimeout(
        this.prisma.$queryRaw`SELECT 1`.then(() => this.c('database', 'ok', 'Connected')).catch((e) => this.c('database', 'down', (e as Error).message.slice(0, 120))),
        5000,
        this.c('database', 'down', 'Database timeout'),
      ),
      this.storageHealth(),
      this.cameraHealth(settings.camera.driver),
      this.withTimeout(this.robotHealth(), 5000, this.c('robot', 'down', 'Robot status timeout')),
      this.withTimeout(this.printerHealth(), 20000, this.c('printer', 'unknown', 'Printer status timeout')),
      this.paymentHealth(),
      this.internetHealth(),
    ]);
    const components = { server: this.c('server', 'ok', 'Running', { uptime: Math.round(process.uptime()) }), database, storage, camera, robot, printer, payment, internet };
    const accepting = !Object.values(components).some((c) => c.critical && c.status === 'down');
    const report: HealthReport = {
      ok: accepting && !Object.values(components).some((c) => c.status === 'down'),
      acceptingSessions: accepting,
      checkedAt: new Date().toISOString(),
      components,
    };
    for (const [name, comp] of Object.entries(components)) {
      const prev = this.lastStatus.get(name);
      if (prev && prev !== comp.status) {
        const level = comp.status === 'down' ? 'ERROR' : comp.status === 'ok' ? 'INFO' : 'WARN';
        const device = (['camera', 'robot', 'printer', 'payment', 'storage', 'internet'].includes(name) ? name : 'system') as never;
        void this.devices.record(device, level, 'health_changed', `${name}: ${prev} → ${comp.status} (${comp.message})`);
      }
      this.lastStatus.set(name, comp.status);
    }
    this.report = report;
    return report;
  }

  private async storageHealth(): Promise<ComponentHealth> {
    const local = await this.store.health();
    const detail: Record<string, unknown> = { freeBytes: local.freeBytes, totalBytes: local.totalBytes, provider: this.env.STORAGE_PROVIDER };
    if (this.remote) {
      const r = await this.withTimeout(this.remote.health(), 6000, { ok: false, status: 'down' as const, message: 'S3 timeout' });
      detail.remote = r.message;
      if (local.status === 'ok' && !r.ok) return this.c('storage', 'degraded', `Local OK, cloud: ${r.message} (uploads queued)`, detail);
    }
    return this.c('storage', local.status, local.message, detail);
  }

  private async cameraHealth(driver: string): Promise<ComponentHealth> {
    if (driver === 'webcam') {
      const b = this.hardware.browserCamera;
      if (!b || Date.now() - b.reportedAt > 60_000) return this.c('camera', 'unknown', 'Waiting for booth heartbeat');
      if (['ready', 'previewing', 'capturing'].includes(b.state)) return this.c('camera', 'ok', `Connected (${b.model ?? 'webcam'})`, { driver, ...b });
      if (b.state === 'connecting') return this.c('camera', 'degraded', 'Connecting', { driver, ...b });
      return this.c('camera', 'down', b.error ?? `Camera ${b.state}`, { driver, ...b });
    }
    const cam = this.hardware.camera;
    if (!cam) return this.c('camera', 'down', 'No camera driver');
    const st = cam.getStatus();
    const detail = { driver, model: st.model, state: st.state, lastError: st.lastError };
    if (['ready', 'previewing', 'capturing'].includes(st.state)) return this.c('camera', 'ok', `Connected (${st.model ?? driver})`, detail);
    if (st.state === 'connecting') return this.c('camera', 'degraded', 'Connecting', detail);
    return this.c('camera', 'down', st.lastError ?? `Camera ${st.state}`, detail);
  }

  private async robotHealth(): Promise<ComponentHealth> {
    const st = await this.hardware.robotStatus();
    const detail = { driver: st.driver, state: st.state, angle: st.angle, lastError: st.lastError };
    if (['idle', 'moving', 'homing', 'stopped'].includes(st.state)) return this.c('robot', 'ok', `Connected (${st.driver})`, detail);
    if (st.state === 'connecting') return this.c('robot', 'degraded', 'Connecting', detail);
    return this.c('robot', 'down', st.lastError ?? `Robot ${st.state}`, detail);
  }

  private async printerHealth(): Promise<ComponentHealth> {
    const st = await this.hardware.printer.getStatus();
    const detail = { driver: st.driver, name: st.name, state: st.state, queue: st.queueLength };
    if (st.state === 'ready' || st.state === 'printing') return this.c('printer', 'ok', st.state === 'ready' ? 'Ready' : 'Printing', detail);
    if (st.state === 'unknown') return this.c('printer', 'degraded', st.message || 'Unknown status', detail);
    return this.c('printer', 'down', st.message, detail);
  }

  private async paymentHealth(): Promise<ComponentHealth> {
    if (this.paymentCache && Date.now() - this.paymentCache.at < 60_000) return this.paymentCache.value;
    const r = await this.withTimeout(this.hardware.payment.health(), 8000, { ok: false, message: 'Payment API timeout' });
    const value = this.c('payment', r.ok ? 'ok' : 'down', r.message, { provider: this.hardware.payment.name });
    this.paymentCache = { at: Date.now(), value };
    return value;
  }

  invalidatePaymentCache() {
    this.paymentCache = null;
  }

  private async internetHealth(): Promise<ComponentHealth> {
    if (this.internetCache && Date.now() - this.internetCache.at < 20_000) return this.internetCache.value;
    let value: ComponentHealth;
    try {
      const res = await fetch(this.env.INTERNET_CHECK_URL, { method: 'GET', signal: AbortSignal.timeout(4000), redirect: 'manual' });
      value = this.c('internet', res.status < 500 ? 'ok' : 'degraded', res.status < 500 ? 'Online' : `HTTP ${res.status}`);
    } catch {
      value = this.c('internet', 'down', 'Offline');
    }
    this.internetCache = { at: Date.now(), value };
    return value;
  }
}
