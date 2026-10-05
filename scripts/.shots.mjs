import { chromium } from '@playwright/test';
const OUT = process.argv[2];
const which = process.argv[3] || 'both';
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });

if (which !== 'booth') {
  const p = await browser.newPage({ viewport: { width: 1920, height: 1120 } });
  await p.goto('file:///C:/Users/WELCOME/UI%20Phobot/ROBOT%20PHOTOBOOTH%20%E2%80%93%20UI_UX%20System.html');
  await p.waitForTimeout(1500);
  await p.screenshot({ path: `${OUT}/proto-welcome.png` });
  const names = ['pay', 'ready', 'session', 'review', 'tpl', 'pick', 'edit', 'final', 'print', 'qr', 'thanks'];
  for (let i = 0; i < names.length; i++) {
    await p.evaluate((n) => window.jump(n), i + 1);
    await p.waitForTimeout(names[i] === 'session' ? 5200 : 1400);
    await p.screenshot({ path: `${OUT}/proto-${names[i]}.png` });
  }
  await p.close();
}

if (which !== 'proto') {
  { // cancel leftovers via the admin API
    const r = await fetch("http://localhost:8080/api/admin/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:"admin",password:"admin12345"})});
    const {token} = await r.json(); const h={authorization:"Bearer "+token,"content-type":"application/json"};
    const list = await (await fetch("http://localhost:8080/api/admin/sessions?pageSize=100",{headers:h})).json();
    for (const it of list.items) if (!["FINISHED","CANCELLED","EXPIRED"].includes(it.status)) await fetch("http://localhost:8080/api/admin/sessions/"+it.id+"/cancel",{method:"POST",headers:h,body:"{}"});
  }
  const b = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  b.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && console.log('[console]', m.type(), m.text()));
  b.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await b.goto('http://localhost:8080/?dev');
  await b.waitForSelector('[data-testid=start]', { timeout: 20000 });
  await b.waitForTimeout(1200);
  await b.screenshot({ path: `${OUT}/booth-welcome.png` });
  await b.click('[data-testid=start]');
  await b.waitForSelector('[data-testid=qris] svg', { timeout: 20000 });
  await b.waitForTimeout(1500);
  await b.screenshot({ path: `${OUT}/booth-pay.png` });
  await b.click('[data-testid=qty-plus]');
  await b.waitForTimeout(2000);
  await b.screenshot({ path: `${OUT}/booth-pay2.png` });
  // pay through the mock QR page (same as scanning it with a phone)
  const qr = await b.evaluate(async () => {
    const s = JSON.parse(localStorage.getItem('pb.session'));
    const r = await fetch(`/api/sessions/${s.id}`, { headers: { 'x-session-token': s.token } });
    return (await r.json()).payment.qrString;
  });
  const orderId = decodeURIComponent(qr.split('/mock-pay/')[1]);
  await b.evaluate(async (o) => fetch(`/mock-pay/${encodeURIComponent(o)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'PAID' }) }), orderId);
  await b.waitForSelector('[data-testid=pay-ok]', { timeout: 15000 });
  await b.screenshot({ path: `${OUT}/booth-pay-ok.png` });
  await b.waitForSelector('[data-testid=ready-cd]', { timeout: 15000 });
  await b.waitForTimeout(1500);
  await b.screenshot({ path: `${OUT}/booth-ready.png` });
  await b.waitForSelector('[data-testid=session-angle]', { timeout: 15000 });
  await b.waitForTimeout(3600);
  await b.screenshot({ path: `${OUT}/booth-session.png` });
  await b.waitForTimeout(1300);
  await b.screenshot({ path: `${OUT}/booth-session-cd.png` });
  await b.waitForSelector('[data-screen=review]', { timeout: 240000 });
  await b.waitForTimeout(1500);
  await b.screenshot({ path: `${OUT}/booth-review.png` });
  await b.click('[data-testid=review-next]');
  await b.waitForSelector('[data-screen=tpl]', { timeout: 15000 });
  await b.waitForTimeout(1500);
  await b.screenshot({ path: `${OUT}/booth-tpl.png` });
  await b.click('[data-testid=tpl-next]');
  await b.waitForSelector('[data-screen=pick]', { timeout: 15000 });
  await b.click('[data-testid=pick-auto]');
  await b.waitForTimeout(1500);
  await b.screenshot({ path: `${OUT}/booth-pick.png` });
  await b.click('[data-testid=pick-next]');
  await b.waitForSelector('[data-screen=edit]', { timeout: 15000 });
  await b.click('[data-testid=filter-warm]');
  await b.click('[data-testid=tool-rotate]');
  await b.waitForTimeout(1500);
  await b.screenshot({ path: `${OUT}/booth-edit.png` });
  await b.click('[data-testid=edit-done]');
  await b.waitForSelector('[data-screen=final]', { timeout: 15000 });
  await b.waitForTimeout(1500);
  await b.screenshot({ path: `${OUT}/booth-final.png` });
  await b.click('[data-testid=final-print]');
  await b.waitForSelector('[data-screen=print]', { timeout: 15000 });
  await b.waitForTimeout(2500);
  await b.screenshot({ path: `${OUT}/booth-print.png` });
  await b.waitForSelector('[data-screen=qr]', { timeout: 120000 });
  await b.waitForTimeout(1500);
  await b.screenshot({ path: `${OUT}/booth-qr.png` });
  console.log('gallery', await b.getAttribute('[data-testid=gallery-qr]', 'data-url'));
  await b.click('[data-testid=qr-done]');
  await b.waitForSelector('[data-screen=thanks]', { timeout: 15000 });
  await b.waitForTimeout(800);
  await b.screenshot({ path: `${OUT}/booth-thanks.png` });
}
await browser.close();
console.log('done');
