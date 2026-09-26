import { afterEach, describe, expect, it, vi } from "vitest";
import { type ExecCodememFn, PiCodememClient } from "./client.js";
import { defaultPiExtensionConfig } from "./config.js";
import { createPiInjector, type PiContextMessage } from "./inject.js";
import { CODEMEM_MEMORIES_HEADER } from "./payloads.js";
import { createViewerRuntime } from "./viewer.js";

/** A valid renderer fingerprint is sha256-shaped in span validation. */
const FINGERPRINT_A = "a".repeat(64);
const FINGERPRINT_B = "b".repeat(64);

type QueuedResponse = string | Error;

/**
 * Counting CLI spy: each queued response is returned (or thrown) for one pack
 * transport call (`pack --json` or `pi-hook-inject`). Fetch count = number of
 * pack-transport spawns.
 */
function makeExecSpy(queue: QueuedResponse[]) {
	const calls: string[][] = [];
	const execImpl: ExecCodememFn = async (args) => {
		calls.push([...args]);
		const next = queue.shift();
		if (next instanceof Error) throw next;
		if (args[0] === "pack") return { stdout: next ?? "", stderr: "" };
		if (args[0] === "pi-hook-inject") return { stdout: next ?? "", stderr: "" };
		return { stdout: "", stderr: "" };
	};
	const fetchCount = () =>
		calls.filter((args) => args[0] === "pack" || args[0] === "pi-hook-inject").length;
	return { calls, execImpl, fetchCount };
}

function makeInjector(execImpl: ExecCodememFn, configOverrides: Record<string, unknown> = {}) {
	const config = defaultPiExtensionConfig(configOverrides);
	const client = new PiCodememClient(config, createViewerRuntime(), { execImpl });
	let seq = 0;
	const injector = createPiInjector({
		client,
		config,
		discriminator: (message) => {
			const ts = (message as { timestamp?: unknown }).timestamp;
			if (typeof ts === "number" && Number.isFinite(ts)) return ts;
			seq += 1;
			return `n:${seq}`;
		},
	});
	injector.rekey("sess-inject-test");
	return { config, injector };
}

/** Fresh message objects per call — the context event hands the hook a throwaway copy. */
function userMsg(
	text: string,
	timestamp?: number,
	content?: PiContextMessage["content"],
): PiContextMessage {
	if (content !== undefined)
		return { role: "user", content, ...(timestamp === undefined ? {} : { timestamp }) };
	return timestamp === undefined
		? { role: "user", content: text }
		: { role: "user", content: text, timestamp };
}

/** Fresh copies of a two-message history. */
const turn = (first = "first", second = "second") => [
	userMsg(first, 1_000),
	userMsg(second, 2_000),
];

function spannedPackBody(pack_text: string, items: unknown[]): string {
	return JSON.stringify({
		pack_text,
		rendered_items: items,
		metrics: { total_items: items.length },
	});
}

function latestText(message: PiContextMessage): string {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.map((block) =>
				typeof block === "object" && block !== null
					? String((block as { text?: unknown }).text ?? "")
					: "",
			)
			.join("\n");
	}
	return "";
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("createPiInjector replay", () => {
	it("replays identical bytes onto two decided messages and the fetch spy stays at 0", async () => {
		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("pack one", []),
			spannedPackBody("pack two", []),
		]);
		const { injector } = makeInjector(execImpl);

		// Turn 1: only the first message exists — it gets a decision.
		const firstTurn = [userMsg("first", 1_000)];
		await injector.inject(firstTurn);
		expect(fetchCount()).toBe(1);
		expect(latestText(firstTurn[0])).toContain("pack one");

		// Turn 2: a new message fetches its own pack; the first replays.
		const secondTurn = turn();
		await injector.inject(secondTurn);
		expect(fetchCount()).toBe(2);
		const firstReplay = latestText(secondTurn[0]);
		const secondBlock = latestText(secondTurn[1]);
		expect(firstReplay).toContain("pack one");
		expect(secondBlock).toContain("pack two");

		// Same turn again (next model call): both decided — replay only, zero fetches.
		const thirdTurn = turn();
		await injector.inject(thirdTurn);
		expect(fetchCount()).toBe(2);
		expect(latestText(thirdTurn[0])).toBe(firstReplay);
		expect(latestText(thirdTurn[1])).toBe(secondBlock);
	});

	it("appends to string content by concatenation and to array content with one text block", async () => {
		const { execImpl } = makeExecSpy([
			spannedPackBody("pack one", []),
			spannedPackBody("pack two", []),
		]);
		const { injector } = makeInjector(execImpl);

		const message = userMsg(undefined, 1_000, [
			{ type: "text", text: "look at this" },
			{ type: "image", data: "img", mimeType: "image/png" },
		]);
		const imagePart = (message.content as Array<Record<string, unknown>>)[1];
		await injector.inject([message]);

		const content = message.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(3);
		expect(content[0]?.type).toBe("text");
		expect(String(content[0]?.text)).toContain("look at this");
		// Image part untouched by identity — never rebuilt.
		expect(content[1]).toBe(imagePart);
		expect(content[2]?.type).toBe("text");
		expect(String(content[2]?.text)).toContain("pack one");

		const stringMessage = userMsg("plain prompt", 2_000);
		await injector.inject([userMsg("plain prompt", 2_000), stringMessage]);
		expect(typeof stringMessage.content).toBe("string");
		expect(String(stringMessage.content)).toContain("pack two");
	});

	it("a missing timestamp injects once and is not cached", async () => {
		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("pack one", []),
			spannedPackBody("pack two", []),
		]);
		const { injector } = makeInjector(execImpl);

		await injector.inject([userMsg("no timestamp")]);
		expect(fetchCount()).toBe(1);

		// No stable discriminator → the decision is not cached → fetches again.
		await injector.inject([userMsg("no timestamp")]);
		expect(fetchCount()).toBe(2);
	});
});

describe("createPiInjector span dedup", () => {
	it("cuts already-shown items via rendered spans; a fully-retained pack appends nothing and freezes", async () => {
		const item = (id: number, fingerprint: string, packLength: number) => ({
			id,
			fingerprint,
			spans: [{ start: 0, end: packLength }],
		});
		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("ITEM A", [item(7, FINGERPRINT_A, 6)]),
			spannedPackBody("ITEM A", [item(7, FINGERPRINT_A, 6)]),
		]);
		const { injector } = makeInjector(execImpl);

		// Turn 1: item A is attached and its fingerprint recorded.
		const firstTurn = [userMsg("first", 1_000)];
		await injector.inject(firstTurn);
		expect(fetchCount()).toBe(1);
		expect(latestText(firstTurn[0])).toContain("ITEM A");

		// Turn 2: the pack only repeats item A → dedup leaves nothing → frozen inject-nothing.
		const secondTurn = turn();
		await injector.inject(secondTurn);
		expect(fetchCount()).toBe(2);
		expect(latestText(secondTurn[1])).toBe("second");

		// Frozen: a later call for that message does not fetch again.
		await injector.inject(turn());
		expect(fetchCount()).toBe(2);
	});

	it("malformed spans keep the full pack text and record no fingerprints", async () => {
		// Span end exceeds the pack text length → invalid → full text, no suppression later.
		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("short", [
				{ id: 7, fingerprint: FINGERPRINT_A, spans: [{ start: 0, end: 999 }] },
			]),
			spannedPackBody("short again", [
				{ id: 7, fingerprint: FINGERPRINT_A, spans: [{ start: 0, end: 11 }] },
			]),
		]);
		const { injector } = makeInjector(execImpl);

		const firstTurn = [userMsg("first", 1_000)];
		await injector.inject(firstTurn);
		expect(fetchCount()).toBe(1);
		expect(latestText(firstTurn[0])).toContain("short");

		// No fingerprints were recorded, so the same item is eligible again.
		const secondTurn = turn();
		await injector.inject(secondTurn);
		expect(fetchCount()).toBe(2);
		expect(latestText(secondTurn[1])).toContain("short again");
	});
});

describe("createPiInjector freeze", () => {
	it("freezes a cascade failure as inject-nothing; a later inject does not fetch", async () => {
		// Every transport in the one-cascade retry chain fails for this fetch.
		const { execImpl, fetchCount } = makeExecSpy([new Error("cli down"), new Error("cli down")]);
		const { injector } = makeInjector(execImpl);

		const message = userMsg("first", 1_000);
		await injector.inject([message]);
		expect(fetchCount()).toBe(2); // pack --json + pi-hook-inject both tried once
		expect(latestText(message)).toBe("first");

		await injector.inject([userMsg("first", 1_000)]);
		expect(fetchCount()).toBe(2);
	});

	it("freezes an empty pack result as inject-nothing; a later inject does not fetch", async () => {
		const { execImpl, fetchCount } = makeExecSpy([spannedPackBody("", [])]);
		const { injector } = makeInjector(execImpl);

		await injector.inject([userMsg("first", 1_000)]);
		expect(fetchCount()).toBe(1);

		await injector.inject([userMsg("first", 1_000)]);
		expect(fetchCount()).toBe(1);
	});
});

describe("createPiInjector truncation", () => {
	it("appends the capped block, records no fingerprints, and a later pack may still include the items", async () => {
		const item = (packLength: number) => ({
			id: 9,
			fingerprint: FINGERPRINT_B,
			spans: [{ start: 0, end: packLength }],
		});
		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("Y".repeat(60), [item(60)]),
			spannedPackBody("Y".repeat(60), [item(60)]),
		]);
		// Budget barely above the header → every pack truncates.
		const { injector } = makeInjector(execImpl, {
			injectMaxChars: CODEMEM_MEMORIES_HEADER.length + 10,
		});

		const firstTurn = [userMsg("first", 1_000)];
		await injector.inject(firstTurn);
		expect(fetchCount()).toBe(1);
		expect(latestText(firstTurn[0])).toContain("[pack truncated]");

		// The truncated turn recorded no fingerprints → the item is not suppressed next turn.
		const secondTurn = turn();
		await injector.inject(secondTurn);
		expect(fetchCount()).toBe(2);
		expect(latestText(secondTurn[1])).toContain("YYY");
	});
});

describe("createPiInjector compaction", () => {
	it("compaction is a one-shot replay with no fetch and no new decision; the next inject may fetch", async () => {
		const { execImpl, fetchCount } = makeExecSpy([
			spannedPackBody("pack one", []),
			spannedPackBody("pack two", []),
		]);
		const { injector } = makeInjector(execImpl);

		await injector.inject([userMsg("first", 1_000)]);
		expect(fetchCount()).toBe(1);

		injector.noteCompaction();
		const compactedTurn = [userMsg("first", 1_000)];
		await injector.inject(compactedTurn);
		expect(fetchCount()).toBe(1); // replay only
		expect(latestText(compactedTurn[0])).toContain("pack one");

		// One-shot consumed → the next inject may fetch for the new message.
		const nextTurn = turn();
		await injector.inject(nextTurn);
		expect(fetchCount()).toBe(2);
		expect(latestText(nextTurn[1])).toContain("pack two");
	});
	it("a new user message during compaction is not fetched and gets no decision", async () => {
		const { execImpl, fetchCount } = makeExecSpy([spannedPackBody("should not run", [])]);
		const { injector } = makeInjector(execImpl);
		injector.rekey("sess-inject-test");
		injector.noteCompaction();
		const duringCompact = [userMsg("summarize this", 9_000)];
		await injector.inject(duringCompact);
		expect(fetchCount()).toBe(0);
		expect(latestText(duringCompact[0])).toBe("summarize this");
		const after = [userMsg("summarize this", 9_000)];
		await injector.inject(after);
		expect(fetchCount()).toBe(1);
		expect(latestText(after[0])).toContain("should not run");
	});
});

describe("createPiInjector retained-token ceiling", () => {
	it("with the cap below the already-replayed total, the next inject replays old bytes, fetches nothing, and appends nothing", async () => {
		vi.stubEnv("CODEMEM_INJECT_RETAINED_TOKEN_BUDGET", "200");
		const { execImpl, fetchCount } = makeExecSpy([spannedPackBody("Z".repeat(400), [])]);
		const { injector } = makeInjector(execImpl);

		// Turn 1 fits under the cap: ~175 estimated tokens for header + pack.
		const firstTurn = [userMsg("first", 1_000)];
		await injector.inject(firstTurn);
		expect(fetchCount()).toBe(1);
		const firstBlock = latestText(firstTurn[0]);
		expect(firstBlock).toContain("ZZZ");

		// Turn 2: replayed bytes already exceed the cap → no fetch, nothing new, nothing evicted.
		const secondTurn = turn();
		await injector.inject(secondTurn);
		expect(fetchCount()).toBe(1);
		expect(latestText(secondTurn[0])).toBe(firstBlock);
		expect(latestText(secondTurn[1])).toBe("second");
	});

	it("an unset, zero, or invalid cap never restricts injection", async () => {
		for (const value of ["", "0", "-5", "abc", "1.5"]) {
			vi.stubEnv("CODEMEM_INJECT_RETAINED_TOKEN_BUDGET", value);
			const { execImpl, fetchCount } = makeExecSpy([spannedPackBody("pack one", [])]);
			const { injector } = makeInjector(execImpl);

			await injector.inject([userMsg("first", 1_000)]);
			expect(fetchCount()).toBe(1);
			vi.unstubAllEnvs();
		}
	});
});
