import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerRootCommands } from "./command-tree.js";
import { helpStyle } from "./help-style.js";

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

describe("coordinator resource discovery", () => {
	it.each([
		{ group: "account", children: ["link"] },
		{ group: "owner", children: ["enroll", "review", "qualify"] },
		{ group: "group", children: ["create", "list", "grant-identity"] },
		{ group: "device", children: ["enroll", "list", "rename", "disable", "remove", "revoke"] },
		{
			group: "schema",
			children: ["diagnose-team", "upgrade-auth", "upgrade-account", "baseline-d1"],
		},
		{ group: "domain", children: ["list", "create", "update", "members", "grant", "revoke"] },
		{ group: "grant", children: ["list", "revoke"] },
		{ group: "invitation", children: ["create", "accept"] },
		{ group: "request", children: ["list", "approve", "deny"] },
	])("discovers coordinator $group routes without flat legacy names", ({ group, children }) => {
		// Arrange
		const coordinator = atPath(makeProgram(), ["coordinator"]);
		const command = atPath(coordinator, [group]);
		// Act
		const names = command.commands.map((child) => child.name());
		const help = coordinator.helpInformation();
		// Assert
		expect(names.sort()).toEqual([...children].sort());
		expect(help).not.toMatch(
			/^\s+(?:link-account|enroll-owner|group-create|list-scopes|import-invite)(?:\s|$)/m,
		);
	});
});
