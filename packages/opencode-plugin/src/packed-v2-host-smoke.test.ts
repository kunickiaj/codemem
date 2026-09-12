import { AssertionError, ok } from "node:assert/strict";
import { readFileSync } from "node:fs";
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
