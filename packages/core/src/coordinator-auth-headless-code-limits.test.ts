import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	HEADLESS_CODE_ENTRY_CLEANUP_LIMIT,
	HEADLESS_CODE_ENTRY_CLIENT_LIMIT,
	HEADLESS_CODE_ENTRY_COORDINATOR_LIMIT,
	HEADLESS_CODE_ENTRY_WINDOW_MS,
	hashHeadlessCodeEntryClient,
	reserveHeadlessCodeEntry,
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
const CLIENT = "a".repeat(64);
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

function entry(nowMs: number, clientKeyHash = CLIENT, coordinatorId = COORDINATOR) {
	return { coordinatorId, clientKeyHash, nowMs };
}

async function reserve(limits: AuthLinkBackend, times: number, nowMs = T0, clientKeyHash = CLIENT) {
	const decisions = [];
	for (let n = 0; n < times; n += 1)
		decisions.push(await reserveHeadlessCodeEntry(limits, entry(nowMs, clientKeyHash)));
	return decisions;
}

function rows(f: Fixture) {
	return f.db
		.prepare(`SELECT * FROM ${HEADLESS_CODE_LIMITS_TABLE} ORDER BY coordinator_id, scope, key_hash`)
		.all() as { scope: string; key_hash: string; window_start_ms: number; failures: number }[];
}

function sha256(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

function counts(f: Fixture) {
	return rows(f).map(({ scope, failures }) => [scope, failures]);
}

/** Starts every call only after all of them are queued, so they race at one instant. */
async function barrierRace(limits: AuthLinkBackend, total: number, nowMs: number) {
	let release = () => {};
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const pending = Array.from({ length: total }, async () => {
		await barrier;
		return reserveHeadlessCodeEntry(limits, entry(nowMs));
	});
	release();
	return Promise.all(pending);
}

for (const backend of ["SQLite", "D1"] as const) {
	describe(`${backend} headless code-entry reservations`, () => {
		it("counts an allowed entry under the client hash and the coordinator", async () => {
			// Arrange
			const f = await open(backend);
			// Act
			const [decision] = await reserve(f.limits, 1);
			// Assert
			expect(decision).toEqual({ allowed: true });
			expect(rows(f)).toEqual([
				{
					coordinator_id: COORDINATOR,
					scope: "client",
					key_hash: CLIENT,
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
		});

		it("allows exactly the client limit, then refuses only that client", async () => {
			// Arrange
			const f = await open(backend);
			const allowed = await reserve(f.limits, HEADLESS_CODE_ENTRY_CLIENT_LIMIT);
			// Act
			const blocked = await reserveHeadlessCodeEntry(f.limits, entry(T0 + 1000));
			const other = await reserveHeadlessCodeEntry(f.limits, entry(T0 + 1000, "b".repeat(64)));
			const elsewhere = await reserveHeadlessCodeEntry(
				f.limits,
				entry(T0 + 1000, CLIENT, "coordinator-b"),
			);
			// Assert
			expect(allowed.every((decision) => decision.allowed)).toBe(true);
			expect(blocked).toEqual({ allowed: false, retryAfterMs: W - 1000 });
			expect(other).toEqual({ allowed: true });
			expect(elsewhere).toEqual({ allowed: true });
		});

		it("does not spend the coordinator budget on entries the client limit refuses", async () => {
			// Arrange
			const f = await open(backend);
			await reserve(f.limits, HEADLESS_CODE_ENTRY_CLIENT_LIMIT + 5);
			// Act
			const rowsAfter = counts(f);
			// Assert
			expect(rowsAfter).toEqual([
				["client", HEADLESS_CODE_ENTRY_CLIENT_LIMIT + 5],
				["coordinator", HEADLESS_CODE_ENTRY_CLIENT_LIMIT],
			]);
		});

		it("refuses every client once the coordinator reaches its limit", async () => {
			// Arrange
			const f = await open(backend);
			for (let n = 0; n < HEADLESS_CODE_ENTRY_COORDINATOR_LIMIT; n += 1)
				await reserve(f.limits, 1, T0 + n, sha256(`client-${n}`));
			// Act
			const decision = await reserveHeadlessCodeEntry(f.limits, entry(T0 + 5000, sha256("fresh")));
			// Assert
			expect(decision).toEqual({ allowed: false, retryAfterMs: W - 5000 });
		});

		it("restarts an expired window at the next entry", async () => {
			// Arrange
			const f = await open(backend);
			await reserve(f.limits, HEADLESS_CODE_ENTRY_CLIENT_LIMIT + 1);
			// Act
			const [decision] = await reserve(f.limits, 1, T0 + W);
			// Assert
			expect(decision).toEqual({ allowed: true });
			expect(rows(f).map(({ window_start_ms, failures }) => [window_start_ms, failures])).toEqual([
				[T0 + W, 1],
				[T0 + W, 1],
			]);
		});

		it("allows exactly one of many entries released together at the threshold", async () => {
			// Arrange
			const f = await open(backend);
			await reserve(f.limits, HEADLESS_CODE_ENTRY_CLIENT_LIMIT - 1);
			// Act
			const decisions = await barrierRace(f.limits, 25, T0 + 1);
			// Assert
			expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
			expect(counts(f)[0]).toEqual(["client", HEADLESS_CODE_ENTRY_CLIENT_LIMIT - 1 + 25]);
		});

		it("removes at most the cleanup limit of expired windows per entry", async () => {
			// Arrange
			const f = await open(backend);
			const insert = f.db.prepare(
				`INSERT INTO ${HEADLESS_CODE_LIMITS_TABLE} VALUES (?, 'client', ?, ?, 3)`,
			);
			const expired = HEADLESS_CODE_ENTRY_CLEANUP_LIMIT + 8;
			for (let n = 0; n < expired; n += 1) insert.run(`old-${n}`, sha256(`key-${n}`), T0 - W);
			insert.run("live", sha256("live-key"), T0 - W + 1);
			// Act
			await reserve(f.limits, 1);
			// Assert
			const remaining = rows(f);
			expect(remaining.filter(({ window_start_ms }) => window_start_ms === T0 - W)).toHaveLength(8);
			expect(remaining).toContainEqual(expect.objectContaining({ coordinator_id: "live" }));
			expect(remaining).toHaveLength(8 + 1 + 2);
		});

		it("rejects a raw client address or a bad clock instead of counting it", async () => {
			// Arrange
			const f = await open(backend);
			// Act / Assert
			await expect(reserveHeadlessCodeEntry(f.limits, entry(-1))).rejects.toThrow(
				"headless_code_entry_invalid_input",
			);
			await expect(reserveHeadlessCodeEntry(f.limits, entry(T0, "203.0.113.7"))).rejects.toThrow(
				"headless_code_entry_invalid_input",
			);
			expect(rows(f)).toEqual([]);
		});
	});
}

describe("headless code-entry client hash", () => {
	it("is HMAC-SHA-256 of the address, stable per key and different across keys", async () => {
		// Arrange
		const raw = new Uint8Array(32).fill(9);
		const key = await crypto.subtle.importKey(
			"raw",
			raw,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const other = await crypto.subtle.importKey(
			"raw",
			new Uint8Array(32).fill(8),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		// Act
		const first = await hashHeadlessCodeEntryClient(key, "203.0.113.7");
		const again = await hashHeadlessCodeEntryClient(key, "203.0.113.7");
		const rotated = await hashHeadlessCodeEntryClient(other, "203.0.113.7");
		// Assert
		expect(first).toBe(createHmac("sha256", raw).update("203.0.113.7").digest("hex"));
		expect(again).toBe(first);
		expect(rotated).not.toBe(first);
		await expect(hashHeadlessCodeEntryClient(key, "")).rejects.toThrow(
			"headless_code_entry_invalid_input",
		);
	});
});

describe("headless code-entry limits shared by two stores on one database", () => {
	it("counts SQLite entries from both stores against one limit", async () => {
		// Arrange
		const directory = mkdtempSync(join(tmpdir(), "headless-code-limits-"));
		cleanups.push(() => rmSync(directory, { recursive: true }));
		const databasePath = join(directory, "coordinator.sqlite");
		const a = await open("SQLite", { databasePath });
		const b = await open("SQLite", { databasePath });
		// Act
		await Promise.all([
			reserve(a.limits, HEADLESS_CODE_ENTRY_CLIENT_LIMIT / 2),
			reserve(b.limits, HEADLESS_CODE_ENTRY_CLIENT_LIMIT / 2),
		]);
		// Assert
		expect(await reserveHeadlessCodeEntry(a.limits, entry(T0 + 1))).toMatchObject({
			allowed: false,
		});
	});

	it("counts D1 entries from both stores against one limit", async () => {
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
			reserve(a.limits, HEADLESS_CODE_ENTRY_CLIENT_LIMIT / 2),
			reserve(b, HEADLESS_CODE_ENTRY_CLIENT_LIMIT / 2),
		]);
		// Assert
		expect(await reserveHeadlessCodeEntry(b, entry(T0 + 1))).toMatchObject({ allowed: false });
	});
});
