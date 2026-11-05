/**
 * Tests for codemem setup — OpenCode MCP entry handling.
 *
 * Default setup removes the stdio MCP entries it used to write (V1 `mcp.codemem`
 * and V2 `mcp.servers.codemem`) and leaves customized entries in place.
 * `--opencode-mcp stdio` keeps writing the per-project entry.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codememMcpLauncher, migrateLegacyOpencodeMcp, setupCommand } from "./setup.js";
import { loadJsoncConfig } from "./setup-config.js";

const NPX_LAUNCHER = codememMcpLauncher(false);
const NPX_COMMAND = [NPX_LAUNCHER.command, ...NPX_LAUNCHER.args];

const MANAGED_COMMANDS: [string, string[]][] = [
	["bare codemem", ["codemem", "mcp"]],
	["current npx launcher", NPX_COMMAND],
	["npx -y single package", ["npx", "-y", "codemem", "mcp"]],
	["npx single package", ["npx", "codemem", "mcp"]],
	["uvx", ["uvx", "codemem", "mcp"]],
];

const savedHome = process.env.HOME;
const savedPath = process.env.PATH;
const savedExitCode = process.exitCode;
let home: string;
let configPath: string;
const logs: Record<"success" | "info" | "warn" | "error" | "step", string[]> = {
	success: [],
	info: [],
	warn: [],
	error: [],
	step: [],
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "codemem-setup-opencode-"));
	process.env.HOME = home;
	// An empty PATH makes the launcher probe fail, so stdio writes the npx form.
	process.env.PATH = join(home, "empty-bin");
	configPath = join(home, ".config", "opencode", "opencode.jsonc");
	mkdirSync(join(home, ".config", "opencode"), { recursive: true });
	for (const level of Object.keys(logs) as (keyof typeof logs)[]) {
		logs[level] = [];
		vi.spyOn(p.log, level).mockImplementation((msg: string) => {
			logs[level].push(msg);
		});
	}
});

afterEach(() => {
	vi.restoreAllMocks();
	process.env.HOME = savedHome;
	process.env.PATH = savedPath;
	process.exitCode = savedExitCode;
	rmSync(home, { recursive: true, force: true });
});

async function runSetup(...args: string[]): Promise<void> {
	await setupCommand.parseAsync(["--opencode-only", ...args], { from: "user" });
}

function writeConfig(raw: string): void {
	writeFileSync(configPath, raw, "utf-8");
}

function readRaw(): string {
	return readFileSync(configPath, "utf-8");
}

function seed(config: Record<string, unknown>): string {
	const raw = `${JSON.stringify({ plugin: ["@codemem/opencode-plugin"], ...config }, null, 2)}\n`;
	writeConfig(raw);
	return raw;
}

describe("codemem setup (OpenCode) — removes managed MCP entries", () => {
	it.each(MANAGED_COMMANDS)("removes a V1 mcp.codemem entry using %s", async (_name, command) => {
		const original = seed({ mcp: { codemem: { type: "local", command, enabled: true } } });

		await runSetup();

		expect(loadJsoncConfig(configPath)).toEqual({ plugin: ["@codemem/opencode-plugin"] });
		expect(readFileSync(`${configPath}.codemem.bak`, "utf-8")).toBe(original);
		expect(logs.success.join("\n")).toContain(`Removed the codemem MCP entry mcp.codemem`);
		expect(logs.success.join("\n")).toContain(configPath);
		expect(logs.info.join("\n")).toContain("Memory tools now come from the codemem plugin");
		expect(process.exitCode).not.toBe(1);
	});

	it.each(MANAGED_COMMANDS)(
		"removes a V2 mcp.servers.codemem entry using %s",
		async (_name, command) => {
			const original = seed({ mcp: { servers: { codemem: { type: "local", command } } } });

			await runSetup();

			expect(loadJsoncConfig(configPath)).toEqual({ plugin: ["@codemem/opencode-plugin"] });
			expect(readFileSync(`${configPath}.codemem.bak`, "utf-8")).toBe(original);
			expect(logs.success.join("\n")).toContain("mcp.servers.codemem");
		},
	);

	it("removes a disabled managed entry", async () => {
		seed({
			mcp: { servers: { codemem: { type: "local", command: ["codemem", "mcp"], disabled: true } } },
		});

		await runSetup();

		expect(loadJsoncConfig(configPath).mcp).toBeUndefined();
	});

	it("keeps unrelated servers, settings, and comments", async () => {
		writeConfig(`{
  // top comment
  "plugin": ["@codemem/opencode-plugin"],
  "mcp": {
    "timeout": { "startup": 45000 },
    "servers": {
      // docs server
      "docs": { "type": "remote", "url": "https://mcp.example.com/mcp" },
      "codemem": { "type": "local", "command": ["codemem", "mcp"] },
    },
  },
}
`);

		await runSetup();

		const raw = readRaw();
		expect(raw).toContain("// top comment");
		expect(raw).toContain("// docs server");
		// Sibling entries keep their original formatting.
		expect(raw).toContain('"docs": { "type": "remote", "url": "https://mcp.example.com/mcp" },');
		expect(raw).not.toContain('"codemem"');
		expect(loadJsoncConfig(configPath).mcp).toEqual({
			timeout: { startup: 45000 },
			servers: { docs: { type: "remote", url: "https://mcp.example.com/mcp" } },
		});
	});

	it("keeps an emptied container that holds a comment", async () => {
		writeConfig(`{
  "plugin": ["@codemem/opencode-plugin"],
  "mcp": {
    // memory server
    "codemem": { "type": "local", "command": ["codemem", "mcp"], "enabled": true },
  },
}
`);

		await runSetup();

		expect(readRaw()).toContain("// memory server");
		expect(loadJsoncConfig(configPath).mcp).toEqual({});
	});

	it("removes the plugin's V1 entry alongside a fresh plugin install", async () => {
		const original = `${JSON.stringify(
			{ mcp: { codemem: { type: "local", command: ["codemem", "mcp"], enabled: true } } },
			null,
			2,
		)}\n`;
		writeConfig(original);

		await runSetup();

		expect(loadJsoncConfig(configPath)).toEqual({ plugin: ["@codemem/opencode-plugin"] });
		// The first write of the run owns the backup, so it holds the original file.
		expect(readFileSync(`${configPath}.codemem.bak`, "utf-8")).toBe(original);
	});

	it("is idempotent across repeated runs", async () => {
		seed({ mcp: { codemem: { type: "local", command: ["codemem", "mcp"], enabled: true } } });

		await runSetup();
		const afterFirst = readRaw();
		logs.success = [];
		await runSetup();

		expect(readRaw()).toBe(afterFirst);
		expect(logs.success).toEqual([]);
		expect(logs.info.join("\n")).toContain("no MCP entry needed");
	});

	it("writes nothing when there is no OpenCode config yet beyond the plugin", async () => {
		await runSetup();

		expect(loadJsoncConfig(configPath)).toEqual({ plugin: ["@codemem/opencode-plugin"] });
	});
});

describe("codemem setup (OpenCode) — leaves customized entries alone", () => {
	const cases: [string, string, Record<string, unknown>, string][] = [
		[
			"environment",
			"v1",
			{ type: "local", command: ["codemem", "mcp"], environment: { CODEMEM_DB: "/tmp/x" } },
			"sets environment variables",
		],
		["cwd", "v2", { type: "local", command: ["codemem", "mcp"], cwd: "~" }, "working directory"],
		[
			"custom command",
			"v1",
			{ type: "local", command: ["npx", "-y", "codemem@next", "mcp"], enabled: true },
			"custom command",
		],
		["remote", "v2", { type: "remote", url: "https://example.com/mcp" }, "remote server"],
		[
			"extra fields",
			"v2",
			{ type: "local", command: ["codemem", "mcp"], timeout: { startup: 1000 } },
			"sets timeout",
		],
	];

	it.each(cases)("keeps and reports an entry with %s", async (_name, shape, entry, reason) => {
		const mcp = shape === "v2" ? { servers: { codemem: entry } } : { codemem: entry };
		const original = seed({ mcp });

		await runSetup();

		expect(readRaw()).toBe(original);
		expect(existsSync(`${configPath}.codemem.bak`)).toBe(false);
		const label = shape === "v2" ? "mcp.servers.codemem" : "mcp.codemem";
		const warning = logs.warn.join("\n");
		expect(warning).toContain(label);
		expect(warning).toContain(configPath);
		expect(warning).toContain(reason);
		expect(process.exitCode).not.toBe(1);
	});

	it("removes a managed V1 entry while keeping a custom V2 entry", async () => {
		seed({
			mcp: {
				codemem: { type: "local", command: ["codemem", "mcp"], enabled: true },
				servers: {
					codemem: { type: "local", command: ["codemem", "mcp"], environment: { A: "1" } },
				},
			},
		});

		await runSetup();

		expect(loadJsoncConfig(configPath).mcp).toEqual({
			servers: { codemem: { type: "local", command: ["codemem", "mcp"], environment: { A: "1" } } },
		});
		expect(logs.warn.join("\n")).toContain("mcp.servers.codemem");
	});
});

describe("codemem setup --opencode-mcp stdio", () => {
	it("writes the V1 stdio entry on a fresh config", async () => {
		await runSetup("--opencode-mcp", "stdio");

		expect(loadJsoncConfig(configPath).mcp).toEqual({
			codemem: { type: "local", command: NPX_COMMAND, enabled: true },
		});
		expect(logs.success.join("\n")).toContain("MCP entry installed");
	});

	it("writes the V2 shape when the file already uses mcp.servers", async () => {
		seed({ mcp: { servers: { docs: { type: "remote", url: "https://mcp.example.com/mcp" } } } });

		await runSetup("--opencode-mcp", "stdio");

		expect(loadJsoncConfig(configPath).mcp).toEqual({
			servers: {
				docs: { type: "remote", url: "https://mcp.example.com/mcp" },
				codemem: { type: "local", command: NPX_COMMAND },
			},
		});
	});

	it("keeps an existing managed entry and is idempotent", async () => {
		const original = seed({
			mcp: { codemem: { type: "local", command: ["codemem", "mcp"], enabled: true } },
		});

		await runSetup("--opencode-mcp", "stdio");
		await runSetup("--opencode-mcp", "stdio");

		expect(readRaw()).toBe(original);
		expect(logs.info.join("\n")).toContain("MCP entry already exists");
	});

	it("upgrades a legacy launcher in the V2 shape", async () => {
		seed({
			mcp: { servers: { codemem: { type: "local", command: ["npx", "-y", "codemem", "mcp"] } } },
		});

		await runSetup("--opencode-mcp", "stdio");

		expect(loadJsoncConfig(configPath).mcp).toEqual({
			servers: { codemem: { type: "local", command: NPX_COMMAND } },
		});
	});

	it("rejects an unknown mode with a usage error and writes nothing", async () => {
		const original = seed({});

		await runSetup("--opencode-mcp", "http");

		expect(process.exitCode).toBe(2);
		expect(logs.error.join("\n")).toContain('Unknown --opencode-mcp mode "http"');
		expect(readRaw()).toBe(original);
	});

	it("declares --opencode-mcp", () => {
		expect(setupCommand.options.map((o) => o.long)).toContain("--opencode-mcp");
	});
});

describe("migrateLegacyOpencodeMcp — V2 shape", () => {
	it("upgrades a legacy launcher under mcp.servers while preserving fields", () => {
		const config = {
			mcp: {
				servers: {
					codemem: { type: "local", command: ["uvx", "codemem", "mcp"], disabled: true },
				},
			},
		};

		expect(migrateLegacyOpencodeMcp(config, { launcher: NPX_LAUNCHER })).toBe(true);
		expect(config.mcp.servers.codemem).toEqual({
			type: "local",
			command: NPX_COMMAND,
			disabled: true,
		});
	});
});
