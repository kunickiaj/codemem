import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import {
	AUTH_CONTROLLER_INSERT_SQL,
	AUTH_CONTROLLER_RETRY_ACTIVE_SQL,
	AUTH_CONTROLLER_RETRY_ELIGIBLE_SQL,
	authControllerInsertValues,
	authControllerRetryActiveValues,
	authControllerRetryEligibleValues,
	type CoordinatorAuthControllerReviewInput,
} from "./coordinator-auth-controller.js";
import {
	type Backend,
	enroll,
	type Fixture,
	review,
	setupStore,
	sqliteD1,
} from "./coordinator-auth-store-test-fixtures.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

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

function registerSnapshotPerformanceTests(
	test: ReturnType<typeof it.extend<{ fixture: Fixture }>>,
) {
	test("materializes snapshot JSON once and compares sets without correlated scans", async ({
		fixture: { store, db },
	}) => {
		// Arrange: explain the insert and both live retry guards against the fixture schema.
		await enroll(store);
		const input = review({ verifiedSnapshot: { enrollmentIdentityId: null, invites: [] } });
		for (const [sql, values] of [
			[AUTH_CONTROLLER_INSERT_SQL, authControllerInsertValues(input, "now")],
			[AUTH_CONTROLLER_RETRY_ELIGIBLE_SQL, authControllerRetryEligibleValues(input)],
			[AUTH_CONTROLLER_RETRY_ACTIVE_SQL, authControllerRetryActiveValues(input)],
		] as const) {
			// Act
			const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values) as {
				detail: string;
			}[];
			const details = plan.map((row) => row.detail);
			// Assert: the actual D1 retry must retain the single materialized JSON scan.
			expect(details.filter((detail) => /SCAN j VIRTUAL TABLE/.test(detail))).toHaveLength(1);
			expect(details).toContain("MATERIALIZE snapshot_invites");
			expect(
				details.includes("EXCEPT USING TEMP B-TREE") ||
					(details.includes("MERGE (EXCEPT)") && details.includes("USE TEMP B-TREE FOR ORDER BY")),
			).toBe(true);
			expect(details.some((detail) => /CORRELATED/.test(detail))).toBe(false);
		}
	});
	test("guards all 4096 tuples below the JSON cap, including nullable identity fields", async ({
		fixture: { store, db },
	}) => {
		await enroll(store);
		const invites = Array.from({ length: 4096 }, (_, index) => ({
			inviteId: `i${index}`,
			kind: "add_device" as const,
			actorId: "identity-a",
			assignedIdentityId: index % 2 === 0 ? null : "identity-a",
			targetIdentityId: index % 2 === 0 ? "identity-a" : null,
			digest: "c".repeat(64),
		}));
		const input = review({ verifiedSnapshot: { enrollmentIdentityId: null, invites } });
		expect(Buffer.byteLength(JSON.stringify(input.verifiedSnapshot))).toBeLessThan(1_000_000);
		const insert = db.prepare(`INSERT INTO coordinator_invites (
			invite_id, group_id, token, policy, expires_at, created_at, consumed_at,
			bound_device_id, bound_public_key, bound_fingerprint, invite_kind,
			recipient_actor_id, assigned_identity_id, target_identity_id, reviewed_preview_digest
		) VALUES (?, ?, ?, 'auto', '2030', 'now', 'consumed', ?, ?, ?, ?, ?, ?, ?, ?)`);
		db.transaction(() => {
			for (const invite of invites)
				insert.run(
					invite.inviteId,
					input.groupId,
					invite.inviteId,
					input.deviceId,
					input.publicKey,
					input.fingerprint,
					invite.kind,
					invite.actorId,
					invite.assignedIdentityId,
					invite.targetIdentityId,
					invite.digest,
				);
		})();
		expect(authControllerInsertValues(input, "now")).toHaveLength(16);
		expect(await store.createAuthControllerAttestation(input)).toMatchObject({ kind: "created" });
		// Order is not evidence; an unchanged maximum-size retry must stay valid.
		const reordered = {
			...input,
			verifiedSnapshot: { enrollmentIdentityId: null, invites: [...invites].reverse() },
		};
		expect(await store.createAuthControllerAttestation(reordered)).toMatchObject({
			kind: "existing",
		});
		for (const sql of [
			"UPDATE coordinator_invites SET assigned_identity_id = 'identity-a' WHERE invite_id = 'i4094'",
			"UPDATE coordinator_invites SET target_identity_id = NULL WHERE invite_id = 'i4094'",
		]) {
			db.exec(sql);
			expect(await store.createAuthControllerAttestation(input)).toEqual({
				kind: "rejected",
				error: "review_stale",
			});
			db.exec(
				"UPDATE coordinator_invites SET assigned_identity_id = NULL, target_identity_id = 'identity-a' WHERE invite_id = 'i4094'",
			);
		}
		expect(
			db.prepare("SELECT count(*) AS count FROM coordinator_auth_controller_attestations").get(),
		).toEqual({ count: 1 });
	});
}

function registerSnapshotTests(test: ReturnType<typeof it.extend<{ fixture: Fixture }>>) {
	test.for([
		null,
		undefined,
		{},
		{ enrollmentIdentityId: null, invites: null },
		{ enrollmentIdentityId: "invalid\n", invites: [] },
		{ enrollmentIdentityId: null, invites: new Array(4097) },
		{ enrollmentIdentityId: null, invites: new Array(1) },
		{ enrollmentIdentityId: null, invites: [{ inviteId: "a" }] },
	])(
		"rejects malformed optional snapshot %j",
		async (verifiedSnapshot, { fixture: { store, db } }) => {
			await enroll(store);
			const input = { ...review(), verifiedSnapshot } as CoordinatorAuthControllerReviewInput;
			expect(await store.createAuthControllerAttestation(input)).toEqual({
				kind: "rejected",
				error: "invalid_review_input",
			});
			expect(db.prepare("SELECT * FROM coordinator_auth_controller_attestations").all()).toEqual(
				[],
			);
		},
	);
	test.for(["snapshot", "identity", "list", "item", "field", "inherited"] as const)(
		"captures snapshot own data only: %s",
		async (variant, { fixture: { store } }) => {
			await enroll(store);
			const getter = vi.fn(() => {
				throw new Error("must not execute");
			});
			const invite = {
				inviteId: "a",
				kind: "team_member" as const,
				actorId: "identity-a",
				assignedIdentityId: "identity-a",
				targetIdentityId: null,
				digest: "c".repeat(64),
			};
			const verifiedSnapshot = { enrollmentIdentityId: null, invites: [invite] };
			let input = review({ verifiedSnapshot });
			if (variant === "snapshot") Object.defineProperty(input, "verifiedSnapshot", { get: getter });
			if (variant === "identity")
				Object.defineProperty(verifiedSnapshot, "enrollmentIdentityId", { get: getter });
			if (variant === "list") Object.defineProperty(verifiedSnapshot, "invites", { get: getter });
			if (variant === "item") Object.defineProperty(verifiedSnapshot.invites, "0", { get: getter });
			if (variant === "field") Object.defineProperty(invite, "digest", { get: getter });
			if (variant === "inherited") {
				input = review();
				Object.setPrototypeOf(input, { verifiedSnapshot });
			}
			expect(await store.createAuthControllerAttestation(input)).toEqual({
				kind: "rejected",
				error: "invalid_review_input",
			});
			expect(getter).not.toHaveBeenCalled();
		},
	);
	test("rejects duplicate refs and oversized captured JSON", async ({ fixture: { store } }) => {
		await enroll(store);
		const invite = {
			inviteId: "a".repeat(256),
			kind: "team_member" as const,
			actorId: "i".repeat(256),
			assignedIdentityId: "i".repeat(256),
			targetIdentityId: "i".repeat(256),
			digest: "c".repeat(64),
		};
		for (const invites of [
			[invite, invite],
			Array.from({ length: 1500 }, (_, index) => ({
				...invite,
				inviteId: `${index}`.padEnd(256, "a"),
			})),
		]) {
			expect(
				await store.createAuthControllerAttestation(
					review({ verifiedSnapshot: { enrollmentIdentityId: null, invites } }),
				),
			).toEqual({ kind: "rejected", error: "invalid_review_input" });
		}
	});
	test("captures an empty snapshot before an asynchronous caller mutation", async ({
		fixture: { store },
	}) => {
		await enroll(store);
		const verifiedSnapshot = { enrollmentIdentityId: null, invites: [] };
		const pending = store.createAuthControllerAttestation(review({ verifiedSnapshot }));
		Object.assign(verifiedSnapshot, { enrollmentIdentityId: "changed", invites: null });
		expect(await pending).toMatchObject({ kind: "created" });
	});
	test("empty guarded snapshot rejects a changed enrollment Identity", async ({
		fixture: { store, db },
	}) => {
		await enroll(store);
		setIdentity(db, "identity-a");
		expect(
			await store.createAuthControllerAttestation(
				review({ verifiedSnapshot: { enrollmentIdentityId: null, invites: [] } }),
			),
		).toEqual({ kind: "rejected", error: "review_stale" });
		expect(db.prepare("SELECT * FROM coordinator_auth_controller_attestations").all()).toEqual([]);
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
	test("rejects an exact D1 retry revoked immediately before its final guarded read", async ({
		fixture: { store, db },
	}) => {
		// Arrange: intercept SQL, not the early active helper removed by the fix.
		await enroll(store);
		const input = review({ verifiedSnapshot: { enrollmentIdentityId: null, invites: [] } });
		expect((await store.createAuthControllerAttestation(input)).kind).toBe("created");
		let revocation: Promise<boolean> | undefined;
		const beforeRead = vi.fn((query: string) => {
			if (!/^\s*WITH snapshot\b/u.test(query) || !/SELECT (?:1 AS eligible|a\.\*)/u.test(query))
				return;
			if (!revocation)
				revocation = store.revokeAuthControllerAttestation(
					input.coordinatorId,
					input.attestationId,
				);
		});
		const racing = new D1CoordinatorStore(sqliteD1(db, { beforeRead }));
		// Act: revocation lands after the conflict read and before final eligibility.
		const retry = await racing.createAuthControllerAttestation(input);
		// Assert: an unchanged snapshot cannot approve cached, revoked authority.
		expect(revocation).toBeDefined();
		expect(await revocation).toBe(true);
		expect(retry).toMatchObject({ kind: "rejected" });
		expect(
			await store.getActiveAuthControllerAttestation(input.coordinatorId, input.attestationId),
		).toBeNull();
		expect(
			db.prepare("SELECT count(*) AS count FROM coordinator_auth_controller_attestations").get(),
		).toEqual({ count: 1 });
	});

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
	registerSnapshotTests(test);
	registerSnapshotPerformanceTests(test);
	registerPersistenceTests(test, backend);
	registerBindingTests(test);
	if (backend === "D1") registerD1ReadRaceTests(test);
});
