import { AssertionError, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import type { ContractRecord } from "./opencode-v2-contract-fixture.js";

const smokeSource = readFileSync(
	new URL("../scripts/packed-v2-host-smoke.mjs", import.meta.url),
	"utf8",
);

function smokeSection(start: string, end: string) {
	const startIndex = smokeSource.indexOf(start);
	const endIndex = smokeSource.indexOf(end, startIndex);
	ok(startIndex >= 0 && endIndex > startIndex, "packed smoke test seam must exist");
	return smokeSource.slice(startIndex, endIndex);
}

function installForVersion(override: string | undefined, installs: string[][]) {
	new Script(
		`${smokeSection("const pinnedVersion =", "const contextMarker =")}
		${smokeSection("\tconst installDir =", "\tconst installedFixture =")}`,
	).runInNewContext({
		process: { env: { CODEMEM_OPENCODE_V2_VERSION: override } },
		join,
		tempDir: "/fixture",
		tarball: "/fixture/plugin.tgz",
		mkdirSync: () => undefined,
		writeFileSync: () => undefined,
		run: (command: string, args: string[]) => installs.push([command, ...args]),
	});
}

describe("packed OpenCode 2 version selection", () => {
	it("keeps 2.0.12 as the exact default SDK and host version", () => {
		const installs: string[][] = [];
		installForVersion(undefined, installs);
		expect(smokeSource).toContain('const pinnedVersion = "2.0.12";');
		expect(installs).toEqual([
			["npm", "install", "/fixture/plugin.tgz", "@opencode/plugin@2.0.12"],
		]);
	});

	it.each(["2.0.3", "2.0.3-beta.7", "2.0.3-beta-branch.0", "2.0.3-0", "2.0.3-beta.7+build.4"])(
		"installs an exact advisory override %s",
		(version) => {
			const installs: string[][] = [];
			installForVersion(version, installs);
			expect(installs).toEqual([
				["npm", "install", "/fixture/plugin.tgz", `@opencode/plugin@${version}`],
			]);
		},
	);

	it.each([
		"",
		"beta",
		"latest",
		"^2.0.2",
		"~2.0.2",
		"2",
		"2.0",
		"2.0.x",
		"v2.0.2",
		"02.0.2",
		"2.00.2",
		"2.0.02",
		"2.0.3-beta.01",
		"2.0.3-beta..1",
		"2.0.3-",
		" 2.0.2",
		"2.0.2\n",
		"2.0.2 --ignore-scripts",
		"2.0.2;touch bad",
		"file:../host",
		"https://example.invalid/host.tgz",
		"npm:other@2.0.2",
	])("rejects invalid override %j before package installation", (version) => {
		const installs: string[][] = [];
		expect(() => installForVersion(version, installs)).toThrow(
			/CODEMEM_OPENCODE_V2_VERSION.*exact semver/u,
		);
		expect(installs).toEqual([]);
	});
});

describe("packed OpenCode 2 plugin readiness", () => {
	function waitWithInventories(inventories: unknown[][]) {
		let requests = 0;
		const wait = new Script(
			`${smokeSection("async function waitForPlugins(", "async function inspectStandalonePlugins(")}\nwaitForPlugins`,
		).runInNewContext({
			URL,
			Buffer,
			assert: ok,
			setTimeout: (callback: () => void) => callback(),
			fetch: async (url: URL) => {
				expect(url.searchParams.get("location[directory]")).toBe("/fixture");
				const data = inventories[Math.min(requests++, inventories.length - 1)];
				return { ok: true, json: async () => ({ data }) };
			},
		});
		return {
			result: wait(
				{ baseURL: "http://localhost", output: () => "host log" },
				"/fixture",
				{ OPENCODE_SERVER_PASSWORD: "test" },
				["codemem"],
			),
			requests: () => requests,
		};
	}

	it("waits past empty inventory until the expected plugin is active", async () => {
		const probe = waitWithInventories([[], [{ id: "codemem", state: { status: "active" } }]]);
		await probe.result;
		expect(probe.requests()).toBe(2);
	});

	it("fails immediately when setup fails", async () => {
		const probe = waitWithInventories([[{ id: "codemem", state: { status: "failed" } }]]);
		await expect(probe.result).rejects.toThrow("Plugin activation failed");
		expect(probe.requests()).toBe(1);
	});

	it("bounds waiting when the expected plugin never appears", async () => {
		const probe = waitWithInventories([[]]);
		await expect(probe.result).rejects.toThrow("Plugin activation timed out");
		expect(probe.requests()).toBe(200);
	});
});

describe("packed OpenCode 2 host config", () => {
	it("uses setup's singular plugin key alongside the native fixture configuration", () => {
		const configs: unknown[] = [];
		new Script(
			smokeSection(
				'\twriteFileSync(\n\t\tjoin(projectDir, "opencode.json")',
				"\tconst opencode2 =",
			),
		).runInNewContext({
			join,
			projectDir: "/fixture",
			packedPluginTarget: "./node_modules/@codemem/opencode-plugin",
			packedFixtureTarget: "./node_modules/@codemem/opencode-plugin/v2-contract-fixture",
			provider: { baseURL: "http://127.0.0.1:1/v1" },
			writeFileSync: (_path: string, value: string) => configs.push(JSON.parse(value)),
		});
		expect(configs).toHaveLength(1);
		expect(configs[0]).toMatchObject({
			plugin: ["./node_modules/@codemem/opencode-plugin"],
			plugins: [
				{
					package: "./node_modules/@codemem/opencode-plugin/v2-contract-fixture",
					options: { contract: true },
				},
			],
		});
		expect(smokeSource).toContain(
			"configResult.stdout.includes(JSON.stringify(packedPluginTarget))",
		);
		expect(smokeSource).toContain(
			"configResult.stdout.includes(JSON.stringify(packedFixtureTarget))",
		);
		expect(smokeSource).toContain('["mem-status", "mem-recent", "mem-stats"].every');
		expect(smokeSource).toContain('record.phase === "setup" &&');
	});

	it.each([undefined, "2.0.3-beta.7"])(
		"requires the binary to match the selected version %s",
		(override) => {
			const selected = override ?? "2.0.12";
			const checkVersion = (reported: string) =>
				new Script(
					`${smokeSection("const pinnedVersion =", "const contextMarker =")}
					${smokeSection('\tconst version = run(opencode2, ["--version"]', "\tconst checkoutHomeDir =")}`,
				).runInNewContext({
					process: { env: { CODEMEM_OPENCODE_V2_VERSION: override } },
					opencode2: "opencode",
					projectDir: "/fixture",
					env: {},
					run: () => ({ stdout: `opencode v${reported}` }),
					assert: ok,
				});
			expect(() => checkVersion(selected)).not.toThrow();
			expect(() => checkVersion("2.0.1")).toThrow(AssertionError);
		},
	);
});

const correlationAssertions = new Script(
	smokeSection(
		"\tconst promptMessageIDs = records",
		'\tfor (const kind of ["primary", "compaction", "generate", "title"])',
	),
	{ filename: "packed-v2-host-smoke.mjs:correlation" },
);

function assertCorrelation(records: readonly ContractRecord[]) {
	correlationAssertions.runInNewContext({ records, assert: ok }, { timeout: 1_000 });
}

function turnRecords(messageID: string): ContractRecord[] {
	return [
		{ phase: "prompt", sessionID: "session-a", messageID },
		...Array.from({ length: 2 }, () => [
			{
				phase: "context",
				sessionID: "session-a",
				latestUserMessageID: messageID,
				userMessageIDs: [messageID],
				alreadyMarked: false,
				systemAlreadyMarked: false,
				systemReused: false,
				messagesReused: false,
				toolsReused: false,
			},
			{ phase: "model.request", kind: "primary" },
		]).flat(),
	];
}

describe("packed OpenCode 2 smoke correlation regressions", () => {
	it("rejects the same prompt ID on distinct turns while accepting stable same-turn replays", () => {
		expect(() =>
			assertCorrelation([...turnRecords("user-a"), ...turnRecords("user-b")]),
		).not.toThrow();

		expect(() => assertCorrelation([...turnRecords("user-a"), ...turnRecords("user-a")])).toThrow(
			AssertionError,
		);
	});

	it.each([
		{ label: "missing", replayID: null },
		{ label: "changed", replayID: "user-foreign" },
		{ label: "empty", replayID: "" },
	])(
		"rejects a $label latest-user ID on replay even when initial contexts match",
		({ replayID }) => {
			const records = [...turnRecords("user-a"), ...turnRecords("user-b")];
			expect(() => assertCorrelation(records)).not.toThrow();
			const replayIndex = records.findLastIndex(
				(record) => record.phase === "context" && record.latestUserMessageID === "user-a",
			);
			const brokenReplay = records.map((record, index) =>
				index === replayIndex ? { ...record, latestUserMessageID: replayID } : record,
			);

			expect(() => assertCorrelation(brokenReplay)).toThrow(AssertionError);
		},
	);

	it("rejects an older identity on a coalesced turn even when both prompt IDs occur elsewhere", () => {
		const records = [...turnRecords("user-a"), ...turnRecords("user-b")];
		const coalescedIndex = records.findLastIndex((record) => record.phase === "context");
		const coalesced = records.map((record, index) =>
			index === coalescedIndex ? { ...record, userMessageIDs: ["user-a", "user-b"] } : record,
		);
		expect(() => assertCorrelation(coalesced)).not.toThrow();
		const brokenCoalesced = coalesced.map((record, index) =>
			index === coalescedIndex ? { ...record, latestUserMessageID: "user-a" } : record,
		);

		expect(() => assertCorrelation(brokenCoalesced)).toThrow(AssertionError);
	});

	it("submits a steering prompt before waiting for active generation to finish", async () => {
		let activeGeneration = false;
		const promptOverlaps: boolean[] = [];
		const runAsync = async (_command: string, args: string[]) => {
			if (args.some((argument) => argument.endsWith("/prompt"))) {
				promptOverlaps.push(activeGeneration);
				activeGeneration = true;
			}
			if (args.some((argument) => argument.endsWith("/wait"))) activeGeneration = false;
		};
		const promptDriver = new Script(
			`${smokeSection("async function promptHost(", "async function generateHost(")}
			(async () => {
				${smokeSection("\tconst host = await startHost(", "\tconst liveHostResult =")}
			})()`,
			{ filename: "packed-v2-host-smoke.mjs:prompt-driver" },
		);

		await promptDriver.runInNewContext(
			{
				runAsync,
				startHost: async () => ({ baseURL: "http://127.0.0.1:1" }),
				provider: {
					holdNextPrimary: () => ({
						waitUntilBlocked: async () => undefined,
						release: () => undefined,
					}),
				},
				opencode2: "opencode",
				projectDir: "/fixture/project",
				env: {},
				sessionID: "session-a",
			},
			{ timeout: 1_000 },
		);

		expect(promptOverlaps.length).toBeGreaterThanOrEqual(2);
		expect(promptOverlaps, "packed smoke must exercise an overlapping steering prompt").toContain(
			true,
		);
	});
});
