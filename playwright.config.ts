import { defineConfig } from '@playwright/test';

const port = 4173;

export default defineConfig({
  testDir: './e2e',
  timeout: 60000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${port}`,
    viewport: { width: 1500, height: 950 },
    trace: 'retain-on-failure'
  },
  webServer: {
    command: `pnpm --filter @breadboard-studio/web exec vite --port ${port} --strictPort`,
    port,
    reuseExistingServer: !process.env.CI,
    timeout: 120000
  }
});
