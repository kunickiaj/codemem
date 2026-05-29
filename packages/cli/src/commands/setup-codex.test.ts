import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildCodememCodexHookGroups,
	codememCodexHookBase,
	codexConfigDir,
	installCodex,
	isTransientNpxBinPath,
	setupCommand,
} from "./setup.js";

// Resolve the same command base the implementation will use in this environment
// (direct `codemem` when on PATH, else `npx -y codemem`) so integration
// assertions are deterministic across dev and CI.
const HOOK_BASE = codememCodexHookBase();
const INGEST_CMD = `${HOOK_BASE} codex-hook-ingest`;
const INJECT_CMD = `${HOOK_BASE} codex-hook-inject`;
const INGEST_TIMEOUT = HOOK_BASE === "codemem" ? 10 : 30;
const INJECT_TIMEOUT = HOOK_BASE === "codemem" ? 10 : 20;

const savedCodexHome = process.env.CODEX_HOME;
let codexHome: string;

beforeEach(() => {
	codexHome = mkdtempSync(join(tmpdir(), "codemem-setup-codex-"));
	process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
	if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = savedCodexHome;
	rmSync(codexHome, { recursive: true, force: true });
});

interface CodexHookCommand {
	type: string;
	command: string;
	timeout: number;
	statusMessage: string;
}

interface CodexHookGroup {
	hooks: CodexHookCommand[];
}

function readHooks(): Record<string, CodexHookGroup[]> {
	const raw = readFileSync(join(codexHome, "hooks.json"), "utf-8");
	return (JSON.parse(raw) as { hooks: Record<string, CodexHookGroup[]> }).hooks;
}

function groupsFor(hooks: Record<string, CodexHookGroup[]>, event: string): CodexHookGroup[] {
	const groups = hooks[event];
	if (!groups) throw new Error(`expected hook groups for ${event}`);
	return groups;
}

function readConfigToml(): string {
	return readFileSync(join(codexHome, "config.toml"), "utf-8");
}

describe("codexConfigDir", () => {
	it("honors CODEX_HOME", () => {
		expect(codexConfigDir()).toBe(codexHome);
	});
});

describe("installCodex — fresh CODEX_HOME", () => {
	it("writes the MCP block and all four hook events with correct schema", () => {
		expect(installCodex(false)).toBe(true);

		const toml = readConfigToml();
		expect(toml).toContain("[mcp_servers.codemem]");
		expect(toml).toContain('command = "npx"');
		expect(toml).toContain('args = ["-y", "codemem", "mcp"]');
		expect(toml).toContain("startup_timeout_sec = 30");
		expect(toml).toContain("tool_timeout_sec = 60");

		const hooks = readHooks();
		expect(Object.keys(hooks).sort()).toEqual([
			"PostToolUse",
			"SessionStart",
			"Stop",
			"UserPromptSubmit",
		]);

		// Single-ingest events.
		for (const event of ["SessionStart", "PostToolUse", "Stop"]) {
			const groups = groupsFor(hooks, event);
			expect(groups).toHaveLength(1);
			const group = groups[0];
			if (!group) throw new Error(`missing group for ${event}`);
			expect(group.hooks).toHaveLength(1);
			expect(group.hooks[0]).toEqual({
				type: "command",
				command: INGEST_CMD,
				timeout: INGEST_TIMEOUT,
				statusMessage: "codemem",
			});
		}

		// UserPromptSubmit has BOTH ingest then inject, in order.
		const ups = groupsFor(hooks, "UserPromptSubmit");
		expect(ups).toHaveLength(1);
		const upsGroup = ups[0];
		if (!upsGroup) throw new Error("missing UserPromptSubmit group");
		expect(upsGroup.hooks).toHaveLength(2);
		expect(upsGroup.hooks[0]).toEqual({
			type: "command",
			command: INGEST_CMD,
			timeout: INGEST_TIMEOUT,
			statusMessage: "codemem capture",
		});
		expect(upsGroup.hooks[1]).toEqual({
			type: "command",
			command: INJECT_CMD,
			timeout: INJECT_TIMEOUT,
			statusMessage: "codemem recall",
		});
	});

	it("creates CODEX_HOME if it does not yet exist", () => {
		const nested = join(codexHome, "nested", "codex");
		process.env.CODEX_HOME = nested;
		expect(existsSync(nested)).toBe(false);

		expect(installCodex(false)).toBe(true);

		expect(existsSync(join(nested, "config.toml"))).toBe(true);
		expect(existsSync(join(nested, "hooks.json"))).toBe(true);
	});
});

describe("installCodex — idempotency", () => {
	it("does not duplicate the MCP block or hook entries on re-run", () => {
		expect(installCodex(false)).toBe(true);
		expect(installCodex(false)).toBe(true);

		const toml = readConfigToml();
		const mcpOccurrences = toml.split("[mcp_servers.codemem]").length - 1;
		expect(mcpOccurrences).toBe(1);

		const hooks = readHooks();
		expect(groupsFor(hooks, "SessionStart")).toHaveLength(1);
		expect(groupsFor(hooks, "PostToolUse")).toHaveLength(1);
		expect(groupsFor(hooks, "Stop")).toHaveLength(1);
		const ups = groupsFor(hooks, "UserPromptSubmit");
		expect(ups).toHaveLength(1);
		expect(ups[0]?.hooks).toHaveLength(2);
	});

	it("does not duplicate codemem hooks when run again with --force", () => {
		expect(installCodex(false)).toBe(true);
		expect(installCodex(true)).toBe(true);

		const hooks = readHooks();
		expect(groupsFor(hooks, "SessionStart")).toHaveLength(1);
		const ups = groupsFor(hooks, "UserPromptSubmit");
		expect(ups).toHaveLength(1);
		expect(ups[0]?.hooks).toHaveLength(2);
	});
});

describe("installCodex — non-destructive merge", () => {
	it("preserves unrelated config.toml content (comments + other MCP servers)", () => {
		const original = [
			"# my codex config",
			"",
			"[mcp_servers.other]",
			'command = "other-cmd"',
			"",
		].join("\n");
		writeFileSync(join(codexHome, "config.toml"), original, "utf-8");

		expect(installCodex(false)).toBe(true);

		const toml = readConfigToml();
		expect(toml).toContain("# my codex config");
		expect(toml).toContain("[mcp_servers.other]");
		expect(toml).toContain('command = "other-cmd"');
		expect(toml).toContain("[mcp_servers.codemem]");
	});

	it("preserves an unrelated user SessionStart hook and adds the codemem hook", () => {
		const existing = {
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command: "echo user-hook",
								timeout: 10,
								statusMessage: "user",
							},
						],
					},
				],
			},
		};
		writeFileSync(join(codexHome, "hooks.json"), `${JSON.stringify(existing, null, 2)}\n`, "utf-8");

		expect(installCodex(false)).toBe(true);

		const hooks = readHooks();
		const sessionStart = groupsFor(hooks, "SessionStart");
		expect(sessionStart).toHaveLength(2);
		const commands = sessionStart.flatMap((g) => g.hooks.map((h) => h.command));
		expect(commands).toContain("echo user-hook");
		expect(commands).toContain(INGEST_CMD);
	});

	it("--force preserves an unrelated user hook on the same event", () => {
		const existing = {
			hooks: {
				UserPromptSubmit: [
					{
						hooks: [
							{ type: "command", command: "echo user-ups", timeout: 10, statusMessage: "user" },
						],
					},
				],
			},
		};
		writeFileSync(join(codexHome, "hooks.json"), `${JSON.stringify(existing, null, 2)}\n`, "utf-8");

		// Seed codemem hooks, then re-run with --force.
		expect(installCodex(false)).toBe(true);
		expect(installCodex(true)).toBe(true);

		const hooks = readHooks();
		const ups = groupsFor(hooks, "UserPromptSubmit");
		const commands = ups.flatMap((g) => g.hooks.map((h) => h.command));
		// Unrelated user hook survives; codemem hooks present exactly once.
		expect(commands).toContain("echo user-ups");
		expect(commands.filter((c) => c === INGEST_CMD)).toHaveLength(1);
		expect(commands.filter((c) => c === INJECT_CMD)).toHaveLength(1);
	});
});

describe("isTransientNpxBinPath", () => {
	it("flags npx/dlx cache bins so they are not baked into hooks", () => {
		expect(isTransientNpxBinPath("/Users/x/.npm/_npx/abc123/node_modules/.bin/codemem")).toBe(true);
		expect(isTransientNpxBinPath("/tmp/.pnpm/dlx/abc/node_modules/.bin/codemem")).toBe(true);
	});

	it("treats durable global/managed bins as on-PATH", () => {
		expect(isTransientNpxBinPath("/usr/local/bin/codemem")).toBe(false);
		expect(isTransientNpxBinPath("/Users/x/.local/share/mise/installs/node/lts/bin/codemem")).toBe(
			false,
		);
		expect(isTransientNpxBinPath("C\\\\Program Files\\\\nodejs\\\\codemem.cmd")).toBe(false);
	});
});

describe("setup command options", () => {
	it("declares both --codex and --codex-only", () => {
		const longs = setupCommand.options.map((o) => o.long);
		expect(longs).toContain("--codex");
		expect(longs).toContain("--codex-only");
	});
});

describe("buildCodememCodexHookGroups — command base", () => {
	it("uses a direct `codemem` call with short timeouts when on PATH", () => {
		const groups = buildCodememCodexHookGroups("codemem");
		const ups = groups.UserPromptSubmit?.[0]?.hooks ?? [];
		expect(ups[0]).toEqual({
			type: "command",
			command: "codemem codex-hook-ingest",
			timeout: 10,
			statusMessage: "codemem capture",
		});
		expect(ups[1]).toEqual({
			type: "command",
			command: "codemem codex-hook-inject",
			timeout: 10,
			statusMessage: "codemem recall",
		});
		expect(groups.SessionStart?.[0]?.hooks?.[0]?.command).toBe("codemem codex-hook-ingest");
	});

	it("uses `npx -y codemem` with generous timeouts as the fallback", () => {
		const groups = buildCodememCodexHookGroups("npx -y codemem");
		const ups = groups.UserPromptSubmit?.[0]?.hooks ?? [];
		expect(ups[0]).toEqual({
			type: "command",
			command: "npx -y codemem codex-hook-ingest",
			timeout: 30,
			statusMessage: "codemem capture",
		});
		expect(ups[1]).toEqual({
			type: "command",
			command: "npx -y codemem codex-hook-inject",
			timeout: 20,
			statusMessage: "codemem recall",
		});
		expect(groups.Stop?.[0]?.hooks?.[0]?.command).toBe("npx -y codemem codex-hook-ingest");
	});
});

describe("installCodex — config.toml MCP detection edge cases", () => {
	it("does not treat a sibling [mcp_servers.codemem-foo] table as ours (appends our block)", () => {
		writeFileSync(
			join(codexHome, "config.toml"),
			'[mcp_servers.codemem-foo]\ncommand = "x"\n',
			"utf-8",
		);

		expect(installCodex(false)).toBe(true);

		const toml = readConfigToml();
		expect(toml).toContain("[mcp_servers.codemem-foo]");
		// Our real block was appended (distinct from the sibling).
		expect(toml.split("[mcp_servers.codemem]").length - 1).toBe(1);
	});

	it('detects a quoted [mcp_servers."codemem"] table and does not append a duplicate', () => {
		writeFileSync(
			join(codexHome, "config.toml"),
			'[mcp_servers."codemem"]\ncommand = "npx"\n',
			"utf-8",
		);

		expect(installCodex(false)).toBe(true);

		const toml = readConfigToml();
		// No unquoted duplicate appended.
		expect(toml).not.toContain("[mcp_servers.codemem]\n");
	});

	it("tolerates whitespace inside the table header", () => {
		writeFileSync(
			join(codexHome, "config.toml"),
			'[ mcp_servers . codemem ]\ncommand = "npx"\n',
			"utf-8",
		);

		expect(installCodex(false)).toBe(true);

		const toml = readConfigToml();
		expect(toml.split("[mcp_servers.codemem]").length - 1).toBe(0);
	});
});

describe("installCodex — malformed hooks.json", () => {
	it("returns false and does not clobber an unparseable hooks.json", () => {
		const broken = "{ this is not valid json ";
		writeFileSync(join(codexHome, "hooks.json"), broken, "utf-8");

		expect(installCodex(false)).toBe(false);
		// File left untouched (no overwrite, no backup-then-replace).
		expect(readFileSync(join(codexHome, "hooks.json"), "utf-8")).toBe(broken);
	});
});

describe("installCodex — backups", () => {
	it("backs up an existing config.toml before appending", () => {
		const original = '[mcp_servers.other]\ncommand = "x"\n';
		writeFileSync(join(codexHome, "config.toml"), original, "utf-8");

		expect(installCodex(false)).toBe(true);

		const backup = join(codexHome, "config.toml.codemem.bak");
		expect(existsSync(backup)).toBe(true);
		expect(readFileSync(backup, "utf-8")).toBe(original);
	});

	it("backs up an existing hooks.json before overwriting", () => {
		const existing = {
			hooks: {
				SessionStart: [
					{ hooks: [{ type: "command", command: "echo x", timeout: 1, statusMessage: "x" }] },
				],
			},
		};
		const serialized = `${JSON.stringify(existing, null, 2)}\n`;
		writeFileSync(join(codexHome, "hooks.json"), serialized, "utf-8");

		expect(installCodex(false)).toBe(true);

		const backup = join(codexHome, "hooks.json.codemem.bak");
		expect(existsSync(backup)).toBe(true);
		expect(readFileSync(backup, "utf-8")).toBe(serialized);
	});
});
