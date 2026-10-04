import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 180000,
  use: { baseURL: "http://127.0.0.1:4173" },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // phone-shaped: the narrow viewport flips the app onto its
      // adaptive 12 px/mm path; only the fixture smoke runs here
      name: "mobile",
      testMatch: /fixtures\.spec\.js/,
      use: { ...devices["Pixel 7"], browserName: "chromium" },
    },
  ],
  webServer: {
    // explicit IPv4 host: CI runners otherwise bind ::1 while the probe
    // polls 127.0.0.1 and times out
    command: "npm run preview -- --port 4173 --strictPort --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
});
