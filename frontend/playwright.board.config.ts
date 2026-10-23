import { defineConfig } from "@playwright/test";

import background from "./playwright.background.config";

export default defineConfig(background, {
  testMatch: "agent-board.spec.ts",
  reporter: [["list"], ["html", { outputFolder: "playwright-report/board", open: "never" }]],
  outputDir: "test-results/board",
});
