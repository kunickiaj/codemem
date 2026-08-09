import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPathInside, resolvePathWithinAllowedRoots } from "./path-safety.js";

const temporaryDirectories: string[] = [];

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
});
