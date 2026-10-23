import { defineConfig, devices } from "@playwright/test";

const backendPort = Number(process.env.OPENFIC_E2E_BACKEND_PORT ?? 19001);
const frontendPort = Number(process.env.OPENFIC_E2E_FRONTEND_PORT ?? 19000);

export default defineConfig({
  testDir: "./e2e",
  testMatch: "background-subagents.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { outputFolder: "playwright-report/background", open: "never" }]],
  outputDir: "test-results/background",
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://127.0.0.1:${frontendPort}`,
    viewport: { width: 1600, height: 1000 },
    locale: "zh-CN",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
    launchOptions: {
      ...(process.env.OPENFIC_E2E_CHROMIUM_PATH
        ? { executablePath: process.env.OPENFIC_E2E_CHROMIUM_PATH }
        : {}),
    },
  },
  webServer: [
    {
      command: `.venv/bin/python -m tests.e2e.background_server > /tmp/openfic-e2e-server-${backendPort}.log 2>&1`,
      cwd: "../backend",
      url: `http://127.0.0.1:${backendPort}/api/v1/__e2e__/health`,
      env: { OPENFIC_E2E_BACKEND_PORT: String(backendPort) },
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      command: `node_modules/.bin/vp dev --port ${frontendPort} --strictPort`,
      url: `http://127.0.0.1:${frontendPort}`,
      env: { VITE_BACKEND_URL: `http://127.0.0.1:${backendPort}` },
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
});
