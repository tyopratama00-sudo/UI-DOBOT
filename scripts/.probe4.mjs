import { chromium } from '@playwright/test';
const b = await chromium.launch({ channel: process.env.CH || 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const ctx = await b.newContext({ permissions: ['camera'] });
const p = await ctx.newPage();
await p.goto('http://localhost:8080/api/health');
const r = await p.evaluate(async () => {
  const log = [];
  const s = await navigator.mediaDevices.getUserMedia({ video: true });
  const t = s.getVideoTracks()[0];
  window.__keep = s;
  t.addEventListener('ended', () => log.push('ended at ' + Math.round(performance.now())));
  log.push('opened at ' + Math.round(performance.now()) + ' ' + t.readyState);
  await new Promise((r) => setTimeout(r, 5000));
  log.push('after 5s: ' + t.readyState);
  const v = document.createElement('video'); v.muted = true; v.srcObject = s; document.body.appendChild(v); try { await v.play(); log.push('play ok ' + v.videoWidth); } catch (e) { log.push('play err ' + e.name); }
  return log;
});
console.log(r);
await b.close();
