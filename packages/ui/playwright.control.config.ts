import { defineConfig } from "@playwright/test";
import config, { output } from "./playwright.config.js";

export default defineConfig({
	...config,
	testMatch: "control.spec.ts",
	projects: [
		{ name: "control", use: { viewport: { width: 1280, height: 900 }, colorScheme: "dark" } },
	],
	// Scratch comparator inputs are never gallery goldens and never enter the source tree.
	snapshotPathTemplate: `${output}/comparator-inputs/{arg}{ext}`,
	updateSnapshots: "none",
});
