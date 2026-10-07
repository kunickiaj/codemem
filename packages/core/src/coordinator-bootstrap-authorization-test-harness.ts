import { expect } from "vitest";
import { bootstrapRevocationTables } from "./coordinator-bootstrap-revocation-test-harness.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import { guardedGrantD1 } from "./coordinator-identity-grant-revocation-test-harness.js";
import type {
	contractHarness,
	GrantFixture,
} from "./coordinator-identity-group-grant-test-harness.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "./d1-coordinator-store.js";

type Test = ReturnType<typeof contractHarness>;
type Participant = "seed" | "worker";
export const authorizationNowMs = Date.UTC(2026, 9, 7);
export function bootstrapParticipant(f: Pick<GrantFixture, "review">, who: Participant) {
	return `${f.review.deviceId}-${who}`;
}
export async function authorizationFixture(
	f: Pick<GrantFixture, "store" | "review">,
	opaque = false,
) {
	await f.store.createGroup(f.review.groupId);
	for (const who of ["seed", "worker"] as const) {
		let publicKey = who === "seed" ? CANONICAL_PUBLIC_KEY : UNRELATED_PUBLIC_KEY;
		if (opaque) publicKey = `opaque-${who}`;
		await f.store.enrollDevice(f.review.groupId, {
			deviceId: bootstrapParticipant(f, who),
			publicKey,
			fingerprint: f.review.fingerprint,
		});
	}
	return f.store.createBootstrapGrant({
		groupId: f.review.groupId,
		seedDeviceId: bootstrapParticipant(f, "seed"),
		workerDeviceId: bootstrapParticipant(f, "worker"),
		expiresAt: "2099-01-01T00:00:00Z",
		createdBy: "audit-label-not-authority",
	});
}
function request(grantId: string) {
	return { grantId, nowMs: authorizationNowMs };
}
function expectedSeed(f: GrantFixture) {
	return {
		groupId: f.review.groupId,
		deviceId: bootstrapParticipant(f, "seed"),
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: f.review.fingerprint,
	};
}
function rejected(error: string) {
	return { kind: "rejected", error };
}
async function snapshot(f: GrantFixture) {
	return Promise.all(bootstrapRevocationTables.map((table) => f.rows(table)));
}
async function revoke(
	f: GrantFixture,
	who: Participant,
	alias = false,
	publicKey = who === "seed" ? CANONICAL_PUBLIC_KEY : UNRELATED_PUBLIC_KEY,
) {
	const deviceId = `${bootstrapParticipant(f, who)}${alias ? "-alias" : ""}`;
	if (alias)
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
async function revokeIdOnly(f: GrantFixture, who: Participant) {
	const publicKey = `opaque-id-only-${who}`;
	await f.exec(
		"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
		publicKey,
		f.review.groupId,
		bootstrapParticipant(f, who),
	);
	await revoke(f, who, false, publicKey);
	// An ID-plus-key revocation would mask a missing ID guard, including the captured key at final SQL.
	expect(await f.rows("coordinator_device_revocations")).toEqual([
		expect.objectContaining({
			subject_kind: "device_id",
			subject_value: bootstrapParticipant(f, who),
			evidence_public_key: publicKey,
		}),
	]);
}
async function revokeMode(f: GrantFixture, who: Participant, mode: string) {
	if (mode === "ID only") return revokeIdOnly(f, who);
	return revoke(f, who, mode !== "ID");
}

export function registerBootstrapAuthorizationContract(test: Test) {
	registerEnrollmentCases(test);
	registerGrantCases(test);
	registerExpiryCases(test);
	registerExpectationCases(test);
	registerRevocationCases(test);
}
function registerEnrollmentCases(test: Test) {
	test.for(["canonical", "opaque"])(
		"authorizes both current enrollments with version 1: %s",
		async (mode, { fixture: f }) => {
			// Arrange: opaque legacy keys with null identity metadata remain ID-only subjects.
			const grant = await authorizationFixture(f, mode === "opaque");
			const enrollments = await f.store.listEnrolledDevices(f.review.groupId);
			const before = await snapshot(f);
			// Act
			const result = await f.store.getBootstrapGrantAuthorization(request(grant.grant_id));
			// Assert: not a raw grant or a fabricated partial authorization receipt.
			expect(result).toEqual({
				kind: "authorized",
				authorizationVersion: 1,
				grant,
				seedEnrollment: enrollments.find((e) => e.device_id === grant.seed_device_id),
				workerEnrollment: enrollments.find((e) => e.device_id === grant.worker_device_id),
			});
			expect(await snapshot(f)).toEqual(before);
		},
	);
	test.for(["seed", "worker"] as const)(
		"raw unenrolled %s grant is retained but never authorized",
		async (who, { fixture: f }) => {
			// Arrange
			const grant = await authorizationFixture(f);
			await f.store.removeDevice(f.review.groupId, bootstrapParticipant(f, who));
			const before = await snapshot(f);
			// Act
			const result = await f.store.getBootstrapGrantAuthorization(request(grant.grant_id));
			// Assert
			expect(result).toEqual(rejected(`${who}_enrollment_not_found`));
			expect(await f.store.getBootstrapGrant(grant.grant_id)).toEqual(grant);
			expect(await f.store.listBootstrapGrants(f.review.groupId)).toEqual([grant]);
			expect(await snapshot(f)).toEqual(before);
		},
	);
	test.for(["seed", "worker"] as const)(
		"disabled %s is not authorized",
		async (who, { fixture: f }) => {
			// Arrange
			const grant = await authorizationFixture(f);
			await f.store.setDeviceEnabled(f.review.groupId, bootstrapParticipant(f, who), false);
			// Act
			const result = await f.store.getBootstrapGrantAuthorization(request(grant.grant_id));
			// Assert
			expect(result).toEqual(rejected(`${who}_enrollment_not_found`));
			expect(await f.store.getBootstrapGrant(grant.grant_id)).toEqual(grant);
		},
	);
}
function registerGrantCases(test: Test) {
	test.for(["missing grant", "missing group", "archived", "revoked"] as const)(
		"rejects %s without raw fallback",
		async (mode, { fixture: f }) => {
			// Arrange
			const grant = await authorizationFixture(f);
			if (mode === "missing group") {
				await f.exec("DELETE FROM enrolled_devices WHERE group_id = ?", f.review.groupId);
				await f.exec("DELETE FROM groups WHERE group_id = ?", f.review.groupId);
			}
			if (mode === "archived") await f.store.archiveGroup(f.review.groupId);
			if (mode === "revoked") await f.store.revokeBootstrapGrant(grant.grant_id);
			// Act
			const result = await f.store.getBootstrapGrantAuthorization(
				request(mode === "missing grant" ? "missing-grant" : grant.grant_id),
			);
			// Assert
			const errors = {
				"missing grant": "grant_not_found",
				"missing group": "grant_not_found",
				archived: "group_archived",
				revoked: "grant_revoked",
			};
			expect(result).toEqual(rejected(errors[mode]));
		},
	);
}
function registerExpiryCases(test: Test) {
	test.for([
		["2026-10-07T00:00:00.001Z", "authorized"],
		["2026-10-06T20:00:00.001-04:00", "authorized"],
		["2026-10-07T00:00:00Z", "grant_expired"],
		["2026-10-07T01:00:00+02:00", "grant_expired"],
		["2025-12-31T23:59:59Z", "grant_expired"],
		["not-a-date", "bootstrap_authorization_unavailable"],
		["2026-99-99T00:00:00Z", "bootstrap_authorization_unavailable"],
		["2026-10-07T00:00:01", "bootstrap_authorization_unavailable"],
		["Oct 8 2026", "bootstrap_authorization_unavailable"],
	] as const)(
		"expiry %s uses a finite parsed server-time boundary",
		async ([expiry, outcome], { fixture: f }) => {
			// Arrange: offset forms deliberately reverse lexical ordering relative to UTC.
			const grant = await authorizationFixture(f);
			await f.exec(
				"UPDATE coordinator_bootstrap_grants SET expires_at = ? WHERE grant_id = ?",
				expiry,
				grant.grant_id,
			);
			// Act
			const result = await f.store.getBootstrapGrantAuthorization(request(grant.grant_id));
			// Assert
			if (outcome === "authorized")
				expect(result).toMatchObject({
					kind: "authorized",
					authorizationVersion: 1,
					grant: { expires_at: expiry },
				});
			else expect(result).toEqual(rejected(outcome));
		},
	);
	test.for([NaN, Infinity, -Infinity])(
		"invalid internal server time %s fails closed",
		async (nowMs, { fixture: f }) => {
			// Arrange
			const grant = await authorizationFixture(f);
			// Act
			const result = await f.store.getBootstrapGrantAuthorization({
				grantId: grant.grant_id,
				nowMs,
			});
			// Assert
			expect(result).toEqual(rejected("bootstrap_authorization_unavailable"));
		},
	);
}
function registerExpectationCases(test: Test) {
	test("verified seed expectation matches the actual enrollment", async ({ fixture: f }) => {
		// Arrange
		const grant = await authorizationFixture(f);
		// Act
		const result = await f.store.getBootstrapGrantAuthorization({
			...request(grant.grant_id),
			expectedSeed: expectedSeed(f),
		});
		// Assert
		expect(result).toMatchObject({ kind: "authorized", authorizationVersion: 1, grant });
	});
	test.for(["groupId", "deviceId", "publicKey", "fingerprint"] as const)(
		"foreign seed %s stays grant_not_found before global revocation",
		async (field, { fixture: f }) => {
			// Arrange
			const grant = await authorizationFixture(f);
			await revoke(f, "worker");
			const expectation = { ...expectedSeed(f), [field]: "foreign-expectation" };
			// Act
			const result = await f.store.getBootstrapGrantAuthorization({
				...request(grant.grant_id),
				expectedSeed: expectation,
			});
			// Assert: a known grant ID cannot expose global participant revocation to a foreign seed.
			expect(result).toEqual(rejected("grant_not_found"));
		},
	);
}
function registerRevocationCases(test: Test) {
	for (const who of ["seed", "worker"] as const) {
		test.for(["ID", "ID only", "key", "comment", "URL"])(
			`${who} actual %s revocation rejects regardless of caller fingerprint`,
			async (mode, { fixture: f }) => {
				// Arrange: the other participant has a different clean key and ID.
				const grant = await authorizationFixture(f);
				await revokeMode(f, who, mode);
				let key = who === "seed" ? CANONICAL_PUBLIC_KEY : UNRELATED_PUBLIC_KEY;
				if (mode === "comment") key += " fixture-comment";
				if (mode === "URL") key = key.replace(/\+/g, "-").replace(/\//g, "_");
				await f.exec(
					"UPDATE enrolled_devices SET public_key = ?, fingerprint = ? WHERE group_id = ? AND device_id = ?",
					key,
					"false-caller-key-id",
					f.review.groupId,
					bootstrapParticipant(f, who),
				);
				const history = await f.rows("coordinator_device_revocations");
				// Act
				const result = await f.store.getBootstrapGrantAuthorization(request(grant.grant_id));
				// Assert: global revocation never cascades into independently managed raw history.
				expect(result).toEqual(rejected("device_revoked"));
				expect(await f.store.getBootstrapGrant(grant.grant_id)).toEqual(grant);
				expect(await f.store.listBootstrapGrants(f.review.groupId)).toEqual([grant]);
				expect(await f.store.revokeBootstrapGrant(grant.grant_id)).toBe(true);
				expect(await f.rows("coordinator_device_revocations")).toEqual(history);
			},
		);
	}
	test("historically revoked different key cannot convert caller fingerprint into authority", async ({
		fixture: f,
	}) => {
		// Arrange
		const grant = await authorizationFixture(f);
		await revoke(f, "seed", true);
		await f.exec(
			"UPDATE enrolled_devices SET public_key = ?, fingerprint = ? WHERE group_id = ? AND device_id = ?",
			"opaque-clean-key",
			EXPECTED_KEY_ID,
			f.review.groupId,
			bootstrapParticipant(f, "seed"),
		);
		// Act
		const result = await f.store.getBootstrapGrantAuthorization(request(grant.grant_id));
		// Assert
		expect(result).toMatchObject({ kind: "authorized", authorizationVersion: 1 });
	});
}

export function registerBootstrapAuthorizationD1(
	test: Test,
	database: (f: GrantFixture) => D1DatabaseLike,
	isFinal: (query: string) => boolean,
) {
	registerFinalRevocations(test, database, isFinal);
	registerFinalEnrollmentDrift(test, database, isFinal);
	registerRevokedReplacement(test, database, isFinal);
	registerFinalGrantDrift(test, database, isFinal);
	registerCurrentReceipt(test, database, isFinal);
	registerInputCapture(test, database);
	registerReadFailures(test, database, isFinal);
}
type DatabaseFixture = (f: GrantFixture) => D1DatabaseLike;
type FinalQuery = (query: string) => boolean;
function registerRevokedReplacement(test: Test, database: DatabaseFixture, isFinal: FinalQuery) {
	test.for(["seed", "worker"] as const)(
		"revoked replacement %s key denies stale and fresh reads without masking by the other participant",
		async (who, { fixture: f }) => {
			// Arrange: only the new key is revoked; the captured participant and the other current key are clean.
			const grant = await authorizationFixture(f);
			const other = who === "seed" ? "worker" : "seed";
			await f.exec(
				"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
				"opaque-clean-other",
				f.review.groupId,
				bootstrapParticipant(f, other),
			);
			await revoke(f, other, true);
			let called = false;
			const store = guardedGrantD1(database(f), async (query) => {
				if (called || !isFinal(query)) return;
				called = true;
				await f.exec(
					"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
					who === "seed" ? UNRELATED_PUBLIC_KEY : CANONICAL_PUBLIC_KEY,
					f.review.groupId,
					bootstrapParticipant(f, who),
				);
			});
			// Act
			const stale = await store.getBootstrapGrantAuthorization(request(grant.grant_id));
			const fresh = await f.store.getBootstrapGrantAuthorization(request(grant.grant_id));
			// Assert: a stale tuple never refreshes into authority, while a fresh read classifies the new subject.
			expect(called).toBe(true);
			expect(stale).toEqual(rejected("bootstrap_authorization_unavailable"));
			expect(fresh).toEqual(rejected("device_revoked"));
		},
	);
}
function registerFinalRevocations(test: Test, database: DatabaseFixture, isFinal: FinalQuery) {
	for (const who of ["seed", "worker"] as const) {
		test.for(["ID", "ID only", "key", "pinned key removed", "pinned key rotated"])(
			`final SQL denies ${who} %s tombstone`,
			async (mode, { fixture: f }) => {
				// Arrange
				const grant = await authorizationFixture(f);
				let called = false;
				const store = guardedGrantD1(database(f), async (query) => {
					if (called || !isFinal(query)) return;
					called = true;
					await revokeMode(f, who, mode);
					if (mode === "pinned key removed")
						await f.store.removeDevice(f.review.groupId, bootstrapParticipant(f, who));
					if (mode === "pinned key rotated")
						await f.exec(
							"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
							"opaque-clean-rotation",
							f.review.groupId,
							bootstrapParticipant(f, who),
						);
				});
				// Act
				const result = await store.getBootstrapGrantAuthorization(request(grant.grant_id));
				// Assert: the captured key's tombstone survives row removal or clean rotation.
				expect(called).toBe(true);
				expect(result).toEqual(rejected("device_revoked"));
			},
		);
	}
}
function registerFinalEnrollmentDrift(test: Test, database: DatabaseFixture, isFinal: FinalQuery) {
	for (const who of ["seed", "worker"] as const) {
		test.for(["public_key", "fingerprint", "identity_id", "removal", "disabled", "enabled"])(
			`final SQL pins ${who} %s instead of refreshing authority`,
			async (field, { fixture: f }) => {
				// Arrange
				const grant = await authorizationFixture(f);
				if (field === "enabled")
					await f.store.setDeviceEnabled(f.review.groupId, bootstrapParticipant(f, who), false);
				let called = false;
				const store = guardedGrantD1(database(f), async (query) => {
					if (called || !isFinal(query)) return;
					called = true;
					if (field === "removal") {
						await f.store.removeDevice(f.review.groupId, bootstrapParticipant(f, who));
						return;
					}
					if (field === "disabled" || field === "enabled") {
						await f.store.setDeviceEnabled(
							f.review.groupId,
							bootstrapParticipant(f, who),
							field === "enabled",
						);
						return;
					}
					await f.exec(
						`UPDATE enrolled_devices SET ${field} = ? WHERE group_id = ? AND device_id = ?`,
						"clean-drift",
						f.review.groupId,
						bootstrapParticipant(f, who),
					);
				});
				// Act
				const result = await store.getBootstrapGrantAuthorization(request(grant.grant_id));
				// Assert
				expect(called).toBe(true);
				expect(result).toEqual(
					rejected(
						field === "removal" || field === "disabled"
							? `${who}_enrollment_not_found`
							: "bootstrap_authorization_unavailable",
					),
				);
				if (field !== "removal" && field !== "disabled") {
					expect(
						await f.store.getBootstrapGrantAuthorization(request(grant.grant_id)),
					).toMatchObject({ kind: "authorized", authorizationVersion: 1 });
				}
			},
		);
	}
}
function registerFinalGrantDrift(test: Test, database: DatabaseFixture, isFinal: FinalQuery) {
	test.for(["expires_at", "seed_device_id", "worker_device_id", "archived", "revoked"])(
		"final SQL detects grant/group %s drift",
		async (field, { fixture: f }) => {
			// Arrange
			const grant = await authorizationFixture(f);
			let called = false;
			const store = guardedGrantD1(database(f), async (query) => {
				if (called || !isFinal(query)) return;
				called = true;
				if (field === "archived") await f.store.archiveGroup(f.review.groupId);
				else if (field === "revoked") await f.store.revokeBootstrapGrant(grant.grant_id);
				else
					await f.exec(
						`UPDATE coordinator_bootstrap_grants SET ${field} = ? WHERE grant_id = ?`,
						field === "expires_at" ? "2098-01-01T00:00:00Z" : "different-device",
						grant.grant_id,
					);
			});
			// Act
			const result = await store.getBootstrapGrantAuthorization(request(grant.grant_id));
			// Assert
			expect(called).toBe(true);
			const errors: Record<string, string> = {
				archived: "group_archived",
				revoked: "grant_revoked",
			};
			expect(result).toEqual(rejected(errors[field] ?? "bootstrap_authorization_unavailable"));
		},
	);
}
function registerCurrentReceipt(test: Test, database: DatabaseFixture, isFinal: FinalQuery) {
	test("final SQL returns current audit fields rather than captured rows", async ({
		fixture: f,
	}) => {
		// Arrange
		const grant = await authorizationFixture(f);
		let called = false;
		const store = guardedGrantD1(database(f), async (query) => {
			if (called || !isFinal(query)) return;
			called = true;
			await f.exec(
				"UPDATE coordinator_bootstrap_grants SET created_by = ? WHERE grant_id = ?",
				"updated-audit-label",
				grant.grant_id,
			);
			await f.exec(
				"UPDATE enrolled_devices SET display_name = ? WHERE group_id = ?",
				"updated-device-label",
				f.review.groupId,
			);
		});
		// Act
		const result = await store.getBootstrapGrantAuthorization(request(grant.grant_id));
		// Assert
		expect(called).toBe(true);
		expect(result).toMatchObject({
			kind: "authorized",
			authorizationVersion: 1,
			grant: { created_by: "updated-audit-label" },
			seedEnrollment: { display_name: "updated-device-label" },
			workerEnrollment: { display_name: "updated-device-label" },
		});
	});
}
function registerInputCapture(test: Test, database: DatabaseFixture) {
	test("captures input including nested verified seed before the first await", async ({
		fixture: f,
	}) => {
		// Arrange
		const grant = await authorizationFixture(f);
		const input = { ...request(grant.grant_id), expectedSeed: expectedSeed(f) };
		let called = false;
		const store = guardedGrantD1(database(f), async () => {
			if (called) return;
			called = true;
			input.grantId = "mutated-grant";
			input.nowMs = Infinity;
			for (const field of ["groupId", "deviceId", "publicKey", "fingerprint"] as const)
				input.expectedSeed[field] = "mutated-expectation";
		});
		// Act
		const result = await store.getBootstrapGrantAuthorization(input);
		// Assert
		expect(called).toBe(true);
		expect(result).toMatchObject({ kind: "authorized", authorizationVersion: 1, grant });
	});
}
function registerReadFailures(test: Test, database: DatabaseFixture, isFinal: FinalQuery) {
	test.for(["read failure", "final failure", "missing receipt", "malformed receipt"])(
		"D1 %s returns a fixed unavailable rejection",
		async (failure, { fixture: f }) => {
			// Arrange: deterministic driver fault injection, no external service.
			const grant = await authorizationFixture(f);
			const db = database(f);
			let called = false;
			const wrap = (
				statement: D1PreparedStatementLike,
				query: string,
			): D1PreparedStatementLike => ({
				bind: (...values) => wrap(statement.bind(...values), query),
				first: async <T>() => {
					if (failure !== "read failure" && !isFinal(query)) return statement.first<T>();
					called = true;
					if (failure === "read failure" || failure === "final failure")
						throw new Error("private backend diagnostic");
					if (failure === "missing receipt") return null;
					return { kind: "authorized", authorizationVersion: 1 } as T;
				},
				all: <T>() => statement.all<T>(),
				raw: <T>() => statement.raw<T>(),
				run: () => statement.run(),
			});
			const store = new D1CoordinatorStore({ prepare: (query) => wrap(db.prepare(query), query) });
			const before = await snapshot(f);
			// Act
			const result = await store.getBootstrapGrantAuthorization(request(grant.grant_id));
			// Assert
			expect(called).toBe(true);
			expect(result).toEqual(rejected("bootstrap_authorization_unavailable"));
			expect(await snapshot(f)).toEqual(before);
		},
	);
}
