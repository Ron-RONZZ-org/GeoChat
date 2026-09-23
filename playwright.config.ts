import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// The CI reporters write a JUnit file here; create it before any reporter runs.
mkdirSync(resolve(".artifacts"), { recursive: true });

/**
 * End-to-end tests for the web renderer.
 *
 * They run the renderer the same way the Tauri shell wires it: the Vite dev
 * server talks to the local Bun backend, which serves the vendored GeoGebra
 * assets. The native shell itself is not launched — it has no headless mode,
 * and every behaviour under test (GeoGebra mount, canvas chrome switching)
 * lives in the renderer plus the backend.
 *
 * Ports are deliberately not the packaged defaults: a locally installed
 * GeoChat.app occupies 17365, and reusing it would test the installed build
 * instead of this checkout.
 */
const BACKEND_PORT = 17366;
const RENDERER_URL = "http://127.0.0.1:1421";
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }], ["junit", { outputFile: ".artifacts/e2e-junit.xml" }]]
    : [["list"]],
  use: {
    baseURL: RENDERER_URL,
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "bun backend/src/index.ts",
      url: `${BACKEND_URL}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...(process.env as Record<string, string>), GEOCHAT_DESKTOP_BACKEND_PORT: String(BACKEND_PORT) },
    },
    {
      command: "bun run tauri:renderer:dev",
      url: RENDERER_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...(process.env as Record<string, string>), VITE_API_ORIGIN: BACKEND_URL },
    },
  ],
});
