import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function aliasCommand(commandName: string) {
	// Fresh real command trees prevent parsed options leaking between cases.
	vi.resetModules();
	const { syncCommand } = await import("./sync.js");
	const program = new Command("codemem").exitOverride();
	program.addCommand(syncCommand);
	const alias = syncCommand.commands.find((command) => command.name() === "coordinator");
	const leaf = alias?.commands.find((command) => command.name() === commandName);
	if (!alias || !leaf) throw new Error(`Missing coordinator alias command: ${commandName}`);
	return { program, alias, leaf };
}

describe("sync coordinator alias deprecation output", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request")));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it.each([
		{ name: "enroll-owner", args: ["test-group", "--prepare", "--json"], ancestorJson: false },
		{ name: "list-groups", args: ["--json"], ancestorJson: false },
		{ name: "list-groups", args: [], ancestorJson: true },
	])("keeps $name JSON output unchanged with ancestor JSON=$ancestorJson", async (fixture) => {
		// Arrange: replace only the action, retaining the real alias hook and leaf options.
		const { program, alias, leaf } = await aliasCommand(fixture.name);
		if (fixture.ancestorJson) program.option("--json", "structured output");
		const payload = { ok: true, result: "test-result" };
		const action = vi.fn(() => console.log(JSON.stringify(payload)));
		leaf.action(action);
		const args = ["sync", "coordinator", fixture.name, ...fixture.args];
		if (fixture.ancestorJson) args.unshift("--json");

		// Act: parse the full hidden alias, not the leaf in isolation.
		await program.parseAsync(args, { from: "user" });

		// Assert: action-level JSON includes ancestors; alias-local options miss leaf JSON.
		expect(leaf.optsWithGlobals().json).toBe(true);
		expect(alias.opts().json).toBeUndefined();
		expect(leaf.opts().json).toBe(fixture.ancestorJson ? undefined : true);
		expect(action).toHaveBeenCalledTimes(1);
		expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(payload));
		expect(console.error).not.toHaveBeenCalled();
		expect(process.stderr.write).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		{ name: "enroll-owner", args: ["test-group", "--prepare"] },
		{ name: "list-groups", args: [] },
	])("still warns for $name without JSON", async (fixture) => {
		// Arrange: avoid profile, database and network work while retaining alias behavior.
		const { program, leaf } = await aliasCommand(fixture.name);
		const action = vi.fn();
		leaf.action(action);

		// Act.
		await program.parseAsync(["sync", "coordinator", fixture.name, ...fixture.args], {
			from: "user",
		});

		// Assert: non-JSON callers still get the existing migration guidance.
		expect(action).toHaveBeenCalledTimes(1);
		expect(console.error).toHaveBeenCalledExactlyOnceWith(
			`Warning: 'codemem sync coordinator ${fixture.name}' is deprecated, use 'codemem coordinator ${fixture.name}' instead.`,
		);
		expect(console.log).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});
