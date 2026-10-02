import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database, { type Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import type { CoordinatorAuthControllerReviewInput } from "./coordinator-auth-controller.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "./d1-coordinator-store.js";

type Store = BetterSqliteCoordinatorStore | D1CoordinatorStore;
type Backend = "SQLite" | "D1";
type Fixture = { store: Store; db: SqliteDatabase };

// The existing D1 suite's adapter is private. Keep this local equivalent small:
// every statement runs against SQLite and batch preserves D1 atomicity.
function sqliteD1(db: SqliteDatabase, hooks: { beforeFirst?: () => void } = {}): D1DatabaseLike {
	const executions = new WeakMap<D1PreparedStatementLike, () => unknown>();
	return {
		prepare(query) {
			const statement = db.prepare(query);
			let values: unknown[] = [];
			const run = () => ({ meta: { changes: statement.run(...values).changes } });
			const adapter: D1PreparedStatementLike = {
				bind(...bound) {
					values = bound;
					return adapter;
				},
				async first<T>() {
					hooks.beforeFirst?.();
					return (statement.get(...values) as T | undefined) ?? null;
				},
				async all<T>() {
					return { results: statement.all(...values) as T[] };
				},
				async raw<T>() {
					return statement.raw(true).all(...values) as T[];
				},
				async run() {
					return run();
				},
			};
			executions.set(adapter, run);
			return adapter;
		},
		async batch(statements) {
			return db.transaction(() =>
				statements.map((statement) => {
					const run = executions.get(statement);
					if (!run) throw new Error("Unknown test statement");
					return run();
				}),
			)();
		},
	};
}

function setupStore(backend: Backend): Fixture {
	if (backend === "SQLite") {
		const store = new BetterSqliteCoordinatorStore(":memory:");
		return { store, db: store.db };
	}
	const db = new Database(":memory:");
	try {
		const worker = join(import.meta.dirname, "../../cloudflare-coordinator-worker");
		db.exec(readFileSync(join(worker, "schema.sql"), "utf8"));
		return { store: new D1CoordinatorStore(sqliteD1(db)), db };
	} catch (error) {
		db.close();
		throw error;
	}
}

function review(
	overrides: Partial<CoordinatorAuthControllerReviewInput> = {},
): CoordinatorAuthControllerReviewInput {
	return {
		attestationId: "attestation-a",
		coordinatorId: "coordinator-a",
		identityId: "identity-a",
		groupId: "group-a",
		deviceId: "device-a",
		publicKey: "fixture-public-key\nexact-key-line",
		fingerprint: "a".repeat(64),
		reviewReceiptId: "receipt-a",
		evidenceDigest: "b".repeat(64),
		...overrides,
	};
}

async function enroll(store: Store, input = review()) {
	await store.createGroup(input.groupId);
	await store.enrollDevice(input.groupId, {
		deviceId: input.deviceId,
		publicKey: input.publicKey,
		fingerprint: input.fingerprint,
	});
}

function setIdentity(db: SqliteDatabase, identity: string | null) {
	db.prepare(
		"UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ? AND device_id = ?",
	).run(identity, "group-a", "device-a");
}

function registerCreationTests(test: ReturnType<typeof it.extend<{ fixture: Fixture }>>) {
	test.for([null, "identity-a"])(
		"requires explicit review for enrollment identity %s without mutating enrollment",
		async (identity, { fixture: { store, db } }) => {
			// Arrange: existing identity binding is not itself controller trust.
			const input = Object.freeze(review());
			await enroll(store, input);
			setIdentity(db, identity);
			const before = await store.getEnrollment(input.groupId, input.deviceId, true);
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM coordinator_auth_controller_attestations").get(),
			).toEqual({ count: 0 });
			expect(
				await store.getActiveAuthControllerAttestation(input.coordinatorId, input.attestationId),
			).toBeNull();
			// Act
			const result = await store.createAuthControllerAttestation(input);
			const active = await store.getActiveAuthControllerAttestation(
				input.coordinatorId,
				input.attestationId,
			);
			// Assert: reviewed actor and nullable enrollment binding are distinct.
			expect(result).toEqual({
				kind: "created",
				attestation: {
					attestation_id: input.attestationId,
					coordinator_id: input.coordinatorId,
					identity_id: input.identityId,
					group_id: input.groupId,
					device_id: input.deviceId,
					public_key: input.publicKey,
					fingerprint: input.fingerprint,
					review_receipt_id: input.reviewReceiptId,
					evidence_digest: input.evidenceDigest,
					enrollment_identity_id: identity,
					revision: 1,
					created_at: "2026-10-02T12:00:00.000Z",
					revoked_at: null,
				},
			});
			expect(active).toEqual(result.kind === "created" ? result.attestation : null);
			expect(await store.getEnrollment(input.groupId, input.deviceId, true)).toEqual(before);
			expect(input).toEqual(review());
		},
	);

	test("returns the unchanged original attestation on exact retry", async ({
		fixture: { store },
	}) => {
		// Arrange
		const input = review();
		await enroll(store);
		const first = await store.createAuthControllerAttestation(input);
		vi.setSystemTime(new Date("2026-10-03T12:00:00.000Z"));
		// Act
		const retry = await store.createAuthControllerAttestation(input);
		// Assert
		expect(first.kind).toBe("created");
		expect(retry).toEqual({
			kind: "existing",
			attestation: first.kind === "created" ? first.attestation : null,
		});
	});

	test("isolates duplicate attestation, receipt, and tuple identifiers by coordinator", async ({
		fixture: { store },
	}) => {
		// Arrange
		await enroll(store);
		const firstInput = review();
		const secondInput = review({ coordinatorId: "coordinator-b" });
		// Act
		const first = await store.createAuthControllerAttestation(firstInput);
		const second = await store.createAuthControllerAttestation(secondInput);
		// Assert
		expect(first.kind).toBe("created");
		expect(second.kind).toBe("created");
		expect(
			await store.getActiveAuthControllerAttestation("coordinator-b", "attestation-a"),
		).toMatchObject({ coordinator_id: "coordinator-b" });
		expect(
			await store.getActiveAuthControllerAttestation("coordinator-missing", "attestation-a"),
		).toBeNull();
	});
}

const mismatches = [
	"wrong actor",
	"missing group",
	"missing device",
	"archived group",
	"disabled key",
	"wrong fingerprint",
	"wrong key",
] as const;
async function mismatch(fixture: Fixture, scenario: (typeof mismatches)[number]) {
	const input = review();
	const { store, db } = fixture;
	await enroll(store);
	if (scenario === "wrong actor") setIdentity(db, "identity-other");
	if (scenario === "missing group") input.groupId = "group-missing";
	if (scenario === "missing device") input.deviceId = "device-missing";
	if (scenario === "archived group") await store.archiveGroup(input.groupId);
	if (scenario === "disabled key")
		await store.setDeviceEnabled(input.groupId, input.deviceId, false);
	if (scenario === "wrong fingerprint") input.fingerprint = "c".repeat(64);
	if (scenario === "wrong key") input.publicKey = `${input.publicKey}\n`;
	return input;
}

function registerMismatchTests(test: ReturnType<typeof it.extend<{ fixture: Fixture }>>) {
	test.for(mismatches)(
		"rejects review for %s without changing enrollment",
		async (scenario, { fixture }) => {
			// Arrange
			const input = await mismatch(fixture, scenario);
			const before = await fixture.store.getEnrollment("group-a", "device-a", true);
			// Act
			const result = await fixture.store.createAuthControllerAttestation(input);
			// Assert
			expect(result).toEqual({ kind: "rejected", error: "enrollment_mismatch" });
			expect(
				await fixture.store.getActiveAuthControllerAttestation(
					input.coordinatorId,
					input.attestationId,
				),
			).toBeNull();
			expect(await fixture.store.getEnrollment("group-a", "device-a", true)).toEqual(before);
		},
	);
}

const conflicts: [string, Partial<CoordinatorAuthControllerReviewInput>][] = [
	["changed attestation actor", { identityId: "identity-other" }],
	["changed evidence", { evidenceDigest: "c".repeat(64) }],
	["changed receipt", { reviewReceiptId: "receipt-other" }],
	[
		"changed binding",
		{ deviceId: "device-b", publicKey: "second-public-key", fingerprint: "d".repeat(64) },
	],
	[
		"same tuple with new ID",
		{ attestationId: "attestation-other", reviewReceiptId: "receipt-other" },
	],
	[
		"same tuple with new actor",
		{
			attestationId: "attestation-other",
			identityId: "identity-other",
			reviewReceiptId: "receipt-other",
		},
	],
	[
		"receipt reused for another target",
		{
			attestationId: "attestation-other",
			deviceId: "device-b",
			publicKey: "second-public-key",
			fingerprint: "d".repeat(64),
		},
	],
];

function registerConflictTests(test: ReturnType<typeof it.extend<{ fixture: Fixture }>>) {
	test.for(conflicts)(
		"rejects %s and preserves the original review",
		async ([_label, overrides], { fixture: { store } }) => {
			// Arrange
			await enroll(store);
			await store.enrollDevice("group-a", {
				deviceId: "device-b",
				publicKey: "second-public-key",
				fingerprint: "d".repeat(64),
			});
			const first = await store.createAuthControllerAttestation(review());
			const conflicting = review(overrides);
			// Act
			const result = await store.createAuthControllerAttestation(conflicting);
			// Assert
			expect(result).toEqual({ kind: "rejected", error: "attestation_conflict" });
			expect(
				await store.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
			).toEqual(first.kind === "created" ? first.attestation : null);
			if (conflicting.attestationId !== "attestation-a") {
				expect(
					await store.getActiveAuthControllerAttestation(
						"coordinator-a",
						conflicting.attestationId,
					),
				).toBeNull();
			}
		},
	);
}

function registerRevocationTests(test: ReturnType<typeof it.extend<{ fixture: Fixture }>>) {
	test("revokes idempotently, never resurrects, and leaves enrollment unchanged", async ({
		fixture: { store },
	}) => {
		// Arrange
		await enroll(store);
		await store.createAuthControllerAttestation(review());
		const before = await store.getEnrollment("group-a", "device-a", true);
		// Act
		const revoked = await store.revokeAuthControllerAttestation("coordinator-a", "attestation-a");
		const repeated = await store.revokeAuthControllerAttestation("coordinator-a", "attestation-a");
		const retry = await store.createAuthControllerAttestation(review());
		const replacement = await store.createAuthControllerAttestation(
			review({ attestationId: "attestation-new", reviewReceiptId: "receipt-new" }),
		);
		await store.setDeviceEnabled("group-a", "device-a", false);
		await store.setDeviceEnabled("group-a", "device-a", true);
		await store.enrollDevice("group-a", {
			deviceId: "device-a",
			publicKey: "replacement-key",
			fingerprint: "c".repeat(64),
		});
		await enroll(store);
		// Assert
		expect([revoked, repeated]).toEqual([true, true]);
		expect(retry).toEqual({ kind: "rejected", error: "attestation_revoked" });
		expect(replacement).toEqual({ kind: "rejected", error: "attestation_conflict" });
		expect(
			await store.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
		).toBeNull();
		expect(await store.getEnrollment("group-a", "device-a", true)).toEqual(before);
	});

	test("cannot revoke a missing or another coordinator's attestation", async ({
		fixture: { store },
	}) => {
		// Arrange
		await enroll(store);
		const first = await store.createAuthControllerAttestation(review());
		// Act
		const wrongCoordinator = await store.revokeAuthControllerAttestation(
			"coordinator-b",
			"attestation-a",
		);
		const missing = await store.revokeAuthControllerAttestation("coordinator-a", "missing");
		// Assert
		expect([wrongCoordinator, missing]).toEqual([false, false]);
		expect(
			await store.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
		).toEqual(first.kind === "created" ? first.attestation : null);
	});
}

const liveChanges = [
	"rekey",
	"disable",
	"archive",
	"remove enrollment",
	"change identity",
] as const;
async function changeLiveEnrollment({ store, db }: Fixture, change: (typeof liveChanges)[number]) {
	if (change === "rekey") {
		await store.enrollDevice("group-a", {
			deviceId: "device-a",
			publicKey: "replacement-key",
			fingerprint: "c".repeat(64),
		});
	}
	if (change === "disable") await store.setDeviceEnabled("group-a", "device-a", false);
	if (change === "archive") await store.archiveGroup("group-a");
	if (change === "remove enrollment") await store.removeDevice("group-a", "device-a");
	if (change === "change identity") setIdentity(db, "identity-other");
}

function registerLiveTests(test: ReturnType<typeof it.extend<{ fixture: Fixture }>>) {
	test.for(liveChanges)("stops trusting the controller after %s", async (change, { fixture }) => {
		// Arrange
		await enroll(fixture.store);
		setIdentity(fixture.db, "identity-a");
		const created = await fixture.store.createAuthControllerAttestation(review());
		expect(
			await fixture.store.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
		).toEqual(created.kind === "created" ? created.attestation : null);
		// Act
		await changeLiveEnrollment(fixture, change);
		const active = await fixture.store.getActiveAuthControllerAttestation(
			"coordinator-a",
			"attestation-a",
		);
		// Assert
		expect(active).toBeNull();
	});

	test.for(["disable", "archive", "rekey"] as const)(
		"restores unrevoked trust when the exact live values return after %s",
		async (change, { fixture }) => {
			// Arrange
			await enroll(fixture.store);
			const created = await fixture.store.createAuthControllerAttestation(review());
			await changeLiveEnrollment(fixture, change);
			expect(
				await fixture.store.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
			).toBeNull();
			// Act
			await enroll(fixture.store);
			await fixture.store.setDeviceEnabled("group-a", "device-a", true);
			await fixture.store.unarchiveGroup("group-a");
			const restored = await fixture.store.getActiveAuthControllerAttestation(
				"coordinator-a",
				"attestation-a",
			);
			// Assert
			expect(restored).toEqual(created.kind === "created" ? created.attestation : null);
		},
	);
}

const idFields = [
	"attestationId",
	"coordinatorId",
	"identityId",
	"groupId",
	"deviceId",
	"reviewReceiptId",
] as const;
const invalidIds = [
	"",
	" ",
	" padded ",
	"x".repeat(257),
	"has\u0000control",
	"has\u200bformat",
	"has\ud800surrogate",
	42,
	null,
	undefined,
];
const invalidInputs: [string, unknown][] = [
	["null input", null],
	["array input", []],
	...idFields.flatMap((field) =>
		invalidIds.map((value): [string, unknown] => [
			`invalid ${field}: ${JSON.stringify(value)}`,
			{ ...review(), [field]: value },
		]),
	),
	...["fingerprint", "evidenceDigest"].flatMap((field) =>
		["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "z".repeat(64)].map(
			(value): [string, unknown] => [`invalid ${field}: ${value}`, { ...review(), [field]: value }],
		),
	),
	...["", " ", "x".repeat(4097), 42].map((value): [string, unknown] => [
		`invalid public key: ${String(value).slice(0, 32)}`,
		{ ...review(), publicKey: value },
	]),
];

function registerValidationTests(test: ReturnType<typeof it.extend<{ fixture: Fixture }>>) {
	test.for(invalidInputs)(
		"rejects %s with a redacted result",
		async ([_label, input], { fixture: { store } }) => {
			// Arrange
			await enroll(store);
			const before = await store.getEnrollment("group-a", "device-a", true);
			// Act: casts deliberately exercise the runtime boundary, not TypeScript.
			const result = await store.createAuthControllerAttestation(
				input as CoordinatorAuthControllerReviewInput,
			);
			// Assert
			expect(result).toEqual({ kind: "rejected", error: "invalid_review_input" });
			expect(
				await store.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
			).toBeNull();
			expect(await store.getEnrollment("group-a", "device-a", true)).toEqual(before);
		},
	);

	test.for(["getter", "inherited", "coercion"] as const)(
		"rejects %s fields without executing user code",
		async (variant, { fixture: { store } }) => {
			// Arrange
			await enroll(store);
			const executed = vi.fn(() => {
				throw new Error("untrusted input must not execute");
			});
			let input: unknown = review();
			if (variant === "getter") Object.defineProperty(input, "identityId", { get: executed });
			if (variant === "inherited") input = Object.create(review());
			if (variant === "coercion")
				input = { ...review(), identityId: { toString: executed, valueOf: executed } };
			// Act
			const result = await store.createAuthControllerAttestation(
				input as CoordinatorAuthControllerReviewInput,
			);
			// Assert
			expect(result).toEqual({ kind: "rejected", error: "invalid_review_input" });
			expect(executed).not.toHaveBeenCalled();
			expect(
				await store.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
			).toBeNull();
		},
	);

	test("accepts maximum identifier and key lengths with exact multiline key storage", async ({
		fixture: { store },
	}) => {
		// Arrange
		const input = Object.freeze(
			review({
				attestationId: "a".repeat(256),
				coordinatorId: "c".repeat(256),
				identityId: "i".repeat(256),
				groupId: "g".repeat(256),
				deviceId: "d".repeat(256),
				reviewReceiptId: "r".repeat(256),
				publicKey: `first-line\n${"k".repeat(4085)}`,
			}),
		);
		await enroll(store, input);
		// Act
		const result = await store.createAuthControllerAttestation(input);
		// Assert
		expect(input.publicKey).toHaveLength(4096);
		expect(result).toMatchObject({
			kind: "created",
			attestation: { public_key: input.publicKey, attestation_id: input.attestationId },
		});
	});
}

function registerFailureTests(test: ReturnType<typeof it.extend<{ fixture: Fixture }>>) {
	test("rejects an accessor even when Object.prototype supplies its expected value", async ({
		fixture: { store, db },
	}) => {
		// Arrange: construct the accessor before polluting descriptor inheritance.
		await enroll(store);
		const input = review();
		const getter = vi.fn(() => "identity-a");
		Object.defineProperty(input, "identityId", { get: getter });
		const previous = Object.getOwnPropertyDescriptor(Object.prototype, "value");
		let result: unknown;
		try {
			Object.defineProperty(Object.prototype, "value", { value: "identity-a", configurable: true });
			// Act
			result = await store.createAuthControllerAttestation(input);
		} finally {
			Reflect.deleteProperty(Object.prototype, "value");
			if (previous) Object.defineProperty(Object.prototype, "value", previous);
		}
		// Assert
		expect(result).toEqual({ kind: "rejected", error: "invalid_review_input" });
		expect(getter).not.toHaveBeenCalled();
		expect(
			db.prepare("SELECT COUNT(*) AS count FROM coordinator_auth_controller_attestations").get(),
		).toEqual({ count: 0 });
	});

	test("propagates non-unique insertion failures without storing a controller", async ({
		fixture: { store, db },
	}) => {
		// Arrange: a disposable trigger fails the real backend insertion.
		await enroll(store);
		db.exec(`CREATE TEMP TRIGGER fail_controller_insert
			BEFORE INSERT ON coordinator_auth_controller_attestations
			BEGIN SELECT RAISE(ABORT, 'test insertion backend failure'); END;`);
		// Act
		const creation = store.createAuthControllerAttestation(review());
		// Assert: infrastructure failure is not a review conflict.
		await expect(creation).rejects.toThrow("test insertion backend failure");
		expect(
			db.prepare("SELECT COUNT(*) AS count FROM coordinator_auth_controller_attestations").get(),
		).toEqual({ count: 0 });
		expect(
			await store.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
		).toBeNull();
	});

	test("concurrent different reviews for one ID produce one winner and a safe exact retry", async ({
		fixture: { store, db },
	}) => {
		// Arrange
		await enroll(store);
		const inputs = [review(), review({ evidenceDigest: "c".repeat(64) })];
		// Act
		const results = await Promise.all(
			inputs.map((input) => store.createAuthControllerAttestation(input)),
		);
		const winner = results.findIndex((result) => result.kind === "created");
		const retry = await store.createAuthControllerAttestation(inputs[winner]);
		// Assert
		expect(results.filter((result) => result.kind === "created")).toHaveLength(1);
		expect(results.filter((result) => result.kind === "rejected")).toEqual([
			{ kind: "rejected", error: "attestation_conflict" },
		]);
		expect(
			db.prepare("SELECT COUNT(*) AS count FROM coordinator_auth_controller_attestations").get(),
		).toEqual({ count: 1 });
		const winningResult = results[winner];
		expect(retry).toEqual({
			kind: "existing",
			attestation: winningResult.kind === "created" ? winningResult.attestation : null,
		});
	});
}

function registerD1ReadRaceTests(test: ReturnType<typeof it.extend<{ fixture: Fixture }>>) {
	test("recovers a persisted review by exact retry after the D1 post-insert read fails", async ({
		fixture: { store, db },
	}) => {
		// Arrange
		await enroll(store);
		const beforeFirst = vi.fn().mockImplementationOnce(() => {
			throw new Error("test D1 read failure");
		});
		const faulting = new D1CoordinatorStore(sqliteD1(db, { beforeFirst }));
		// Act
		const creation = faulting.createAuthControllerAttestation(review());
		// Assert: the failed response does not roll back an already committed D1 insert.
		await expect(creation).rejects.toThrow("test D1 read failure");
		expect(
			db.prepare("SELECT COUNT(*) AS count FROM coordinator_auth_controller_attestations").get(),
		).toEqual({ count: 1 });
		const recovered = await faulting.createAuthControllerAttestation(review());
		expect(recovered.kind).toBe("existing");
		expect(
			await faulting.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
		).toEqual(recovered.kind === "existing" ? recovered.attestation : null);
	});

	test("denies authority when the live key changes between D1 insertion and read", async ({
		fixture: { store, db },
	}) => {
		// Arrange
		await enroll(store);
		const beforeFirst = vi.fn().mockImplementationOnce(() => {
			db.prepare(
				"UPDATE enrolled_devices SET public_key = ?, fingerprint = ? WHERE group_id = ? AND device_id = ?",
			).run("replacement-key", "c".repeat(64), "group-a", "device-a");
		});
		const racing = new D1CoordinatorStore(sqliteD1(db, { beforeFirst }));
		// Act
		const creation = racing.createAuthControllerAttestation(review());
		await expect(creation).rejects.toThrow("auth_controller_persistence_incomplete");
		const retry = await racing.createAuthControllerAttestation(review());
		// Assert: a durable receipt is not active authority for the replacement key.
		expect(retry).toEqual({ kind: "rejected", error: "enrollment_mismatch" });
		expect(
			db
				.prepare(
					"SELECT review_receipt_id, public_key, fingerprint FROM coordinator_auth_controller_attestations",
				)
				.all(),
		).toEqual([
			{
				review_receipt_id: "receipt-a",
				public_key: review().publicKey,
				fingerprint: review().fingerprint,
			},
		]);
		expect(
			await racing.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
		).toBeNull();
		// Restoring the exact values can reactivate the stored review; explicit
		// revocation is required to prevent that review from becoming authority.
		await enroll(store);
		expect(
			await racing.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
		).toMatchObject({ review_receipt_id: "receipt-a" });
		expect(await racing.revokeAuthControllerAttestation("coordinator-a", "attestation-a")).toBe(
			true,
		);
		expect(
			await racing.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
		).toBeNull();
		expect(await racing.createAuthControllerAttestation(review())).toEqual({
			kind: "rejected",
			error: "attestation_revoked",
		});
	});
}

function controllerSchema(db: SqliteDatabase) {
	const indexes = db.pragma("index_list(coordinator_auth_controller_attestations)") as {
		name: string;
		unique: number;
	}[];
	return {
		ddl: (
			db
				.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
				.pluck()
				.get("coordinator_auth_controller_attestations") as string
		)
			.replace(/\s+/gu, " ")
			.trim(),
		columns: db.pragma("table_info(coordinator_auth_controller_attestations)"),
		uniqueIndexes: indexes
			.filter((index) => index.unique === 1)
			.map((index) => {
				const columns = db
					.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
					.all(index.name) as { name: string }[];
				return columns.map((column) => column.name).join(",");
			})
			.sort(),
	};
}

function registerPersistenceTests(
	test: ReturnType<typeof it.extend<{ fixture: Fixture }>>,
	backend: Backend,
) {
	test("fresh Worker schema matches SQLite controller columns and unique bindings", async ({
		fixture: { db },
	}) => {
		// Arrange: D1 setup loads schema.sql alone, without applying migration 0016.
		const peer = setupStore(backend === "SQLite" ? "D1" : "SQLite");
		try {
			// Act
			const actual = controllerSchema(db);
			const expected = controllerSchema(peer.db);
			// Assert
			expect(actual.ddl).toEqual(expected.ddl);
			expect(actual.columns).toEqual(expected.columns);
			expect(actual.uniqueIndexes).toEqual(expected.uniqueIndexes);
			expect(actual.uniqueIndexes).toEqual([
				"coordinator_id,attestation_id",
				"coordinator_id,group_id,device_id,fingerprint",
				"coordinator_id,review_receipt_id",
			]);
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM coordinator_auth_controller_attestations").get(),
			).toEqual({ count: 0 });
		} finally {
			await peer.store.close();
			if (peer.db.open) peer.db.close();
		}
	});

	test("gives disabled enrollment mismatch priority over a revoked retry", async ({
		fixture: { store },
	}) => {
		// Arrange
		await enroll(store);
		await store.createAuthControllerAttestation(review());
		await store.revokeAuthControllerAttestation("coordinator-a", "attestation-a");
		await store.setDeviceEnabled("group-a", "device-a", false);
		// Act
		const result = await store.createAuthControllerAttestation(review());
		// Assert
		expect(result).toEqual({ kind: "rejected", error: "enrollment_mismatch" });
		expect(
			await store.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
		).toBeNull();
	});

	test("preserves revocation tombstones across removal and reenrollment", async ({
		fixture: { store, db },
	}) => {
		// Arrange
		await enroll(store);
		await store.createAuthControllerAttestation(review());
		await store.revokeAuthControllerAttestation("coordinator-a", "attestation-a");
		// Act
		await store.removeDevice("group-a", "device-a");
		const repeatedRevocation = await store.revokeAuthControllerAttestation(
			"coordinator-a",
			"attestation-a",
		);
		await enroll(store);
		const retry = await store.createAuthControllerAttestation(review());
		// Assert
		expect(repeatedRevocation).toBe(true);
		expect(
			db.prepare("SELECT revoked_at FROM coordinator_auth_controller_attestations").get(),
		).toEqual({ revoked_at: "2026-10-02T12:00:00.000Z" });
		expect(retry).toEqual({ kind: "rejected", error: "attestation_revoked" });
		expect(
			await store.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
		).toBeNull();
	});
}

function registerBindingTests(test: ReturnType<typeof it.extend<{ fixture: Fixture }>>) {
	test("keeps explicitly reviewed identity authority when its enrollment label becomes null", async ({
		fixture: { store, db },
	}) => {
		// Arrange
		await enroll(store);
		setIdentity(db, "identity-a");
		const created = await store.createAuthControllerAttestation(review());
		// Act
		setIdentity(db, null);
		const active = await store.getActiveAuthControllerAttestation("coordinator-a", "attestation-a");
		// Assert: live values, not a label-change counter, decide current authority.
		expect(active).toEqual(created.kind === "created" ? created.attestation : null);
		expect(active).toMatchObject({ enrollment_identity_id: "identity-a" });
		expect(await store.getEnrollment("group-a", "device-a", true)).toMatchObject({
			identity_id: null,
		});
	});

	test("round-trips quote, percent, underscore, and double-hyphen IDs without SQL interpretation", async ({
		fixture: { store, db },
	}) => {
		// Arrange
		const token = "quote'percent%underscore_double--hyphen";
		const input = review({
			attestationId: `att-${token}`,
			coordinatorId: `coord-${token}`,
			identityId: `actor-${token}`,
			groupId: `group-${token}`,
			deviceId: `device-${token}`,
			reviewReceiptId: `receipt-${token}`,
		});
		await enroll(store, input);
		// Act
		const result = await store.createAuthControllerAttestation(input);
		const active = await store.getActiveAuthControllerAttestation(
			input.coordinatorId,
			input.attestationId,
		);
		const wildcard = await store.getActiveAuthControllerAttestation("%", "%");
		// Assert
		expect(result.kind).toBe("created");
		expect(active).toMatchObject({
			attestation_id: input.attestationId,
			coordinator_id: input.coordinatorId,
			identity_id: input.identityId,
			group_id: input.groupId,
			device_id: input.deviceId,
			review_receipt_id: input.reviewReceiptId,
		});
		expect(wildcard).toBeNull();
		expect(db.prepare("SELECT COUNT(*) AS count FROM enrolled_devices").get()).toEqual({
			count: 1,
		});
	});
}

describe("SQLite auth-controller existing-file upgrade", () => {
	it("adds an empty review table without trusting or changing legacy enrollment", async () => {
		// Arrange: only this disposable fixture file simulates a pre-controller store.
		const directory = mkdtempSync(join(tmpdir(), "controller-upgrade-test-"));
		const path = join(directory, "coordinator.sqlite");
		let store: BetterSqliteCoordinatorStore | undefined;
		try {
			store = new BetterSqliteCoordinatorStore(path);
			await enroll(store);
			setIdentity(store.db, "identity-a");
			const before = await store.getEnrollment("group-a", "device-a", true);
			store.db.exec("DROP TABLE coordinator_auth_controller_attestations");
			await store.close();
			// Act
			store = new BetterSqliteCoordinatorStore(path);
			const after = await store.getEnrollment("group-a", "device-a", true);
			// Assert
			expect(after).toEqual(before);
			expect(
				store.db
					.prepare("SELECT COUNT(*) AS count FROM coordinator_auth_controller_attestations")
					.get(),
			).toEqual({ count: 0 });
			expect(
				await store.getActiveAuthControllerAttestation("coordinator-a", "attestation-a"),
			).toBeNull();
			const explicit = await store.createAuthControllerAttestation(review());
			expect(explicit.kind).toBe("created");
		} finally {
			if (store?.db.open) await store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe.each(["SQLite", "D1"] as const)("%s auth-controller store parity", (backend) => {
	const test = it.extend<{ fixture: Fixture }>({
		fixture: async ({ task: _task }, use) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-10-02T12:00:00.000Z"));
			let fixture: Fixture | undefined;
			try {
				fixture = setupStore(backend);
				await use(fixture);
			} finally {
				if (fixture) {
					await fixture.store.close();
					if (fixture.db.open) fixture.db.close();
				}
				vi.useRealTimers();
			}
		},
	});
	registerCreationTests(test);
	registerMismatchTests(test);
	registerConflictTests(test);
	registerRevocationTests(test);
	registerLiveTests(test);
	registerValidationTests(test);
	registerFailureTests(test);
	registerPersistenceTests(test, backend);
	registerBindingTests(test);
	if (backend === "D1") registerD1ReadRaceTests(test);
});
