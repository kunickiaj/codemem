import { describe, expect, it } from "vitest";
import { syncCommand } from "./sync.js";
import {
	buildServeLifecycleArgs,
	collectAdvertiseAddresses,
	formatSyncAttempt,
	formatSyncOnceResult,
	parseProjectList,
} from "./sync-helpers.js";

describe("formatSyncAttempt", () => {
	it("matches the compact Python-era output shape", () => {
		expect(
			formatSyncAttempt({
				peer_device_id: "peer-1",
				ok: 1,
				ops_in: 3,
				ops_out: 5,
				error: null,
				finished_at: "2026-03-18T20:00:00Z",
			}),
		).toBe("peer-1|ok|in=3|out=5|2026-03-18T20:00:00Z");
	});

	it("includes the error suffix when present", () => {
		expect(
			formatSyncAttempt({
				peer_device_id: "peer-2",
				ok: 0,
				ops_in: 0,
				ops_out: 1,
				error: "timeout",
				finished_at: "2026-03-18T21:00:00Z",
			}),
		).toBe("peer-2|error|in=0|out=1|2026-03-18T21:00:00Z | timeout");
	});

	it("builds sync start as a background serve invocation using the current runner", () => {
		expect(
			buildServeLifecycleArgs(
				"start",
				{ dbPath: "/tmp/test.sqlite", host: "127.0.0.1", port: "7337" },
				"/repo/packages/cli/src/index.ts",
				["--conditions", "source"],
			),
		).toEqual([
			"--conditions",
			"source",
			"/repo/packages/cli/src/index.ts",
			"serve",
			"--restart",
			"--db-path",
			"/tmp/test.sqlite",
			"--host",
			"127.0.0.1",
			"--port",
			"7337",
		]);
	});

	it("builds sync restart as a serve restart invocation", () => {
		expect(
			buildServeLifecycleArgs(
				"restart",
				{ dbPath: "/tmp/test.sqlite" },
				"/repo/packages/cli/src/index.ts",
				[],
			),
		).toEqual([
			"/repo/packages/cli/src/index.ts",
			"serve",
			"--restart",
			"--db-path",
			"/tmp/test.sqlite",
		]);
	});

	it("formats sync once success output like the Python command", () => {
		expect(formatSyncOnceResult("peer-1", { ok: true })).toBe("- peer-1: ok");
	});

	it("formats sync once error output like the Python command", () => {
		expect(formatSyncOnceResult("peer-2", { ok: false, error: "timeout" })).toBe(
			"- peer-2: error: timeout",
		);
	});

	it("parses comma-separated project filter lists", () => {
		expect(parseProjectList("foo, bar ,baz")).toEqual(["foo", "bar", "baz"]);
	});

	it("drops empty project filter entries", () => {
		expect(parseProjectList("foo, , ,bar")).toEqual(["foo", "bar"]);
	});

	it("collects advertise addresses from non-loopback interfaces when host is unspecified", () => {
		expect(
			collectAdvertiseAddresses(null, "0.0.0.0", 7337, {
				lo0: [{ address: "127.0.0.1", internal: true, family: "IPv4" }],
				en0: [{ address: "192.168.1.10", internal: false, family: "IPv4" }],
			}),
		).toEqual(["192.168.1.10:7337"]);
	});

	it("registers coordinator parity subcommands", () => {
		const coordinator = syncCommand.commands.find((command) => command.name() === "coordinator");
		expect(coordinator).toBeDefined();
		expect(coordinator?.commands.map((command) => command.name())).toEqual([
			"serve",
			"create-invite",
			"import-invite",
			"list-join-requests",
			"approve-join-request",
			"deny-join-request",
		]);
	});

	it("documents the coordinator command surface in help output", () => {
		const coordinator = syncCommand.commands.find((command) => command.name() === "coordinator");
		const help = coordinator?.helpInformation() ?? "";
		expect(help).toContain("serve");
		expect(help).toContain("create-invite");
		expect(help).toContain("import-invite");
		expect(help).toContain("list-join-requests");
		expect(help).toContain("approve-join-request");
		expect(help).toContain("deny-join-request");
	});

	it("defaults coordinator serve to the coordinator store database", () => {
		const coordinator = syncCommand.commands.find((command) => command.name() === "coordinator");
		const serve = coordinator?.commands.find((command) => command.name() === "serve");
		expect(serve?.options.find((opt) => opt.long === "--db")?.defaultValue).toBeUndefined();
		// runtime default is enforced in action code, not commander metadata
		const help = serve?.helpInformation() ?? "";
		expect(help).toContain("coordinator database path");
	});

	it("allows positional group ids for create-invite and list-join-requests", () => {
		const coordinator = syncCommand.commands.find((command) => command.name() === "coordinator");
		const createInvite = coordinator?.commands.find(
			(command) => command.name() === "create-invite",
		);
		const listRequests = coordinator?.commands.find(
			(command) => command.name() === "list-join-requests",
		);
		expect(createInvite?.registeredArguments[0]?.required).toBe(false);
		expect(listRequests?.registeredArguments[0]?.required).toBe(false);
		expect(createInvite?.helpInformation()).toContain("[group]");
		expect(listRequests?.helpInformation()).toContain("[group]");
	});
});
