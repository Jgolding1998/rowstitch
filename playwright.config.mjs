import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export default defineConfig({
  testDir: './tests',
  testMatch: 'studio.spec.mjs',
  timeout: 25_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: process.env.CI ? 2 : 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  outputDir: resolve(process.env.PW_OUTPUT_DIR || join(tmpdir(), 'rowstitch-playwright', String(process.pid))),
  use: {
    browserName: 'chromium',
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    acceptDownloads: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
