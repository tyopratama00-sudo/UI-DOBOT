import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Payment provider abstraction for dynamic QRIS.
 *
 * Flow: createPayment → show QR → gateway webhook → handleWebhook (signature
 * verified, status re-checked with the gateway) → server marks the session
 * paid. The booth never decides that a payment succeeded; the backend does.
 */

export type ProviderPaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'CANCELLED';

export interface CreatePaymentInput {
  orderId: string;
  amount: number;
  currency: string;
  description: string;
  expiresInSeconds: number;
  callbackUrl?: string;
}

export interface PaymentRequest {
  providerTransactionId: string;
  /** EMVCo QRIS payload to render as a QR code. */
  qrString: string;
  expiresAt: Date;
  raw: unknown;
}

export interface PaymentCheckResult {
  status: ProviderPaymentStatus;
  paidAt?: Date;
  amount?: number;
  raw: unknown;
}

export interface WebhookInput {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody: string;
}

export interface WebhookResult {
  orderId: string;
  providerTransactionId?: string;
  status: ProviderPaymentStatus;
  amount?: number;
  paidAt?: Date;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<PaymentRequest>;
  checkPayment(providerTransactionId: string, orderId: string): Promise<PaymentCheckResult>;
  /** Validates the webhook (signature / token) and normalizes it. Throws WebhookValidationError. */
  handleWebhook(input: WebhookInput): Promise<WebhookResult>;
  cancelPayment?(providerTransactionId: string, orderId: string): Promise<void>;
  health(): Promise<{ ok: boolean; message: string }>;
}

export class WebhookValidationError extends Error {
  readonly code = 'WEBHOOK_INVALID';
}

export class PaymentProviderError extends Error {
  constructor(
    readonly code: 'PAYMENT_API_UNAVAILABLE' | 'PAYMENT_REJECTED' | 'PAYMENT_CONFIG',
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

function header(h: WebhookInput['headers'], name: string): string | undefined {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ------------------------------------------------------------------ QRIS (EMVCo) helpers

function tlv(id: string, value: string): string {
  return id + String(value.length).padStart(2, '0') + value;
}

export function crc16ccitt(s: string): string {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Builds a structurally valid (test) dynamic QRIS payload for the mock provider. */
export function buildMockQris(orderId: string, amount: number, merchant = 'ROBOT PHOTOBOOTH', city = 'JAKARTA'): string {
  const body =
    tlv('00', '01') +
    tlv('01', '12') +
    tlv('26', tlv('00', 'ID.CO.MOCK.WWW') + tlv('01', '936000000000000000') + tlv('02', 'MOCK0001') + tlv('03', 'UMI')) +
    tlv('52', '7221') +
    tlv('53', '360') +
    tlv('54', String(amount)) +
    tlv('58', 'ID') +
    tlv('59', merchant.slice(0, 25)) +
    tlv('60', city.slice(0, 15)) +
    tlv('62', tlv('01', orderId.slice(0, 25))) +
    '6304';
  return body + crc16ccitt(body);
}

// ------------------------------------------------------------------ mock

export interface MockPaymentOptions {
  webhookSecret: string;
  /** If set, the QR encodes `${payUrlBase}/mock-pay/<orderId>` so a phone can "pay" in dev. */
  payUrlBase?: string;
}

/**
 * Development provider. Payments are settled by a signed webhook
 * (HMAC-SHA256 of the raw body in `x-mock-signature`) sent by the admin panel,
 * the /mock-pay page or the E2E tests — the same validation path as production.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  private statuses = new Map<string, { status: ProviderPaymentStatus; paidAt?: Date; amount: number; expiresAt: Date }>();
  private unavailable = false;

  constructor(private readonly opts: MockPaymentOptions) {}

  simulateUnavailable(v: boolean) {
    this.unavailable = v;
  }

  sign(rawBody: string): string {
    return createHmac('sha256', this.opts.webhookSecret).update(rawBody).digest('hex');
  }

  /** Build a signed webhook as a real gateway would send it. */
  buildWebhook(orderId: string, status: 'PAID' | 'FAILED' | 'EXPIRED', amount: number): { rawBody: string; headers: Record<string, string> } {
    const rawBody = JSON.stringify({ orderId, transactionId: `mock-${orderId}`, status, amount, paidAt: status === 'PAID' ? new Date().toISOString() : null });
    return { rawBody, headers: { 'content-type': 'application/json', 'x-mock-signature': this.sign(rawBody) } };
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentRequest> {
    if (this.unavailable) throw new PaymentProviderError('PAYMENT_API_UNAVAILABLE', 'Mock payment API unavailable (simulated)', true);
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    this.statuses.set(input.orderId, { status: 'PENDING', amount: input.amount, expiresAt });
    const qrString = this.opts.payUrlBase
      ? `${this.opts.payUrlBase.replace(/\/+$/, '')}/mock-pay/${encodeURIComponent(input.orderId)}`
      : buildMockQris(input.orderId, input.amount);
    return { providerTransactionId: `mock-${input.orderId}`, qrString, expiresAt, raw: { mock: true, orderId: input.orderId } };
  }

  async checkPayment(_id: string, orderId: string): Promise<PaymentCheckResult> {
    if (this.unavailable) throw new PaymentProviderError('PAYMENT_API_UNAVAILABLE', 'Mock payment API unavailable (simulated)', true);
    const s = this.statuses.get(orderId);
    if (!s) return { status: 'PENDING', raw: null };
    if (s.status === 'PENDING' && s.expiresAt.getTime() < Date.now()) s.status = 'EXPIRED';
    return { status: s.status, paidAt: s.paidAt, amount: s.amount, raw: { ...s } };
  }

  async handleWebhook(input: WebhookInput): Promise<WebhookResult> {
    const sig = header(input.headers, 'x-mock-signature');
    if (!sig || !safeEqual(sig, this.sign(input.rawBody))) throw new WebhookValidationError('Invalid mock webhook signature');
    const b = JSON.parse(input.rawBody) as { orderId: string; transactionId?: string; status: ProviderPaymentStatus; amount?: number; paidAt?: string };
    if (!b.orderId || !['PAID', 'FAILED', 'EXPIRED', 'CANCELLED'].includes(b.status)) throw new WebhookValidationError('Malformed mock webhook');
    const s = this.statuses.get(b.orderId);
    const paidAt = b.paidAt ? new Date(b.paidAt) : b.status === 'PAID' ? new Date() : undefined;
    // A gateway never settles a different amount: keep our record untouched (the server rejects it too).
    if (s && b.status === 'PAID' && b.amount !== undefined && b.amount !== s.amount) {
      return { orderId: b.orderId, providerTransactionId: b.transactionId, status: b.status, amount: b.amount, paidAt, raw: b };
    }
    if (s) {
      s.status = b.status;
      s.paidAt = paidAt;
    } else {
      // Server restarted between create and webhook: remember the outcome.
      this.statuses.set(b.orderId, { status: b.status, paidAt, amount: b.amount ?? 0, expiresAt: new Date(Date.now() + 60000) });
    }
    return { orderId: b.orderId, providerTransactionId: b.transactionId, status: b.status, amount: b.amount, paidAt, raw: b };
  }

  async cancelPayment(_id: string, orderId: string): Promise<void> {
    const s = this.statuses.get(orderId);
    if (s && s.status === 'PENDING') s.status = 'CANCELLED';
  }

  async health() {
    return this.unavailable ? { ok: false, message: 'Mock payment API unavailable (simulated)' } : { ok: true, message: 'Mock provider' };
  }
}

// ------------------------------------------------------------------ Midtrans (Core API, QRIS)

export interface MidtransOptions {
  serverKey: string;
  production: boolean;
  /** QRIS acquirer: 'gopay' (default) or 'airpay shopee' */
  acquirer?: string;
}

/**
 * Midtrans Core API QRIS.
 * Docs: https://docs.midtrans.com/reference/qris  (charge, status, notification)
 * Notification signature: sha512(order_id + status_code + gross_amount + serverKey)
 */
export class MidtransProvider implements PaymentProvider {
  readonly name = 'midtrans';
  constructor(private readonly opts: MidtransOptions) {
    if (!opts.serverKey) throw new PaymentProviderError('PAYMENT_CONFIG', 'MIDTRANS_SERVER_KEY is required');
  }

  private get base() {
    return this.opts.production ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
  }

  private async api(method: string, p: string, body?: unknown): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await fetch(this.base + p, {
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: 'Basic ' + Buffer.from(this.opts.serverKey + ':').toString('base64'),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new PaymentProviderError('PAYMENT_API_UNAVAILABLE', `Midtrans unreachable: ${(err as Error).message}`, true);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (res.status >= 500) throw new PaymentProviderError('PAYMENT_API_UNAVAILABLE', `Midtrans HTTP ${res.status}`, true);
    return json;
  }

  static mapStatus(transactionStatus: string, fraudStatus?: string): ProviderPaymentStatus {
    switch (transactionStatus) {
      case 'settlement':
        return 'PAID';
      case 'capture':
        return fraudStatus === 'challenge' ? 'PENDING' : 'PAID';
      case 'pending':
        return 'PENDING';
      case 'expire':
        return 'EXPIRED';
      case 'cancel':
        return 'CANCELLED';
      case 'deny':
      case 'failure':
        return 'FAILED';
      default:
        return 'PENDING';
    }
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentRequest> {
    const minutes = Math.max(1, Math.round(input.expiresInSeconds / 60));
    const r = await this.api('POST', '/v2/charge', {
      payment_type: 'qris',
      transaction_details: { order_id: input.orderId, gross_amount: input.amount },
      item_details: [{ id: 'print', price: input.amount, quantity: 1, name: input.description.slice(0, 50) }],
      qris: { acquirer: this.opts.acquirer ?? 'gopay' },
      custom_expiry: { expiry_duration: minutes, unit: 'minute' },
    });
    if (!String(r.status_code ?? '').startsWith('2') || !r.qr_string)
      throw new PaymentProviderError('PAYMENT_REJECTED', `Midtrans charge failed: ${r.status_message ?? 'unknown error'}`);
    const expiresAt = r.expiry_time ? new Date(String(r.expiry_time).replace(' ', 'T') + '+07:00') : new Date(Date.now() + minutes * 60000);
    return { providerTransactionId: String(r.transaction_id), qrString: String(r.qr_string), expiresAt, raw: r };
  }

  async checkPayment(_id: string, orderId: string): Promise<PaymentCheckResult> {
    const r = await this.api('GET', `/v2/${encodeURIComponent(orderId)}/status`);
    if (String(r.status_code) === '404') return { status: 'PENDING', raw: r };
    const status = MidtransProvider.mapStatus(String(r.transaction_status ?? ''), r.fraud_status);
    return {
      status,
      amount: r.gross_amount ? Math.round(Number(r.gross_amount)) : undefined,
      paidAt: status === 'PAID' && r.settlement_time ? new Date(String(r.settlement_time).replace(' ', 'T') + '+07:00') : undefined,
      raw: r,
    };
  }

  async handleWebhook(input: WebhookInput): Promise<WebhookResult> {
    const b = (typeof input.body === 'object' && input.body ? input.body : JSON.parse(input.rawBody)) as Record<string, string>;
    const expected = createHash('sha512').update(`${b.order_id}${b.status_code}${b.gross_amount}${this.opts.serverKey}`).digest('hex');
    if (!b.signature_key || !safeEqual(b.signature_key, expected)) throw new WebhookValidationError('Invalid Midtrans signature');
    // Defense in depth: confirm with the status API instead of trusting the payload.
    const confirmed = await this.checkPayment(b.transaction_id, b.order_id);
    return {
      orderId: b.order_id,
      providerTransactionId: b.transaction_id,
      status: confirmed.status,
      amount: confirmed.amount ?? Math.round(Number(b.gross_amount)),
      paidAt: confirmed.paidAt,
      raw: b,
    };
  }

  async cancelPayment(_id: string, orderId: string): Promise<void> {
    await this.api('POST', `/v2/${encodeURIComponent(orderId)}/cancel`).catch(() => undefined);
  }

  async health() {
    try {
      await this.api('GET', '/v2/health-check-nonexistent/status');
      return { ok: true, message: 'Midtrans API reachable' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}

// ------------------------------------------------------------------ Xendit (QR Codes API)

export interface XenditOptions {
  secretKey: string;
  callbackToken: string;
}

/**
 * Xendit QR Codes API (dynamic QRIS).
 * Docs: https://developers.xendit.co/api-reference/#qr-codes
 * Webhook authenticity: `x-callback-token` header equals the dashboard verification token.
 */
export class XenditProvider implements PaymentProvider {
  readonly name = 'xendit';
  constructor(private readonly opts: XenditOptions) {
    if (!opts.secretKey) throw new PaymentProviderError('PAYMENT_CONFIG', 'XENDIT_SECRET_KEY is required');
    if (!opts.callbackToken) throw new PaymentProviderError('PAYMENT_CONFIG', 'XENDIT_CALLBACK_TOKEN is required');
  }

  private async api(method: string, p: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch('https://api.xendit.co' + p, {
        method,
        headers: {
          'content-type': 'application/json',
          'api-version': '2022-07-31',
          authorization: 'Basic ' + Buffer.from(this.opts.secretKey + ':').toString('base64'),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      throw new PaymentProviderError('PAYMENT_API_UNAVAILABLE', `Xendit unreachable: ${(err as Error).message}`, true);
    }
    const json = await res.json().catch(() => ({}));
    if (res.status >= 500) throw new PaymentProviderError('PAYMENT_API_UNAVAILABLE', `Xendit HTTP ${res.status}`, true);
    if (res.status >= 400) throw new PaymentProviderError('PAYMENT_REJECTED', `Xendit: ${json.message ?? res.status}`);
    return json;
  }

  async createPayment(input: CreatePaymentInput): Promise<PaymentRequest> {
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    const r = await this.api('POST', '/qr_codes', {
      reference_id: input.orderId,
      type: 'DYNAMIC',
      currency: input.currency,
      amount: input.amount,
      expires_at: expiresAt.toISOString(),
      metadata: { description: input.description },
    });
    return { providerTransactionId: String(r.id), qrString: String(r.qr_string), expiresAt: r.expires_at ? new Date(r.expires_at) : expiresAt, raw: r };
  }

  async checkPayment(id: string): Promise<PaymentCheckResult> {
    const list = await this.api('GET', `/qr_codes/${encodeURIComponent(id)}/payments`);
    const payments: any[] = Array.isArray(list?.data) ? list.data : [];
    const ok = payments.find((p) => p.status === 'SUCCEEDED');
    if (ok) return { status: 'PAID', amount: Math.round(Number(ok.amount)), paidAt: new Date(ok.created ?? Date.now()), raw: ok };
    const qr = await this.api('GET', `/qr_codes/${encodeURIComponent(id)}`);
    if (qr.status === 'INACTIVE') return { status: 'EXPIRED', raw: qr };
    return { status: 'PENDING', raw: qr };
  }

  async handleWebhook(input: WebhookInput): Promise<WebhookResult> {
    const token = header(input.headers, 'x-callback-token');
    if (!token || !safeEqual(token, this.opts.callbackToken)) throw new WebhookValidationError('Invalid Xendit callback token');
    const b = (typeof input.body === 'object' && input.body ? input.body : JSON.parse(input.rawBody)) as any;
    const d = b.data ?? b;
    const status: ProviderPaymentStatus = d.status === 'SUCCEEDED' ? 'PAID' : d.status === 'FAILED' ? 'FAILED' : 'PENDING';
    if (!d.reference_id) throw new WebhookValidationError('Malformed Xendit webhook');
    return {
      orderId: d.reference_id,
      providerTransactionId: d.qr_id,
      status,
      amount: d.amount ? Math.round(Number(d.amount)) : undefined,
      paidAt: status === 'PAID' ? new Date(d.created ?? Date.now()) : undefined,
      raw: b,
    };
  }

  async health() {
    try {
      await this.api('GET', '/balance');
      return { ok: true, message: 'Xendit API reachable' };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }
}

export interface PaymentEnv {
  provider: string;
  mockWebhookSecret: string;
  mockPayUrlBase?: string;
  midtransServerKey?: string;
  midtransProduction?: boolean;
  midtransAcquirer?: string;
  xenditSecretKey?: string;
  xenditCallbackToken?: string;
}

export function createPaymentProvider(env: PaymentEnv): PaymentProvider {
  switch (env.provider) {
    case 'midtrans':
      return new MidtransProvider({ serverKey: env.midtransServerKey ?? '', production: !!env.midtransProduction, acquirer: env.midtransAcquirer });
    case 'xendit':
      return new XenditProvider({ secretKey: env.xenditSecretKey ?? '', callbackToken: env.xenditCallbackToken ?? '' });
    case 'mock':
    default:
      return new MockPaymentProvider({ webhookSecret: env.mockWebhookSecret, payUrlBase: env.mockPayUrlBase });
  }
}
