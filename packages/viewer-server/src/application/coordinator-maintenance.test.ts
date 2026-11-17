import { initTestSchema, type RecipientPolicyReconcilerEffects } from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "../store.js";
import {
	advancePendingProjectSharesOperation,
	reconcileRecipientPolicyProjectsOperation,
} from "./coordinator-maintenance.js";

const NOW = "2026-07-22T10:00:00.000Z";

function unusedEffects(): RecipientPolicyReconcilerEffects {
	return {
		now: () => NOW,
		snapshot: vi.fn(async () => {
			throw new Error("unused");
		}),
		listBoundaryEnrollments: vi.fn(async () => {
			throw new Error("unused");
		}),
		probeCapability: vi.fn(async () => "supported"),
		revoke: vi.fn(async () => {
			throw new Error("unused");
		}),
		grant: vi.fn(async () => {
			throw new Error("unused");
		}),
		refresh: vi.fn(async () => undefined),
	};
}

describe("recipient-policy maintenance pacing", () => {
	let db: InstanceType<typeof Database>;
	let store: MemoryStore;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		store = { db, deviceId: "device-local" } as MemoryStore;
	});

	afterEach(() => db.close());

	it("paces active policy checks to preserve coordinator read capacity", async () => {
		db.prepare(
			`INSERT INTO recipient_policy_authority_states(
			 canonical_project_identity, authority_state, generation, state_changed_at,
			 attempt_count, last_attempt_at, created_at, updated_at
			 ) VALUES ('project-active', 'active', 1, ?, 1, ?, ?, ?)`,
		).run(NOW, NOW, NOW, NOW);
		const reconcileProject = vi.fn(async () => ({
			canonicalProjectIdentity: "project-active",
			status: "active" as const,
			generation: 1,
			safeErrorCode: null,
			revokedDeviceIds: [],
			grantedDeviceIds: [],
			deliveredCopiesMayRemain: true as const,
			revocationWarning: "Delivered copies may remain.",
		}));

		const paced = await reconcileRecipientPolicyProjectsOperation(store, {
			now: new Date("2026-07-22T10:00:30.000Z"),
			effects: unusedEffects(),
			reconcileProject,
		});
		expect(paced.processed).toBe(0);

		const resumed = await reconcileRecipientPolicyProjectsOperation(store, {
			now: new Date("2026-07-22T10:01:01.000Z"),
			effects: unusedEffects(),
			reconcileProject,
		});
		expect(resumed).toMatchObject({ processed: 1, active: 1, failed: 0 });
		expect(reconcileProject).toHaveBeenCalledTimes(1);
	});
});

describe("invite reconciliation failure state", () => {
	const OPERATION_ID = "op-waiting";
	const SEEDED_AT = "2026-07-22T09:00:00.000Z";
	let db: InstanceType<typeof Database>;
	let store: MemoryStore;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		store = { db, actorId: "actor-local", deviceId: "device-local" } as MemoryStore;
		db.prepare(
			`INSERT INTO share_operations(
			 operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id, person_kind,
			 teammate_name, history_policy, reviewed_project_set_digest, coordinator_group_id,
			 invite_token_digest, invite_expires_at, created_at, updated_at
			 ) VALUES (?, 'waiting_for_acceptance', 'actor-local', '[]', 'person-1', 'person',
			 'Teammate', 'none', 'digest', 'group-1', 'invite-digest', '2026-08-01T00:00:00.000Z', ?, ?)`,
		).run(OPERATION_ID, SEEDED_AT, SEEDED_AT);
		db.prepare(
			`INSERT INTO share_operation_steps(
			 operation_id, step_key, effect_id, status, attempt_count, updated_at
			 ) VALUES (?, 'invite_consumption', 'effect-1', 'pending', 0, ?)`,
		).run(OPERATION_ID, SEEDED_AT);
	});

	afterEach(() => db.close());

	function readState() {
		return {
			operation: db
				.prepare("SELECT state, updated_at FROM share_operations WHERE operation_id = ?")
				.get(OPERATION_ID),
			step: db
				.prepare(
					`SELECT status, attempt_count, last_attempt_at, safe_error_code, updated_at
					 FROM share_operation_steps WHERE operation_id = ? AND step_key = 'invite_consumption'`,
				)
				.get(OPERATION_ID),
		};
	}

	function advanceWith(error: Error) {
		return advancePendingProjectSharesOperation(store, {
			now: new Date(NOW),
			advanceOperation: async () => {
				throw error;
			},
		});
	}

	it("leaves the step and operation unchanged when the operation update fails", async () => {
		const before = readState();
		db.exec(`CREATE TRIGGER fail_share_operation_update BEFORE UPDATE ON share_operations
			BEGIN SELECT RAISE(ABORT, 'injected share operation failure'); END`);

		await expect(advanceWith(new Error("coordinator unavailable"))).rejects.toThrow(
			"injected share operation failure",
		);

		expect(readState()).toEqual(before);
	});

	it("schedules a retry on both rows for a retryable failure", async () => {
		const result = await advanceWith(new Error("coordinator unavailable"));

		expect(result.items).toEqual([
			{ operationId: OPERATION_ID, outcome: "retry_scheduled", error: "coordinator unavailable" },
		]);
		expect(readState()).toEqual({
			operation: { state: "waiting_for_acceptance", updated_at: NOW },
			step: {
				status: "pending",
				attempt_count: 1,
				last_attempt_at: NOW,
				safe_error_code: "operation_read_failed",
				updated_at: NOW,
			},
		});
	});

	it("marks both rows for attention on a terminal failure", async () => {
		const result = await advanceWith(new Error("operation_not_found"));

		expect(result.items).toEqual([
			{ operationId: OPERATION_ID, outcome: "needs_attention", error: "operation_not_found" },
		]);
		expect(readState()).toEqual({
			operation: { state: "needs_attention", updated_at: NOW },
			step: {
				status: "failed",
				attempt_count: 1,
				last_attempt_at: NOW,
				safe_error_code: "operation_not_found",
				updated_at: NOW,
			},
		});
	});
});
