import { chromium } from '@playwright/test';
const b = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await b.newContext({ permissions: ['camera'] });
for (const url of ['http://localhost:8080/api/health', 'http://localhost:8080/']) {
  const p = await ctx.newPage();
  await p.goto(url);
  await p.waitForTimeout(500);
  const r = await p.evaluate(async () => {
    const out = {};
    const tryIt = async (name, c) => { try { const s = await navigator.mediaDevices.getUserMedia(c); out[name] = 'ok'; s.getTracks().forEach(t => t.stop()); } catch (e) { out[name] = e.name; } };
    await tryIt('plain', { video: true });
    await tryIt('undef', { audio: false, video: { deviceId: undefined } });
    await tryIt('ideal', { audio: false, video: { width: { ideal: 1920 } } });
    out.devices = (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput').length;
    return out;
  });
  console.log(url, JSON.stringify(r));
  await p.close();
}
await b.close();
