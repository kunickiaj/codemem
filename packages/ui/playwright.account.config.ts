import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

// Independent of the Linux-only visual-golden configuration.
export default defineConfig({
	testDir: "./account-e2e",
	testMatch: "management.spec.ts",
	outputDir: resolve(import.meta.dirname, "../../.tmp/account-browser/results"),
	reporter: "list",
	forbidOnly: true,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	use: {
		browserName: "chromium",
		actionTimeout: 10_000,
		ignoreHTTPSErrors: true,
		serviceWorkers: "block",
		locale: "en-US",
		timezoneId: "UTC",
		trace: "retain-on-failure",
	},
});
