import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildCodememCodexHookGroups,
	codememCodexHookBase,
	codememMcpLauncher,
	codexConfigDir,
	installCodex,
	isTransientNpxBinPath,
	migrateLegacyClaudeMcp,
	migrateLegacyOpencodeMcp,
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
		const launcher = codememMcpLauncher();
		expect(toml).toContain("[mcp_servers.codemem]");
		expect(toml).toContain(`command = ${JSON.stringify(launcher.command)}`);
		expect(toml).toContain(
			`args = [${launcher.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
		);
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

describe("codememMcpLauncher", () => {
	it("uses the durable global binary so optional sibling packages resolve", () => {
		expect(codememMcpLauncher(true)).toEqual({ command: "codemem", args: ["mcp"] });
	});

	it("requests both runtime packages when falling back to npx", () => {
		expect(codememMcpLauncher(false)).toEqual({
			command: "npx",
			args: ["-y", "--package", "codemem", "--package", "@codemem/embeddings", "codemem", "mcp"],
		});
	});
});

describe("managed single-package MCP launcher migration", () => {
	it("upgrades exact OpenCode and Claude npx launchers while preserving fields", () => {
		const opencode = {
			mcp: {
				codemem: {
					type: "local",
					command: ["npx", "-y", "codemem", "mcp"],
					enabled: false,
				},
			},
		};
		const claude = {
			mcpServers: {
				codemem: {
					command: "npx",
					args: ["-y", "codemem", "mcp"],
					env: { CODEMEM_DB_PATH: "/tmp/example.sqlite" },
				},
			},
		};

		expect(migrateLegacyOpencodeMcp(opencode)).toBe(true);
		expect(migrateLegacyClaudeMcp(claude)).toBe(true);
		const launcher = codememMcpLauncher();
		expect(opencode.mcp.codemem).toEqual({
			type: "local",
			command: [launcher.command, ...launcher.args],
			enabled: false,
		});
		expect(claude.mcpServers.codemem).toEqual({
			command: launcher.command,
			args: launcher.args,
			env: { CODEMEM_DB_PATH: "/tmp/example.sqlite" },
		});
	});

	it("upgrades the older OpenCode launcher emitted without -y", () => {
		const opencode = {
			mcp: { codemem: { type: "local", command: ["npx", "codemem", "mcp"], enabled: true } },
		};

		expect(migrateLegacyOpencodeMcp(opencode)).toBe(true);
		const launcher = codememMcpLauncher();
		expect(opencode.mcp.codemem).toEqual({
			type: "local",
			command: [launcher.command, ...launcher.args],
			enabled: true,
		});
	});

	it("leaves custom npx launchers unchanged", () => {
		const opencode = {
			mcp: { codemem: { command: ["npx", "-y", "codemem@next", "mcp"] } },
		};
		const claude = {
			mcpServers: { codemem: { command: "npx", args: ["-y", "codemem", "custom"] } },
		};

		expect(migrateLegacyOpencodeMcp(opencode)).toBe(false);
		expect(migrateLegacyClaudeMcp(claude)).toBe(false);
		expect(opencode.mcp.codemem.command).toEqual(["npx", "-y", "codemem@next", "mcp"]);
		expect(claude.mcpServers.codemem.args).toEqual(["-y", "codemem", "custom"]);
	});
});

describe("installCodex — hook migration", () => {
	it("preserves an unrelated user hook sharing a group during migration", () => {
		// Old single-package codemem command AND an unrelated user command in the
		// same SessionStart group. A non-force rerun should migrate the codemem
		// command but keep the user's hook.
		const legacy = {
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command: "npx -y codemem codex-hook-ingest",
								timeout: 30,
								statusMessage: "codemem",
							},
							{ type: "command", command: "echo user-shared", timeout: 5, statusMessage: "user" },
						],
					},
				],
			},
		};
		writeFileSync(join(codexHome, "hooks.json"), `${JSON.stringify(legacy, null, 2)}\n`, "utf-8");

		expect(installCodex(false)).toBe(true);

		const commands = groupsFor(readHooks(), "SessionStart").flatMap((g) =>
			g.hooks.map((h) => h.command),
		);
		expect(commands).toContain("echo user-shared");
		expect(commands).not.toContain("npx -y codemem codex-hook-ingest");
		expect(commands).toContain(INGEST_CMD);
	});

	it("upgrades a previously generated single-package npx hook on a non-force rerun", () => {
		// Simulate hooks written by an earlier release: managed codemem commands
		// using the old single-package `npx -y codemem` base.
		const legacy = {
			hooks: {
				SessionStart: [
					{
						hooks: [
							{
								type: "command",
								command: "npx -y codemem codex-hook-ingest",
								timeout: 30,
								statusMessage: "codemem",
							},
						],
					},
				],
			},
		};
		writeFileSync(join(codexHome, "hooks.json"), `${JSON.stringify(legacy, null, 2)}\n`, "utf-8");

		expect(installCodex(false)).toBe(true);

		const hooks = readHooks();
		const commands = groupsFor(hooks, "SessionStart").flatMap((g) => g.hooks.map((h) => h.command));
		// The stale single-package command is gone; the current base is installed.
		expect(commands).not.toContain("npx -y codemem codex-hook-ingest");
		expect(commands).toContain(INGEST_CMD);
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
	it("upgrades the exact managed npx launcher and preserves unrelated TOML", () => {
		const original = [
			"# my codex config",
			"[mcp_servers.codemem]",
			'command = "npx"',
			'args = ["-y", "codemem", "mcp"]',
			"startup_timeout_sec = 30",
			"",
			"[mcp_servers.other]",
			'command = "other-cmd"',
			"",
		].join("\n");
		writeFileSync(join(codexHome, "config.toml"), original, "utf-8");

		expect(installCodex(false)).toBe(true);

		const launcher = codememMcpLauncher();
		const toml = readConfigToml();
		expect(toml).toContain(`command = ${JSON.stringify(launcher.command)}`);
		expect(toml).toContain(
			`args = [${launcher.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
		);
		expect(toml).toContain("# my codex config");
		expect(toml).toContain('[mcp_servers.other]\ncommand = "other-cmd"');
		expect(readFileSync(join(codexHome, "config.toml.codemem.bak"), "utf-8")).toBe(original);
	});

	it("does not rewrite a custom Codex npx launcher", () => {
		const original = [
			"[mcp_servers.codemem]",
			'command = "npx"',
			'args = ["-y", "codemem@next", "mcp"]',
			"",
		].join("\n");
		writeFileSync(join(codexHome, "config.toml"), original, "utf-8");

		expect(installCodex(false)).toBe(true);
		expect(readConfigToml()).toBe(original);
	});

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
	it("flags npx/dlx cache and project-local bins so they are not baked into hooks", () => {
		expect(isTransientNpxBinPath("/Users/x/.npm/_npx/abc123/node_modules/.bin/codemem")).toBe(true);
		expect(isTransientNpxBinPath("/tmp/.pnpm/dlx/abc/node_modules/.bin/codemem")).toBe(true);
		// A project-local install (npm exec / pnpm exec / package script) that the
		// global MCP hosts will not inherit on PATH.
		expect(isTransientNpxBinPath("/home/dev/my-project/node_modules/.bin/codemem")).toBe(true);
		expect(isTransientNpxBinPath("C:\\dev\\proj\\node_modules\\.bin\\codemem.cmd")).toBe(true);
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
	it("declares --codex-only (consistent with --opencode-only/--claude-only) and no redundant --codex", () => {
		const longs = setupCommand.options.map((o) => o.long);
		expect(longs).toContain("--codex-only");
		expect(longs).not.toContain("--codex");
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

	it("pairs the embedding runtime in the npx hook fallback base", () => {
		// When codemem is not on PATH, the fallback base must request both
		// packages so the local-store inject path can embed instead of degrading
		// to FTS. codememCodexHookBase resolves to this string in that case.
		const base = "npx -y --package codemem --package @codemem/embeddings codemem";
		const groups = buildCodememCodexHookGroups(base);
		expect(groups.SessionStart?.[0]?.hooks?.[0]?.command).toBe(`${base} codex-hook-ingest`);
		expect(groups.UserPromptSubmit?.[0]?.hooks?.[1]?.command).toBe(`${base} codex-hook-inject`);
		// Still treated as the npx (cold-resolve) path with generous timeouts.
		expect(groups.SessionStart?.[0]?.hooks?.[0]?.timeout).toBe(30);
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
