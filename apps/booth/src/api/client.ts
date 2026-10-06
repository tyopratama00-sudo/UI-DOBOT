import type { ApiErrorBody, BoothConfig, HealthReport, SessionCommand, SessionCreated, SessionSnapshot } from '@photobooth/shared';
import { deviceKey } from '../kiosk';

/**
 * Booth ↔ server API. Every mutating call carries an x-request-id so retries
 * after a network blip are idempotent on the server. Network failures are
 * reported to a connectivity listener (reconnecting overlay).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly userMessage?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class NetworkError extends Error {
  readonly code = 'BACKEND_UNAVAILABLE';
  readonly userMessage = 'Sistem sedang menyambung ulang…';
}

type ConnListener = (online: boolean) => void;
const connListeners = new Set<ConnListener>();
let failures = 0;
function reportNetwork(ok: boolean) {
  const before = failures;
  failures = ok ? 0 : failures + 1;
  if (ok && before >= 2) connListeners.forEach((l) => l(true));
  if (!ok && failures === 2) connListeners.forEach((l) => l(false));
}
export function onConnectivity(l: ConnListener): () => void {
  connListeners.add(l);
  return () => connListeners.delete(l);
}

export const newRequestId = () =>
  (crypto as Crypto & { randomUUID?: () => string }).randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ReqOpts {
  timeoutMs?: number;
  retries?: number;
  requestId?: string;
  form?: FormData;
  auth?: boolean;
}

class Api {
  token: string | null = null;
  sessionId: string | null = null;

  private headers(opts: ReqOpts, json: boolean): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['content-type'] = 'application/json';
    const key = deviceKey();
    if (key) h['x-booth-key'] = key;
    if (opts.auth !== false && this.token) h['x-session-token'] = this.token;
    if (opts.requestId) h['x-request-id'] = opts.requestId;
    return h;
  }

  async req<T>(method: string, path: string, body?: unknown, opts: ReqOpts = {}): Promise<T> {
    const retries = opts.retries ?? (method === 'GET' ? 2 : 0);
    let attempt = 0;
    for (;;) {
      try {
        const res = await fetch(path, {
          method,
          headers: this.headers(opts, !opts.form && body !== undefined),
          body: opts.form ?? (body !== undefined ? JSON.stringify(body) : undefined),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15000),
          cache: 'no-store',
        });
        reportNetwork(true);
        if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;
        let err: ApiErrorBody['error'] = { code: 'HTTP_' + res.status, message: res.statusText };
        try {
          err = ((await res.json()) as ApiErrorBody).error ?? err;
        } catch {
          /* not JSON */
        }
        const apiErr = new ApiError(res.status, err.code, err.message, err.userMessage, err.retryable ?? res.status >= 500);
        if (apiErr.retryable && attempt < retries && res.status !== 409) throw apiErr;
        throw Object.assign(apiErr, { final: true });
      } catch (e) {
        const final = (e as { final?: boolean }).final;
        if (final) throw e;
        const isNet = !(e instanceof ApiError);
        if (isNet) reportNetwork(false);
        if (attempt >= retries) throw isNet ? new NetworkError((e as Error).message) : e;
        await sleep(Math.min(4000, 400 * 2 ** attempt));
        attempt++;
      }
    }
  }

  config() {
    return this.req<BoothConfig>('GET', '/api/booth/config', undefined, { retries: 3, auth: false });
  }
  health() {
    return this.req<Pick<HealthReport, 'ok' | 'acceptingSessions' | 'checkedAt'> & { components: Record<string, { status: string; critical: boolean; message: string }> }>(
      'GET',
      '/api/booth/health',
      undefined,
      { retries: 1, auth: false, timeoutMs: 25000 },
    );
  }
  active() {
    return this.req<{ session: SessionSnapshot | null; token: string | null }>('GET', '/api/booth/active', undefined, { auth: false });
  }
  heartbeat(body: { camera?: { state: string; model?: string; error?: string }; screen?: string; sessionId?: string | null }) {
    return this.req<{ ok: boolean; cameraFault: 'capture' | 'disconnect' | null }>('POST', '/api/booth/heartbeat', body, { auth: false, timeoutMs: 8000 });
  }

  async createSession(): Promise<SessionCreated> {
    const r = await this.req<SessionCreated>('POST', '/api/sessions', { deviceId: navigator.userAgent.slice(0, 60) }, { auth: false, retries: 2, requestId: newRequestId() });
    this.token = r.token;
    this.sessionId = r.session.id;
    return r;
  }
  getSession(id = this.sessionId!) {
    return this.req<SessionSnapshot>('GET', `/api/sessions/${id}`, undefined, { retries: 2 });
  }
  payment(quantity: number, requestId = newRequestId()) {
    return this.req<SessionSnapshot>('POST', `/api/sessions/${this.sessionId}/payment`, { quantity }, { retries: 3, requestId, timeoutMs: 30000 });
  }
  mockPay(orderId: string) {
    return this.req<{ ok: boolean }>('POST', `/mock-pay/${encodeURIComponent(orderId)}`, { status: 'PAID' });
  }
  command(cmd: SessionCommand, opts: { requestId?: string; timeoutMs?: number; retries?: number } = {}) {
    return this.req<SessionSnapshot>('POST', `/api/sessions/${this.sessionId}/commands`, cmd, {
      retries: opts.retries ?? 4,
      requestId: opts.requestId ?? newRequestId(),
      timeoutMs: opts.timeoutMs ?? 20000,
    });
  }
  uploadPhoto(blob: Blob, angle: number, shot: number, requestId: string) {
    const form = new FormData();
    form.append('angle', String(angle));
    form.append('shot', String(shot));
    form.append('requestId', requestId);
    form.append('file', blob, `a${angle}_s${shot}.jpg`);
    return this.req<SessionSnapshot>('POST', `/api/sessions/${this.sessionId}/photos`, undefined, { form, retries: 3, requestId, timeoutMs: 45000 });
  }

  /** Server-sent events: authoritative snapshots pushed by the backend. */
  subscribe(onSnapshot: (s: SessionSnapshot) => void): () => void {
    if (!this.sessionId || !this.token) return () => undefined;
    const q = new URLSearchParams({ token: this.token });
    const key = deviceKey();
    if (key) q.set('key', key);
    const es = new EventSource(`/api/sessions/${this.sessionId}/events?${q}`);
    es.addEventListener('snapshot', (ev) => {
      try {
        onSnapshot(JSON.parse((ev as MessageEvent).data));
      } catch {
        /* ignore malformed */
      }
    });
    return () => es.close();
  }

  clear() {
    this.token = null;
    this.sessionId = null;
  }
}

export const api = new Api();
