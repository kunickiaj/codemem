import { describe, expect, it } from "vitest";
import {
	entriesWithinLimit,
	parseSyncEntryTooLarge,
	SyncEntryTooLargeError,
	syncEntryTooLargeMessage,
} from "./sync-entry-size.js";

const MiB = 1024 * 1024;

describe("sync entry size", () => {
	it("passes entries through without a limit and throws for the first one over it", () => {
		const entries = [{ id: "a" }, { id: "b", body: "x".repeat(100) }];
		expect(entriesWithinLimit("op", entries, (e) => e.id, undefined)).toBe(entries);
		expect(entriesWithinLimit("op", entries, (e) => e.id, 1000)).toBe(entries);
		const failure = (() => {
			try {
				entriesWithinLimit("op", entries, (e) => e.id, 50);
			} catch (error) {
				return error;
			}
		})();
		expect(failure).toBeInstanceOf(SyncEntryTooLargeError);
		expect((failure as SyncEntryTooLargeError).toResponseBody()).toEqual({
			error: "sync_entry_too_large",
			kind: "op",
			key: "b",
			bytes: Buffer.byteLength(JSON.stringify(entries[1])) + 1,
			limit: 50,
		});
	});

	it("turns a peer's checked refusal into recovery guidance", () => {
		const reply = {
			error: "sync_entry_too_large",
			kind: "snapshot_item",
			key: "memory-source-v1:abc",
			bytes: 20 * MiB,
			limit: 16 * MiB,
		};
		const refusal = parseSyncEntryTooLarge(reply);
		expect(refusal).toEqual({
			kind: "snapshot_item",
			key: "memory-source-v1:abc",
			bytes: 20 * MiB,
			limit: 16 * MiB,
		});
		expect(refusal && syncEntryTooLargeMessage(refusal)).toBe(
			"sync_entry_too_large: memory memory-source-v1:abc is 20.0 MiB, over the 16.0 MiB this connection carries. Trim it on the peer, or exclude its Project from this pairing, then sync again.",
		);
		const op = parseSyncEntryTooLarge({ ...reply, kind: "op", key: "op-1" });
		expect(op && syncEntryTooLargeMessage(op)).toBe(
			"sync_entry_too_large: change op-1 is 20.0 MiB, over the 16.0 MiB this connection carries. Exclude its Project from this pairing, then sync again. Trimming or deleting the memory won't clear it, because the peer still has the oversized change.",
		);
	});

	it.each([
		["another error", { error: "reset_required" }],
		["no payload", null],
		["text after the code", { error: "sync_entry_too_large: arbitrary\n\u001b[31mtext" }],
		["an unknown kind", { error: "sync_entry_too_large", kind: "x", bytes: 1, limit: 1 }],
		["a string size", { error: "sync_entry_too_large", kind: "op", bytes: "1", limit: 1 }],
		["a negative size", { error: "sync_entry_too_large", kind: "op", bytes: -1, limit: 1 }],
		["a fractional limit", { error: "sync_entry_too_large", kind: "op", bytes: 1, limit: 0.5 }],
	])("refuses %s as a size refusal", (_label, payload) => {
		expect(parseSyncEntryTooLarge(payload as Record<string, unknown> | null)).toBeNull();
	});

	it("keeps peer-chosen key text out of local errors unless it is a plain identifier", () => {
		const reply = { error: "sync_entry_too_large", kind: "op", bytes: MiB, limit: 1 };
		for (const key of ["line\nbreak", "\u001b[31mred", "x".repeat(201), 42])
			expect(parseSyncEntryTooLarge({ ...reply, key })?.key).toBe("unknown");
	});
});
