import { defineConfig } from "@playwright/test";
const directory =
  process.env.ADMIN_E2E_DIR || `/tmp/aistudio-admin-integration-${process.pid}`;
process.env.ADMIN_E2E_DIR = directory;
export default defineConfig({
  testDir: "./integration",
  globalTeardown: "./integration/cleanup.ts",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:5277/admin/",
    headless: true,
    launchOptions: process.env.ADMIN_TEST_BROWSER
      ? { executablePath: process.env.ADMIN_TEST_BROWSER }
      : undefined,
  },
  webServer: {
    command: "node --import tsx integration/server.ts",
    env: { ADMIN_E2E_DIR: directory },
    url: "http://127.0.0.1:5277/health",
    reuseExistingServer: false,
    timeout: 45000,
  },
});
