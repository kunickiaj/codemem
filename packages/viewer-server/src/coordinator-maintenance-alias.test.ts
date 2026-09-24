import {
	initTestSchema,
	type MemoryStore,
	type RecipientPolicyReconcilerEffects,
	type reconcileRecipientPolicyProject,
} from "@codemem/core";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { reconcileRecipientPolicyProjectsOperation } from "./application/coordinator-maintenance.js";

const NOW = "2026-07-22T10:00:00.000Z";

function insertRecipient(
	db: InstanceType<typeof Database>,
	projectId: string,
	ordinal: number,
): void {
	db.prepare(`INSERT INTO project_recipients(
		canonical_project_identity, recipient_kind, recipient_id, status, provenance,
		policy_revision, migration_state, idempotency_key, created_at, updated_at
	 ) VALUES (?, 'identity', ?, 'active', 'test', '1', 'native', ?, ?, ?)`).run(
		projectId,
		`identity-${ordinal}`,
		`recipient-${ordinal}`,
		NOW,
		NOW,
	);
}

function unusedEffects(): RecipientPolicyReconcilerEffects {
	const unused = async () => {
		throw new Error("unused");
	};
	return {
		now: () => NOW,
		snapshot: unused,
		listBoundaryEnrollments: unused,
		probeCapability: vi.fn(async () => "supported"),
		revoke: unused,
		grant: unused,
		refresh: vi.fn(async () => undefined),
	};
}

it("deduplicates legacy checkout aliases before applying the maintenance batch limit", async () => {
	const db = new Database(":memory:");
	initTestSchema(db);
	const repository = "https://example.test/acme/maintenance.git";
	try {
		for (const [index, cwd] of ["/workspace/main", "/workspace/one", "/workspace/two"].entries()) {
			insertRecipient(db, cwd, index);
			db.prepare(
				"INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, ?)",
			).run(NOW, cwd, "maintenance", JSON.stringify({ codemem_repository_identity: repository }));
		}
		insertRecipient(db, "project-other", 3);
		const store = {
			actorId: "actor-local",
			db,
			deviceId: "device-local",
		} as unknown as MemoryStore;
		const visited: string[] = [];
		const reconcileProject: typeof reconcileRecipientPolicyProject = vi.fn(async (_db, input) => {
			visited.push(input.canonicalProjectIdentity);
			return {
				canonicalProjectIdentity: input.canonicalProjectIdentity,
				status: "waiting" as const,
				generation: 0,
				safeErrorCode: "recipient_policy_capability_undetermined",
				revokedDeviceIds: [],
				grantedDeviceIds: [],
				deliveredCopiesMayRemain: true as const,
				revocationWarning: "Delivered copies may remain.",
			};
		});

		const result = await reconcileRecipientPolicyProjectsOperation(store, {
			limit: 2,
			effects: unusedEffects(),
			reconcileProject,
		});

		expect(result.processed).toBe(2);
		expect(visited).toEqual(expect.arrayContaining([repository, "project-other"]));
	} finally {
		db.close();
	}
});

it("uses canonical authority pacing when a newer alias row also exists", async () => {
	const db = new Database(":memory:");
	initTestSchema(db);
	const repository = "https://example.test/acme/maintenance-authority.git";
	const cwd = "/workspace/maintenance-authority";
	try {
		insertRecipient(db, repository, 0);
		db.prepare(
			"INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, ?, ?)",
		).run(
			NOW,
			cwd,
			"maintenance-authority",
			JSON.stringify({ codemem_repository_identity: repository }),
		);
		for (const [projectId, safeErrorCode, lastAttemptAt] of [
			[repository, null, "2026-07-22T09:00:00.000Z"],
			[cwd, "recipient_policy_snapshot_not_fresh", "2026-07-22T09:59:30.000Z"],
		]) {
			db.prepare(`INSERT INTO recipient_policy_authority_states(
				canonical_project_identity, authority_state, generation, safe_error_code,
				state_changed_at, last_attempt_at, created_at, updated_at
			 ) VALUES (?, 'legacy', 0, ?, ?, ?, ?, ?)`).run(
				projectId,
				safeErrorCode,
				NOW,
				lastAttemptAt,
				NOW,
				NOW,
			);
		}
		const store = {
			actorId: "actor-local",
			db,
			deviceId: "device-local",
		} as unknown as MemoryStore;
		const visited: string[] = [];
		const reconcileProject: typeof reconcileRecipientPolicyProject = vi.fn(async (_db, input) => {
			visited.push(input.canonicalProjectIdentity);
			return {
				canonicalProjectIdentity: input.canonicalProjectIdentity,
				status: "waiting" as const,
				generation: 0,
				safeErrorCode: null,
				revokedDeviceIds: [],
				grantedDeviceIds: [],
				deliveredCopiesMayRemain: true as const,
				revocationWarning: "Delivered copies may remain.",
			};
		});

		await reconcileRecipientPolicyProjectsOperation(store, {
			now: new Date(NOW),
			limit: 1,
			effects: unusedEffects(),
			reconcileProject,
		});

		expect(visited).toEqual([repository]);
	} finally {
		db.close();
	}
});

it("backs off a project when reconciliation throws before lease acquisition", async () => {
	const db = new Database(":memory:");
	initTestSchema(db);
	const projectId = "https://example.test/acme/conflicted-maintenance.git";
	try {
		insertRecipient(db, projectId, 0);
		db.prepare(`INSERT INTO recipient_policy_authority_states(
			canonical_project_identity, authority_state, generation, state_changed_at,
			created_at, updated_at
		 ) VALUES (?, 'active', 1, ?, ?, ?)`).run(projectId, NOW, NOW, NOW);
		const store = {
			actorId: "actor-local",
			db,
			deviceId: "device-local",
		} as unknown as MemoryStore;
		const reconcileProject: typeof reconcileRecipientPolicyProject = vi.fn(async () => {
			throw new Error("recipient_policy_reconciliation_step_conflict");
		});

		const first = await reconcileRecipientPolicyProjectsOperation(store, {
			now: new Date(NOW),
			backoffMs: 60_000,
			effects: unusedEffects(),
			reconcileProject,
		});
		const second = await reconcileRecipientPolicyProjectsOperation(store, {
			now: new Date(NOW),
			backoffMs: 60_000,
			effects: unusedEffects(),
			reconcileProject,
		});

		expect(first.failed).toBe(1);
		expect(second.processed).toBe(0);
		expect(reconcileProject).toHaveBeenCalledTimes(1);
		expect(
			db
				.prepare(
					`SELECT attempt_count, last_attempt_at, safe_error_code
					 FROM recipient_policy_authority_states WHERE canonical_project_identity = ?`,
				)
				.get(projectId),
		).toEqual({
			attempt_count: 1,
			last_attempt_at: NOW,
			safe_error_code: "recipient_policy_reconciliation_failed",
		});
	} finally {
		db.close();
	}
});

it("backs off an alias failure when only the legacy authority row exists", async () => {
	const db = new Database(":memory:");
	initTestSchema(db);
	const cwd = "/workspace/alias-only-failure";
	const repository = "https://example.test/acme/alias-only-failure.git";
	try {
		insertRecipient(db, cwd, 0);
		db.prepare(
			"INSERT INTO sessions(started_at, cwd, project, metadata_json) VALUES (?, ?, 'alias-only-failure', ?)",
		).run(NOW, cwd, JSON.stringify({ codemem_repository_identity: repository }));
		db.prepare(`INSERT INTO recipient_policy_authority_states(
			canonical_project_identity, authority_state, generation, state_changed_at, created_at, updated_at
		 ) VALUES (?, 'legacy', 0, ?, ?, ?)`).run(cwd, NOW, NOW, NOW);
		const store = { db, deviceId: "device-local" } as unknown as MemoryStore;
		const reconcileProject: typeof reconcileRecipientPolicyProject = vi.fn(async () => {
			throw new Error("recipient_policy_reconciliation_step_conflict");
		});
		const options = {
			now: new Date(NOW),
			backoffMs: 60_000,
			effects: unusedEffects(),
			reconcileProject,
		};
		const first = await reconcileRecipientPolicyProjectsOperation(store, options);
		const second = await reconcileRecipientPolicyProjectsOperation(store, options);
		expect(first.failed).toBe(1);
		expect(second.processed).toBe(0);
		expect(
			db
				.prepare(
					"SELECT attempt_count, last_attempt_at FROM recipient_policy_authority_states WHERE canonical_project_identity = ?",
				)
				.get(repository),
		).toMatchObject({ attempt_count: 1, last_attempt_at: NOW });
	} finally {
		db.close();
	}
});

it("continues maintenance after a busy reconciliation failure", async () => {
	const directory = mkdtempSync(join(tmpdir(), "codemem-maintenance-busy-"));
	const dbPath = join(directory, "state.sqlite");
	const db = new Database(dbPath);
	const blocker = new Database(dbPath);
	initTestSchema(db);
	db.pragma("busy_timeout = 10");
	let locked = false;
	try {
		insertRecipient(db, "a-busy", 0);
		insertRecipient(db, "b-next", 1);
		const store = { db, deviceId: "device-local" } as unknown as MemoryStore;
		const reconcileProject: typeof reconcileRecipientPolicyProject = vi.fn(async (_db, input) => {
			if (input.canonicalProjectIdentity === "a-busy") {
				blocker.exec("BEGIN EXCLUSIVE");
				locked = true;
				db.prepare(
					"UPDATE project_recipients SET updated_at = ? WHERE canonical_project_identity = ?",
				).run(NOW, "a-busy");
			}
			return {
				canonicalProjectIdentity: input.canonicalProjectIdentity,
				status: "waiting" as const,
				generation: 0,
				safeErrorCode: null,
				revokedDeviceIds: [],
				grantedDeviceIds: [],
				deliveredCopiesMayRemain: true as const,
				revocationWarning: "Delivered copies may remain.",
			};
		});
		const result = await reconcileRecipientPolicyProjectsOperation(store, {
			now: new Date(NOW),
			effects: unusedEffects(),
			reconcileProject,
		});
		expect(result).toMatchObject({ processed: 2, failed: 1, waiting: 1 });
		expect(result.items.map((item) => item.canonicalProjectIdentity)).toEqual(["a-busy", "b-next"]);
	} finally {
		if (locked) blocker.exec("ROLLBACK");
		blocker.close();
		db.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
