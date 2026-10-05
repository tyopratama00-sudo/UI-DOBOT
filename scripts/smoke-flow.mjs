#!/usr/bin/env node
/**
 * End-to-end API smoke test against a running server in MOCK mode
 * (PAYMENT_PROVIDER=mock, CAMERA_DRIVER=mock, ROBOT_DRIVER=mock, PRINTER_DRIVER=mock).
 *
 *   node scripts/smoke-flow.mjs [baseUrl]
 *
 * Walks the whole customer journey exactly like the booth does:
 * session → QRIS payment (signed mock webhook) → 10×2 captures → retake →
 * frame → photos → edit → confirm → print job → gallery → ZIP → finish.
 */
const BASE = process.argv[2] || process.env.SMOKE_URL || 'http://localhost:8080';
let token = '';
let id = '';
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

async function call(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-session-token': token } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${typeof json === 'string' ? json.slice(0, 200) : JSON.stringify(json)}`);
  return json;
}
const cmd = (c) => call('POST', `/api/sessions/${id}/commands`, c, { 'x-request-id': crypto.randomUUID() });
const waitFor = async (pred, label, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) {
    const s = await call('GET', `/api/sessions/${id}`);
    if (pred(s)) return s;
    if (Date.now() > end) throw new Error(`Timeout waiting for ${label} (status ${s.status})`);
    await new Promise((r) => setTimeout(r, 400));
  }
};

const health = await call('GET', '/api/booth/health');
log('health', health.acceptingSessions ? 'accepting sessions' : 'NOT accepting', Object.entries(health.components).map(([k, v]) => `${k}:${v.status}`).join(' '));

const created = await call('POST', '/api/sessions', {});
token = created.token;
id = created.session.id;
log('session', created.session.code, created.session.status);

let s = await call('POST', `/api/sessions/${id}/payment`, { quantity: 1 });
s = await call('POST', `/api/sessions/${id}/payment`, { quantity: 2 }, { 'x-request-id': crypto.randomUUID() });
log('payment', s.payment.amount, s.status, s.payment.qrString.slice(0, 60));

const orderId = decodeURIComponent(s.payment.qrString.split('/mock-pay/')[1] || '');
await call('POST', `/mock-pay/${encodeURIComponent(orderId)}`, { status: 'PAID' });
s = await waitFor((x) => x.status === 'PAYMENT_SUCCESS', 'payment success');
log('paid', s.status, s.amount);

s = await cmd({ type: 'begin' });
const { angles, shotsPerAngle } = s.plan;
for (let a = 0; a < angles; a++) {
  s = await cmd({ type: 'move', angle: a });
  for (let k = 0; k < shotsPerAngle; k++) {
    await cmd({ type: 'countdown', angle: a, shot: k });
    s = await cmd({ type: 'capture', angle: a, shot: k });
    s = await cmd({ type: k + 1 < shotsPerAngle ? 'next_shot' : 'angle_done' });
  }
}
log('captured', s.photos.length, 'photos →', s.status);

// Retake angle 3 and choose one new + one old photo
s = await cmd({ type: 'retake', angle: 2 });
s = await cmd({ type: 'move', angle: 2 });
for (let k = 0; k < shotsPerAngle; k++) {
  await cmd({ type: 'countdown', angle: 2, shot: k });
  s = await cmd({ type: 'capture', angle: 2, shot: k });
  s = await cmd({ type: k + 1 < shotsPerAngle ? 'next_shot' : 'angle_done' });
}
const a2 = s.photos.filter((p) => p.angle === 2);
s = await cmd({ type: 'select_angle', angle: 2, photoIds: [a2[0].id, a2[a2.length - 1].id] });
log('retake done', a2.length, 'photos on angle 3 →', s.status, 'retaken:', s.retakenAngles);

s = await cmd({ type: 'choose_frame' });
s = await cmd({ type: 'frame', templateId: 'kotak-ceria' });
const active = s.photos.filter((p) => p.selected).sort((x, y) => x.angle - y.angle || x.shot - y.shot);
s = await cmd({ type: 'photos', photoIds: [active[0].id, active[5].id, active[10].id, active[19].id] });
s = await cmd({
  type: 'edit_done',
  slots: [
    { slotIndex: 0, edit: { x: 0.1, y: -0.05, zoom: 1.3, rotation: 12, flipHorizontal: true, brightness: 1.2, filter: 'warm' } },
    { slotIndex: 1, edit: { x: 0, y: 0, zoom: 1, rotation: 90, flipHorizontal: false, brightness: 1, filter: 'mono' } },
    { slotIndex: 2, edit: { x: 0, y: 0, zoom: 0.7, rotation: 0, flipHorizontal: false, brightness: 0.8, filter: 'cool' } },
    { slotIndex: 3, edit: { x: -0.2, y: 0.1, zoom: 1.5, rotation: -20, flipHorizontal: false, brightness: 1, filter: 'soft' } },
  ],
});
log('edits saved →', s.status);
s = await cmd({ type: 'confirm' });
log('confirmed →', s.status);
s = await waitFor((x) => x.status === 'QR_READY', 'QR_READY', 120000);
log('print', s.print?.status, s.print?.progress + '%', '→ gallery', s.gallery?.url);

const page = await fetch(s.gallery.url.replace(/^https?:\/\/[^/]+/, BASE));
const html = await page.text();
const zip = await fetch(s.gallery.url.replace(/^https?:\/\/[^/]+/, BASE) + '/zip');
const zipBytes = (await zip.arrayBuffer()).byteLength;
const frame = await fetch(s.gallery.url.replace(/^https?:\/\/[^/]+/, BASE) + '/frame');
const frameBytes = (await frame.arrayBuffer()).byteLength;
log('gallery page', page.status, html.length, 'bytes · frame', frame.status, frameBytes, 'bytes · zip', zip.status, zipBytes, 'bytes');

s = await cmd({ type: 'finish' });
log('finished →', s.status);
if (s.status !== 'FINISHED' || page.status !== 200 || zip.status !== 200 || frame.status !== 200) process.exit(1);
console.log(`SMOKE OK · session ${s.code} · ${s.photos.length} photos · gallery ${s.gallery.url}`);
