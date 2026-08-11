import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMPLETION_ONLY_TOKENS,
	invokedAsTopLevelAlias,
	ROOT_COMPLETION_COMMANDS,
	registerRootCommands,
} from "./command-tree.js";
import { memoryCommand } from "./commands/memory.js";
import { syncCommand } from "./commands/sync.js";
import { helpStyle } from "./help-style.js";

const completionOnly = new Set<string>(["help", ...COMPLETION_ONLY_TOKENS]);

// The exact assembly used by the runtime entrypoint (index.ts).
const program = registerRootCommands(new Command("codemem").configureHelp(helpStyle));

describe("root command tree", () => {
	it("keeps visible registrations and completions in parity", () => {
		const registeredNames = new Set(program.commands.map((command) => command.name()));
		const visibleNames = program
			.createHelp()
			.visibleCommands(program)
			.map((command) => command.name());

		for (const commandName of visibleNames) {
			expect(ROOT_COMPLETION_COMMANDS).toContain(commandName);
		}

		for (const completion of ROOT_COMPLETION_COMMANDS) {
			if (completionOnly.has(completion)) continue;
			expect(registeredNames).toContain(completion);
		}
	});

	it("keeps hidden compatibility commands out of shell completion", () => {
		const visibleNames = new Set(
			program
				.createHelp()
				.visibleCommands(program)
				.map((command) => command.name()),
		);
		const hiddenNames = program.commands
			.map((command) => command.name())
			.filter((name) => name !== "help" && !visibleNames.has(name));

		expect(hiddenNames).toEqual(
			expect.arrayContaining(["show", "forget", "remember", "prompt-pack-ledger"]),
		);
		for (const hiddenName of hiddenNames) {
			expect(ROOT_COMPLETION_COMMANDS).not.toContain(hiddenName);
		}
	});

	it("shows warned aliases and omits hidden root compatibility commands", () => {
		const help = program.helpInformation();

		expect(help).toMatch(/^\s+export-memories(?:\s|$)/m);
		expect(help).toMatch(/^\s+import-memories(?:\s|$)/m);
		for (const hiddenName of ["show", "forget", "remember", "prompt-pack-ledger"]) {
			expect(help).not.toMatch(new RegExp(`^\\s+${hiddenName}(?:\\s|$)`, "m"));
		}
	});

	it("registers the memory export/import wrappers exactly once", () => {
		registerRootCommands(new Command("codemem-again").configureHelp(helpStyle));

		const wrapperNames = memoryCommand.commands
			.map((command) => command.name())
			.filter((name) => name === "export" || name === "import");
		expect(wrapperNames.sort()).toEqual(["export", "import"]);
	});

	it("hides sync coordinator from help without unregistering it", () => {
		const coordinator = syncCommand.commands.find((command) => command.name() === "coordinator");

		expect(coordinator).toBeDefined();
		expect(syncCommand.helpInformation()).not.toMatch(/^\s+coordinator(?:\s|$)/m);
	});
});

describe("invokedAsTopLevelAlias", () => {
	const originalArgv = process.argv;
	afterEach(() => {
		process.argv = originalArgv;
	});

	it("matches an alias when it is the first non-flag token", () => {
		expect(invokedAsTopLevelAlias("export-memories", ["--verbose", "export-memories"])).toBe(true);
	});

	it("does not match aliases forwarded through the memory group", () => {
		expect(invokedAsTopLevelAlias("export-memories", ["memory", "export"])).toBe(false);
		expect(invokedAsTopLevelAlias("import-memories", ["memory", "import"])).toBe(false);
	});

	it("stops scanning at the -- terminator", () => {
		expect(invokedAsTopLevelAlias("export-memories", ["--", "export-memories"])).toBe(false);
	});

	it("reads the real process argv by default", () => {
		process.argv = ["node", "codemem", "export-memories", "out.json"];
		expect(invokedAsTopLevelAlias("export-memories")).toBe(true);

		process.argv = ["node", "codemem", "memory", "export", "out.json"];
		expect(invokedAsTopLevelAlias("export-memories")).toBe(false);
	});
});
