import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: /.*\.pw\.ts$/,
  fullyParallel: true, forbidOnly: !!process.env.CI, retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never", outputFolder: "../../test-results/ui-report" }]] : "list",
  outputDir: "../../test-results/ui",
  use: { baseURL: "http://127.0.0.1:4417", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun tests/helpers/site-fixture-serve.ts", cwd: "../..",
    url: "http://127.0.0.1:4417/api/home", reuseExistingServer: !process.env.CI, timeout: 60_000,
    env: { SITE_FIXTURE_PORT: "4417", WARDEN_NO_OPEN: "1" },
  },
});
