import { describe, expect, it } from "vitest";
import {
	forgetMemoryCommand,
	memoryCommand,
	rememberMemoryCommand,
	showMemoryCommand,
} from "./memory.js";

describe("memory command aliases", () => {
	it("keeps memory subcommands available under the memory group", () => {
		expect(memoryCommand.commands.map((command) => command.name())).toEqual([
			"show",
			"forget",
			"remember",
			"inject",
			"compact",
		]);
	});

	it("exports top-level compatibility aliases", () => {
		expect(showMemoryCommand.name()).toBe("show");
		expect(forgetMemoryCommand.name()).toBe("forget");
		expect(rememberMemoryCommand.name()).toBe("remember");
	});

	it("keeps inject expecting a context argument", () => {
		const inject = memoryCommand.commands.find((command) => command.name() === "inject");
		expect(inject).toBeDefined();
		expect(inject?.registeredArguments[0]?.required).toBe(true);
		expect(inject?.registeredArguments[0]?.name()).toBe("context");
		expect(inject?.options.some((option) => option.long === "--working-set-file")).toBe(true);
	});
});
