import type { PrismaClient, LogLevel } from '@photobooth/database';
import type { Logger } from 'pino';

export type Device = 'camera' | 'robot' | 'printer' | 'payment' | 'storage' | 'system' | 'internet' | 'booth';

/** Hardware/integration event log: structured log line + DeviceEvent row (admin diagnostics). */
export class DeviceLog {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly log: Logger,
  ) {}

  async record(device: Device, level: LogLevel, event: string, message: string, data: { sessionId?: string | null; [k: string]: unknown } = {}) {
    const { sessionId, ...rest } = data;
    const lvl = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : level === 'DEBUG' ? 'debug' : 'info';
    this.log[lvl]({ event, device, sessionId: sessionId ?? undefined, ...rest }, message);
    try {
      await this.prisma.deviceEvent.create({
        data: { device, level, event, message: message.slice(0, 1000), sessionId: sessionId ?? null, data: Object.keys(rest).length ? (JSON.parse(JSON.stringify(rest)) as never) : undefined },
      });
    } catch (err) {
      this.log.warn({ err }, 'device_event_persist_failed');
    }
  }

  info(device: Device, event: string, message: string, data?: Record<string, unknown>) {
    return this.record(device, 'INFO', event, message, data);
  }
  warn(device: Device, event: string, message: string, data?: Record<string, unknown>) {
    return this.record(device, 'WARN', event, message, data);
  }
  error(device: Device, event: string, message: string, data?: Record<string, unknown>) {
    return this.record(device, 'ERROR', event, message, data);
  }
}
