import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { ROOT_COMPLETION_COMMANDS, registerRootCommands } from "./command-tree.js";
import { helpStyle } from "./help-style.js";

const publicRoots = [
	"memory",
	"session",
	"service",
	"status",
	"sync",
	"coordinator",
	"maintenance",
	"diagnostics",
	"config",
	"setup",
	"update",
	"mcp",
];
const protocolRoots = [
	"serve",
	"pack",
	"recent",
	"stats",
	"search",
	"distill",
	"version",
	"pi-session-search",
	"prompt-pack-ledger",
	"claude-hook-file-context",
	"claude-hook-inject",
	"claude-hook-ingest",
	"codex-hook-inject",
	"codex-hook-ingest",
	"pi-hook-inject",
	"pi-hook-ingest",
	"enqueue-raw-event",
	"memory-tool",
];

function makeProgram() {
	return registerRootCommands(new Command("codemem").configureHelp(helpStyle))
		.exitOverride()
		.configureOutput({ writeErr: () => {} });
}

function atPath(program: Command, path: string[]): Command {
	return path.reduce((parent, name) => {
		const child = parent.commands.find((command) => command.name() === name);
		if (!child) throw new Error(`Missing command: ${path.join(" ")}`);
		return child;
	}, program);
}

describe("public command tree", () => {
	it("advertises exactly twelve roots in everyday-first order", () => {
		// Arrange
		const program = makeProgram();
		// Act
		const visible = program
			.createHelp()
			.visibleCommands(program)
			.map((command) => command.name());
		// Assert
		expect(visible.filter((name) => name !== "help")).toEqual(publicRoots);
		expect(
			ROOT_COMPLETION_COMMANDS.filter((name) => !["help", "--help", "--version"].includes(name)),
		).toEqual(publicRoots);
	});

	it("keeps installed protocol roots executable but absent from discovery", () => {
		// Arrange
		const program = makeProgram();
		// Act
		const registered = program.commands.map((command) => command.name());
		const visible = program
			.createHelp()
			.visibleCommands(program)
			.map((command) => command.name());
		// Assert
		for (const name of protocolRoots) {
			expect(registered).toContain(name);
			expect(visible).not.toContain(name);
			expect(ROOT_COMPLETION_COMMANDS).not.toContain(name);
		}
	});

	it.each([
		"show",
		"forget",
		"remember",
		"capture",
		"db",
		"embed",
		"export-memories",
		"import-memories",
		"pi-import-sessions",
	])("removes the old human root %s", (name) => {
		// Arrange
		const program = makeProgram();
		// Act
		const registered = program.commands.map((command) => command.name());
		// Assert
		expect(registered).not.toContain(name);
	});

	it.each([
		{
			path: ["memory"],
			children: [
				"list",
				"search",
				"show",
				"remember",
				"forget",
				"context",
				"distill",
				"stats",
				"export",
				"import",
			],
		},
		{ path: ["memory", "context"], children: ["trace"] },
		{ path: ["session"], children: ["import", "search"] },
		{ path: ["service"], children: ["start", "stop", "restart", "status"] },
		{
			path: ["diagnostics", "memory"],
			children: ["roles", "compare", "artifacts", "relink", "relink-plan"],
		},
		{ path: ["diagnostics", "extraction"], children: ["report", "replay", "benchmark"] },
		{
			path: ["diagnostics", "capture"],
			children: ["list-rejected", "show-rejected", "recover-rejected", "status", "retry", "check"],
		},
		{
			path: ["maintenance"],
			children: ["status", "embeddings", "database", "memory", "project", "backfill"],
		},
		{
			path: ["maintenance", "database"],
			children: ["init", "vacuum", "stats", "prune-events", "prune-history"],
		},
		{
			path: ["maintenance", "memory"],
			children: ["prune", "deduplicate", "redact-secrets"],
		},
		{ path: ["maintenance", "project"], children: ["rename", "normalize"] },
		{
			path: ["maintenance", "backfill"],
			children: ["tags", "dedup-keys", "narrative", "structured"],
		},
	])("discovers canonical children of $path without obsolete siblings", ({ path, children }) => {
		// Arrange
		const group = atPath(makeProgram(), path);
		// Act
		const names = group
			.createHelp()
			.visibleCommands(group)
			.map((command) => command.name());
		// Assert: exact sets catch both missing routes and leaked diagnostic/legacy names.
		expect(names.filter((name) => name !== "help").sort()).toEqual([...children].sort());
	});
});

describe("compatibility and session discovery", () => {
	it("retains memory pack as hidden compatibility and removes obsolete project routes", () => {
		// Arrange
		const program = makeProgram();
		const memory = atPath(program, ["memory"]);
		const repairs = atPath(program, ["maintenance", "memory"]);
		// Act
		const visible = memory
			.createHelp()
			.visibleCommands(memory)
			.map((command) => command.name());
		// Assert
		expect(atPath(memory, ["pack", "trace"])).toBeDefined();
		expect(visible).toContain("context");
		expect(visible).not.toContain("pack");
		expect(repairs.commands.map((command) => command.name())).not.toContain("rename-project");
		expect(repairs.commands.map((command) => command.name())).not.toContain("normalize-projects");
	});

	it("describes sessions as Pi conversations without a speculative backend flag", () => {
		// Arrange
		const session = atPath(makeProgram(), ["session"]);
		// Act
		const description = session.description();
		const options = [session, ...session.commands].flatMap((command) =>
			command.options.map((option) => option.long),
		);
		// Assert
		expect(description).toBe("Import and search Pi conversations");
		expect(options).not.toContain("--backend");
		expect(options).not.toContain("--source");
	});

	it("does not duplicate children when the runtime tree is assembled again", () => {
		// Arrange
		makeProgram();
		// Act
		const memory = atPath(makeProgram(), ["memory"]);
		const names = memory.commands.map((command) => command.name());
		// Assert
		expect(new Set(names).size).toBe(names.length);
		expect(names.filter((name) => name === "export")).toHaveLength(1);
		expect(names.filter((name) => name === "import")).toHaveLength(1);
	});

	it("keeps sync status removed and coordinator compatibility hidden", () => {
		// Arrange
		const sync = atPath(makeProgram(), ["sync"]);
		// Act
		const visible = sync
			.createHelp()
			.visibleCommands(sync)
			.map((command) => command.name());
		// Assert
		expect(sync.commands.map((command) => command.name())).not.toContain("status");
		expect(visible).toContain("peers");
		expect(visible).not.toContain("coordinator");
		expect(atPath(sync, ["coordinator"])).toBeDefined();
	});

	it("does not add an all-commands escape hatch", () => {
		// Arrange
		const program = makeProgram();
		// Act
		const options = program.options.map((option) => option.long);
		// Assert
		expect(options).not.toContain("--all");
		for (const alias of ["link-account", "upgrade-auth-schema", "upgrade-account-schema"]) {
			expect(ROOT_COMPLETION_COMMANDS).not.toContain(alias);
		}
	});
});
