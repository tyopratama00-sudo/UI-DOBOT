import { chromium } from '@playwright/test';
const B = 'http://localhost:8080';
const login = await (await fetch(B + '/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin12345' }) })).json();
const h = { authorization: 'Bearer ' + login.token, 'content-type': 'application/json' };
await fetch(B + '/api/admin/settings/camera', { method: 'PUT', headers: h, body: JSON.stringify({ value: { driver: 'webcam' } }) });
const b = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await b.newContext({ permissions: ['camera'], viewport: { width: 1920, height: 1080 } });
const p = await ctx.newPage();
await p.addInitScript(() => {
  const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  let n = 0;
  const where = () => (new Error().stack || '').split('\n').slice(2, 5).map((l) => l.trim()).join(' | ');
  navigator.mediaDevices.getUserMedia = async (c) => {
    const id = ++n;
    console.log(`gUM#${id} ${JSON.stringify(c)} ${where()}`);
    const s = await orig(c);
    s.getTracks().forEach((t) => {
      t.addEventListener('ended', () => console.log(`ended#${id}`));
      const st = t.stop.bind(t);
      t.stop = () => {
        console.log(`stop#${id} ${where()}`);
        st();
      };
    });
    console.log(`gUM#${id} ok`);
    return s;
  };
});
p.on('console', (m) => !/Failed to load/.test(m.text()) && console.log('[console]', m.type(), m.text()));
await p.goto(B + '/');
await p.waitForTimeout(12500);
const d = await (await fetch(B + '/api/admin/diagnostics', { headers: h })).json();
console.log('browser camera', JSON.stringify(d.camera.browser));
await b.close();
await fetch(B + '/api/admin/settings/camera', { method: 'DELETE', headers: h });
