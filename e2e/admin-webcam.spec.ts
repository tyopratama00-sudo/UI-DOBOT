import { expect, test } from '@playwright/test';
import { ADMIN, adminApi, payCurrentQr, resetBooth, screen, trackErrors } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetBooth(request);
});

test('admin panel: login, dashboard, diagnostics and mock controls', async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto('/admin/');
  await page.getByTestId('login-pass').fill('wrong');
  await page.getByTestId('login-submit').click();
  await expect(page.getByText('Invalid username or password')).toBeVisible();
  errors.length = 0; // the deliberate wrong password produced an expected 401
  await page.getByTestId('login-pass').fill(ADMIN.password);
  await page.getByTestId('login-submit').click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByText('Sessions today')).toBeVisible();
  await expect(page.getByText('Revenue today')).toBeVisible();

  await page.getByRole('link', { name: 'Diagnostics' }).click();
  await expect(page.getByTestId('diag-camera')).toContainText('Camera: Connected');
  await expect(page.getByTestId('diag-robot')).toContainText('Robot: Connected');
  await expect(page.getByTestId('diag-printer')).toContainText('Printer: Ready');
  await expect(page.getByTestId('diag-storage')).toContainText('Storage: Ready');
  await page.getByRole('button', { name: 'Simulate Printer Offline' }).click();
  await expect(page.getByTestId('diag-printer')).toContainText('Not ready', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Clear' }).last().click();
  await expect(page.getByTestId('diag-printer')).toContainText('Printer: Ready', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Home Robot' }).click();
  await expect(page.getByText('Robot homed').first()).toBeVisible();

  await page.getByRole('link', { name: 'Configuration' }).click();
  await expect(page.getByRole('heading', { name: 'Configuration' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('webcam mode: captures real frames from the browser camera', async ({ page, request }) => {
  const a = await adminApi(request);
  await a.put('/api/admin/settings/camera', { value: { driver: 'webcam' } });
  await a.put('/api/admin/settings/session', { value: { angles: 2, shotsPerAngle: 1 } });
  try {
    const errors = trackErrors(page);
    await page.goto('/');
    await page.getByTestId('start').click();
    await expect(page.locator('[data-testid=qris] svg')).toBeVisible();
    await payCurrentQr(page);
    await screen(page, 'session', 30_000);
    await expect(page.locator('.cam video.lv')).toBeVisible();
    await screen(page, 'review', 90_000);
    await expect(page.locator('.th')).toHaveCount(2);
    const sessions = await a.get('/api/admin/sessions?pageSize=5');
    const detail = await a.get(`/api/admin/sessions/${sessions.items[0].id}`);
    expect(detail.snapshot.photos.length).toBe(2);
    expect(detail.snapshot.photos[0].width).toBeGreaterThanOrEqual(320);
    expect(errors).toEqual([]);
  } finally {
    await a.del('/api/admin/settings/camera');
    await a.del('/api/admin/settings/session');
  }
});
