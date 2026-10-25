export const IMAGE =
	"mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27";

/** @param {{ platform: string, arch: string }} runtime */
export function assertCanonicalPlatform({ platform, arch }) {
	if (platform === "linux" && arch === "x64") return;
	throw new Error(
		`Visual snapshots require Linux x64; received ${platform}/${arch}. Use pnpm --filter @codemem/ui visual:test or visual:update to run the pinned Docker wrapper.`,
	);
}

// Exact additions are allowed before their first commit, never arbitrary untracked files.
export const HARNESS_FILES = [
	"packages/ui/playwright.config.ts",
	"packages/ui/playwright.control.config.ts",
	"packages/ui/tsconfig.visual.json",
	"packages/ui/scripts/visual-policy.mjs",
	"packages/ui/scripts/visual-policy.test.mjs",
	"packages/ui/scripts/visual-runner.mjs",
	"packages/ui/visual/gallery.spec.ts",
	"packages/ui/visual/layout.spec.ts",
	"packages/ui/visual/fixtures.ts",
	"packages/ui/visual/control.spec.ts",
	"packages/ui/src/gallery/gallery-interactions.test.tsx",
];

export const GOLDEN_FILES = [
	"desktop-dark",
	"desktop-light",
	"narrow-dark",
	"narrow-light",
].flatMap((project) =>
	["all-families", "select-open", "action-menu-open", "dialog-open", "autocomplete-open"].map(
		(name) => `packages/ui/visual/__screenshots__/${project}/${name}.png`,
	),
);

/** @param {string} address */
export function isGalleryRequest(address) {
	const url = new URL(address);
	return url.origin === "http://127.0.0.1:38923" && !url.pathname.startsWith("/api");
}

/** @param {string} path */
export function isPublicSource(path) {
	const parts = path.split("/");
	if (path.startsWith("/") || parts.some((part) => part === ".." || !part)) return false;
	if (
		parts.some(
			(part) =>
				[".git", ".beads", ".tmp", ".opencode", "node_modules", ".venv"].includes(part) ||
				part.toLowerCase() === ".npmrc" ||
				part.startsWith(".env"),
		)
	)
		return false;
	if (/\.(sqlite(?:3)?|db)(?:-shm|-wal)?$/i.test(path)) return false;
	return (
		!/^packages\/[^/]+\/dist\//.test(path) && !path.startsWith("packages/viewer-server/static/")
	);
}

/** @param {string[]} tracked */
export function selectSourcePaths(tracked) {
	return [...new Set([...tracked, ...HARNESS_FILES, ...GOLDEN_FILES])].filter(isPublicSource);
}

/** @param {string[]} generated */
export function validateGeneratedGoldens(generated) {
	const expected = GOLDEN_FILES.map((path) =>
		path.replace("packages/ui/visual/__screenshots__/", ""),
	);
	if (
		generated.length !== expected.length ||
		new Set(generated).size !== expected.length ||
		generated.some((path) => !expected.includes(path))
	) {
		throw new Error(
			"Generated goldens must contain exactly the 24 approved PNG paths before copy-back.",
		);
	}
	return expected;
}

/** @param {string[]} args @param {string | undefined} ci */
export function parseMode(args, ci) {
	if (args.length > 1 || args.some((arg) => !["--update", "--control"].includes(arg))) {
		throw new Error("Use visual:test, visual:update, or visual:control without extra flags.");
	}
	if (args[0] === "--update" && ci) throw new Error("Baseline updates are forbidden in CI.");
	return args[0] ?? "test";
}

/** @param {{ args: string[], ci?: string, update?: string, browserPath?: string }} options */
export function snapshotMode({ args, ci, update, browserPath }) {
	if (args.some((arg) => arg === "--ignore-snapshots" || arg.startsWith("--ignore-snapshots="))) {
		throw new Error("Visual comparisons cannot ignore snapshots.");
	}
	if (
		args.some((arg) => arg === "-u" || arg.startsWith("--update-snapshots") || /^-u./.test(arg))
	) {
		throw new Error("Use the explicit visual:update command instead of snapshot CLI flags.");
	}
	if (update && ci) throw new Error("Baseline updates are forbidden in CI.");
	// An accidental bare-Linux authoring check, not a security boundary or image attestation.
	if (update === "1" && browserPath !== "/ms-playwright") {
		throw new Error(
			"Baseline updates require the image browser path; use the visual:update Docker wrapper.",
		);
	}
	return update === "1" ? "changed" : "none";
}
