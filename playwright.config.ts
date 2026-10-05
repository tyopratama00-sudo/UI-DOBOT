import { defineConfig } from '@playwright/test';

/**
 * E2E tests drive the real booth + admin UIs against an isolated mock-mode server.
 *   npx playwright install chromium        # once (or set PW_CHANNEL=msedge / chrome)
 *   npm run test:e2e
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:8090',
    viewport: { width: 1920, height: 1080 },
    channel: process.env.PW_CHANNEL || undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] },
    permissions: ['camera'],
  },
  webServer: {
    command: 'node scripts/e2e-server.mjs',
    url: 'http://localhost:8090/api/health',
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
