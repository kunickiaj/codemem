import { expect } from "vitest";
import type { CoordinatorAuthControllerReviewInput } from "./coordinator-auth-controller.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import {
	compareIdentityGroupGrantRevisions,
	IDENTITY_GROUP_GRANT_INSERT_SQL,
	IDENTITY_GROUP_GRANT_RETRY_SQL,
} from "./coordinator-identity-group-grant.js";
import {
	type contractHarness,
	type GrantFixture,
	grantSideEffectTables,
} from "./coordinator-identity-group-grant-test-harness.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "./d1-coordinator-store.js";

type GrantTest = ReturnType<typeof contractHarness>;
const denied = { kind: "rejected", error: "grant_authority_unavailable" };
export const grantRevocationTables = [
	...grantSideEffectTables,
	"coordinator_identity_group_grants",
	"coordinator_device_revocations",
];
async function snapshot(f: GrantFixture) {
	return Promise.all(grantRevocationTables.map((table) => f.rows(table)));
}
export async function attestGrantSource(f: GrantFixture, review = f.review) {
	await f.store.createGroup(review.groupId);
	await f.store.enrollDevice(review.groupId, {
		deviceId: review.deviceId,
		publicKey: review.publicKey,
		fingerprint: review.fingerprint,
	});
	expect(await f.store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
}
function issue(f: GrantFixture, store = f.store) {
	return store.issueIdentityGroupGrantFromControllerAttestation({
		coordinatorId: f.review.coordinatorId,
		attestationId: f.review.attestationId,
	});
}
async function revoke(f: GrantFixture, evidence: CoordinatorAuthControllerReviewInput) {
	await f.store.createGroup(evidence.groupId);
	await f.store.enrollDevice(evidence.groupId, evidence);
	expect(await f.store.createDeviceRevocation(evidence)).toMatchObject({ kind: "revoked" });
}
async function reinstate(f: GrantFixture) {
	const r = f.review;
	// Direct fixture SQL simulates legacy/manual reinstatement, not an authorized enrollment API.
	await f.exec(
		"UPDATE enrolled_devices SET enabled = 1, public_key = ?, fingerprint = ?, identity_id = NULL WHERE group_id = ? AND device_id = ?",
		r.publicKey,
		r.fingerprint,
		r.groupId,
		r.deviceId,
	);
}

export function registerIdentityGrantRevocationContract(test: GrantTest) {
	registerControls(test);
	registerSourceDenials(test);
	registerPersistence(test);
}
function registerControls(test: GrantTest) {
	test.for(["canonical", "opaque"] as const)(
		"unrevoked %s source issues once and exact retries preserve the sole revision",
		async (key, { fixture: f }) => {
			// Arrange
			f.review.publicKey = key === "canonical" ? CANONICAL_PUBLIC_KEY : "opaque-grant-fixture";
			await attestGrantSource(f);
			// Act
			const created = await issue(f);
			const retry = await issue(f);
			// Assert
			expect(created).toMatchObject({ kind: "created", grant: { revision: 1 } });
			expect(retry).toEqual({
				kind: "existing",
				grant: (await f.store.listIdentityGroupGrantRevisions(f.review))[0],
			});
			expect(await f.rows("coordinator_identity_group_grants")).toHaveLength(1);
		},
	);
	test("unrelated revoked ID/key and caller hints cannot replace the actual source tuple", async ({
		fixture: f,
	}) => {
		// Arrange: even matching fingerprint/actor metadata does not revoke another public key.
		f.review.publicKey = UNRELATED_PUBLIC_KEY;
		await attestGrantSource(f);
		await revoke(f, {
			...f.review,
			deviceId: `${f.review.deviceId}-other`,
			publicKey: CANONICAL_PUBLIC_KEY,
		});
		const input = {
			coordinatorId: f.review.coordinatorId,
			attestationId: f.review.attestationId,
			deviceId: `${f.review.deviceId}-other`,
			publicKey: CANONICAL_PUBLIC_KEY,
			fingerprint: f.review.fingerprint,
		};
		// Act
		const result = await f.store.issueIdentityGroupGrantFromControllerAttestation(input);
		const retry = await f.store.issueIdentityGroupGrantFromControllerAttestation(input);
		// Assert
		expect(result).toMatchObject({ kind: "created" });
		expect(retry).toMatchObject({ kind: "existing" });
	});
}

const revokedSources = [
	{
		name: "source ID fresh key",
		publicKey: UNRELATED_PUBLIC_KEY,
		evidenceKey: CANONICAL_PUBLIC_KEY,
		alias: false,
	},
	{
		name: "key-only alias",
		publicKey: CANONICAL_PUBLIC_KEY,
		evidenceKey: CANONICAL_PUBLIC_KEY,
		alias: true,
	},
	{
		name: "key comment",
		publicKey: `${CANONICAL_PUBLIC_KEY} grant-fixture-comment`,
		evidenceKey: CANONICAL_PUBLIC_KEY,
		alias: true,
	},
	{
		name: "URL-safe key",
		publicKey: CANONICAL_PUBLIC_KEY.replace(/\+/g, "-").replace(/\//g, "_"),
		evidenceKey: CANONICAL_PUBLIC_KEY,
		alias: true,
	},
	{
		name: "opaque ID",
		publicKey: "opaque-grant-fixture",
		evidenceKey: "opaque-grant-fixture",
		alias: false,
	},
];
function registerSourceDenials(test: GrantTest) {
	for (const stage of ["first", "retry"] as const) {
		test.for(revokedSources)(
			`revoked $name denies ${stage} without changing retained authority`,
			async (subject, { fixture: f }) => {
				// Arrange: attest before R so controller creation guards cannot mask grant issuance bugs.
				f.review.publicKey = subject.publicKey;
				await attestGrantSource(f);
				if (stage === "retry") expect(await issue(f)).toMatchObject({ kind: "created" });
				const evidence = { ...f.review, publicKey: subject.evidenceKey };
				if (subject.alias) evidence.deviceId += "-alias";
				await revoke(f, evidence);
				await reinstate(f);
				const before = await snapshot(f);
				// Act: caller-provided clean key/ID/fingerprint cannot bypass actual SQL source authority.
				const result = await f.store.issueIdentityGroupGrantFromControllerAttestation({
					coordinatorId: f.review.coordinatorId,
					attestationId: f.review.attestationId,
					...{
						deviceId: "clean-hint",
						publicKey: UNRELATED_PUBLIC_KEY,
						fingerprint: "f".repeat(64),
					},
				});
				// Assert
				expect(result).toEqual(denied);
				expect(await snapshot(f)).toEqual(before);
				expect(await f.store.listIdentityGroupGrantRevisions(f.review)).toHaveLength(
					stage === "retry" ? 1 : 0,
				);
				// Fixture-only counterfactual proves R, not a mismatched reinstatement, caused denial.
				await f.exec(
					"DELETE FROM coordinator_device_revocations WHERE evidence_group_id = ?",
					f.review.groupId,
				);
				expect(await issue(f)).toMatchObject({ kind: stage === "retry" ? "existing" : "created" });
			},
		);
	}
}

function registerPersistence(test: GrantTest) {
	test("source R leaves grants across namespaces listable and comparable; explicit CAS alone revokes them", async ({
		fixture: f,
	}) => {
		// Arrange
		f.review.publicKey = CANONICAL_PUBLIC_KEY;
		await attestGrantSource(f);
		await issue(f);
		const foreign = {
			...f.review,
			coordinatorId: `${f.review.coordinatorId}-other`,
			attestationId: `${f.review.attestationId}-other`,
			reviewReceiptId: `${f.review.reviewReceiptId}-other`,
		};
		expect(await f.store.createAuthControllerAttestation(foreign)).toMatchObject({
			kind: "created",
		});
		await f.store.issueIdentityGroupGrantFromControllerAttestation(foreign);
		const before = await f.store.listIdentityGroupGrantRevisions(f.review);
		const foreignBefore = await f.store.listIdentityGroupGrantRevisions(foreign);
		await revoke(f, f.review);
		const history = await f.rows("coordinator_device_revocations");
		// Act
		const retained = await f.store.listIdentityGroupGrantRevisions(f.review);
		const wrong = await f.store.revokeIdentityGroupGrant({ ...f.review, expectedRevision: 2 });
		const revoked = await f.store.revokeIdentityGroupGrant({ ...f.review, expectedRevision: 1 });
		const current = await f.store.listIdentityGroupGrantRevisions(f.review);
		// Assert
		expect(compareIdentityGroupGrantRevisions(before, retained)).toBe(true);
		expect([wrong, revoked]).toEqual([false, true]);
		expect(compareIdentityGroupGrantRevisions(before, current)).toBe(false);
		expect(current).toEqual([
			{ ...before[0], status: "revoked", revision: 2, revoked_at: expect.any(String) },
		]);
		expect(await f.store.listIdentityGroupGrantRevisions(foreign)).toEqual(foreignBefore);
		expect(await f.rows("coordinator_device_revocations")).toEqual(history);
	});
}

// Run the hook immediately before execution, including INSERT RETURNING via first/all.
// Preserve native statement objects for batch so its atomicity and results stay real.
export function guardedGrantD1(db: D1DatabaseLike, hook: (query: string) => Promise<void>) {
	const originals = new WeakMap<D1PreparedStatementLike, D1PreparedStatementLike>();
	const queries = new WeakMap<D1PreparedStatementLike, string>();
	const wrap = (statement: D1PreparedStatementLike, query: string): D1PreparedStatementLike => {
		const adapter: D1PreparedStatementLike = {
			bind: (...values) => wrap(statement.bind(...values), query),
			first: async <T>() => {
				await hook(query);
				return statement.first<T>();
			},
			all: async <T>() => {
				await hook(query);
				return statement.all<T>();
			},
			raw: async <T>() => {
				await hook(query);
				return statement.raw<T>();
			},
			run: async () => {
				await hook(query);
				return statement.run();
			},
		};
		originals.set(adapter, statement);
		queries.set(adapter, query);
		return adapter;
	};
	return new D1CoordinatorStore({
		prepare: (query) => wrap(db.prepare(query), query),
		batch: async (statements) => {
			for (const statement of statements) await hook(queries.get(statement) ?? "");
			if (!db.batch) throw new Error("Fixture batch unavailable");
			return db.batch(
				statements.map((statement) => {
					const original = originals.get(statement);
					if (!original) throw new Error("Unknown grant fixture statement");
					return original;
				}),
			);
		},
	});
}

export function registerIdentityGrantStatementGuards(
	test: GrantTest,
	guarded: (f: GrantFixture, hook: (query: string) => Promise<void>) => D1CoordinatorStore,
) {
	registerRevocationRaces(test, guarded);
	registerKeyRaces(test, guarded);
	test("captures mutable issuance IDs before awaiting source lookup", async ({ fixture: f }) => {
		// Arrange
		f.review.publicKey = CANONICAL_PUBLIC_KEY;
		await attestGrantSource(f);
		const input = { coordinatorId: f.review.coordinatorId, attestationId: f.review.attestationId };
		let called = false;
		const racing = guarded(f, async () => {
			if (called) return;
			called = true;
			input.coordinatorId = "wrong-coordinator";
			input.attestationId = "wrong-attestation";
		});
		// Act
		const result = await racing.issueIdentityGroupGrantFromControllerAttestation(input);
		// Assert
		expect(called).toBe(true);
		expect(result).toMatchObject({
			kind: "created",
			grant: { coordinator_id: f.review.coordinatorId },
		});
		expect(await racing.issueIdentityGroupGrantFromControllerAttestation(input)).toMatchObject({
			kind: "rejected",
		});
	});
}
type Guarded = Parameters<typeof registerIdentityGrantStatementGuards>[1];
function registerRevocationRaces(test: GrantTest, guarded: Guarded) {
	for (const stage of ["insert", "retry"] as const) {
		test.for(["ID", "key"] as const)(
			`R for source %s immediately before actual ${stage} statement denies without grant writes`,
			async (subject, { fixture: f }) => {
				// Arrange
				f.review.publicKey = CANONICAL_PUBLIC_KEY;
				await attestGrantSource(f);
				if (stage === "retry") await issue(f);
				let called = false;
				let atGate: unknown[][] = [];
				const racing = guarded(f, async (query) => {
					const target =
						stage === "insert" ? IDENTITY_GROUP_GRANT_INSERT_SQL : IDENTITY_GROUP_GRANT_RETRY_SQL;
					if (called || query !== target) return;
					called = true;
					const evidence = { ...f.review };
					if (subject === "key") evidence.deviceId += "-alias";
					await revoke(f, evidence);
					await reinstate(f);
					atGate = await snapshot(f);
				});
				// Act
				const result = await issue(f, racing);
				// Assert
				expect(called).toBe(true);
				expect(result).toEqual(denied);
				expect(await snapshot(f)).toEqual(atGate);
			},
		);
	}
}
function registerKeyRaces(test: GrantTest, guarded: Guarded) {
	test.for(["clean", "revoked"] as const)(
		"pins checked source public key when both enrollment and controller rotate to %s key before INSERT RETURNING",
		async (replacement, { fixture: f }) => {
			// Arrange: update both keys so ordinary controller/enrollment equality still passes.
			f.review.publicKey = UNRELATED_PUBLIC_KEY;
			await attestGrantSource(f);
			if (replacement === "revoked")
				await revoke(f, {
					...f.review,
					deviceId: `${f.review.deviceId}-alias`,
					publicKey: CANONICAL_PUBLIC_KEY,
				});
			let called = false;
			let atGate: unknown[][] = [];
			const racing = guarded(f, async (query) => {
				if (called || query !== IDENTITY_GROUP_GRANT_INSERT_SQL) return;
				called = true;
				await f.exec(
					"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
					CANONICAL_PUBLIC_KEY,
					f.review.groupId,
					f.review.deviceId,
				);
				await f.exec(
					"UPDATE coordinator_auth_controller_attestations SET public_key = ? WHERE coordinator_id = ? AND attestation_id = ?",
					CANONICAL_PUBLIC_KEY,
					f.review.coordinatorId,
					f.review.attestationId,
				);
				atGate = await snapshot(f);
			});
			// Act
			const result = await issue(f, racing);
			// Assert: an unchecked replacement cannot borrow the previously checked canonical identity.
			expect(called).toBe(true);
			expect(result).toEqual(denied);
			expect(await snapshot(f)).toEqual(atGate);
			if (replacement === "clean") expect(await issue(f)).toMatchObject({ kind: "created" });
			else expect(await issue(f)).toEqual(denied);
		},
	);
}
