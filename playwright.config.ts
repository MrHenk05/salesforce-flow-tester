import { defineConfig } from '@playwright/test';

// Locally the tests use the installed Microsoft Edge; FLOW_TESTER_CHROMIUM points to another Chromium binary.
const executablePath = process.env.FLOW_TESTER_CHROMIUM;

export default defineConfig({
  testDir: 'tests',
  timeout: 120_000,
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    channel: executablePath ? undefined : 'msedge',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'node dist/demo/server.js',
    url: 'http://localhost:4173/login.html',
    reuseExistingServer: true,
  },
});
