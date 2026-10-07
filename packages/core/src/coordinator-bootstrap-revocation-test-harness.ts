import { expect } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import { guardedGrantD1 } from "./coordinator-identity-grant-revocation-test-harness.js";
import type {
	contractHarness,
	GrantFixture,
} from "./coordinator-identity-group-grant-test-harness.js";
import type { CoordinatorCreateBootstrapGrantInput } from "./coordinator-store-contract.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "./d1-coordinator-store.js";

export const bootstrapRevocationTables = [
	"coordinator_bootstrap_grants",
	"coordinator_device_revocations",
	"enrolled_devices",
	"groups",
];
type Test = ReturnType<typeof contractHarness>;
type Participant = "seed" | "worker";
const incomplete = "bootstrap_grant_write_incomplete";
function input(f: GrantFixture): CoordinatorCreateBootstrapGrantInput {
	return {
		groupId: f.review.groupId,
		seedDeviceId: `${f.review.deviceId}-seed`,
		workerDeviceId: `${f.review.deviceId}-worker`,
		expiresAt: "2099-01-01T00:00:00Z",
		createdBy: "fixture-label",
	};
}
function participant(f: GrantFixture, who: Participant) {
	return `${f.review.deviceId}-${who}`;
}
async function enroll(f: GrantFixture, who: Participant, publicKey = UNRELATED_PUBLIC_KEY) {
	await f.store.createGroup(f.review.groupId);
	await f.store.enrollDevice(f.review.groupId, {
		deviceId: participant(f, who),
		publicKey,
		fingerprint: f.review.fingerprint,
	});
}
async function revoke(
	f: GrantFixture,
	who: Participant,
	publicKey = UNRELATED_PUBLIC_KEY,
	alias = false,
) {
	const deviceId = `${participant(f, who)}${alias ? "-alias" : ""}`;
	await f.store.createGroup(f.review.groupId);
	await f.store.enrollDevice(f.review.groupId, {
		deviceId,
		publicKey,
		fingerprint: f.review.fingerprint,
	});
	expect(
		await f.store.createDeviceRevocation({
			groupId: f.review.groupId,
			deviceId,
			publicKey,
			fingerprint: f.review.fingerprint,
		}),
	).toMatchObject({ kind: "revoked" });
}
async function snapshot(f: GrantFixture) {
	return Promise.all(bootstrapRevocationTables.map((table) => f.rows(table)));
}
function expected(f: GrantFixture, overrides: Partial<CoordinatorCreateBootstrapGrantInput> = {}) {
	const i = { ...input(f), ...overrides };
	return {
		grant_id: expect.any(String),
		group_id: i.groupId,
		seed_device_id: i.seedDeviceId,
		worker_device_id: i.workerDeviceId,
		expires_at: i.expiresAt,
		created_at: expect.any(String),
		created_by: i.createdBy ?? null,
		revoked_at: null,
	};
}

export function registerBootstrapRevocationContract(test: Test) {
	registerCompatibility(test);
	registerNormalization(test);
	registerMetadataControls(test);
	registerDenials(test);
	registerHistory(test);
}
function registerCompatibility(test: Test) {
	test.for([
		"registered",
		"missing seed",
		"missing worker",
		"missing both",
		"disabled",
		"opaque",
		"same ID",
		"archived group",
		"missing group",
		"long ID",
	])("raw grant preserves unrevoked compatibility: %s", async (mode, { fixture: f }) => {
		// Arrange: raw records are not permission; enrollment is deliberately optional.
		if (!["missing seed", "missing both", "missing group"].includes(mode))
			await enroll(f, "seed", mode === "opaque" ? "opaque-bootstrap-key" : UNRELATED_PUBLIC_KEY);
		if (!["missing worker", "missing both", "missing group"].includes(mode))
			await enroll(f, "worker");
		if (mode === "disabled")
			await f.store.setDeviceEnabled(f.review.groupId, participant(f, "seed"), false);
		if (mode === "archived group") await f.store.archiveGroup(f.review.groupId);
		const i = input(f);
		if (mode === "same ID") i.workerDeviceId = i.seedDeviceId;
		if (mode === "long ID") i.seedDeviceId = `${i.seedDeviceId}-${"x".repeat(300)}`;
		const before = await snapshot(f);
		// Act
		const grant = await f.store.createBootstrapGrant(i);
		// Assert: every returned field and raw retrieval retain the original contract.
		expect(grant).toEqual(expected(f, i));
		expect(await f.store.getBootstrapGrant(grant.grant_id)).toEqual(grant);
		expect(await f.store.listBootstrapGrants(i.groupId)).toEqual([grant]);
		expect((await snapshot(f)).slice(1)).toEqual(before.slice(1));
	});
}
function registerNormalization(test: Test) {
	test.for(["groupId", "seedDeviceId", "workerDeviceId", "expiresAt"] as const)(
		"empty %s still fails input normalization without writes",
		async (field, { fixture: f }) => {
			// Arrange
			const i = { ...input(f), [field]: " \t " };
			const before = await snapshot(f);
			// Act
			const result = f.store.createBootstrapGrant(i);
			// Assert
			await expect(result).rejects.toThrow(
				"groupId, seedDeviceId, workerDeviceId, and expiresAt are required.",
			);
			expect(await snapshot(f)).toEqual(before);
		},
	);
	test("normalizes strings but does not invent expiry validation or creator authority", async ({
		fixture: f,
	}) => {
		// Arrange
		const i = input(f);
		const padded = {
			groupId: ` ${i.groupId} `,
			seedDeviceId: ` ${i.seedDeviceId} `,
			workerDeviceId: ` ${i.workerDeviceId} `,
			expiresAt: " not-a-date ",
			createdBy: " \t ",
		};
		// Act
		const grant = await f.store.createBootstrapGrant(padded);
		// Assert
		expect(grant).toEqual(expected(f, { expiresAt: "not-a-date", createdBy: null }));
	});
}
function registerMetadataControls(test: Test) {
	test.for(["opaque", "missing", "clean"])(
		"revoked historical key and caller hints cannot revoke %s actual key",
		async (mode, { fixture: f }) => {
			// Arrange: a different ID owns the revoked key; fingerprints/actor hints are not key identity.
			await revoke(f, "seed", CANONICAL_PUBLIC_KEY, true);
			if (mode !== "missing")
				await enroll(f, "seed", mode === "opaque" ? "opaque-bootstrap-key" : UNRELATED_PUBLIC_KEY);
			await enroll(f, "worker");
			const i = {
				...input(f),
				publicKey: CANONICAL_PUBLIC_KEY,
				fingerprint: f.review.fingerprint,
				keyId: "caller-key-id",
				seedOwnerIdentityHint: "caller-owner",
				createdBy: `${participant(f, "seed")}-alias`,
			};
			const before = await snapshot(f);
			// Act
			const grant = await f.store.createBootstrapGrant(i);
			// Assert
			expect(grant).toEqual(expected(f, i));
			expect((await snapshot(f)).slice(1)).toEqual(before.slice(1));
		},
	);
}

function registerDenials(test: Test) {
	for (const who of ["seed", "worker"] as const) {
		test.for(["current", "removed", "replaced key", "opaque"])(
			`revoked ${who} ID denies with %s enrollment and retains all history`,
			async (mode, { fixture: f }) => {
				// Arrange: retain a grant issued before revocation.
				await enroll(f, "seed");
				await enroll(f, "worker");
				await f.store.createBootstrapGrant(input(f));
				await revoke(f, who, mode === "opaque" ? "opaque-bootstrap-key" : UNRELATED_PUBLIC_KEY);
				if (mode === "removed") await f.store.removeDevice(f.review.groupId, participant(f, who));
				if (mode === "replaced key")
					await f.exec(
						"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
						CANONICAL_PUBLIC_KEY,
						f.review.groupId,
						participant(f, who),
					);
				const before = await snapshot(f);
				// Act
				const result = f.store.createBootstrapGrant({
					...input(f),
					...{ publicKey: "clean-caller-hint", fingerprint: "c".repeat(64) },
				});
				// Assert
				await expect(result).rejects.toThrow(/^device_revoked$/);
				expect(await snapshot(f)).toEqual(before);
			},
		);
		test.for(["canonical", "comment", "URL", "disabled"])(
			`revoked key under another ID denies ${who} actual %s key`,
			async (mode, { fixture: f }) => {
				// Arrange: the other participant's clean key prevents an accidental ID/key denial.
				await revoke(f, who, CANONICAL_PUBLIC_KEY, true);
				let publicKey = CANONICAL_PUBLIC_KEY;
				if (mode === "comment") publicKey += " bootstrap-fixture-comment";
				if (mode === "URL") publicKey = publicKey.replace(/\+/g, "-").replace(/\//g, "_");
				// Fixture SQL represents legacy rows, bypassing the already-tested enrollment admission guard.
				await enroll(f, "seed");
				await enroll(f, "worker");
				await f.exec(
					"UPDATE enrolled_devices SET public_key = ?, enabled = ? WHERE group_id = ? AND device_id = ?",
					publicKey,
					mode === "disabled" ? 0 : 1,
					f.review.groupId,
					participant(f, who),
				);
				const before = await snapshot(f);
				// Act
				const result = f.store.createBootstrapGrant(input(f));
				// Assert
				await expect(result).rejects.toThrow(/^device_revoked$/);
				expect(await snapshot(f)).toEqual(before);
			},
		);
	}
}
function registerHistory(test: Test) {
	test("participant revocation does not cascade into raw get/list/revoke or revocation history", async ({
		fixture: f,
	}) => {
		// Arrange
		await enroll(f, "seed");
		const grant = await f.store.createBootstrapGrant(input(f));
		await revoke(f, "seed");
		const history = await f.rows("coordinator_device_revocations");
		// Act: no lookup authorization claim is made by these raw persistence methods.
		const fetched = await f.store.getBootstrapGrant(grant.grant_id);
		const listed = await f.store.listBootstrapGrants(f.review.groupId);
		const missingGrant = await f.store.getBootstrapGrant("missing-fixture-grant");
		const emptyGroup = await f.store.listBootstrapGrants(`${f.review.groupId}-empty`);
		const missing = await f.store.revokeBootstrapGrant("missing-fixture-grant");
		const revoked = await f.store.revokeBootstrapGrant(grant.grant_id, "2099-01-02T00:00:00Z");
		// Assert
		expect(fetched).toEqual(grant);
		expect(listed).toEqual([grant]);
		expect(missingGrant).toBeNull();
		expect(emptyGroup).toEqual([]);
		expect([missing, revoked]).toEqual([false, true]);
		expect(await f.store.getBootstrapGrant(grant.grant_id)).toEqual({
			...grant,
			revoked_at: "2099-01-02T00:00:00Z",
		});
		expect(await f.rows("coordinator_device_revocations")).toEqual(history);
	});
}

export function guardedBootstrapD1(db: D1DatabaseLike, hook: (query: string) => Promise<void>) {
	return guardedGrantD1(db, hook);
}
type Guarded = (f: GrantFixture, hook: (query: string) => Promise<void>) => D1CoordinatorStore;
function isInsert(query: string) {
	return /INSERT\s+INTO\s+coordinator_bootstrap_grants/i.test(query);
}
export function registerBootstrapStatementGuards(test: Test, guarded: Guarded) {
	registerRevocationRaces(test, guarded);
	registerTupleRaces(test, guarded);
	registerCapturedInput(test, guarded);
}
function registerRevocationRaces(test: Test, guarded: Guarded) {
	for (const who of ["seed", "worker"] as const) {
		test.for(["ID", "key"])(
			`D1 ${who} %s revocation at INSERT execution prevents all protected writes`,
			async (subject, { fixture: f }) => {
				// Arrange
				await enroll(f, who);
				await enroll(f, who === "seed" ? "worker" : "seed", "opaque-other-key");
				let called = false;
				let atGate: unknown[][] = [];
				const store = guarded(f, async (query) => {
					if (called || !isInsert(query)) return;
					called = true;
					await revoke(f, who, UNRELATED_PUBLIC_KEY, subject === "key");
					atGate = await snapshot(f);
				});
				// Act
				const result = store.createBootstrapGrant(input(f));
				// Assert
				await expect(result).rejects.toThrow(/^device_revoked$/);
				expect(called).toBe(true);
				expect(await snapshot(f)).toEqual(atGate);
			},
		);
	}
}
async function changeTuple(f: GrantFixture, who: Participant, change: string) {
	if (change === "removal") return f.store.removeDevice(f.review.groupId, participant(f, who));
	if (change === "appearance") return enroll(f, who, CANONICAL_PUBLIC_KEY);
	await f.exec(
		"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
		CANONICAL_PUBLIC_KEY,
		f.review.groupId,
		participant(f, who),
	);
}
function registerTupleRaces(test: Test, guarded: Guarded) {
	for (const who of ["seed", "worker"] as const) {
		test.for(["rotation", "removal", "appearance"])(
			`D1 pins ${who} tuple or absence against %s at INSERT`,
			async (change, { fixture: f }) => {
				// Arrange
				if (change !== "appearance") await enroll(f, who);
				await enroll(f, who === "seed" ? "worker" : "seed", "opaque-other-key");
				let called = false;
				let atGate: unknown[][] = [];
				const store = guarded(f, async (query) => {
					if (called || !isInsert(query)) return;
					called = true;
					await changeTuple(f, who, change);
					atGate = await snapshot(f);
				});
				// Act
				const result = store.createBootstrapGrant(input(f));
				// Assert: clean drift is not a false device_revoked classification; retry is allowed.
				await expect(result).rejects.toThrow(new RegExp(`^${incomplete}$`));
				expect(called).toBe(true);
				expect(await snapshot(f)).toEqual(atGate);
				expect(await f.store.createBootstrapGrant(input(f))).toEqual(expected(f));
			},
		);
	}
}
function registerCapturedInput(test: Test, guarded: Guarded) {
	test("D1 captures all normalized caller fields before the first await", async ({
		fixture: f,
	}) => {
		// Arrange
		const i = input(f);
		const captured = { ...i };
		let called = false;
		const store = guarded(f, async () => {
			if (called) return;
			called = true;
			i.groupId = "mutated-group";
			i.seedDeviceId = "mutated-seed";
			i.workerDeviceId = "mutated-worker";
			i.expiresAt = "mutated-expiry";
			i.createdBy = "mutated-creator";
		});
		// Act
		const grant = await store.createBootstrapGrant(i);
		// Assert
		expect(called).toBe(true);
		expect(grant).toEqual(expected(f, captured));
	});
	test("D1 insert exception returns a fixed error without fabricated history", async ({
		fixture: f,
	}) => {
		// Arrange
		const before = await snapshot(f);
		const store = guarded(f, async (query) => {
			if (isInsert(query)) throw new Error("private database diagnostic");
		});
		// Act
		const result = store.createBootstrapGrant(input(f));
		// Assert
		await expect(result).rejects.toThrow(new RegExp(`^${incomplete}$`));
		expect(await snapshot(f)).toEqual(before);
	});
}

export function registerBootstrapReceiptFailures(
	test: Test,
	database: (f: GrantFixture) => D1DatabaseLike,
) {
	test.for(["source read", "lost receipt", "unknown receipt"])(
		"D1 %s fails honestly without claiming rollback",
		async (failure, { fixture: f }) => {
			// Arrange: simulate a driver failure, never a live database or network.
			const db = database(f);
			const wrap = (
				statement: D1PreparedStatementLike,
				query: string,
			): D1PreparedStatementLike => ({
				bind: (...values) => wrap(statement.bind(...values), query),
				first: async <T>() => {
					if (
						failure === "source read" &&
						/SELECT public_key, fingerprint, identity_id/.test(query)
					)
						throw new Error("private read diagnostic");
					const row = await statement.first<T>();
					if (!isInsert(query)) return row;
					return receiptResult(failure, row);
				},
				all: <T>() => statement.all<T>(),
				raw: <T>() => statement.raw<T>(),
				run: () => statement.run(),
			});
			const store = new D1CoordinatorStore({ prepare: (query) => wrap(db.prepare(query), query) });
			const before = await snapshot(f);
			// Act
			const result = store.createBootstrapGrant(input(f));
			// Assert: INSERT RETURNING can commit before its receipt is lost.
			await expect(result).rejects.toThrow(new RegExp(`^${incomplete}$`));
			const after = await snapshot(f);
			expect(after.slice(1)).toEqual(before.slice(1));
			const retained = await f.store.listBootstrapGrants(f.review.groupId);
			expect(retained).toHaveLength(failure === "source read" ? 0 : 1);
			if (retained.length) expect(retained[0]).toEqual(expected(f));
		},
	);
}
function receiptResult<T>(failure: string, row: T | null) {
	if (failure === "lost receipt") throw new Error("private receipt diagnostic");
	if (failure === "unknown receipt") return null;
	return row;
}
