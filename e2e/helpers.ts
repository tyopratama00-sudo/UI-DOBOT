import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const ADMIN = { username: 'admin', password: 'e2e-password-123' };

export async function adminApi(request: APIRequestContext) {
  const r = await request.post('/api/admin/login', { data: ADMIN });
  const { token } = await r.json();
  const headers = { authorization: `Bearer ${token}` };
  return {
    get: (url: string) => request.get(url, { headers }).then((x) => x.json()),
    post: (url: string, data: unknown = {}) => request.post(url, { headers, data }).then((x) => x.json()),
    put: (url: string, data: unknown) => request.put(url, { headers, data }).then((x) => x.json()),
    del: (url: string) => request.delete(url, { headers }).then((x) => x.json()),
  };
}

/** Cancel whatever session a previous test left behind so the booth starts on Welcome. */
export async function resetBooth(request: APIRequestContext) {
  const a = await adminApi(request);
  const list = await a.get('/api/admin/sessions?pageSize=100');
  for (const s of list.items) if (!['FINISHED', 'CANCELLED', 'EXPIRED'].includes(s.status)) await a.post(`/api/admin/sessions/${s.id}/cancel`);
  for (const t of ['printer', 'robot', 'camera'] as const) await a.post('/api/admin/mock', { target: t, action: 'clear' });
  await a.post('/api/admin/mock', { target: 'payment', action: 'available' });
}

export function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|ERR_ABORTED|net::ERR_CONNECTION_REFUSED/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  return errors;
}

export async function screen(page: Page, name: string, timeout = 60_000) {
  await expect(page.locator('#ct')).toHaveAttribute('data-screen', name, { timeout });
}

/** "Scan" the dynamic QR: the mock QR encodes /mock-pay/<order> exactly like a phone would open it. */
export async function payCurrentQr(page: Page, status: 'PAID' | 'FAILED' = 'PAID') {
  const qr = await page.evaluate(async () => {
    const s = JSON.parse(localStorage.getItem('pb.session')!);
    const r = await fetch(`/api/sessions/${s.id}`, { headers: { 'x-session-token': s.token } });
    return (await r.json()).payment.qrString as string;
  });
  const order = decodeURIComponent(qr.split('/mock-pay/')[1]);
  const res = await page.request.post(`/mock-pay/${encodeURIComponent(order)}`, { data: { status } });
  expect(res.ok()).toBeTruthy();
}
