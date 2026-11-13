import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { useLocalCaptureFixture } from "./memory-local-capture-test-fixtures.js";

const { fixture, enroll, remember } = useLocalCaptureFixture();

it("holds the write lock before reading source identity and persists the memory with its binding", () => {
	enroll();
	const { store, sessionId } = fixture;
	expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
	const writer = new Database(store.dbPath);
	writer.pragma("busy_timeout = 0");
	const context = store.scopeResolutionDeviceContext();
	const attemptWrite = vi.fn(() => {
		expect(() =>
			writer.prepare("UPDATE sessions SET user = 'concurrent' WHERE id = ?").run(sessionId),
		).toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
	});
	vi.spyOn(store, "scopeResolutionDeviceContext").mockReturnValue({
		loadExpectedPublicKey: () => {
			attemptWrite();
			return context.loadExpectedPublicKey?.();
		},
	});
	try {
		const id = remember("Concurrent capture");
		expect(attemptWrite).toHaveBeenCalledOnce();
		expect(
			store.db
				.prepare(`SELECT source_device_id, evidence FROM memory_source_bindings
			WHERE entity_id = (SELECT import_key FROM memory_items WHERE id = ?)`)
				.get(id),
		).toEqual({
			source_device_id: store.deviceId,
			evidence: "local_creation",
		});
		expect(store.db.inTransaction).toBe(false);
	} finally {
		writer.close();
	}
});

it("leaves no partial creation when another connection already holds the write lock", () => {
	enroll();
	const { store } = fixture;
	const writer = new Database(store.dbPath);
	store.db.pragma("busy_timeout = 0");
	writer.exec("BEGIN IMMEDIATE");
	try {
		expect(() => remember("Busy capture")).toThrow(
			expect.objectContaining({ code: "SQLITE_BUSY" }),
		);
		expect(store.db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(0);
		expect(store.db.prepare("SELECT COUNT(*) FROM memory_source_bindings").pluck().get()).toBe(0);
		expect(store.db.inTransaction).toBe(false);
	} finally {
		writer.exec("ROLLBACK");
		writer.close();
	}
	expect(remember("Capture after writer finished")).toBeGreaterThan(0);
});

it("rolls back source binding when the memory insert fails", () => {
	enroll();
	const { store } = fixture;
	store.db.exec(`CREATE TRIGGER reject_capture BEFORE INSERT ON memory_items
		BEGIN SELECT RAISE(ABORT, 'fixture_insert_failure'); END`);
	expect(() => remember("Rejected capture")).toThrow("fixture_insert_failure");
	expect(store.db.prepare("SELECT COUNT(*) FROM memory_source_bindings").pluck().get()).toBe(0);
	expect(store.db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(0);
	expect(store.db.inTransaction).toBe(false);
});

it("keeps creation inside a caller's immediate transaction and rolls back with that caller", () => {
	enroll();
	const { store } = fixture;
	expect(() =>
		store.db
			.transaction(() => {
				remember("Nested capture");
				expect(store.db.inTransaction).toBe(true);
				throw new Error("caller_rollback");
			})
			.immediate(),
	).toThrow("caller_rollback");
	expect(store.db.prepare("SELECT COUNT(*) FROM memory_source_bindings").pluck().get()).toBe(0);
	expect(store.db.prepare("SELECT COUNT(*) FROM memory_items").pluck().get()).toBe(0);
	expect(store.db.inTransaction).toBe(false);
});
