import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import { assertCanonicalPlatform, snapshotMode } from "./scripts/visual-policy.mjs";

assertCanonicalPlatform({ platform: process.platform, arch: process.arch });

export const output = resolve(
	import.meta.dirname,
	process.env.CODEMEM_VISUAL_OUTPUT || "../../.tmp/visual/local",
);
export default defineConfig({
	testDir: "./visual",
	testMatch: "gallery.spec.ts",
	outputDir: `${output}/test-results`,
	reporter: [["list"], ["html", { outputFolder: `${output}/report`, open: "never" }]],
	snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
	updateSnapshots: snapshotMode({
		args: process.argv,
		ci: process.env.CI,
		update: process.env.CODEMEM_VISUAL_UPDATE,
		browserPath: process.env.PLAYWRIGHT_BROWSERS_PATH,
	}),
	captureGitInfo: { commit: false, diff: false },
	forbidOnly: true,
	workers: 1,
	retries: 0,
	expect: {
		toHaveScreenshot: {
			animations: "disabled",
			caret: "hide",
			scale: "css",
			// Ignore sub-perceptual RGB rounding in blur/edges, not differing-pixel counts.
			threshold: 0.01,
			maxDiffPixels: 0,
		},
	},
	use: {
		browserName: "chromium",
		baseURL: "http://127.0.0.1:38923",
		deviceScaleFactor: 1,
		locale: "en-US",
		timezoneId: "UTC",
		reducedMotion: "reduce",
		serviceWorkers: "block",
	},
	projects: [1280, 390].flatMap((width) =>
		(["dark", "light"] as const).map((colorScheme) => ({
			name: `${width === 390 ? "narrow" : "desktop"}-${colorScheme}`,
			use: { viewport: { width, height: 900 }, colorScheme },
		})),
	),
	webServer: {
		command:
			"node scripts/make-gallery-html.mjs && pnpm exec vite --config vite.gallery.config.ts --port 38923",
		cwd: import.meta.dirname,
		url: "http://127.0.0.1:38923/gallery.html",
		reuseExistingServer: false,
		timeout: 60_000,
	},
});
