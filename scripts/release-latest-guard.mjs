/**
 * Guard the npm `latest` dist-tag against prerelease leakage.
 *
 * npm assigns `latest` to the first-ever version of a package regardless of
 * `--tag`. A new package whose first publication is a prerelease therefore
 * exposes that prerelease to `npm install <pkg>` with no tag. This script
 * inspects a package's live dist-tags and reports whether `latest` must be
 * removed. It only ever removes; it never adds or moves `latest`.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PRERELEASE_VERSION = /^\d+\.\d+\.\d+-[0-9A-Za-z.+-]+$/;

export function isPrereleaseVersion(version) {
	return PRERELEASE_VERSION.test(version);
}

/**
 * Decide what to do about a package's `latest` dist-tag.
 *
 * Returns `remove` only when `latest` points at a prerelease — the exact
 * shape npm's first-publish behavior produces. A stable `latest` is never
 * touched even during a prerelease publish, and an absent `latest` is fine.
 */
export function latestGuardAction(distTags) {
	const latest = distTags?.latest;
	if (latest == null || latest === "") return { action: "none", reason: "latest absent" };
	if (!isPrereleaseVersion(latest)) {
		return { action: "none", reason: `latest is stable ${latest}` };
	}
	return { action: "remove", reason: `latest points at prerelease ${latest}` };
}

/**
 * Read a package's live dist-tags. An unpublished package (E404) has no
 * `latest` and therefore nothing to guard; it reads as `{}` rather than an
 * error so the guard can run before a new package's first publish.
 */
export function readDistTags(packageName, { spawn = spawnSync } = {}) {
	const result = spawn("npm", ["view", packageName, "dist-tags", "--json"], {
		encoding: "utf8",
	});
	if (result.status !== 0) {
		if (/E404|404 Not Found/u.test(result.stderr ?? "")) return {};
		throw new Error(`npm view ${packageName} dist-tags failed: ${(result.stderr ?? "").trim()}`);
	}
	const parsed = JSON.parse(result.stdout);
	// npm returns an array when the spec resolves to multiple versions; a
	// bare package name resolves to one object.
	return Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed;
}

export function removeLatest(packageName, { spawn = spawnSync } = {}) {
	const result = spawn("npm", ["dist-tag", "rm", packageName, "latest"], {
		encoding: "utf8",
		stdio: ["ignore", "inherit", "inherit"],
	});
	if (result.status !== 0) throw new Error(`npm dist-tag rm ${packageName} latest failed`);
}

/**
 * Inspect every package and, with `apply`, remove a prerelease `latest`.
 *
 * Every package is inspected even if an earlier one fails, so the operator
 * sees the full picture from one run; failures are collected and thrown
 * together at the end. Returns how many packages needed action, whether or
 * not it was applied, so a dry run can fail a verify step without touching
 * the registry.
 */
export function guardPackages(packageNames, { apply, log = console.log, spawn = spawnSync } = {}) {
	let needingAction = 0;
	const failures = [];
	for (const packageName of packageNames) {
		try {
			const distTags = readDistTags(packageName, { spawn });
			const decision = latestGuardAction(distTags);
			log(`${packageName}: ${decision.action} (${decision.reason})`);
			if (decision.action !== "remove") continue;
			needingAction += 1;
			if (apply) removeLatest(packageName, { spawn });
		} catch (error) {
			failures.push(`${packageName}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (failures.length > 0) throw new Error(`latest-tag guard failures:\n${failures.join("\n")}`);
	return needingAction;
}

if (
	process.argv[1] &&
	realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
) {
	const args = process.argv.slice(2);
	const flags = args.filter((arg) => arg.startsWith("--"));
	const unknownFlags = flags.filter((flag) => flag !== "--apply");
	const apply = flags.includes("--apply");
	const packageNames = args.filter((arg) => !arg.startsWith("--"));
	if (unknownFlags.length > 0 || packageNames.length === 0) {
		// Reject typos like --aply: a human runs apply mode, and a silent
		// fallback to dry-run would report success while fixing nothing.
		if (unknownFlags.length > 0) process.stderr.write(`unknown flag: ${unknownFlags.join(" ")}\n`);
		process.stderr.write("usage: release-latest-guard.mjs [--apply] <package>...\n");
		process.exitCode = 2;
	} else {
		try {
			const needingAction = guardPackages(packageNames, { apply });
			// Dry run (verify mode) fails when any package still needs action;
			// apply mode has fixed them, so it succeeds.
			if (!apply && needingAction > 0) process.exitCode = 1;
		} catch (error) {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		}
	}
}
