import { describe, expect, it } from "vitest";
import {
	entriesWithinLimit,
	SyncEntryTooLargeError,
	syncEntryTooLargeGuidance,
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

	it("turns a peer's refusal into recovery guidance", () => {
		const reply = {
			error: "sync_entry_too_large",
			kind: "snapshot_item",
			key: "memory-source-v1:abc",
			bytes: 20 * MiB,
			limit: 16 * MiB,
		};
		expect(syncEntryTooLargeMessage(reply)).toBe(
			"sync_entry_too_large: memory memory-source-v1:abc is 20.0 MiB, over the 16.0 MiB this connection carries. Trim or delete it on the peer, or exclude its project, then sync again.",
		);
		expect(syncEntryTooLargeMessage({ ...reply, kind: "op", key: "op-1" })).toContain(
			"change op-1",
		);
		expect(syncEntryTooLargeMessage({ error: "reset_required" })).toBeNull();
		expect(syncEntryTooLargeMessage(null)).toBeNull();
	});

	it("keeps peer-chosen key text out of local errors unless it is a plain identifier", () => {
		const reply = { error: "sync_entry_too_large", kind: "op", bytes: MiB, limit: 1 };
		for (const key of ["line\nbreak", "\u001b[31mred", "x".repeat(201), 42])
			expect(syncEntryTooLargeMessage({ ...reply, key })).toContain("change unknown is");
	});

	it("finds the guidance inside a wrapped error", () => {
		const guidance = syncEntryTooLargeMessage({
			error: "sync_entry_too_large",
			kind: "op",
			key: "op-1",
			bytes: MiB,
			limit: 1,
		});
		expect(syncEntryTooLargeGuidance(`peer scoped ops fetch failed (409: ${guidance})`)).toBe(
			guidance,
		);
		expect(syncEntryTooLargeGuidance("peer scoped ops fetch failed (409: other)")).toBeNull();
		expect(syncEntryTooLargeGuidance(undefined)).toBeNull();
	});
});
