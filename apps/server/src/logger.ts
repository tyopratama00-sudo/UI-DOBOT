import fs from 'node:fs';
import path from 'node:path';
import pino, { type Logger, type DestinationStream } from 'pino';
import type { Env } from './env';

/**
 * Structured JSON logging (pino) to stdout and to a daily log file in LOG_DIR.
 * Domain events use a stable `event` field (session_created, payment_success,
 * capture_failed, print_failed, …) and always carry `sessionId` when relevant.
 */
class DailyFileStream implements DestinationStream {
  private day = '';
  private stream: fs.WriteStream | null = null;
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }
  write(msg: string): void {
    const d = new Date().toISOString().slice(0, 10);
    if (d !== this.day || !this.stream) {
      this.stream?.end();
      this.day = d;
      this.stream = fs.createWriteStream(path.join(this.dir, `server-${d}.log`), { flags: 'a' });
    }
    this.stream.write(msg);
  }
}

export function createLogger(env: Env): Logger {
  const streamLevel = (env.LOG_LEVEL === 'silent' ? 'fatal' : env.LOG_LEVEL) as pino.Level;
  const streams: pino.StreamEntry[] = [{ level: streamLevel, stream: process.stdout }];
  if (env.NODE_ENV !== 'test') {
    try {
      streams.push({ level: streamLevel, stream: new DailyFileStream(env.logDir) });
    } catch {
      /* read-only FS: stdout only */
    }
  }
  return pino(
    {
      level: env.LOG_LEVEL,
      base: { app: 'robot-photobooth' },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-session-token"]', 'req.headers["x-booth-key"]', '*.password', '*.passwordHash', '*.serverKey', '*.secretKey'],
        censor: '[redacted]',
      },
    },
    pino.multistream(streams),
  );
}

export type DomainEvent =
  | 'session_created'
  | 'session_recovered'
  | 'payment_created'
  | 'payment_success'
  | 'payment_failed'
  | 'payment_expired'
  | 'payment_late'
  | 'robot_move_started'
  | 'robot_move_completed'
  | 'robot_move_failed'
  | 'capture_started'
  | 'capture_success'
  | 'capture_failed'
  | 'render_started'
  | 'render_success'
  | 'render_failed'
  | 'print_queued'
  | 'print_started'
  | 'print_success'
  | 'print_failed'
  | 'gallery_created'
  | 'upload_failed'
  | 'session_finished'
  | 'session_cancelled'
  | 'session_expired'
  | 'session_auto_completed'
  | 'state_changed';

export function logEvent(log: Logger, event: DomainEvent, data: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info') {
  log[level]({ event, ...data }, event);
}
