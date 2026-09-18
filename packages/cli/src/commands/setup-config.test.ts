import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	loadJsoncConfig,
	reconcileOpencodePluginConfig,
	resolveOpencodeConfigPath,
	writeJsonConfig,
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

describe("writeJsonConfig", () => {
	it("preserves comments, trailing commas, unrelated settings, and practical formatting", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		const original = [
			"{",
			"  // user model choice",
			'  "model": "example/model",',
			"  /* Keep custom MCP settings. */",
			'  "mcp": {',
			'    "custom": { "enabled": false },',
			"  },",
			"}",
			"",
		].join("\n");
		writeFileSync(configPath, original, "utf-8");

		writeJsonConfig(configPath, {
			model: "example/model",
			mcp: {
				custom: { enabled: false },
				codemem: { type: "local", command: ["codemem", "mcp"], enabled: true },
			},
		});

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain("// user model choice");
		expect(updated).toContain("/* Keep custom MCP settings. */");
		expect(updated).toContain('"model": "example/model"');
		expect(updated).toContain('"custom": { "enabled": false }');
		expect(updated).toContain('"codemem"');
		expect(loadJsoncConfig(configPath)).toEqual({
			model: "example/model",
			mcp: {
				custom: { enabled: false },
				codemem: { type: "local", command: ["codemem", "mcp"], enabled: true },
			},
		});
		expect(readFileSync(`${configPath}.codemem.bak`, "utf-8")).toBe(original);
		expect(readdirSync(dir).some((name) => name.includes(".codemem.tmp-"))).toBe(false);
	});

	it("is idempotent and does not replace the backup on a no-op", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(configPath, "{\n  // retained\n}\n", "utf-8");
		const data = { plugin: ["@codemem/opencode-plugin"] };

		writeJsonConfig(configPath, data);
		const firstOutput = readFileSync(configPath, "utf-8");
		const firstBackup = readFileSync(`${configPath}.codemem.bak`, "utf-8");
		writeJsonConfig(configPath, data);

		expect(readFileSync(configPath, "utf-8")).toBe(firstOutput);
		expect(readFileSync(`${configPath}.codemem.bak`, "utf-8")).toBe(firstBackup);
		expect(firstOutput).toContain("// retained");
	});

	it("keeps comments inside an existing plugin array when appending Codemem", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "plugin": [\n    // user plugin\n    "other-plugin",\n    /* keep this note */\n  ],\n}\n',
			"utf-8",
		);

		writeJsonConfig(configPath, {
			plugin: ["other-plugin", "@codemem/opencode-plugin"],
		});

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain("// user plugin");
		expect(updated).toContain("/* keep this note */");
		expect(loadJsoncConfig(configPath)).toEqual({
			plugin: ["other-plugin", "@codemem/opencode-plugin"],
		});
	});
});

describe("writeJsonConfig object reconciliation", () => {
	it("removes stale fields from the Codemem-owned MCP object", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "mcp": {\n    // keep unrelated MCP\n    "custom": {},\n    "codemem": {\n      "enabled": false,\n      "stale": true /* preserve note */,\n    },\n  },\n}\n',
			"utf-8",
		);

		writeJsonConfig(configPath, {
			mcp: { custom: {}, codemem: { enabled: true } },
		});

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain("// keep unrelated MCP");
		expect(updated).toContain("/* preserve note */");
		expect(updated).not.toContain('"stale"');
		expect(loadJsoncConfig(configPath)).toEqual({
			mcp: { custom: {}, codemem: { enabled: true } },
		});
	});
});

describe("writeJsonConfig comment placement", () => {
	it("appends after an array entry with a trailing line comment and no comma", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "plugin": [\n    "other-plugin" // keep with user plugin\n  ],\n}\n',
			"utf-8",
		);

		writeJsonConfig(configPath, {
			plugin: ["other-plugin", "@codemem/opencode-plugin"],
		});

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain('"other-plugin" // keep with user plugin');
		expect(loadJsoncConfig(configPath)).toEqual({
			plugin: ["other-plugin", "@codemem/opencode-plugin"],
		});
	});

	it("removes duplicate managed plugin entries without removing their comments", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			[
				"{",
				'  "plugin": [',
				'    "codemem", // legacy comment',
				'    "other-plugin", /* unrelated comment */',
				'    "@codemem/opencode-plugin@0.44.0" // pinned comment',
				"  ],",
				"}",
				"",
			].join("\n"),
			"utf-8",
		);
		const current = loadJsoncConfig(configPath);
		const reconciled = reconcileOpencodePluginConfig(current, { force: true });

		writeJsonConfig(configPath, reconciled.config);
		const firstOutput = readFileSync(configPath, "utf-8");
		writeJsonConfig(configPath, reconciled.config);

		expect(firstOutput).toContain("// legacy comment");
		expect(firstOutput).toContain("/* unrelated comment */");
		expect(firstOutput).toContain("// pinned comment");
		expect(loadJsoncConfig(configPath)).toEqual({
			plugin: ["other-plugin", "@codemem/opencode-plugin"],
		});
		expect(readFileSync(configPath, "utf-8")).toBe(firstOutput);
	});

	it("moves a legacy managed-plugin comment to its canonical replacement", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "plugin": [\n    "codemem", /* legacy note */\n    "other-plugin",\n  ],\n}\n',
			"utf-8",
		);
		const current = loadJsoncConfig(configPath);
		const reconciled = reconcileOpencodePluginConfig(current, { force: true });

		writeJsonConfig(configPath, reconciled.config);

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain('"@codemem/opencode-plugin", /* legacy note */');
		expect(updated).not.toContain('"other-plugin", /* legacy note */');
	});

	it("inserts into an object whose last property has a trailing line comment", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "mcp": {\n    "custom": {} // keep with custom MCP\n  },\n}\n',
			"utf-8",
		);

		writeJsonConfig(configPath, {
			mcp: { custom: {}, codemem: { enabled: true } },
		});

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain('"custom": {} // keep with custom MCP');
		expect(loadJsoncConfig(configPath)).toEqual({
			mcp: { codemem: { enabled: true }, custom: {} },
		});
	});

	it("keeps comments next to an updated Codemem-owned scalar", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "mcp": {\n    "codemem": {\n      "enabled": false /* user note */,\n    },\n  },\n}\n',
			"utf-8",
		);

		writeJsonConfig(configPath, { mcp: { codemem: { enabled: true } } });

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain("true /* user note */");
		expect(loadJsoncConfig(configPath)).toEqual({ mcp: { codemem: { enabled: true } } });
	});
});

describe("writeJsonConfig array comment placement", () => {
	it("keeps comments from removed launcher arguments during a shrinking migration", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "mcp": {\n    "codemem": {\n      "command": [\n        "npx", // runner note\n        "-y", /* install note */\n        "codemem",\n        "mcp",\n      ],\n    },\n  },\n}\n',
			"utf-8",
		);

		const command = ["codemem", "mcp"];
		writeJsonConfig(configPath, { mcp: { codemem: { command } } });

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain("// runner note");
		expect(updated).toContain("/* install note */");
		expect(loadJsoncConfig(configPath)).toEqual({ mcp: { codemem: { command } } });
	});

	it("keeps comments while replacing and extending a managed command array", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "mcp": {\n    "codemem": {\n      "command": [\n        "uvx", // launcher note\n        "codemem", /* package note */\n      ],\n    },\n  },\n}\n',
			"utf-8",
		);

		const command = ["npx", "-y", "--package", "codemem", "codemem", "mcp"];
		writeJsonConfig(configPath, { mcp: { codemem: { command } } });

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain('"npx", // launcher note');
		expect(updated).toContain('"codemem", /* package note */');
		expect(updated).not.toContain('"-y", // launcher note');
		expect(updated).not.toContain('"-y", /* package note */');
		expect(loadJsoncConfig(configPath)).toEqual({ mcp: { codemem: { command } } });
	});

	it("keeps own-line comments with the following retained array value", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "mcp": {\n    "codemem": {\n      "command": [\n        "uvx",\n        // package note\n        "codemem",\n      ],\n    },\n  },\n}\n',
			"utf-8",
		);

		const command = ["npx", "-y", "--package", "codemem", "codemem", "mcp"];
		writeJsonConfig(configPath, { mcp: { codemem: { command } } });

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain('"codemem", // package note');
		expect(updated).not.toContain('"npx", // package note');
		expect(loadJsoncConfig(configPath)).toEqual({ mcp: { codemem: { command } } });
	});

	it("keeps comments when expanding an empty managed command array", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "mcp": {\n    "codemem": {\n      "command": [ /* installation note */ ],\n    },\n  },\n}\n',
			"utf-8",
		);

		const command = ["npx", "-y", "codemem", "mcp"];
		writeJsonConfig(configPath, { mcp: { codemem: { command } } });

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain("/* installation note */");
		expect(loadJsoncConfig(configPath)).toEqual({ mcp: { codemem: { command } } });
	});

	it("keeps a multiline block comment with the preceding array value", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "mcp": {\n    "codemem": {\n      "command": [\n        "uvx", /* launcher\n          note */\n        "codemem",\n      ],\n    },\n  },\n}\n',
			"utf-8",
		);

		const command = ["npx", "-y", "--package", "codemem", "codemem", "mcp"];
		writeJsonConfig(configPath, { mcp: { codemem: { command } } });

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain('"npx", /* launcher\n          note */');
		expect(loadJsoncConfig(configPath)).toEqual({ mcp: { codemem: { command } } });
	});
});

describe("writeJsonConfig deletion comment placement", () => {
	it("preserves a comment between a deleted property key and value", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "mcp": {\n    "codemem": {\n      "stale": /* deployment note */ true,\n      "enabled": true,\n    },\n  },\n}\n',
			"utf-8",
		);

		writeJsonConfig(configPath, { mcp: { codemem: { enabled: true } } });

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain("/* deployment note */");
		expect(loadJsoncConfig(configPath)).toEqual({ mcp: { codemem: { enabled: true } } });
	});

	it("preserves comments nested inside deleted property values", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "mcp": {\n    "codemem": {\n      "staleObject": { /* object note */ "url": "https://example.test" },\n      "staleArray": ["legacy", /* array note */],\n      "enabled": true,\n    },\n  },\n}\n',
			"utf-8",
		);

		writeJsonConfig(configPath, { mcp: { codemem: { enabled: true } } });

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain("/* object note */");
		expect(updated).toContain("/* array note */");
		expect(updated).not.toContain("example.test");
		expect(loadJsoncConfig(configPath)).toEqual({ mcp: { codemem: { enabled: true } } });
	});

	it("deletes stale own properties whose names exist on Object.prototype", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "mcp": {\n    "codemem": {\n      "constructor": true,\n      "enabled": true,\n    },\n  },\n}\n',
			"utf-8",
		);

		writeJsonConfig(configPath, { mcp: { codemem: { enabled: true } } });

		expect(loadJsoncConfig(configPath)).toEqual({ mcp: { codemem: { enabled: true } } });
	});
});

describe("writeJsonConfig composite replacement comment placement", () => {
	it("preserves nested comments when repairing a composite value with a different type", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(
			configPath,
			'{\n  "mcp": {\n    "codemem": [\n      // legacy deployment note\n      "invalid",\n    ],\n  },\n}\n',
			"utf-8",
		);
		const codemem = { command: ["codemem", "mcp"] };

		writeJsonConfig(configPath, { mcp: { codemem } });

		const updated = readFileSync(configPath, "utf-8");
		expect(updated).toContain("// legacy deployment note");
		expect(loadJsoncConfig(configPath)).toEqual({ mcp: { codemem } });
	});
});

describe("writeJsonConfig safety", () => {
	it("leaves malformed input and its backup untouched", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		const malformed = '{\n  "plugin": [\n';
		writeFileSync(configPath, malformed, "utf-8");

		expect(() => writeJsonConfig(configPath, { plugin: [] })).toThrow();
		expect(readFileSync(configPath, "utf-8")).toBe(malformed);
		expect(existsSync(`${configPath}.codemem.bak`)).toBe(false);
		expect(readdirSync(dir).some((name) => name.includes(".codemem.tmp-"))).toBe(false);
	});

	it("rejects unterminated comments without writing or backing up", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		const malformed = '{\n  "plugin": [] /* unfinished\n}\n';
		writeFileSync(configPath, malformed, "utf-8");

		expect(() => writeJsonConfig(configPath, { plugin: ["@codemem/opencode-plugin"] })).toThrow();
		expect(readFileSync(configPath, "utf-8")).toBe(malformed);
		expect(existsSync(`${configPath}.codemem.bak`)).toBe(false);
	});

	it("rejects an unfinished block comment after a complete object", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		const malformed = "{}\n/* unfinished";
		writeFileSync(configPath, malformed, "utf-8");

		expect(() => writeJsonConfig(configPath, { plugin: ["@codemem/opencode-plugin"] })).toThrow(
			"Unterminated block comment",
		);
		expect(readFileSync(configPath, "utf-8")).toBe(malformed);
		expect(existsSync(`${configPath}.codemem.bak`)).toBe(false);
	});
});

describe("writeJsonConfig path safety", () => {
	it.each([
		'{\n  "plugin": ["first"],\n  "plugin": ["effective"],\n}\n',
		'{\n  "mcp": { "codemem": { "enabled": false } },\n  "mcp": { "custom": {} },\n}\n',
	])("rejects duplicate effective config keys before mutation", (duplicateConfig) => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(configPath, duplicateConfig, "utf-8");

		expect(() => writeJsonConfig(configPath, { plugin: ["@codemem/opencode-plugin"] })).toThrow(
			"Duplicate JSONC key",
		);
		expect(readFileSync(configPath, "utf-8")).toBe(duplicateConfig);
		expect(existsSync(`${configPath}.codemem.bak`)).toBe(false);
	});

	it("rejects symlink-managed configs without replacing the link or target", () => {
		const dir = makeTempDir();
		const targetPath = join(dir, "managed.jsonc");
		const configPath = join(dir, "opencode.jsonc");
		const original = '{\n  "plugin": ["other-plugin"],\n}\n';
		writeFileSync(targetPath, original, "utf-8");
		chmodSync(targetPath, 0o640);
		symlinkSync(targetPath, configPath);

		expect(() =>
			writeJsonConfig(configPath, { plugin: ["other-plugin", "@codemem/opencode-plugin"] }),
		).toThrow("Refusing to replace symlink-managed config");
		expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
		expect(readFileSync(targetPath, "utf-8")).toBe(original);
		expect(statSync(targetPath).mode & 0o777).toBe(0o640);
		expect(existsSync(`${configPath}.codemem.bak`)).toBe(false);
	});

	it("replaces a symlink-managed backup without modifying its target", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		const backupTargetPath = join(dir, "backup-target.jsonc");
		const backupPath = `${configPath}.codemem.bak`;
		writeFileSync(configPath, "{}\n", "utf-8");
		writeFileSync(backupTargetPath, '{"keep":true}\n', "utf-8");
		symlinkSync(backupTargetPath, backupPath);

		writeJsonConfig(configPath, { plugin: ["@codemem/opencode-plugin"] });

		expect(lstatSync(backupPath).isSymbolicLink()).toBe(false);
		expect(readFileSync(backupPath, "utf-8")).toBe("{}\n");
		expect(readFileSync(backupTargetPath, "utf-8")).toBe('{"keep":true}\n');
		expect(loadJsoncConfig(configPath)).toEqual({ plugin: ["@codemem/opencode-plugin"] });
	});

	it("replaces a hard-linked backup without modifying its other inode link", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		const backupTargetPath = join(dir, "backup-target.jsonc");
		const backupPath = `${configPath}.codemem.bak`;
		writeFileSync(configPath, "{}\n", "utf-8");
		writeFileSync(backupTargetPath, '{"keep":true}\n', "utf-8");
		linkSync(backupTargetPath, backupPath);

		writeJsonConfig(configPath, { plugin: ["@codemem/opencode-plugin"] });

		expect(statSync(backupPath).ino).not.toBe(statSync(backupTargetPath).ino);
		expect(readFileSync(backupPath, "utf-8")).toBe("{}\n");
		expect(readFileSync(backupTargetPath, "utf-8")).toBe('{"keep":true}\n');
		expect(loadJsoncConfig(configPath)).toEqual({ plugin: ["@codemem/opencode-plugin"] });
	});

	it("writes a new config atomically with a trailing newline", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");

		writeJsonConfig(configPath, { plugin: ["@codemem/opencode-plugin"] });

		const output = readFileSync(configPath, "utf-8");
		expect(output.endsWith("\n")).toBe(true);
		expect(loadJsoncConfig(configPath)).toEqual({ plugin: ["@codemem/opencode-plugin"] });
		expect(existsSync(`${configPath}.codemem.bak`)).toBe(false);
	});

	it("preserves the mode of an atomically replaced config", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		writeFileSync(configPath, "{}\n", { mode: 0o640 });

		writeJsonConfig(configPath, { plugin: ["@codemem/opencode-plugin"] });

		expect(statSync(configPath).mode & 0o777).toBe(0o640);
	});

	it("can preserve the first backup across multiple writes in one setup run", () => {
		const dir = makeTempDir();
		const configPath = join(dir, "opencode.jsonc");
		const original = "{}\n";
		writeFileSync(configPath, original, "utf-8");

		writeJsonConfig(configPath, { plugin: ["@codemem/opencode-plugin"] });
		writeJsonConfig(
			configPath,
			{ plugin: ["@codemem/opencode-plugin"], mcp: {} },
			{ createBackup: false },
		);

		expect(readFileSync(`${configPath}.codemem.bak`, "utf-8")).toBe(original);
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
