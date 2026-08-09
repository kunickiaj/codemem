import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type HistoricalInjectionDriverInput,
	runHistoricalInjectionDriver,
} from "./historical-injection.js";
import {
	isPathInside,
	resolveFreshSqlitePathWithinAllowedRoots,
	resolvePathWithinAllowedRoots,
} from "./path-safety.js";

const temporaryDirectories: string[] = [];

function historicalInjectionInput(
	root: string,
	worktreePath: string,
	tracePath: string,
): HistoricalInjectionDriverInput {
	return {
		execute: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
		nodeExecutable: "node",
		driverPath: join(root, "driver.ts"),
		runnerPath: join(root, "runner.mjs"),
		pluginPath: join(worktreePath, "plugin.js"),
		tracePath,
		worktreePath,
		repositoryRoot: root,
		request: {
			schema_version: 1,
			operation: "run_plugin_injection",
			case: {
				first_prompt: "prompt",
				latest_prompt: "prompt",
				project_name: "release-eval",
				files_modified: [],
				disabled: false,
				pack: { outcome: "empty", pack_text: "", memory_ids: [] },
			},
		},
		tsxImportPath: join(root, "tsx.mjs"),
		prepareDependencies: async () => {},
		clearTrace: async () => {},
		realpath: async (path) => resolve(path),
	};
}

afterEach(async () => {
	for (const path of temporaryDirectories.splice(0))
		await rm(path, { recursive: true, force: true });
});

describe("release-eval path safety", () => {
	it("distinguishes descendants from traversal and sibling prefixes", () => {
		const root = resolve("/tmp/release-root");
		expect(isPathInside(root, resolve(root, "nested/report.json"))).toBe(true);
		expect(isPathInside(root, resolve(root, "../release-root-other/report.json"))).toBe(false);
	});

	it("accepts missing descendants beneath an allowed root", async () => {
		const root = await mkdtemp(join(tmpdir(), "codemem-path-safety-"));
		temporaryDirectories.push(root);
		await mkdir(join(root, "scripts/eval/baselines"), { recursive: true });
		await expect(
			resolvePathWithinAllowedRoots(root, "scripts/eval/baselines/v0.40/report.json", [
				"scripts/eval/baselines",
			]),
		).resolves.toBe(join(root, "scripts/eval/baselines/v0.40/report.json"));
	});

	it("rejects lexical and symlink escapes", async () => {
		const root = await mkdtemp(join(tmpdir(), "codemem-path-safety-"));
		const outside = await mkdtemp(join(tmpdir(), "codemem-path-outside-"));
		temporaryDirectories.push(root, outside);
		await mkdir(join(root, "scripts/eval/baselines"), { recursive: true });
		await symlink(outside, join(root, "scripts/eval/baselines/escape"));
		await expect(
			resolvePathWithinAllowedRoots(root, "package.json", ["scripts/eval/baselines"]),
		).rejects.toThrow("outside the allowed");
		await expect(
			resolvePathWithinAllowedRoots(root, "scripts/eval/baselines/escape/report.json", [
				"scripts/eval/baselines",
			]),
		).rejects.toThrow("resolves outside");
	});

	it("rejects semantic stores through symlinked parents and stale SQLite sidecars", async () => {
		const root = await mkdtemp(join(tmpdir(), "codemem-semantic-path-"));
		const outside = await mkdtemp(join(tmpdir(), "codemem-semantic-outside-"));
		temporaryDirectories.push(root, outside);
		const allowed = join(root, ".tmp/eval-results/release");
		await mkdir(allowed, { recursive: true });
		await symlink(outside, join(allowed, "escape"));
		await expect(
			resolveFreshSqlitePathWithinAllowedRoots(root, join(allowed, "escape/store.sqlite"), [
				".tmp/eval-results/release",
			]),
		).rejects.toThrow("resolves outside");

		const store = join(allowed, "candidate/store.sqlite");
		await mkdir(join(allowed, "candidate"), { recursive: true });
		await writeFile(`${store}-journal`, "stale", "utf8");
		await expect(
			resolveFreshSqlitePathWithinAllowedRoots(root, store, [".tmp/eval-results/release"]),
		).rejects.toThrow("sidecars must not already exist");
	});

	it("rejects historical injection trace traversal and symlink escapes", async () => {
		const root = await mkdtemp(join(tmpdir(), "codemem-injection-path-"));
		const outside = await mkdtemp(join(tmpdir(), "codemem-injection-outside-"));
		temporaryDirectories.push(root, outside);
		const allowed = join(root, ".tmp/eval-results/release");
		const worktree = join(root, ".tmp/worktree");
		await mkdir(worktree, { recursive: true });
		await mkdir(allowed, { recursive: true });
		await symlink(outside, join(allowed, "escape"));

		await expect(
			runHistoricalInjectionDriver(
				historicalInjectionInput(root, worktree, join(root, "outside-trace.json")),
			),
		).rejects.toThrow("outside the allowed");
		await expect(
			runHistoricalInjectionDriver(
				historicalInjectionInput(root, worktree, join(allowed, "escape/trace.json")),
			),
		).rejects.toThrow("resolves outside");
	});

	it("rejects historical injection traces inside the subject worktree", async () => {
		const root = await mkdtemp(join(tmpdir(), "codemem-injection-worktree-"));
		temporaryDirectories.push(root);
		const worktree = join(root, ".tmp/eval-results/release/subject-worktree");
		await mkdir(worktree, { recursive: true });

		await expect(
			runHistoricalInjectionDriver(
				historicalInjectionInput(root, worktree, join(worktree, "trace.json")),
			),
		).rejects.toThrow("outside the subject worktree");
	});
});
