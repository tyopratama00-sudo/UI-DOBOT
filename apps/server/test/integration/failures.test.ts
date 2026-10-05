import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { admin, adminToken, BoothClient, createTestApp, type TestApp } from './helpers';

let t: TestApp;
let tok: string;
beforeAll(async () => {
  t = await createTestApp({ PHOTO_ANGLES: '2', SHOTS_PER_ANGLE: '1' });
  tok = await adminToken(t.app);
});
afterAll(async () => {
  await t?.close();
});
beforeEach(async () => {
  t.ctx.hardware.mockPrinter!.simulateFault(null);
  t.ctx.hardware.mockRobot!.simulateFault(null);
  t.ctx.hardware.camera!.simulateFailure(null);
  t.ctx.hardware.mockPayment!.simulateUnavailable(false);
  t.ctx.health.invalidatePaymentCache();
  await t.ctx.health.refresh();
});

async function toFinal(b: BoothClient) {
  await b.start();
  await b.pay(t.ctx);
  await b.ok({ type: 'begin' });
  await b.captureAll();
  await b.ok({ type: 'choose_frame' });
  const s = await b.ok({ type: 'frame', templateId: 'duo-mini' });
  await b.ok({ type: 'photos', photoIds: s.photos.slice(0, 2).map((p) => p.id) });
  return b.ok({ type: 'edit_done', slots: [] });
}

describe('failure handling', () => {
  it('printer failure: customer still gets the QR, job retries, admin retry completes', async () => {
    const b = new BoothClient(t.app);
    await toFinal(b);
    t.ctx.hardware.mockPrinter!.simulateFault('fail_next');
    await b.ok({ type: 'confirm' });
    const s = await b.waitFor((x) => x.status === 'QR_READY', 'QR after print failure');
    expect(s.print?.status).toMatch(/RETRYING|FAILED|PRINTING|COMPLETED/);
    const events = await t.prisma.sessionEvent.findMany({ where: { sessionId: b.id } });
    expect(events.map((e) => e.toStatus)).toContain('PRINT_FAILED');
    expect(await t.prisma.deviceEvent.count({ where: { device: 'printer', event: 'print_failed' } })).toBeGreaterThan(0);
    const job = await t.prisma.printJob.findFirstOrThrow({ where: { sessionId: b.id } });
    await admin(t.app, tok, 'POST', `/api/admin/print-jobs/${job.id}/retry`);
    const done = await b.waitFor((x) => x.print?.status === 'COMPLETED', 'retried job completed');
    expect(done.print?.progress).toBe(100);
  });

  it('printer offline/paper empty blocks new sessions (maintenance) and recovers', async () => {
    t.ctx.hardware.mockPrinter!.simulateFault('paper_out');
    const h = await t.ctx.health.refresh();
    expect(h.acceptingSessions).toBe(false);
    expect(h.components.printer.status).toBe('down');
    const r = await t.app.inject({ method: 'POST', url: '/api/sessions', headers: { 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.body).error.code).toBe('MAINTENANCE');
    t.ctx.hardware.mockPrinter!.simulateFault(null);
    await t.ctx.health.refresh();
    expect((await t.app.inject({ method: 'POST', url: '/api/sessions', headers: { 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(201);
  });

  it('robot timeout: capture continues in degraded mode and is logged', async () => {
    const b = new BoothClient(t.app);
    await b.start();
    await b.pay(t.ctx);
    await b.ok({ type: 'begin' });
    t.ctx.hardware.mockRobot!.simulateFault('timeout');
    const s = await b.ok({ type: 'move', angle: 0 });
    expect(s.status).toBe('POSE_GUIDANCE');
    expect(await t.prisma.deviceEvent.count({ where: { device: 'robot', event: 'robot_move_failed', sessionId: b.id } })).toBe(1);
    const arrived = await t.prisma.sessionEvent.findFirstOrThrow({ where: { sessionId: b.id, event: 'ROBOT_ARRIVED' } });
    expect(arrived.data).toMatchObject({ degraded: true });
  });

  it('camera failure: retries go back to pose guidance, then ERROR; admin can resume', async () => {
    const b = new BoothClient(t.app);
    await b.start();
    await b.pay(t.ctx);
    await b.ok({ type: 'begin' });
    await b.ok({ type: 'move', angle: 0 });
    t.ctx.hardware.camera!.simulateFailure('capture');
    for (let i = 0; i < 3; i++) {
      await b.ok({ type: 'countdown', angle: 0, shot: 0 });
      const r = await b.cmd({ type: 'capture', angle: 0, shot: 0 });
      expect(r.status).toBe(502);
      expect(r.json.error.userMessage).toContain('Foto gagal');
    }
    expect((await b.get()).status).toBe('ERROR');
    t.ctx.hardware.camera!.simulateFailure(null);
    expect((await admin(t.app, tok, 'POST', `/api/admin/sessions/${b.id}/resume`, { target: 'READY' })).status).toBe(200);
    const s = await b.captureAll();
    expect(s.status).toBe('REVIEW');
  });

  it('payment failure, expiry and API outage are recoverable', async () => {
    const b = new BoothClient(t.app);
    await b.start();
    await b.pay(t.ctx, 1, 'FAILED');
    expect((await b.get()).status).toBe('PAYMENT_FAILED');
    await b.ok({ type: 'retry_payment' });
    await b.pay(t.ctx, 1, 'EXPIRED');
    expect((await b.get()).status).toBe('PAYMENT_FAILED');
    t.ctx.hardware.mockPayment!.simulateUnavailable(true);
    await b.ok({ type: 'retry_payment' });
    const r = await b.req('POST', `/api/sessions/${b.id}/payment`, { quantity: 1 });
    expect(r.status).toBe(503);
    expect(r.json.error).toMatchObject({ code: 'PAYMENT_API_UNAVAILABLE', retryable: true });
    t.ctx.hardware.mockPayment!.simulateUnavailable(false);
    await b.pay(t.ctx, 1, 'PAID');
    expect((await b.get()).status).toBe('PAYMENT_SUCCESS');
  });

  it('webhooks: bad signature rejected, amount mismatch ignored, late payment after cancel flagged for refund', async () => {
    const b = new BoothClient(t.app);
    await b.start();
    await b.req('POST', `/api/sessions/${b.id}/payment`, { quantity: 1 });
    const p = await t.prisma.payment.findFirstOrThrow({ where: { sessionId: b.id, status: 'PENDING' } });
    const forged = await t.app.inject({ method: 'POST', url: '/api/payments/webhook/mock', headers: { 'content-type': 'application/json', 'x-mock-signature': 'deadbeef' }, payload: JSON.stringify({ orderId: p.orderId, status: 'PAID', amount: p.amount }) });
    expect(forged.statusCode).toBe(401);
    const cheap = t.ctx.hardware.mockPayment!.buildWebhook(p.orderId, 'PAID', 1000);
    await t.app.inject({ method: 'POST', url: '/api/payments/webhook/mock', headers: cheap.headers, payload: cheap.rawBody });
    expect((await b.get()).status).toBe('WAITING_PAYMENT');
    expect(await t.prisma.deviceEvent.count({ where: { event: 'payment_amount_mismatch' } })).toBe(1);
    // the booth cancels (timeout) — then the real payment arrives late
    await b.ok({ type: 'cancel' });
    expect((await b.get()).status).toBe('CANCELLED');
    const late = t.ctx.hardware.mockPayment!.buildWebhook(p.orderId, 'PAID', p.amount);
    expect((await t.app.inject({ method: 'POST', url: '/api/payments/webhook/mock', headers: late.headers, payload: late.rawBody })).statusCode).toBe(200);
    expect((await t.prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('PAID');
    expect(await t.prisma.deviceEvent.count({ where: { event: 'payment_after_cancel' } })).toBe(1);
    expect((await t.prisma.webhookEvent.findMany()).some((w) => !w.signatureValid)).toBe(true);
  });

  it('paid session timeout: auto-complete prints a sensible default', async () => {
    const b = new BoothClient(t.app);
    await b.start();
    await b.pay(t.ctx, 2);
    await b.ok({ type: 'begin' });
    await b.captureAll();
    const s = await b.ok({ type: 'auto_complete' });
    expect(s.status).toBe('RENDERING');
    const done = await b.waitFor((x) => x.status === 'QR_READY', 'auto complete');
    // only 2 photos in this plan → the largest frame that fits (Duo Mini) is used
    expect(done.templateId).toBe('duo-mini');
    expect(done.slots).toHaveLength(2);
    const row = await t.prisma.session.findUniqueOrThrow({ where: { id: b.id } });
    expect(row.autoCompleted).toBe(true);
  });

  it('unpaid sessions expire server-side', async () => {
    const b = new BoothClient(t.app);
    await b.start();
    await b.req('POST', `/api/sessions/${b.id}/payment`, { quantity: 1 });
    await t.prisma.session.update({ where: { id: b.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await t.ctx.reaper.tick();
    expect((await b.get()).status).toBe('EXPIRED');
  });
});
