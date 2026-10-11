import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5174/admin/",
    headless: true,
    launchOptions: process.env.ADMIN_TEST_BROWSER
      ? { executablePath: process.env.ADMIN_TEST_BROWSER }
      : undefined,
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5174/admin/",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
