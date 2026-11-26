import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ObserverClient } from "./observer-client.js";
import { flushRawEvents } from "./raw-event-flush.js";
import { MemoryStore } from "./store.js";

/*
 * The live raw-event path prepares transcript and tool output with the observer's
 * own `observer_max_chars`, so ingest's pre-budgets and the observer agree.
 */

let directory: string;
let store: MemoryStore;
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-flush-observer-budget-"));
	store = new MemoryStore(join(directory, "test.sqlite"));
});
afterEach(() => {
	store.close();
	rmSync(directory, { recursive: true, force: true });
});

// Exercise the real observe() path, replacing only the transport.
function capturingObserver(maxChars: number) {
	const sent = vi.fn(async (_system: string, _user: string) => {
		throw new Error("captured");
	});
	const client = Object.assign(Object.create(ObserverClient.prototype), {
		maxChars,
		runtime: "test",
		_callOnce: sent,
		getStatus: () => ({
			provider: "test",
			model: "fixture",
			runtime: "test",
			auth: { source: "none", type: "none", hasToken: false },
		}),
	}) as ObserverClient;
	return { client, sent };
}

function recordReads(count: number) {
	for (let index = 0; index < count; index += 1) {
		store.recordRawEvent({
			opencodeSessionId: "budget",
			eventId: `read-${index}`,
			eventType: "tool.execute.after",
			payload: {
				type: "tool.execute.after",
				tool: "read",
				args: { path: `file-${index}.ts` },
				result: `READ_${index} ${"line of source. ".repeat(60)}`,
			},
		});
	}
}

it("prepares tool output with the observer's configured budget", async () => {
	recordReads(12);
	const { client, sent } = capturingObserver(48_000);

	await expect(
		flushRawEvents(store, { observer: client }, { opencodeSessionId: "budget" }),
	).rejects.toThrow("captured");

	// At 48,000 the tool budget is 8,000 characters; the 12,000 default allows 7,000.
	const user = sent.mock.calls[0]?.[1] ?? "";
	const reads = user.match(/<what_happened>read<\/what_happened>/g) ?? [];
	expect(reads).toHaveLength(7);
});
