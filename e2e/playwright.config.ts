import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

/**
 * RIOS end-to-end tests. The stack (API + web) is expected to be running at
 * PLAYWRIGHT_BASE_URL (default http://localhost:5173). In CI/local use
 * `e2e/run.sh` which boots Postgres, the API, and the web dev server first.
 *
 * Uses the pre-installed system Chromium via executablePath so no browser
 * download is needed (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1).
 */
// Prefer an explicit/system Chromium when present (sandboxed dev environments);
// otherwise fall back to Playwright's own managed browser (CI: `playwright install`).
const SYSTEM_CHROMIUM =
  process.env.RIOS_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROMIUM = existsSync(SYSTEM_CHROMIUM) ? SYSTEM_CHROMIUM : undefined;

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { executablePath: CHROMIUM, args: ['--no-sandbox'] },
      },
    },
  ],
});
