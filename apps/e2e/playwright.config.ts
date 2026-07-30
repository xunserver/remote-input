import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(e2eDir, "../..");
const port = 17_889;
const baseURL = `http://127.0.0.1:${port}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  // All tests share one in-memory PC Agent and therefore run serially.
  workers: 1,
  reporter: [
    [isCI ? "line" : "list"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL,
    headless: isCI,
    launchOptions: {
      slowMo: isCI ? 0 : 150,
    },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "node apps/e2e/support/test-server.mjs",
    cwd: repositoryRoot,
    reuseExistingServer: false,
    timeout: 30_000,
    url: `${baseURL}/api/info`,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
