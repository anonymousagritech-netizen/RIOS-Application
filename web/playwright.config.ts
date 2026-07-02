import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: process.env.VITE_PREVIEW_URL ?? 'http://localhost:4173',
    ...devices['Desktop Chrome'],
    executablePath: process.env.CHROMIUM_PATH ?? undefined,
  },
  webServer: process.env.CI
    ? undefined
    : {
        command: 'npm run preview',
        port: 4173,
        reuseExistingServer: true,
      },
});
