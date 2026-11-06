import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkHeadlessCodeEntry,
	HEADLESS_CODE_ENTRY_CLEANUP_LIMIT,
	HEADLESS_CODE_ENTRY_CLIENT_LIMIT,
	HEADLESS_CODE_ENTRY_COORDINATOR_LIMIT,
	HEADLESS_CODE_ENTRY_WINDOW_MS,
	recordHeadlessCodeEntryFailure,
} from "./coordinator-auth-headless-code-limits.js";
import { HEADLESS_CODE_LIMITS_TABLE } from "./coordinator-auth-headless-schema.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import {
	type Backend,
	type Fixture,
	setupStore,
	sqliteD1,
} from "./coordinator-auth-store-test-fixtures.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

const T0 = 1_800_000_000_000;
const W = HEADLESS_CODE_ENTRY_WINDOW_MS;
const COORDINATOR = "coordinator-a";
const CLIENT = "203.0.113.7";
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(backend: Backend, options: { databasePath?: string } = {}) {
	const f = setupStore(backend, options);
	cleanups.push(async () => {
		await f.store.close();
		if (f.db.open) f.db.close();
	});
	const limits = await f.store.readHeadlessLinkBackend();
	if (!limits) throw new Error("fixture_headless_capability_missing");
	return { ...f, limits };
}

function entry(nowMs: number, clientKey = CLIENT, coordinatorId = COORDINATOR) {
	return { coordinatorId, clientKey, nowMs };
}

async function fail(limits: AuthLinkBackend, times: number, nowMs = T0, clientKey = CLIENT) {
	for (let n = 0; n < times; n += 1)
		await recordHeadlessCodeEntryFailure(limits, entry(nowMs, clientKey));
}

function rows(f: Fixture) {
	return f.db
		.prepare(`SELECT * FROM ${HEADLESS_CODE_LIMITS_TABLE} ORDER BY coordinator_id, scope, key_hash`)
		.all() as { scope: string; key_hash: string; window_start_ms: number; failures: number }[];
}

function sha256(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

for (const backend of ["SQLite", "D1"] as const) {
	describe(`${backend} headless code-entry limits`, () => {
		it("allows entry when no failures are recorded", async () => {
			// Arrange
			const f = await open(backend);
			// Act
			const decision = await checkHeadlessCodeEntry(f.limits, entry(T0));
			// Assert
			expect(decision).toEqual({ allowed: true });
		});

		it("stores the SHA-256 hash of the client key and never the raw key", async () => {
			// Arrange
			const f = await open(backend);
			// Act
			await fail(f.limits, 1);
			// Assert
			expect(rows(f)).toEqual([
				{
					coordinator_id: COORDINATOR,
					scope: "client",
					key_hash: sha256(CLIENT),
					window_start_ms: T0,
					failures: 1,
				},
				{
					coordinator_id: COORDINATOR,
					scope: "coordinator",
					key_hash: "",
					window_start_ms: T0,
					failures: 1,
				},
			]);
			expect(JSON.stringify(rows(f))).not.toContain(CLIENT);
		});

		it("blocks a client at its limit until its window ends, and only that client", async () => {
			// Arrange
			const f = await open(backend);
			await fail(f.limits, HEADLESS_CODE_ENTRY_CLIENT_LIMIT - 1);
			const below = await checkHeadlessCodeEntry(f.limits, entry(T0 + 1000));
			await fail(f.limits, 1);
			// Act
			const blocked = await checkHeadlessCodeEntry(f.limits, entry(T0 + 1000));
			const other = await checkHeadlessCodeEntry(f.limits, entry(T0 + 1000, "198.51.100.9"));
			const elsewhere = await checkHeadlessCodeEntry(
				f.limits,
				entry(T0 + 1000, CLIENT, "coordinator-b"),
			);
			// Assert
			expect(below).toEqual({ allowed: true });
			expect(blocked).toEqual({ allowed: false, retryAfterMs: W - 1000 });
			expect(other).toEqual({ allowed: true });
			expect(elsewhere).toEqual({ allowed: true });
		});

		it("blocks every client once the coordinator reaches its limit", async () => {
			// Arrange
			const f = await open(backend);
			for (let n = 0; n < HEADLESS_CODE_ENTRY_COORDINATOR_LIMIT; n += 1)
				await fail(f.limits, 1, T0 + n, `client-${n}`);
			// Act
			const decision = await checkHeadlessCodeEntry(f.limits, entry(T0 + 5000, "fresh-client"));
			// Assert
			expect(decision).toEqual({ allowed: false, retryAfterMs: W - 5000 });
		});

		it("resets an expired window at the next failure", async () => {
			// Arrange
			const f = await open(backend);
			await fail(f.limits, HEADLESS_CODE_ENTRY_CLIENT_LIMIT);
			// Act
			const atBoundary = await checkHeadlessCodeEntry(f.limits, entry(T0 + W));
			await fail(f.limits, 1, T0 + W);
			// Assert
			expect(atBoundary).toEqual({ allowed: true });
			expect(rows(f).map(({ window_start_ms, failures }) => [window_start_ms, failures])).toEqual([
				[T0 + W, 1],
				[T0 + W, 1],
			]);
		});

		it("counts every concurrent failure at a window boundary exactly once", async () => {
			// Arrange
			const f = await open(backend);
			await fail(f.limits, 5);
			const concurrent = 25;
			// Act
			await Promise.all(
				Array.from({ length: concurrent }, () =>
					recordHeadlessCodeEntryFailure(f.limits, entry(T0 + W)),
				),
			);
			// Assert: one failure reopened the window and the rest counted in it.
			expect(rows(f).map(({ window_start_ms, failures }) => [window_start_ms, failures])).toEqual([
				[T0 + W, concurrent],
				[T0 + W, concurrent],
			]);
		});

		it("removes at most the cleanup limit of expired windows per failure", async () => {
			// Arrange
			const f = await open(backend);
			const insert = f.db.prepare(
				`INSERT INTO ${HEADLESS_CODE_LIMITS_TABLE} VALUES (?, 'client', ?, ?, 3)`,
			);
			const expired = HEADLESS_CODE_ENTRY_CLEANUP_LIMIT + 8;
			for (let n = 0; n < expired; n += 1) insert.run(`old-${n}`, sha256(`key-${n}`), T0 - W);
			insert.run("live", sha256("live-key"), T0 - W + 1);
			// Act
			await fail(f.limits, 1);
			// Assert
			const remaining = rows(f);
			expect(remaining.filter(({ window_start_ms }) => window_start_ms === T0 - W)).toHaveLength(8);
			expect(remaining).toContainEqual(expect.objectContaining({ coordinator_id: "live" }));
			expect(remaining).toHaveLength(8 + 1 + 2);
		});

		it("rejects malformed input instead of counting it", async () => {
			// Arrange
			const f = await open(backend);
			// Act / Assert
			await expect(checkHeadlessCodeEntry(f.limits, entry(-1))).rejects.toThrow(
				"headless_code_entry_invalid_input",
			);
			await expect(recordHeadlessCodeEntryFailure(f.limits, entry(T0, ""))).rejects.toThrow(
				"headless_code_entry_invalid_input",
			);
			expect(rows(f)).toEqual([]);
		});
	});
}

describe("headless code-entry limits shared by two stores on one database", () => {
	it("counts SQLite failures from both stores against one limit", async () => {
		// Arrange
		const directory = mkdtempSync(join(tmpdir(), "headless-code-limits-"));
		cleanups.push(() => rmSync(directory, { recursive: true }));
		const databasePath = join(directory, "coordinator.sqlite");
		const a = await open("SQLite", { databasePath });
		const b = await open("SQLite", { databasePath });
		// Act
		await Promise.all([
			fail(a.limits, HEADLESS_CODE_ENTRY_CLIENT_LIMIT / 2),
			fail(b.limits, HEADLESS_CODE_ENTRY_CLIENT_LIMIT / 2),
		]);
		// Assert
		expect(await checkHeadlessCodeEntry(a.limits, entry(T0 + 1))).toMatchObject({ allowed: false });
		expect(await checkHeadlessCodeEntry(b.limits, entry(T0 + 1))).toMatchObject({ allowed: false });
	});

	it("counts D1 failures from both stores against one limit", async () => {
		// Arrange
		const directory = mkdtempSync(join(tmpdir(), "headless-code-limits-d1-"));
		cleanups.push(() => rmSync(directory, { recursive: true }));
		const databasePath = join(directory, "coordinator.sqlite");
		const a = await open("D1", { databasePath });
		const shared = new Database(databasePath);
		shared.pragma("busy_timeout = 5000");
		cleanups.push(() => shared.close());
		const other = new D1CoordinatorStore(sqliteD1(shared));
		const b = await other.readHeadlessLinkBackend();
		if (!b) throw new Error("fixture_headless_capability_missing");
		// Act
		await Promise.all([
			fail(a.limits, HEADLESS_CODE_ENTRY_CLIENT_LIMIT / 2),
			fail(b, HEADLESS_CODE_ENTRY_CLIENT_LIMIT / 2),
		]);
		// Assert
		expect(await checkHeadlessCodeEntry(a.limits, entry(T0 + 1))).toMatchObject({ allowed: false });
		expect(await checkHeadlessCodeEntry(b, entry(T0 + 1))).toMatchObject({ allowed: false });
	});
});
