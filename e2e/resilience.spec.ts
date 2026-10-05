import { expect, test } from '@playwright/test';
import { adminApi, payCurrentQr, resetBooth, screen, trackErrors } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetBooth(request);
});

test('a paid session survives a booth reload and resumes capture', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await page.getByTestId('start').click();
  await screen(page, 'pay');
  await expect(page.locator('[data-testid=qris] svg')).toBeVisible();
  await payCurrentQr(page);
  await screen(page, 'session', 30_000);
  await expect(page.getByTestId('session-angle')).toContainText('SUDUT 02', { timeout: 30_000 });
  await page.reload();
  // The same session is recovered from the server and continues where it stopped.
  await screen(page, 'ready', 30_000);
  await screen(page, 'session', 30_000);
  await screen(page, 'review', 120_000);
  await expect(page.locator('.th')).toHaveCount(20);
  expect(errors).toEqual([]);
});

test('critical hardware failure shows the maintenance screen and blocks payment', async ({ page, request }) => {
  const a = await adminApi(request);
  await a.post('/api/admin/mock', { target: 'printer', action: 'paper_out' });
  await page.goto('/');
  await expect(page.getByTestId('maintenance')).toBeVisible();
  await expect(page.getByText('Sebentar ya!')).toBeVisible();
  const r = await request.post('/api/sessions', { data: {} });
  expect(r.status()).toBe(503);
  await a.post('/api/admin/mock', { target: 'printer', action: 'clear' });
  await page.reload();
  await screen(page, 'welcome');
  await expect(page.getByTestId('start')).toBeVisible();
});

test('payment failure → retry → success', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('start').click();
  await expect(page.locator('[data-testid=qris] svg')).toBeVisible();
  await payCurrentQr(page, 'FAILED');
  await expect(page.getByTestId('pay-failed')).toBeVisible();
  await expect(page.getByText('Oops! Pembayaran belum berhasil.')).toBeVisible();
  await page.getByTestId('pay-retry').click();
  await expect(page.getByTestId('pay-waiting')).toBeVisible();
  await expect(page.locator('[data-testid=qris].busy')).toHaveCount(0, { timeout: 15000 });
  await payCurrentQr(page);
  await expect(page.getByTestId('pay-ok')).toBeVisible();
});

test('inactivity on the payment screen warns, then cancels the unpaid session', async ({ page, request }) => {
  const a = await adminApi(request);
  await a.put('/api/admin/settings/timeouts', { value: { paymentSeconds: 30, warningSeconds: 20 } });
  try {
    await page.goto('/');
    await page.getByTestId('start').click();
    await screen(page, 'pay');
    await expect(page.getByTestId('idle-warning')).toBeVisible({ timeout: 25_000 });
    await page.mouse.click(960, 900); // any touch keeps the session alive
    await expect(page.getByTestId('idle-warning')).toHaveCount(0);
    await expect(page.getByTestId('idle-warning')).toBeVisible({ timeout: 25_000 });
    await screen(page, 'welcome', 40_000);
  } finally {
    await a.del('/api/admin/settings/timeouts');
  }
});
