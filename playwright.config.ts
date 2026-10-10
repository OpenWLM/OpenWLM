import { defineConfig, devices } from '@playwright/test';

/**
 * Tests E2E (Playwright) — parcours client réel.
 * Le serveur est lancé par `e2e/start-server.mjs` sur une BASE TEMPORAIRE (jamais la prod).
 * Prérequis : `npm run build` (le serveur sert dist/). `npm run test:e2e` le fait.
 */
const PORT = process.env.E2E_PORT || '3100';

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    actionTimeout: 15000,
    trace: 'retain-on-failure'
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } }
  ],
  webServer: {
    command: 'node e2e/start-server.mjs',
    url: `http://localhost:${PORT}/api/push/status`,
    reuseExistingServer: !process.env.CI,
    timeout: 30000
  }
});
