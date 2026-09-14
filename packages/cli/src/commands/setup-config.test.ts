import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadJsoncConfig,
	reconcileOpencodePluginConfig,
	resolveOpencodeConfigPath,
} from "./setup-config.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "codemem-setup-config-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("resolveOpencodeConfigPath", () => {
	it("prefers an existing opencode.json when both files exist", () => {
		const dir = makeTempDir();
		const jsoncPath = join(dir, "opencode.jsonc");
		const jsonPath = join(dir, "opencode.json");
		writeFileSync(jsoncPath, "{}\n", "utf-8");
		writeFileSync(jsonPath, "{}\n", "utf-8");

		expect(resolveOpencodeConfigPath(dir)).toBe(jsonPath);
	});

	it("falls back to existing opencode.jsonc", () => {
		const dir = makeTempDir();
		const jsoncPath = join(dir, "opencode.jsonc");
		writeFileSync(jsoncPath, "{}\n", "utf-8");

		expect(resolveOpencodeConfigPath(dir)).toBe(jsoncPath);
	});

	it("falls back to existing opencode.json", () => {
		const dir = makeTempDir();
		const jsonPath = join(dir, "opencode.json");
		writeFileSync(jsonPath, "{}\n", "utf-8");

		expect(resolveOpencodeConfigPath(dir)).toBe(jsonPath);
	});

	it("defaults to opencode.jsonc when neither file exists", () => {
		const dir = makeTempDir();
		expect(resolveOpencodeConfigPath(dir)).toBe(join(dir, "opencode.jsonc"));
	});
});

describe("loadJsoncConfig", () => {
	it("parses JSONC with comments and trailing commas", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			[
				"{",
				"  // keep comment",
				'  "mcp": {',
				'    "codemem": {',
				'      "enabled": true,',
				"    },",
				"  },",
				"}",
			].join("\n"),
			"utf-8",
		);

		expect(loadJsoncConfig(configPath)).toEqual({
			mcp: {
				codemem: {
					enabled: true,
				},
			},
		});
	});
});

describe("reconcileOpencodePluginConfig", () => {
	const canonical = "@codemem/opencode-plugin";
	const pinned = `${canonical}@0.44.0`;

	it("adds the singular plugin key for V1 and V2 runtime translation without mutating input", () => {
		const config = Object.freeze({});
		const result = reconcileOpencodePluginConfig(config, { force: false });

		expect(result).toEqual({
			config: { plugin: [canonical] },
			changed: true,
			removedLegacy: false,
		});
		expect(result.config).not.toHaveProperty("plugins");
		expect(config).toEqual({});
	});

	it.each([canonical, pinned])("leaves existing %s unchanged without force", (spec) => {
		const config = { plugin: ["other-plugin", spec, "last-plugin"] };
		const result = reconcileOpencodePluginConfig(config, { force: false });

		expect(result).toEqual({ config, changed: false, removedLegacy: false });
		expect(result.config).toBe(config);
	});

	it.each(["codemem", "codemem@0.20.0", "@kunickiaj/codemem", "@kunickiaj/codemem@0.20.0"])(
		"migrates legacy spec %s without force",
		(spec) => {
			const result = reconcileOpencodePluginConfig(
				{ plugin: ["other-plugin", spec] },
				{ force: false },
			);

			expect(result).toEqual({
				config: { plugin: ["other-plugin", canonical] },
				changed: true,
				removedLegacy: true,
			});
		},
	);

	it("collapses mixed legacy and canonical duplicates during migration without force", () => {
		const config = {
			plugin: [canonical, "codemem", pinned, "other-plugin", "@kunickiaj/codemem@0.20.0"],
		};
		const result = reconcileOpencodePluginConfig(config, { force: false });

		expect(result).toEqual({
			config: { plugin: ["other-plugin", canonical] },
			changed: true,
			removedLegacy: true,
		});
	});

	it("leaves canonical-only duplicates unchanged without force", () => {
		const config = { plugin: [canonical, pinned, canonical] };
		const result = reconcileOpencodePluginConfig(config, { force: false });

		expect(result).toEqual({ config, changed: false, removedLegacy: false });
		expect(result.config).toBe(config);
	});

	it.each([canonical, pinned])(
		"refreshes %s to the unpinned canonical spec under force",
		(spec) => {
			const result = reconcileOpencodePluginConfig({ plugin: [spec] }, { force: true });

			expect(result).toEqual({
				config: { plugin: [canonical] },
				changed: true,
				removedLegacy: false,
			});
		},
	);

	it("collapses all managed duplicates under force while preserving unrelated and unknown entries", () => {
		const unknownEntry = { name: "custom-plugin", options: { enabled: true } };
		const unrelated = [
			"codemem-tools",
			"@codemem/opencode-plugin-extra@1.0.0",
			"@kunickiaj/codemem-extra",
			"file:///plugins/codemem.js",
			unknownEntry,
			["custom-plugin", { enabled: false }],
			null,
			42,
		];
		const plugins = Object.freeze([
			canonical,
			...unrelated,
			"codemem@0.20.0",
			pinned,
			"@kunickiaj/codemem",
			canonical,
		]);
		const config = Object.freeze({
			plugin: plugins,
			mcp: { custom: { enabled: false } },
			model: "example/model",
			experimental: { custom: true },
		});
		const result = reconcileOpencodePluginConfig(config, { force: true });

		expect(result).toEqual({
			config: { ...config, plugin: [...unrelated, canonical] },
			changed: true,
			removedLegacy: true,
		});
		expect(config.plugin).toBe(plugins);
		expect(result.config.mcp).toBe(config.mcp);
		expect(result.config).not.toHaveProperty("plugins");
	});

	it.each([
		{ name: "fresh install", config: {}, force: false },
		{ name: "legacy migration", config: { plugin: ["codemem", pinned] }, force: false },
		{ name: "forced refresh", config: { plugin: [canonical, pinned] }, force: true },
	])("becomes a no-op on repeat after $name", ({ config, force }) => {
		const first = reconcileOpencodePluginConfig(config, { force });
		const second = reconcileOpencodePluginConfig(first.config, { force: false });

		expect(first.changed).toBe(true);
		expect(second).toEqual({ config: first.config, changed: false, removedLegacy: false });
		expect(second.config).toBe(first.config);
	});
});
