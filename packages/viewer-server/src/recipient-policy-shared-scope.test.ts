import {
	initTestSchema,
	type MemoryStore,
	RECIPIENT_POLICY_SHARED_SCOPE_CODE,
	type RecipientPolicyReconcilerEffects,
} from "@codemem/core";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileRecipientPolicyProjectsOperation } from "./application/coordinator-maintenance.js";
import { listRecipientPolicyReconciliationStatus } from "./routes/sync.js";

const NOW = "2026-07-22T10:00:00.000Z";
const SHARED_SCOPE = "team-shared";

function effects(now: () => string): RecipientPolicyReconcilerEffects {
	const unused = async () => {
		throw new Error("no coordinator call is expected for a shared scope");
	};
	return {
		now,
		snapshot: vi.fn(unused),
		listBoundaryEnrollments: vi.fn(unused),
		probeCapability: vi.fn(async () => "supported" as const),
		revoke: vi.fn(unused),
		grant: vi.fn(unused),
		refresh: vi.fn(async () => undefined),
	};
}

function map(db: InstanceType<typeof Database>, project: string, scopeId: string): void {
	db.prepare(
		`INSERT INTO project_scope_mappings(
			workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
		 ) VALUES (?, ?, ?, 0, 'user', ?, ?)`,
	).run(project, project, scopeId, NOW, NOW);
}

function recipient(db: InstanceType<typeof Database>, project: string): void {
	db.prepare(
		`INSERT INTO project_recipients(
			canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			policy_revision, migration_state, idempotency_key, created_at, updated_at
		 ) VALUES (?, 'identity', 'identity-a', 'active', 'test', '1', 'native', ?, ?, ?)`,
	).run(project, `recipient-${project}`, NOW, NOW);
}

function authority(db: InstanceType<typeof Database>, project: string) {
	return db
		.prepare(
			`SELECT authority_state, safe_error_code, attempt_count, last_attempt_at
			 FROM recipient_policy_authority_states WHERE canonical_project_identity = ?`,
		)
		.get(project) as {
		authority_state: string;
		safe_error_code: string | null;
		attempt_count: number;
		last_attempt_at: string | null;
	};
}

describe("Projects in a shared multi-Project scope", () => {
	let db: InstanceType<typeof Database>;
	let store: MemoryStore;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		store = { db, deviceId: "device-local" } as unknown as MemoryStore;
		db.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id, status, created_at, updated_at
			 ) VALUES (?, 'Older team', 'team', 'coordinator', 'coordinator-a', 'group-a', 'active', ?, ?)`,
		).run(SHARED_SCOPE, NOW, NOW);
		for (const project of ["git:alpha", "git:beta"]) {
			map(db, project, SHARED_SCOPE);
			recipient(db, project);
		}
	});

	afterEach(() => db.close());

	async function maintain(at: string) {
		return reconcileRecipientPolicyProjectsOperation(store, {
			now: new Date(at),
			limit: 10,
			effects: effects(() => at),
		});
	}

	it("records the shared-scope state without coordinator calls and reports it as nothing to do", async () => {
		// Act
		const first = await maintain(NOW);

		// Assert
		expect(first).toMatchObject({ processed: 2, attention: 0, waiting: 2, failed: 0 });
		expect(authority(db, "git:alpha")).toMatchObject({
			authority_state: "legacy",
			safe_error_code: RECIPIENT_POLICY_SHARED_SCOPE_CODE,
			attempt_count: 1,
		});
		expect(listRecipientPolicyReconciliationStatus(store).items).toEqual(
			["git:alpha", "git:beta"].map((canonicalProjectIdentity) => ({
				canonicalProjectIdentity,
				state: "legacy_scope",
				label: "Shared scope controls access",
				explanation:
					"Access for this Project is still controlled by the shared scope it belongs to. Nothing is required.",
				deliveredCopiesMayRemain: true,
				revocationWarning: expect.any(String),
			})),
		);
	});

	it("does not retry on a timer, and retries once the scope mapping changes", async () => {
		// Arrange
		await maintain(NOW);

		// Act: hours later, nothing that decides the answer has changed.
		const idle = await maintain("2026-07-22T14:00:00.000Z");

		// Assert
		expect(idle.processed).toBe(0);
		expect(authority(db, "git:alpha").attempt_count).toBe(1);

		// Act: the other Project leaves the shared scope, so git:alpha is its only Project.
		db.prepare("DELETE FROM project_scope_mappings WHERE workspace_identity = 'git:beta'").run();
		const changed = await maintain("2026-07-22T14:05:00.000Z");

		// Assert: it runs again and gets the ordinary answer for a scope that is not managed.
		expect(changed.items.map((item) => item.canonicalProjectIdentity)).toContain("git:alpha");
		expect(authority(db, "git:alpha")).toMatchObject({
			safe_error_code: "recipient_policy_active_managed_scope_required",
			attempt_count: 2,
		});
		expect(listRecipientPolicyReconciliationStatus(store).items[0]?.state).toBe("needs_attention");
	});

	it("runs again on a wake, which clears the last attempt", async () => {
		await maintain(NOW);
		db.prepare(
			`UPDATE recipient_policy_authority_states SET last_attempt_at = NULL, wake_epoch = wake_epoch + 1
			 WHERE canonical_project_identity = 'git:alpha'`,
		).run();

		const woken = await maintain("2026-07-22T14:00:00.000Z");

		expect(woken.items.map((item) => item.canonicalProjectIdentity)).toEqual(["git:alpha"]);
		expect(authority(db, "git:alpha").attempt_count).toBe(2);
		expect(authority(db, "git:beta").attempt_count).toBe(1);
	});
});

describe("recipient policy read state", () => {
	it("keeps real failures and rollbacks as needing attention", () => {
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			const insert = db.prepare(
				`INSERT INTO recipient_policy_authority_states(
					canonical_project_identity, authority_state, generation, safe_error_code,
					state_changed_at, created_at, updated_at
				 ) VALUES (?, ?, 1, ?, ?, ?, ?)`,
			);
			insert.run("git:shared", "legacy", RECIPIENT_POLICY_SHARED_SCOPE_CODE, NOW, NOW, NOW);
			insert.run("git:failed", "legacy", "recipient_policy_effect_failed", NOW, NOW, NOW);
			insert.run(
				"git:rolled-back",
				"rolled_back",
				RECIPIENT_POLICY_SHARED_SCOPE_CODE,
				NOW,
				NOW,
				NOW,
			);
			const store = { db } as unknown as MemoryStore;

			const states = Object.fromEntries(
				listRecipientPolicyReconciliationStatus(store).items.map((item) => [
					item.canonicalProjectIdentity,
					item.state,
				]),
			);

			expect(states).toEqual({
				"git:failed": "needs_attention",
				"git:rolled-back": "needs_attention",
				"git:shared": "legacy_scope",
			});
		} finally {
			db.close();
		}
	});
});
