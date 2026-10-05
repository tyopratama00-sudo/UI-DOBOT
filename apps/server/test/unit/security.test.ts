import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { hashPassword, jwtSign, jwtVerify, randomToken, sessionCode, signMedia, verifyMedia, verifyPassword } from '../../src/util/crypto';
import { buildMockQris, crc16ccitt, MidtransProvider, MockPaymentProvider, WebhookValidationError, XenditProvider } from '@photobooth/payments';
import { LocalStorageProvider, sanitizeKey, StorageKeyError } from '@photobooth/storage';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

describe('gallery / session tokens', () => {
  it('are random, URL-safe and 192-bit', () => {
    const tokens = new Set(Array.from({ length: 2000 }, () => randomToken(24)));
    expect(tokens.size).toBe(2000);
    for (const t of [...tokens].slice(0, 50)) {
      expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    }
  });
  it('session codes are not sequential and avoid ambiguous characters', () => {
    const codes = Array.from({ length: 500 }, sessionCode);
    expect(new Set(codes).size).toBeGreaterThan(495);
    for (const c of codes) expect(c).toMatch(/^RPB-[A-HJ-NP-Z2-9]{6}$/);
  });
});

describe('signed media URLs', () => {
  it('verify only with the right key, signature and before expiry', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const sig = signMedia('sessions/a/x.jpg', exp, 'secret');
    expect(verifyMedia('sessions/a/x.jpg', exp, sig, 'secret')).toBe(true);
    expect(verifyMedia('sessions/b/x.jpg', exp, sig, 'secret')).toBe(false);
    expect(verifyMedia('sessions/a/x.jpg', exp, sig, 'other')).toBe(false);
    expect(verifyMedia('sessions/a/x.jpg', exp - 120, signMedia('sessions/a/x.jpg', exp - 120, 'secret'), 'secret')).toBe(false);
  });
});

describe('admin authentication primitives', () => {
  it('hashes passwords with scrypt and verifies them', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('signs and verifies JWTs, rejecting tampering and expiry', () => {
    const t = jwtSign({ sub: '1', name: 'admin' }, 's', 60);
    expect(jwtVerify(t, 's')?.name).toBe('admin');
    expect(jwtVerify(t, 'x')).toBeNull();
    const [h, , sig] = t.split('.');
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: '1', name: 'root', iat: 0, exp: 9e9 })).toString('base64url')}.${sig}`;
    expect(jwtVerify(forged, 's')).toBeNull();
    expect(jwtVerify(jwtSign({ sub: '1', name: 'a' }, 's', -10), 's')).toBeNull();
  });
});

describe('payment webhook validation', () => {
  it('mock provider accepts only correctly signed webhooks', async () => {
    const p = new MockPaymentProvider({ webhookSecret: 'whsec' });
    await p.createPayment({ orderId: 'RPB-1', amount: 65000, currency: 'IDR', description: 't', expiresInSeconds: 60 });
    const ok = p.buildWebhook('RPB-1', 'PAID', 65000);
    const r = await p.handleWebhook({ headers: ok.headers, body: undefined, rawBody: ok.rawBody });
    expect(r.status).toBe('PAID');
    expect((await p.checkPayment('x', 'RPB-1')).status).toBe('PAID');
    await expect(p.handleWebhook({ headers: { 'x-mock-signature': 'bad' }, body: undefined, rawBody: ok.rawBody })).rejects.toBeInstanceOf(WebhookValidationError);
    const tampered = ok.rawBody.replace('65000', '1000');
    await expect(p.handleWebhook({ headers: ok.headers, body: undefined, rawBody: tampered })).rejects.toBeInstanceOf(WebhookValidationError);
  });
  it('midtrans signature is sha512(order_id+status_code+gross_amount+serverKey)', async () => {
    const p = new MidtransProvider({ serverKey: 'SB-key', production: false });
    const body = { order_id: 'RPB-1', status_code: '200', gross_amount: '65000.00', transaction_id: 't', transaction_status: 'settlement' };
    const bad = { ...body, signature_key: 'nope' };
    await expect(p.handleWebhook({ headers: {}, body: bad, rawBody: JSON.stringify(bad) })).rejects.toBeInstanceOf(WebhookValidationError);
    const good = { ...body, signature_key: createHash('sha512').update('RPB-120065000.00SB-key').digest('hex') };
    // Signature passes; the provider then re-checks the status with the gateway (network) — stub it.
    (p as unknown as { checkPayment: () => Promise<unknown> }).checkPayment = async () => ({ status: 'PAID', amount: 65000, raw: {} });
    expect((await p.handleWebhook({ headers: {}, body: good, rawBody: JSON.stringify(good) })).status).toBe('PAID');
    expect(MidtransProvider.mapStatus('expire')).toBe('EXPIRED');
    expect(MidtransProvider.mapStatus('capture', 'challenge')).toBe('PENDING');
  });
  it('xendit requires the callback token', async () => {
    const p = new XenditProvider({ secretKey: 'xnd', callbackToken: 'tok' });
    const body = { event: 'qr.payment', data: { qr_id: 'qr_1', reference_id: 'RPB-1', status: 'SUCCEEDED', amount: 65000 } };
    await expect(p.handleWebhook({ headers: { 'x-callback-token': 'nope' }, body, rawBody: JSON.stringify(body) })).rejects.toBeInstanceOf(WebhookValidationError);
    const r = await p.handleWebhook({ headers: { 'x-callback-token': 'tok' }, body, rawBody: JSON.stringify(body) });
    expect(r).toMatchObject({ orderId: 'RPB-1', status: 'PAID', amount: 65000 });
  });
  it('mock QRIS payload carries a valid CRC16', () => {
    const q = buildMockQris('RPB-ABC-1', 80000);
    expect(q.slice(-4)).toBe(crc16ccitt(q.slice(0, -4)));
    expect(q).toContain('540580000');
  });
});

describe('storage path sanitization', () => {
  it('rejects traversal, absolute paths and odd characters', () => {
    for (const bad of ['../etc/passwd', 'a/../../b', '/abs/x', 'C:/x', 'a//b', 'a/./b', 'a/b c', '', '.hidden']) {
      expect(() => sanitizeKey(bad)).toThrow(StorageKeyError);
    }
    expect(sanitizeKey('sessions\\abc\\x.jpg')).toBe('sessions/abc/x.jpg');
  });
  it('writes atomically inside the root and reads back', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pb-store-'));
    const s = new LocalStorageProvider(dir);
    await s.put('a/b/c.txt', Buffer.from('hello'));
    expect((await s.getBuffer('a/b/c.txt')).toString()).toBe('hello');
    expect(await s.exists('a/b/c.txt')).toBe(true);
    expect((await s.health()).ok).toBe(true);
    await s.delete('a/b/c.txt');
    expect(await s.exists('a/b/c.txt')).toBe(false);
    expect(() => s.resolve('../outside')).toThrow();
  });
});
