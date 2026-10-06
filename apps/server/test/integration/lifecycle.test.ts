import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { BoothClient, createTestApp, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t?.close();
});

describe('session lifecycle (payment → capture → selection → render → print → gallery)', () => {
  it('refuses capture before payment', async () => {
    const b = new BoothClient(t.app);
    await b.start();
    const r = await b.cmd({ type: 'move', angle: 0 });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('INVALID_TRANSITION');
    expect(r.json.error.userMessage).toBeTruthy();
    expect(JSON.stringify(r.json)).not.toMatch(/at .*\.ts:\d+/); // no stack traces
  });

  it('rejects unauthenticated session access', async () => {
    const b = new BoothClient(t.app);
    await b.start();
    b.token = 'wrong';
    expect((await b.req('GET', `/api/sessions/${b.id}`)).status).toBe(401);
  });

  it('runs the full customer journey', async () => {
    const b = new BoothClient(t.app);
    const s0 = await b.start();
    expect(s0.status).toBe('SELECT_PRINT');
    expect(s0.plan).toMatchObject({ angles: 3, shotsPerAngle: 2, retakeLimit: 2 });

    // quantity change → a new dynamic QR replaces the old one
    await b.req('POST', `/api/sessions/${b.id}/payment`, { quantity: 1 });
    const { webhookStatus, payment } = await b.pay(t.ctx, 3);
    expect(webhookStatus).toBe(200);
    expect(payment.amount).toBe(95000);
    const payments = await t.prisma.payment.findMany({ where: { sessionId: b.id }, orderBy: { createdAt: 'asc' } });
    expect(payments.map((p) => p.status)).toEqual(['CANCELLED', 'PAID']);
    let s = await b.get();
    expect(s.status).toBe('PAYMENT_SUCCESS');
    expect(s.amount).toBe(95000);
    expect(s.quantity).toBe(3);

    // repeated clicks: same request id is idempotent, a second BEGIN is rejected
    const rid = randomUUID();
    expect((await b.cmd({ type: 'begin' }, rid)).status).toBe(200);
    expect((await b.cmd({ type: 'begin' }, rid)).status).toBe(200);
    expect((await b.cmd({ type: 'begin' })).status).toBe(409);

    s = await b.captureAll();
    expect(s.status).toBe('REVIEW');
    expect(s.photos).toHaveLength(6);
    for (const p of await t.prisma.photo.findMany({ where: { sessionId: b.id } })) {
      expect(await t.ctx.store.exists(p.originalPath)).toBe(true);
      expect(await t.ctx.store.exists(p.thumbnailPath!)).toBe(true);
    }

    // retake: max 2 angles, never the same angle twice, originals are kept
    s = await b.ok({ type: 'retake', angle: 1 });
    expect(s.status).toBe('RETAKE');
    s = await b.captureAll(1);
    expect(s.status).toBe('REVIEW');
    const angle1 = s.photos.filter((p) => p.angle === 1);
    expect(angle1).toHaveLength(4);
    expect(angle1.filter((p) => p.selected)).toHaveLength(2);
    expect(angle1.filter((p) => p.retaken)).toHaveLength(2);
    expect((await b.cmd({ type: 'retake', angle: 1 })).status).toBe(400);
    await b.ok({ type: 'retake', angle: 2 });
    await b.captureAll(2);
    expect((await b.cmd({ type: 'retake', angle: 0 })).status).toBe(400); // limit reached
    // pick 1 old + 1 new on angle 1 ("pilih 2 dari 4")
    s = await b.ok({ type: 'select_angle', angle: 1, photoIds: [angle1[0].id, angle1[3].id] });
    const a1 = s.photos.filter((p) => p.angle === 1);
    expect(a1.filter((p) => p.selected).map((p) => p.id)).toEqual([angle1[0].id, angle1[3].id]);
    expect(a1.filter((p) => p.superseded)).toHaveLength(2);
    expect(await t.prisma.photo.count({ where: { sessionId: b.id } })).toBe(10); // nothing deleted

    // frame + photos + edit
    await b.ok({ type: 'choose_frame' });
    s = await b.ok({ type: 'frame', templateId: 'kotak-ceria' });
    expect(s.status).toBe('PHOTO_SELECTION');
    const active = s.photos.filter((p) => p.selected);
    expect((await b.cmd({ type: 'photos', photoIds: active.slice(0, 3).map((p) => p.id) })).status).toBe(400);
    const superseded = s.photos.find((p) => p.superseded)!;
    expect((await b.cmd({ type: 'photos', photoIds: [superseded.id, ...active.slice(0, 3).map((p) => p.id)] })).status).toBe(400);
    s = await b.ok({ type: 'photos', photoIds: active.slice(0, 4).map((p) => p.id) });
    expect(s.status).toBe('EDITING');
    expect(s.slots).toHaveLength(4);
    const edit = { x: 0.1, y: 0, zoom: 1.3, rotation: 15, flipHorizontal: true, brightness: 1.2, filter: 'warm' as const };
    await b.ok({ type: 'edits', slots: [{ slotIndex: 0, edit }] });
    s = await b.ok({ type: 'edit_done', slots: [{ slotIndex: 0, edit }] });
    expect(s.status).toBe('FINAL_PREVIEW');
    expect(s.slots[0].edit).toEqual(edit);
    const dbEdit = await t.prisma.edit.findFirstOrThrow({ where: { sessionId: b.id, slotIndex: 0 } });
    expect(dbEdit.crop).toBeTruthy();

    // concurrent double-confirm: exactly one print job
    const results = await Promise.all([1, 2, 3, 4].map(() => b.cmd({ type: 'confirm' })));
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    s = await b.waitFor((x) => x.status === 'QR_READY', 'QR_READY');
    const jobs = await t.prisma.printJob.findMany({ where: { sessionId: b.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'COMPLETED', copies: 3 });

    // high-resolution composite & print page
    const row = await t.prisma.session.findUniqueOrThrow({ where: { id: b.id } });
    const page = await sharp(await t.ctx.store.getBuffer(row.printFilePath!)).metadata();
    expect([page.width, page.height, page.density, page.format]).toEqual([1200, 1800, 300, 'jpeg']);
    const comp = await sharp(await t.ctx.store.getBuffer(row.compositePath!)).metadata();
    expect(comp.width).toBeGreaterThan(1000);

    // gallery: real URL with an unguessable token
    expect(s.gallery?.url).toMatch(/^https:\/\/photo\.example\.com\/g\/[A-Za-z0-9_-]{32}$/);
    const token = s.gallery!.url.split('/g/')[1];
    const html = await t.app.inject({ method: 'GET', url: `/g/${token}` });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('Foto digitalmu');
    expect(html.headers['x-robots-tag']).toBe('noindex');
    const frame = await t.app.inject({ method: 'GET', url: `/g/${token}/frame?download=1` });
    expect(frame.statusCode).toBe(200);
    expect(frame.headers['content-disposition']).toContain('attachment');
    const p0 = s.photos[0];
    expect((await t.app.inject({ method: 'GET', url: `/g/${token}/p/${p0.id}/original` })).statusCode).toBe(200);
    const zip = await t.app.inject({ method: 'GET', url: `/g/${token}/zip` });
    expect(zip.statusCode).toBe(200);
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe('PK');

    s = await b.ok({ type: 'finish' });
    expect(s.status).toBe('FINISHED');

    const events = await t.prisma.sessionEvent.findMany({ where: { sessionId: b.id } });
    expect(events.length).toBeGreaterThan(40);
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['START', 'PAYMENT_CONFIRMED', 'CAPTURE_OK', 'START_RETAKE', 'CONFIRM', 'PRINT_DONE', 'GALLERY_READY', 'FINISH']));
  });

  it('webcam mode: accepts uploaded frames (multipart) idempotently', async () => {
    const b = new BoothClient(t.app);
    await b.start();
    await b.pay(t.ctx);
    await b.ok({ type: 'begin' });
    await b.ok({ type: 'move', angle: 0 });
    await b.ok({ type: 'countdown', angle: 0, shot: 0 });
    const jpeg = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#88aaff' } }).jpeg().toBuffer();
    const boundary = '----pbtest';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="angle"\r\n\r\n0\r\n--${boundary}\r\nContent-Disposition: form-data; name="shot"\r\n\r\n0\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      jpeg,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const send = (rid: string) =>
      t.app.inject({ method: 'POST', url: `/api/sessions/${b.id}/photos`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-session-token': b.token, 'x-request-id': rid }, payload: body });
    const rid = randomUUID();
    const r1 = await send(rid);
    expect(r1.statusCode).toBe(200);
    const r2 = await send(rid); // network retry of the same upload
    expect(r2.statusCode).toBe(200);
    expect(JSON.parse(r2.body).photos).toHaveLength(1);
    expect(JSON.parse(r2.body).status).toBe('CAPTURE_SUCCESS');
    // garbage upload is rejected
    await b.ok({ type: 'next_shot' });
    await b.ok({ type: 'countdown', angle: 0, shot: 1 });
    const bad = await t.app.inject({
      method: 'POST',
      url: `/api/sessions/${b.id}/photos`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-session-token': b.token },
      payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="angle"\r\n\r\n0\r\n--${boundary}\r\nContent-Disposition: form-data; name="shot"\r\n\r\n1\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\nnot an image\r\n--${boundary}--\r\n`),
    });
    expect(bad.statusCode).toBe(422);
    expect((await b.get()).status).toBe('POSE_GUIDANCE'); // capture failed → back to pose guidance
  });

  it('skip_angles: refused without photos, jumps to review once some exist', async () => {
    const b = new BoothClient(t.app);
    await b.start();
    await b.pay(t.ctx);
    await b.ok({ type: 'begin' });
    expect((await b.cmd({ type: 'skip_angles' })).status).toBe(400);
    await b.ok({ type: 'move', angle: 0 });
    await b.ok({ type: 'countdown', angle: 0, shot: 0 });
    await b.ok({ type: 'capture', angle: 0, shot: 0 });
    const s = await b.ok({ type: 'skip_angles' });
    expect(s.status).toBe('REVIEW');
    expect(s.photos.length).toBe(1);
  });
});
