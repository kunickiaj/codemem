import { initTestSchema, type RecipientPolicyReconcilerEffects } from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryStore } from "../store.js";
import { reconcileRecipientPolicyProjectsOperation } from "./coordinator-maintenance.js";

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
