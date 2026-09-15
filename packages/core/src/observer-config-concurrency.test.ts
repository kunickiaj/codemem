import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mutateCodememConfigFile } from "./observer-config.js";

describe("fallback config mutation concurrency", () => {
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "codemem-fallback-concurrency-"));
	});

	afterEach(() => {
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it.each([
		["legacy lock sorts first", "a-legacy", "z-scoped"],
		["target lock sorts first", "z-legacy", "a-scoped"],
	])("seeds a scoped snapshot without acquiring the %s", (_scenario, legacyDir, targetDir) => {
		const legacyPath = join(tmpHome, legacyDir, "config.json");
		const targetPath = join(tmpHome, targetDir, "config.json");
		mkdirSync(dirname(legacyPath), { recursive: true });
		writeFileSync(legacyPath, '{"value":"before"}\n', "utf8");
		let scopedSeed: Record<string, unknown> | undefined;

		const legacyUpdate = mutateCodememConfigFile(() => {
			scopedSeed = mutateCodememConfigFile((config) => ({ ...config, scoped: true }), targetPath, {
				fallbackReadPath: legacyPath,
			}).data;
			return { value: "after" };
		}, legacyPath);

		expect(scopedSeed).toEqual({ value: "before", scoped: true });
		expect(legacyUpdate.data).toEqual({ value: "after" });
		expect(JSON.parse(readFileSync(targetPath, "utf8"))).toEqual({
			value: "before",
			scoped: true,
		});
		expect(JSON.parse(readFileSync(legacyPath, "utf8"))).toEqual({ value: "after" });
		expect(
			readdirSync(tmpHome, { recursive: true }).filter((name) => String(name).endsWith(".lock")),
		).toEqual([]);
	});

	it("rejects a symlink retargeted while the original target is locked", () => {
		const firstTarget = join(tmpHome, "first.json");
		const secondTarget = join(tmpHome, "second.json");
		const configPath = join(tmpHome, "config.json");
		writeFileSync(firstTarget, '{"value":"first"}\n', "utf8");
		writeFileSync(secondTarget, '{"value":"second"}\n', "utf8");
		symlinkSync(firstTarget, configPath);

		expect(() =>
			mutateCodememConfigFile((config) => {
				unlinkSync(configPath);
				symlinkSync(secondTarget, configPath);
				mutateCodememConfigFile((current) => ({ ...current, nested: true }), configPath);
				return { ...config, outer: true };
			}, configPath),
		).toThrow(expect.objectContaining({ code: "changed" }));

		expect(JSON.parse(readFileSync(firstTarget, "utf8"))).toEqual({ value: "first" });
		expect(JSON.parse(readFileSync(secondTarget, "utf8"))).toEqual({
			value: "second",
			nested: true,
		});
		expect(
			readdirSync(tmpHome, { recursive: true }).filter((path) => String(path).endsWith(".lock")),
		).toEqual([]);
	});
});
