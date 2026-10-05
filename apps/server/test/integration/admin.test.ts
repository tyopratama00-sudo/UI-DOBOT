import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, adminToken, BoothClient, createTestApp, type TestApp } from './helpers';

let t: TestApp;
let tok: string;
let finished: BoothClient;
beforeAll(async () => {
  t = await createTestApp({ PHOTO_ANGLES: '2', SHOTS_PER_ANGLE: '1' });
  tok = await adminToken(t.app);
  finished = new BoothClient(t.app);
  await finished.start();
  await finished.pay(t.ctx);
  await finished.ok({ type: 'begin' });
  await finished.captureAll();
  await finished.ok({ type: 'auto_complete' });
  await finished.waitFor((s) => s.status === 'QR_READY', 'qr');
});
afterAll(async () => {
  await t?.close();
});

describe('admin panel API', () => {
  it('requires authentication', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/admin/dashboard' })).statusCode).toBe(401);
    const bad = await t.app.inject({ method: 'POST', url: '/api/admin/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ username: 'admin', password: 'nope' }) });
    expect(bad.statusCode).toBe(401);
    const ok = await t.app.inject({ method: 'POST', url: '/api/admin/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ username: 'admin', password: 'test-password-123' }) });
    expect(ok.statusCode).toBe(200);
    expect(String(ok.headers['set-cookie'])).toMatch(/pb_admin=.*HttpOnly.*SameSite=Strict/i);
  });

  it('dashboard reports today stats and health', async () => {
    const d = await admin(t.app, tok, 'GET', '/api/admin/dashboard');
    expect(d.status).toBe(200);
    expect(d.json.today.sessions).toBeGreaterThanOrEqual(1);
    expect(d.json.today.revenue).toBe(65000);
    expect(d.json.today.photos).toBe(2);
    expect(d.json.health.components).toHaveProperty('printer');
  });

  it('lists sessions and shows details with payments, photos, gallery QR', async () => {
    const list = await admin(t.app, tok, 'GET', '/api/admin/sessions?q=RPB');
    expect(list.json.items.length).toBeGreaterThanOrEqual(1);
    const d = await admin(t.app, tok, 'GET', `/api/admin/sessions/${finished.id}`);
    expect(d.json.payments[0].status).toBe('PAID');
    expect(d.json.gallery.qrSvg).toContain('<svg');
    expect(Object.keys(d.json.originals)).toHaveLength(2);
    const media = await t.app.inject({ method: 'GET', url: d.json.compositeUrl });
    expect(media.statusCode).toBe(200);
  });

  it('reprints, regenerates the gallery link and can cancel', async () => {
    const r = await admin(t.app, tok, 'POST', `/api/admin/sessions/${finished.id}/reprint`, { copies: 2 });
    expect(r.status).toBe(200);
    const job = await t.prisma.printJob.findUniqueOrThrow({ where: { id: r.json.jobId } });
    expect(job).toMatchObject({ isReprint: true, copies: 2 });
    const before = (await finished.get()).gallery!.url.split('/g/')[1];
    const g = await admin(t.app, tok, 'POST', `/api/admin/sessions/${finished.id}/regenerate-gallery`);
    const after = g.json.url.split('/g/')[1];
    expect(after).not.toBe(before);
    expect((await t.app.inject({ method: 'GET', url: `/g/${before}` })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/g/${after}` })).statusCode).toBe(200);
    const b = new BoothClient(t.app);
    await b.start();
    expect((await admin(t.app, tok, 'POST', `/api/admin/sessions/${b.id}/cancel`)).status).toBe(200);
    expect((await b.get()).status).toBe('CANCELLED');
  });

  it('validates and applies configuration (prices flow to the booth config)', async () => {
    expect((await admin(t.app, tok, 'PUT', '/api/admin/settings/pricing', { value: { firstPrint: -5 } })).status).toBe(400);
    expect((await admin(t.app, tok, 'PUT', '/api/admin/settings/templates', { value: [{ id: 'X' }] })).status).toBe(400);
    expect((await admin(t.app, tok, 'PUT', '/api/admin/settings/pricing', { value: { firstPrint: 70000, additionalPrint: 20000 } })).status).toBe(200);
    const cfg = JSON.parse((await t.app.inject({ method: 'GET', url: '/api/booth/config' })).body);
    expect(cfg.pricing).toMatchObject({ firstPrint: 70000, additionalPrint: 20000 });
    expect(JSON.stringify(cfg)).not.toMatch(/secret|password|serverKey/i);
    const b = new BoothClient(t.app);
    await b.start();
    const p = await b.req('POST', `/api/sessions/${b.id}/payment`, { quantity: 2 });
    expect(p.json.amount).toBe(90000);
    await admin(t.app, tok, 'DELETE', '/api/admin/settings/pricing');
    expect(JSON.parse((await t.app.inject({ method: 'GET', url: '/api/booth/config' })).body).pricing.firstPrint).toBe(65000);
  });

  it('diagnostics + hardware tests + mock controls', async () => {
    const d = await admin(t.app, tok, 'GET', '/api/admin/diagnostics');
    expect(d.json.mock).toMatchObject({ payment: true, robot: true, printer: true });
    for (const action of ['camera_connect', 'camera_capture', 'robot_home', 'printer_test', 'payment_test', 'storage_test']) {
      const r = await admin(t.app, tok, 'POST', '/api/admin/diagnostics/test', { action });
      expect(r.json.ok, `${action}: ${r.json.message}`).toBe(true);
    }
    expect((await admin(t.app, tok, 'POST', '/api/admin/diagnostics/test', { action: 'robot_move', angle: 3 })).json.ok).toBe(true);
    expect((await admin(t.app, tok, 'POST', '/api/admin/mock', { target: 'printer', action: 'offline' })).status).toBe(200);
    expect((await t.ctx.hardware.printer.getStatus()).state).toBe('offline');
    await admin(t.app, tok, 'POST', '/api/admin/mock', { target: 'printer', action: 'clear' });
    const b = new BoothClient(t.app);
    await b.start();
    await b.req('POST', `/api/sessions/${b.id}/payment`, { quantity: 1 });
    expect((await admin(t.app, tok, 'POST', '/api/admin/mock', { target: 'payment', action: 'success' })).status).toBe(200);
    expect((await b.get()).status).toBe('PAYMENT_SUCCESS');
    const events = await admin(t.app, tok, 'GET', '/api/admin/events?device=printer');
    expect(events.json.length).toBeGreaterThan(0);
  });
});

describe('gallery & media security', () => {
  it('expired galleries return 410, unknown tokens 404, unsigned media 403', async () => {
    const token = (await finished.get()).gallery!.url.split('/g/')[1];
    await t.prisma.session.update({ where: { id: finished.id }, data: { galleryExpiresAt: new Date(Date.now() - 1000) } });
    const r = await t.app.inject({ method: 'GET', url: `/g/${token}` });
    expect(r.statusCode).toBe(410);
    expect(r.body).toContain('kedaluwarsa');
    expect((await t.app.inject({ method: 'GET', url: `/g/${token}/zip` })).statusCode).toBe(410);
    expect((await t.app.inject({ method: 'GET', url: '/g/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: '/g/../../etc/passwd' })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'GET', url: `/media/sessions/${finished.id}/output/x.jpg` })).statusCode).toBe(403);
  });

  it('booth recovery hands out a fresh token for the active session', async () => {
    const b = new BoothClient(t.app);
    await b.start();
    const old = b.token;
    const r = await t.app.inject({ method: 'GET', url: '/api/booth/active', remoteAddress: '127.0.0.1' });
    const body = JSON.parse(r.body);
    expect(body.session.id).toBe(b.id);
    expect(body.token).not.toBe(old);
    b.token = old;
    expect((await b.req('GET', `/api/sessions/${b.id}`)).status).toBe(401);
    // non-local callers without a device key get nothing
    const remote = await t.app.inject({ method: 'GET', url: '/api/booth/active', remoteAddress: '10.1.2.3' });
    expect(JSON.parse(remote.body).session).toBeNull();
  });
});
