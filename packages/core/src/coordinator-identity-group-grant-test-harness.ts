import { expect, it } from "vitest";
import type { CoordinatorAuthControllerReviewInput } from "./coordinator-auth-controller.js";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import type { CoordinatorIdentityGroupGrantStore } from "./coordinator-identity-group-grant.js";

export type GrantFixture = {
	store: Store & CoordinatorIdentityGroupGrantStore;
	review: CoordinatorAuthControllerReviewInput;
	exec: (sql: string, ...values: unknown[]) => Promise<void>;
	rows: (table: string) => Promise<unknown[]>;
};
export const grantSideEffectTables = [
	"enrolled_devices",
	"groups",
	"coordinator_auth_controller_attestations",
	"coordinator_invites",
	"coordinator_scopes",
	"coordinator_scope_memberships",
	"coordinator_scope_membership_audit_log",
	"coordinator_scope_membership_effect_receipts",
	"coordinator_legacy_team_completions",
	"coordinator_auth_account_links",
	"coordinator_auth_sessions",
];
export function contractHarness(
	fixture: (use: (f: GrantFixture) => Promise<void>) => Promise<void>,
) {
	return it.extend<{ fixture: GrantFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}
type GrantTest = ReturnType<typeof contractHarness>;
function issue(f: GrantFixture) {
	return f.store.issueIdentityGroupGrantFromControllerAttestation({
		coordinatorId: f.review.coordinatorId,
		attestationId: f.review.attestationId,
	});
}
function list(f: GrantFixture) {
	return f.store.listIdentityGroupGrantRevisions({
		coordinatorId: f.review.coordinatorId,
		identityId: f.review.identityId,
	});
}
async function attest(f: GrantFixture, input = f.review, options: { bindIdentity?: string } = {}) {
	await f.store.createGroup(input.groupId);
	await f.store.enrollDevice(input.groupId, {
		deviceId: input.deviceId,
		publicKey: input.publicKey,
		fingerprint: input.fingerprint,
	});
	if (options.bindIdentity)
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ? AND device_id = ?",
			options.bindIdentity,
			input.groupId,
			input.deviceId,
		);
	expect(await f.store.createAuthControllerAttestation(input)).toMatchObject({ kind: "created" });
}
async function snapshot(f: GrantFixture) {
	return Promise.all(grantSideEffectTables.map((table) => f.rows(table)));
}
const authorityChanges = [
	"revoked controller",
	"disabled enrollment",
	"missing enrollment",
	"missing group",
	"wrong key",
	"wrong fingerprint",
	"wrong actor",
	"null enrollment bound to reviewed identity",
	"archived group",
] as const;
async function changeAuthority(f: GrantFixture, change: (typeof authorityChanges)[number]) {
	const { store, review: r } = f;
	if (change === "revoked controller")
		await store.revokeAuthControllerAttestation(r.coordinatorId, r.attestationId);
	if (change === "disabled enrollment") await store.setDeviceEnabled(r.groupId, r.deviceId, false);
	if (change === "missing enrollment") await store.removeDevice(r.groupId, r.deviceId);
	if (change === "missing group") {
		await store.removeDevice(r.groupId, r.deviceId);
		await f.exec("DELETE FROM groups WHERE group_id = ?", r.groupId);
	}
	if (change === "archived group") await store.archiveGroup(r.groupId);
	if (change === "wrong key")
		await f.exec(
			"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
			"replacement-key",
			r.groupId,
			r.deviceId,
		);
	if (change === "wrong fingerprint")
		await f.exec(
			"UPDATE enrolled_devices SET fingerprint = ? WHERE group_id = ? AND device_id = ?",
			"c".repeat(64),
			r.groupId,
			r.deviceId,
		);
	if (change === "wrong actor")
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ? AND device_id = ?",
			"other-identity",
			r.groupId,
			r.deviceId,
		);
	if (change === "null enrollment bound to reviewed identity")
		await f.exec(
			"UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ? AND device_id = ?",
			r.identityId,
			r.groupId,
			r.deviceId,
		);
}

function registerIssuanceTests(test: GrantTest) {
	test.for(["null", "bound"] as const)(
		"issues exactly one reviewed grant with %s enrollment identity and retries unchanged",
		async (binding, { fixture: f }) => {
			// Arrange: the reviewed server proof is the sole issuance input.
			await attest(f, f.review, {
				bindIdentity: binding === "bound" ? f.review.identityId : undefined,
			});
			const before = await snapshot(f);
			// Act
			const created = await issue(f);
			const first = await list(f);
			const [firstGrant] = first;
			if (!firstGrant) throw new Error("Expected issued grant");
			const retry = await issue(f);
			// Assert
			expect(first).toEqual([
				{
					coordinator_id: f.review.coordinatorId,
					identity_id: f.review.identityId,
					group_id: f.review.groupId,
					status: "active",
					revision: 1,
					source_kind: "controller_attestation",
					source_receipt_id: f.review.reviewReceiptId,
					created_at: expect.any(String),
					revoked_at: null,
				},
			]);
			expect(Number.isFinite(Date.parse(firstGrant.created_at))).toBe(true);
			expect(created).toEqual({ kind: "created", grant: first[0] });
			expect(retry).toEqual({ kind: "existing", grant: first[0] });
			expect(await list(f)).toEqual(first);
			expect(await snapshot(f)).toEqual(before);
		},
	);
}

function registerDeniedAuthorityTests(test: GrantTest) {
	test.for(authorityChanges)(
		"denies issuance after %s without writing a grant or other authority",
		async (change, { fixture: f }) => {
			// Arrange
			await attest(f);
			await changeAuthority(f, change);
			const before = await snapshot(f);
			// Act
			const result = await issue(f);
			// Assert
			expect(result).toMatchObject({ kind: "rejected" });
			expect(await list(f)).toEqual([]);
			expect(await snapshot(f)).toEqual(before);
		},
	);
}

function registerMissingProofTests(test: GrantTest) {
	test.for([
		"missing attestation",
		"wrong coordinator",
		"project receipt",
		"legacy actor hint",
	] as const)("cannot issue from %s", async (scenario, { fixture: f }) => {
		// Arrange
		await attest(f);
		const input = { coordinatorId: f.review.coordinatorId, attestationId: f.review.attestationId };
		if (scenario === "wrong coordinator") input.coordinatorId = `${input.coordinatorId}-other`;
		if (scenario === "missing attestation") input.attestationId = "missing";
		if (scenario === "project receipt") {
			input.attestationId = `${f.review.reviewReceiptId}-project`;
			await f.exec(
				`INSERT INTO coordinator_scope_membership_effect_receipts
				(effect_id, action, request_json, outcome_applied, scope_id, device_id, coordinator_id, group_id, created_at)
				VALUES (?, 'grant', '{}', 1, 'project-scope', ?, ?, ?, '2026-10-02T12:00:00.000Z')`,
				input.attestationId,
				f.review.deviceId,
				f.review.coordinatorId,
				`${f.review.groupId}-foreign`,
			);
		}
		if (scenario === "legacy actor hint") {
			await f.exec(
				"DELETE FROM coordinator_auth_controller_attestations WHERE coordinator_id = ?",
				f.review.coordinatorId,
			);
			await f.exec(
				"UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ?",
				f.review.identityId,
				f.review.groupId,
			);
		}
		const before = await snapshot(f);
		// Act: caller hints cannot replace an owned controller proof.
		await f.store.issueIdentityGroupGrantFromControllerAttestation({
			...input,
			...{
				identityId: f.review.identityId,
				groupId: f.review.groupId,
				deviceId: f.review.deviceId,
				publicKey: f.review.publicKey,
				fingerprint: f.review.fingerprint,
			},
		});
		// Assert
		expect(await list(f)).toEqual([]);
		expect(await f.rows("coordinator_identity_group_grants")).toEqual([]);
		expect(await snapshot(f)).toEqual(before);
	});
}

function registerPersistenceTests(test: GrantTest) {
	test.for(authorityChanges)(
		"retains issued grant after %s but rejects stale issuance retry",
		async (change, { fixture: f }) => {
			// Arrange
			await attest(f);
			await issue(f);
			const first = await list(f);
			await changeAuthority(f, change);
			// Act
			const retry = await issue(f);
			// Assert: a durable grant is separate from permission to issue it now.
			expect(retry).toMatchObject({ kind: "rejected" });
			expect(await list(f)).toEqual(first);
		},
	);
}

function registerRevocationTests(test: GrantTest) {
	test("revokes by active revision only and keeps the immutable receipt tombstone", async ({
		fixture: f,
	}) => {
		// Arrange
		await attest(f);
		await issue(f);
		const [first] = await list(f);
		if (!first) throw new Error("Expected issued grant");
		const input = { ...f.review, expectedRevision: 1 };
		const before = await snapshot(f);
		// Act
		const wrong = await f.store.revokeIdentityGroupGrant({ ...input, expectedRevision: 2 });
		const unchanged = await list(f);
		const revoked = await f.store.revokeIdentityGroupGrant(input);
		const stale = await f.store.revokeIdentityGroupGrant(input);
		const repeated = await f.store.revokeIdentityGroupGrant({ ...input, expectedRevision: 2 });
		const retry = await issue(f);
		// Assert
		expect([wrong, revoked, stale, repeated]).toEqual([false, true, false, false]);
		expect(unchanged).toEqual([first]);
		expect(await list(f)).toEqual([
			{ ...first, status: "revoked", revision: 2, revoked_at: expect.any(String) },
		]);
		const [tombstone] = await list(f);
		if (!tombstone) throw new Error("Expected revoked grant");
		expect(Date.parse(tombstone.revoked_at as string)).toBeGreaterThanOrEqual(
			Date.parse(first.created_at),
		);
		expect(retry).toMatchObject({ kind: "rejected" });
		expect(await snapshot(f)).toEqual(before);
	});
}

function registerNonresurrectionTests(test: GrantTest) {
	test("a new reviewed controller for the same identity and group cannot resurrect a revoked grant", async ({
		fixture: f,
	}) => {
		// Arrange
		await attest(f);
		await issue(f);
		await f.store.revokeIdentityGroupGrant({ ...f.review, expectedRevision: 1 });
		const tombstone = await list(f);
		const next = {
			...f.review,
			deviceId: `${f.review.deviceId}-new`,
			attestationId: `${f.review.attestationId}-new`,
			reviewReceiptId: `${f.review.reviewReceiptId}-new`,
			publicKey: "new-reviewed-key",
			fingerprint: "d".repeat(64),
		};
		await attest(f, next);
		// Act
		const result = await f.store.issueIdentityGroupGrantFromControllerAttestation({
			coordinatorId: next.coordinatorId,
			attestationId: next.attestationId,
		});
		await f.store.removeDevice(f.review.groupId, f.review.deviceId);
		// Assert
		expect(result).toMatchObject({ kind: "rejected" });
		expect(await list(f)).toEqual(tombstone);
	});
}

async function seedScopeGrants(f: GrantFixture) {
	const inputs = [
		{ ...f.review, groupId: `${f.review.groupId}-z` },
		{
			...f.review,
			groupId: `${f.review.groupId}-a`,
			attestationId: "att-second",
			reviewReceiptId: "receipt-second",
		},
		{
			...f.review,
			identityId: "identity-other",
			groupId: `${f.review.groupId}-other`,
			attestationId: "att-other",
			reviewReceiptId: "receipt-other",
		},
		{
			...f.review,
			coordinatorId: `${f.review.coordinatorId}-other`,
			groupId: `${f.review.groupId}-foreign`,
		},
	] as const;
	for (const input of inputs) {
		await attest(f, input);
		await f.store.issueIdentityGroupGrantFromControllerAttestation({
			coordinatorId: input.coordinatorId,
			attestationId: input.attestationId,
		});
	}
	return inputs;
}

function registerScopeTests(test: GrantTest) {
	test("lists active and revoked rows in exact coordinator/identity scope sorted by group", async ({
		fixture: f,
	}) => {
		// Arrange
		const inputs = await seedScopeGrants(f);
		await f.store.revokeIdentityGroupGrant({ ...inputs[0], expectedRevision: 1 });
		// Act
		const rows = await list(f);
		const missing = await f.store.listIdentityGroupGrantRevisions({
			...f.review,
			identityId: "missing",
		});
		const wildcard = await f.store.listIdentityGroupGrantRevisions({
			coordinatorId: "%",
			identityId: "%",
		});
		const wrongScope = await f.store.revokeIdentityGroupGrant({
			...inputs[1],
			coordinatorId: "missing",
			expectedRevision: 1,
		});
		const wrongIdentity = await f.store.revokeIdentityGroupGrant({
			...inputs[1],
			identityId: "missing",
			expectedRevision: 1,
		});
		const wrongGroup = await f.store.revokeIdentityGroupGrant({
			...inputs[1],
			groupId: "missing",
			expectedRevision: 1,
		});
		// Assert
		expect(rows.map((r) => [r.group_id, r.status, r.revision])).toEqual([
			[inputs[1].groupId, "active", 1],
			[inputs[0].groupId, "revoked", 2],
		]);
		expect(
			rows.every(
				(r) => r.identity_id === f.review.identityId && r.coordinator_id === f.review.coordinatorId,
			),
		).toBe(true);
		expect(missing).toEqual([]);
		expect(wildcard).toEqual([]);
		expect(wrongScope).toBe(false);
		expect([wrongIdentity, wrongGroup]).toEqual([false, false]);
		expect(await list(f)).toEqual(rows);
	});
}

function registerConcurrencyTests(test: GrantTest) {
	test("concurrent issuance converges and concurrent CAS has one winner without resurrection", async ({
		fixture: f,
	}) => {
		// Arrange
		await attest(f);
		// Act
		await Promise.all([issue(f), issue(f), issue(f)]);
		const first = await list(f);
		const [firstGrant] = first;
		if (!firstGrant) throw new Error("Expected issued grant");
		const results = await Promise.all(
			[1, 1, 1].map((expectedRevision) =>
				f.store.revokeIdentityGroupGrant({ ...f.review, expectedRevision }),
			),
		);
		await issue(f);
		// Assert
		expect(first).toHaveLength(1);
		expect(firstGrant.revision).toBe(1);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await list(f)).toEqual([
			{ ...first[0], status: "revoked", revision: 2, revoked_at: expect.any(String) },
		]);
	});

	test("initializes empty and cannot revoke a missing grant", async ({ fixture: f }) => {
		// Arrange
		await attest(f);
		// Act
		const rows = await list(f);
		const revoked = await f.store.revokeIdentityGroupGrant({ ...f.review, expectedRevision: 1 });
		// Assert
		expect(rows).toEqual([]);
		expect(revoked).toBe(false);
		expect(await list(f)).toEqual([]);
	});
}

export function registerIdentityGroupGrantContract(test: GrantTest) {
	registerIssuanceTests(test);
	registerDeniedAuthorityTests(test);
	registerMissingProofTests(test);
	registerPersistenceTests(test);
	registerRevocationTests(test);
	registerNonresurrectionTests(test);
	registerScopeTests(test);
	registerConcurrencyTests(test);
}
