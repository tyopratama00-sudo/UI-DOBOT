import { expect, test } from '@playwright/test';
import { payCurrentQr, resetBooth, screen, trackErrors } from './helpers';

test.beforeEach(async ({ request }) => {
  await resetBooth(request);
});

test('complete customer journey: Welcome → Pay → Session → Review → Frame → Pick → Edit → Final → Print → QR → Finish', async ({ page, context }) => {
  const errors = trackErrors(page);
  await page.goto('/');
  await screen(page, 'welcome');
  await expect(page.getByText('Fotografer robotmu sudah siap.')).toBeVisible();

  // Welcome → Pay
  await page.getByTestId('start').click();
  await screen(page, 'pay');
  await expect(page.getByTestId('total')).toHaveText('Rp65.000');
  await expect(page.locator('[data-testid=qris] svg')).toBeVisible();
  await page.getByTestId('qty-plus').click();
  await expect(page.getByTestId('qty')).toHaveText('2');
  await expect(page.getByTestId('total')).toHaveText('Rp80.000');
  await expect(page.locator('[data-testid=qris].busy')).toHaveCount(0, { timeout: 15000 });

  // Payment success (backend webhook is the source of truth)
  await payCurrentQr(page);
  await expect(page.getByTestId('pay-ok')).toBeVisible();

  // Ready → Session (10 angles × 2 photos)
  await screen(page, 'ready');
  await screen(page, 'session');
  await expect(page.getByTestId('session-angle')).toContainText('SUDUT 01 / 10');
  await screen(page, 'review', 120_000);
  await expect(page.locator('.th')).toHaveCount(20);
  await expect(page.getByText('20 foto terpilih')).toBeVisible();

  // Retake angle 2 → back to the session → review shows "pilih 2 dari 4"
  await page.getByTestId('retake-1').click();
  await screen(page, 'session');
  await expect(page.getByTestId('session-angle')).toContainText('ULANG · SUDUT 02');
  await screen(page, 'review', 60_000);
  await expect(page.getByTestId('review-angle-1').getByText('pilih 2 dari 4')).toBeVisible();
  await expect(page.getByText('1 ULANG TERSISA')).toBeVisible();
  await page.getByTestId('review-angle-1').locator('.th').nth(3).click();
  await expect(page.getByTestId('review-angle-1').locator('.th.sel')).toHaveCount(2);

  // Frame
  await page.getByTestId('review-next').click();
  await screen(page, 'tpl');
  await expect(page.locator('[data-testid^="tpl-"]:not([data-testid="tpl-next"])')).toHaveCount(6);
  await page.getByTestId('tpl-kotak-ceria').click();
  await page.getByTestId('tpl-next').click();

  // Pick
  await screen(page, 'pick');
  await expect(page.getByTestId('pick-next')).toBeDisabled();
  await page.getByTestId('pick-auto').click();
  await expect(page.getByTestId('pick-count')).toContainText('4 / 4');
  await page.getByTestId('pick-next').click();

  // Edit
  await screen(page, 'edit');
  await page.getByTestId('filter-warm').click();
  await page.getByTestId('tool-rotate').click();
  await page.getByTestId('tool-bright-up').click();
  await page.getByTestId('slot-2').click();
  await expect(page.getByTestId('edit-chip')).toContainText('foto 3 dari 4');
  // drag the photo inside slot 3
  const box = (await page.getByTestId('slot-2').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 10, { steps: 5 });
  await page.mouse.up();
  await page.getByTestId('edit-done').click();

  // Final → Print → QR
  await screen(page, 'final');
  await expect(page.getByText('Rp80.000')).toBeVisible();
  await page.getByTestId('final-print').click();
  await screen(page, 'print');
  await screen(page, 'qr', 90_000);
  const url = await page.getByTestId('gallery-qr').getAttribute('data-url');
  expect(url).toMatch(/\/g\/[A-Za-z0-9_-]{32}$/);

  // The QR leads to the real digital gallery
  const gallery = await context.newPage();
  await gallery.goto(url!);
  await expect(gallery.getByText('Foto digitalmu')).toBeVisible();
  await expect(gallery.locator('.ph img')).toHaveCount(22);
  const zip = await gallery.request.get(url + '/zip');
  expect(zip.headers()['content-type']).toContain('zip');
  await gallery.close();

  // Finish → Thanks → Welcome
  await page.getByTestId('qr-done').click();
  await screen(page, 'thanks');
  await page.getByTestId('thanks-home').click();
  await screen(page, 'welcome');

  expect(errors).toEqual([]);
});
