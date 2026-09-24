import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import {
	assertLegacyShareGrantAllowed,
	type RecipientPolicyReconcilerEffects,
	reconcileRecipientPolicyProject,
} from "./recipient-policy-reconciler.js";
import {
	deterministicRecipientPolicyReconciliationEffectId,
	ensureRecipientPolicyReconciliationStep,
} from "./recipient-policy-reconciliation.js";
import { initTestSchema } from "./test-utils.js";

const PROJECT = "https://git.example.invalid/acme/reconciled.git";
const CWD = "/workspace/reconciled";
const SCOPE = "managed-project-scope";
const BASE_TIME = Date.parse("2026-07-22T10:00:00.000Z");

function stepPayloadDigest(value: unknown): string {
	return `recipient-policy-step-payload-v1:${createHash("sha256")
		.update(JSON.stringify(value))
		.digest("hex")}`;
}

function insertAliasPolicyGraph(db: InstanceType<typeof Database>): void {
	const now = new Date(BASE_TIME).toISOString();
	db.prepare(`INSERT INTO actors(
		actor_id, display_name, is_local, status, created_at, updated_at
	 ) VALUES ('identity-a', 'Identity A', 1, 'active', ?, ?)`).run(now, now);
	const insertDevice = db.prepare(`INSERT INTO identity_devices(
		device_id, identity_id, display_name, status, provenance, revision, migration_state,
		idempotency_key, created_at, updated_at
	 ) VALUES (?, 'identity-a', ?, 'active', 'test', '1', 'native', ?, ?, ?)`);
	insertDevice.run("device-keep", "Keep", "device:keep", now, now);
	insertDevice.run("device-new", "New", "device:new", now, now);
	db.prepare(`INSERT INTO project_recipients(
		canonical_project_identity, recipient_kind, recipient_id, status, provenance,
		policy_revision, migration_state, idempotency_key, created_at, updated_at
	 ) VALUES (?, 'identity', 'identity-a', 'active', 'test', '1', 'native',
		'recipient:a', ?, ?)`).run(CWD, now, now);
	db.prepare(`INSERT INTO replication_scopes(
		scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch,
		status, created_at, updated_at
	 ) VALUES (?, 'Managed Project', 'managed_project', 'coordinator', 'coord', 'group', 1,
		'active', ?, ?)`).run(SCOPE, now, now);
	db.prepare(`INSERT INTO project_scope_mappings(
		workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
	 ) VALUES (?, ?, ?, 1000, 'test', ?, ?)`).run(CWD, CWD, SCOPE, now, now);
	db.prepare("INSERT INTO sessions(started_at, cwd, metadata_json) VALUES (?, ?, ?)").run(
		now,
		CWD,
		JSON.stringify({ codemem_repository_identity: PROJECT }),
	);
}

function aliasReconciliationEffects(): RecipientPolicyReconcilerEffects {
	let tick = 0;
	const now = () => new Date(BASE_TIME + tick++ * 1_000).toISOString();
	return {
		now,
		snapshot: vi.fn(async () => ({
			authoritative: true,
			scopeId: SCOPE,
			fingerprint: "snapshot:device-keep,device-new",
			observedAt: now(),
			memberships: ["device-keep", "device-new"].map((deviceId) => ({
				deviceId,
				status: "active" as const,
			})),
		})),
		listBoundaryEnrollments: vi.fn(async () =>
			["device-keep", "device-new"].map((deviceId) => ({
				deviceId,
				identityId: "identity-a",
				publicKey: `pk-${deviceId}`,
				fingerprint: `fp-${deviceId}`,
				enabled: true,
			})),
		),
		probeCapability: vi.fn(async () => "supported"),
		revoke: vi.fn(async () => {
			throw new Error("unexpected revoke");
		}),
		grant: vi.fn(async () => {
			throw new Error("unexpected grant");
		}),
		refresh: vi.fn(async () => undefined),
	};
}

it("canonicalizes a queued legacy cwd before resolving its boundary and recipients", async () => {
	const db = new Database(":memory:");
	initTestSchema(db);
	insertAliasPolicyGraph(db);
	const sibling = "/workspace/reconciled-sibling";
	db.prepare("INSERT INTO sessions(started_at, cwd, metadata_json) VALUES (?, ?, ?)").run(
		new Date(BASE_TIME).toISOString(),
		sibling,
		JSON.stringify({ codemem_repository_identity: PROJECT }),
	);
	db.prepare(`INSERT INTO project_scope_mappings(
		workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
	 ) VALUES (?, ?, ?, 1000, 'test', ?, ?)`).run(
		sibling,
		sibling,
		SCOPE,
		new Date(BASE_TIME).toISOString(),
		new Date(BASE_TIME).toISOString(),
	);
	const effects = aliasReconciliationEffects();
	try {
		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: CWD, leaseOwner: "worker-alias" },
			effects,
		);

		expect(outcome).toMatchObject({
			canonicalProjectIdentity: PROJECT,
			status: "parity_pending",
			revokedDeviceIds: [],
			grantedDeviceIds: [],
		});
		expect(effects.revoke).not.toHaveBeenCalled();
	} finally {
		db.close();
	}
});

it("leaves cwd-keyed reconciliation state untouched while its lease is live", async () => {
	const db = new Database(":memory:");
	initTestSchema(db);
	insertAliasPolicyGraph(db);
	const now = new Date(BASE_TIME).toISOString();
	try {
		db.prepare(`INSERT INTO recipient_policy_authority_states(
			canonical_project_identity, authority_state, generation, state_changed_at,
			lease_owner, lease_acquired_at, lease_expires_at, created_at, updated_at
		 ) VALUES (?, 'pending_revoke', 4, ?, 'other-worker', ?, '2099-01-01T00:00:00.000Z', ?, ?)`).run(
			CWD,
			now,
			now,
			now,
			now,
		);
		db.prepare(`INSERT INTO recipient_policy_authority_states(
			canonical_project_identity, authority_state, generation, state_changed_at,
			created_at, updated_at
		 ) VALUES (?, 'legacy', 1, ?, ?, ?)`).run(PROJECT, now, now, now);
		db.prepare(`INSERT INTO recipient_policy_reconciliation_steps(
			canonical_project_identity, generation, step_key, effect_id, payload_digest,
			status, created_at, updated_at
		 ) VALUES (?, 4, 'revoke:device-blocked', 'effect:legacy', 'payload:legacy',
			'pending', ?, ?)`).run(CWD, now, now);
		db.prepare(`INSERT INTO recipient_policy_deny_overlays(
			canonical_project_identity, scope_id, device_id, generation, reason_code,
			created_at, updated_at
		 ) VALUES (?, ?, 'device-blocked', 4, 'pending_revoke', ?, ?)`).run(CWD, SCOPE, now, now);

		const outcome = await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-canonical" },
			aliasReconciliationEffects(),
		);

		expect(outcome).toMatchObject({
			canonicalProjectIdentity: PROJECT,
			generation: 4,
			status: "busy",
		});
		const counts = db
			.prepare(`SELECT
				(SELECT COUNT(*) FROM recipient_policy_authority_states
				 WHERE canonical_project_identity = ?) AS alias_authority,
				(SELECT COUNT(*) FROM recipient_policy_reconciliation_steps
				 WHERE canonical_project_identity = ?) AS alias_steps,
				(SELECT COUNT(*) FROM recipient_policy_deny_overlays
				 WHERE canonical_project_identity = ?) AS alias_overlays,
				(SELECT COUNT(*) FROM recipient_policy_authority_states
				 WHERE canonical_project_identity = ?) AS canonical_authority,
				(SELECT COUNT(*) FROM recipient_policy_reconciliation_steps
				 WHERE canonical_project_identity = ?) AS canonical_steps,
				(SELECT COUNT(*) FROM recipient_policy_deny_overlays
				 WHERE canonical_project_identity = ?) AS canonical_overlays`)
			.get(CWD, CWD, CWD, PROJECT, PROJECT, PROJECT);
		expect(counts).toEqual({
			alias_authority: 1,
			alias_overlays: 1,
			alias_steps: 1,
			canonical_authority: 1,
			canonical_overlays: 0,
			canonical_steps: 0,
		});
	} finally {
		db.close();
	}
});

it("re-keys expired alias steps and preserves a completed collision", async () => {
	const db = new Database(":memory:");
	initTestSchema(db);
	insertAliasPolicyGraph(db);
	const now = new Date(BASE_TIME).toISOString();
	const pendingPayload = "payload:pending";
	const completedPayload = "payload:completed";
	const uncertainPayload = "payload:uncertain";
	try {
		db.prepare(`INSERT INTO recipient_policy_authority_states(
			canonical_project_identity, authority_state, generation, state_changed_at,
			lease_owner, lease_acquired_at, lease_expires_at, created_at, updated_at
		 ) VALUES (?, 'pending_revoke', 4, ?, 'expired-worker', ?, '2026-07-22T09:00:00.000Z', ?, ?)`).run(
			CWD,
			now,
			now,
			now,
			now,
		);
		for (const [projectId, stepKey, payloadDigest, status] of [
			[CWD, "revoke:device-pending", pendingPayload, "pending"],
			[CWD, "revoke:device-uncertain", uncertainPayload, "failed"],
			[
				CWD,
				"refresh:pending-refresh",
				stepPayloadDigest({ canonicalProjectIdentity: CWD }),
				"pending",
			],
			[PROJECT, "revoke:device-collision", completedPayload, "pending"],
			[CWD, "revoke:device-collision", completedPayload, "completed"],
		] as const) {
			db.prepare(`INSERT INTO recipient_policy_reconciliation_steps(
				canonical_project_identity, generation, step_key, effect_id, payload_digest,
				status, completed_at, created_at, updated_at
			 ) VALUES (?, 4, ?, ?, ?, ?, CASE WHEN ? = 'completed' THEN ? ELSE NULL END, ?, ?)`).run(
				projectId,
				stepKey,
				`legacy:${projectId}:${stepKey}`,
				payloadDigest,
				status,
				status,
				now,
				now,
				now,
			);
		}
		db.prepare("DELETE FROM project_scope_mappings").run();

		await reconcileRecipientPolicyProject(
			db,
			{ canonicalProjectIdentity: PROJECT, leaseOwner: "worker-canonical" },
			aliasReconciliationEffects(),
		);

		const rows = db
			.prepare(`SELECT canonical_project_identity, step_key, effect_id, payload_digest, status
				FROM recipient_policy_reconciliation_steps ORDER BY step_key`)
			.all() as Array<Record<string, unknown>>;
		expect(rows).toEqual([
			expect.objectContaining({
				canonical_project_identity: PROJECT,
				step_key: "refresh:pending-refresh",
				payload_digest: stepPayloadDigest({ canonicalProjectIdentity: PROJECT }),
				effect_id: deterministicRecipientPolicyReconciliationEffectId({
					canonicalProjectIdentity: PROJECT,
					generation: 4,
					stepKey: "refresh:pending-refresh",
					payloadDigest: stepPayloadDigest({ canonicalProjectIdentity: PROJECT }),
				}),
			}),
			expect.objectContaining({
				canonical_project_identity: PROJECT,
				step_key: "revoke:device-collision",
				status: "completed",
				effect_id: deterministicRecipientPolicyReconciliationEffectId({
					canonicalProjectIdentity: PROJECT,
					generation: 4,
					stepKey: "revoke:device-collision",
					payloadDigest: completedPayload,
				}),
			}),
			expect.objectContaining({
				canonical_project_identity: PROJECT,
				step_key: "revoke:device-pending",
				status: "pending",
				effect_id: deterministicRecipientPolicyReconciliationEffectId({
					canonicalProjectIdentity: PROJECT,
					generation: 4,
					stepKey: "revoke:device-pending",
					payloadDigest: pendingPayload,
				}),
			}),
			expect.objectContaining({
				canonical_project_identity: PROJECT,
				step_key: "revoke:device-uncertain",
				status: "failed",
				effect_id: `legacy:${CWD}:revoke:device-uncertain`,
			}),
		]);
		expect(
			ensureRecipientPolicyReconciliationStep(db, {
				canonicalProjectIdentity: PROJECT,
				generation: 4,
				stepKey: "revoke:device-uncertain",
				payloadDigest: uncertainPayload,
				now,
			}).effectId,
		).toBe(`legacy:${CWD}:revoke:device-uncertain`);
	} finally {
		db.close();
	}
});

it("canonicalizes legacy grant checks after alias authority migration", () => {
	const db = new Database(":memory:");
	initTestSchema(db);
	insertAliasPolicyGraph(db);
	const now = new Date(BASE_TIME).toISOString();
	try {
		db.prepare(`INSERT INTO recipient_policy_authority_states(
			canonical_project_identity, authority_state, generation, desired_devices_digest,
			state_changed_at, created_at, updated_at
		 ) VALUES (?, 'active', 1, 'different-policy', ?, ?, ?)`).run(PROJECT, now, now, now);
		expect(() =>
			assertLegacyShareGrantAllowed(db, {
				canonicalProjectIdentity: CWD,
				deviceId: "device-new",
			}),
		).toThrow("recipient_policy_legacy_grant_blocked");
	} finally {
		db.close();
	}
});

it("validates a learned repository identity before migrating alias state", async () => {
	const db = new Database(":memory:");
	initTestSchema(db);
	insertAliasPolicyGraph(db);
	const now = new Date(BASE_TIME).toISOString();
	try {
		db.prepare("UPDATE sessions SET metadata_json = ? WHERE cwd = ?").run(
			JSON.stringify({ codemem_repository_identity: "invalid\u0000repository" }),
			CWD,
		);
		db.prepare(`INSERT INTO recipient_policy_authority_states(
			canonical_project_identity, authority_state, generation, state_changed_at,
			created_at, updated_at
		 ) VALUES (?, 'pending_revoke', 2, ?, ?, ?)`).run(CWD, now, now, now);
		db.prepare(`INSERT INTO recipient_policy_deny_overlays(
			canonical_project_identity, scope_id, device_id, generation, reason_code,
			created_at, updated_at
		 ) VALUES (?, ?, 'device-blocked', 2, 'pending_revoke', ?, ?)`).run(CWD, SCOPE, now, now);

		await expect(
			reconcileRecipientPolicyProject(
				db,
				{ canonicalProjectIdentity: CWD, leaseOwner: "worker-invalid-project" },
				aliasReconciliationEffects(),
			),
		).rejects.toThrow("recipient_policy_reconciliation_input_invalid");
		expect(
			db
				.prepare(
					`SELECT COUNT(*) FROM recipient_policy_authority_states
					 WHERE canonical_project_identity = ?`,
				)
				.pluck()
				.get(CWD),
		).toBe(1);
		expect(
			db
				.prepare(
					`SELECT COUNT(*) FROM recipient_policy_deny_overlays
					 WHERE canonical_project_identity = ?`,
				)
				.pluck()
				.get(CWD),
		).toBe(1);
	} finally {
		db.close();
	}
});
