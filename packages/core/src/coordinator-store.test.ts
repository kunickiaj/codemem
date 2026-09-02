import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import {
	COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES,
	COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_RECORDS,
	type CoordinatorLegacyTeamCompletionManifestV1,
} from "./coordinator-legacy-team-completion.js";
import { runCoordinatorStoreContract } from "./coordinator-store-test-harness.js";
import {
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
} from "./recipient-policy-identifiers.js";

function legacyTeamCompletion(): CoordinatorLegacyTeamCompletionManifestV1 {
	const candidateRef = legacyTeamCandidateId("coord-a", "g1");
	return {
		version: 1,
		coordinator_id: "coord-a",
		candidate_ref: candidateRef,
		candidate_digest: "a".repeat(64),
		team_id: deterministicPolicyTeamId(candidateRef),
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Core Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: "identity-a", role: "member" }],
		device_decisions: [
			{
				device_id: "device-a",
				key_fingerprint: "1".repeat(64),
				enabled: true,
				identity_id: "identity-a",
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: "2026-09-01T00:00:00.000Z",
	};
}

describe("CoordinatorStore", () => {
	function setupStore() {
		const tmpDir = mkdtempSync(join(tmpdir(), "coord-test-"));
		const store = new BetterSqliteCoordinatorStore(join(tmpDir, "coordinator.sqlite"));
		return {
			store,
			clearInviteReviewedIntent: (inviteId: string) => {
				store.db
					.prepare("UPDATE coordinator_invites SET reviewed_intent_json = NULL WHERE invite_id = ?")
					.run(inviteId);
			},
			setInviteAssignedIdentity: (inviteId: string, identityId: string | null) => {
				store.db
					.prepare("UPDATE coordinator_invites SET assigned_identity_id = ? WHERE invite_id = ?")
					.run(identityId, inviteId);
			},
			setEnrollmentIdentity: (groupId: string, deviceId: string, identityId: string | null) => {
				store.db
					.prepare(
						"UPDATE enrolled_devices SET identity_id = ? WHERE group_id = ? AND device_id = ?",
					)
					.run(identityId, groupId, deviceId);
			},
			revokeInvite: (inviteId: string, revokedAt: string) => {
				store.db
					.prepare("UPDATE coordinator_invites SET revoked_at = ? WHERE invite_id = ?")
					.run(revokedAt, inviteId);
			},
			cleanup: async () => {
				await store.close();
				rmSync(tmpDir, { recursive: true, force: true });
			},
		};
	}

	it("does not publish a completion after its group is archived concurrently", async () => {
		const { store, cleanup } = setupStore();
		try {
			await store.createGroup("g1");
			const getGroup = store.getGroup.bind(store);
			let archived = false;
			store.getGroup = async (groupId) => {
				const group = await getGroup(groupId);
				if (!archived) {
					archived = true;
					await store.archiveGroup(groupId);
				}
				return group;
			};
			const manifest = legacyTeamCompletion();

			await expect(store.createLegacyTeamCompletion("g1", manifest)).rejects.toThrow(
				"group_archived",
			);
			expect(await store.getLegacyTeamCompletion("g1", manifest.candidate_ref)).toBeNull();
		} finally {
			await cleanup();
		}
	});

	it("does not publish a completion when the SQLite enrollment roster changes before insert", async () => {
		const { store, cleanup } = setupStore();
		try {
			await store.createGroup("g1");
			await store.enrollDevice("g1", {
				deviceId: "device-a",
				fingerprint: "1".repeat(64),
				publicKey: "device-a-public-key",
			});
			const getGroup = store.getGroup.bind(store);
			let enrollmentAdded = false;
			store.getGroup = async (groupId) => {
				const group = await getGroup(groupId);
				if (!enrollmentAdded) {
					enrollmentAdded = true;
					await store.enrollDevice(groupId, {
						deviceId: "device-b",
						fingerprint: "2".repeat(64),
						publicKey: "device-b-public-key",
					});
				}
				return group;
			};
			const manifest = legacyTeamCompletion();

			await expect(store.createLegacyTeamCompletion("g1", manifest)).rejects.toThrow(
				"completion_manifest_unavailable",
			);
			expect(await store.getLegacyTeamCompletion("g1", manifest.candidate_ref)).toBeNull();
		} finally {
			await cleanup();
		}
	});

	describe("schema", () => {
		it("adds nullable enrollment identity binding while preserving pre-column rows", async () => {
			// Arrange
			const tmpDir = mkdtempSync(join(tmpdir(), "coord-enrollment-identity-upgrade-test-"));
			const path = join(tmpDir, "coordinator.sqlite");
			const legacy = new Database(path);
			legacy.exec(`
				CREATE TABLE enrolled_devices (
					group_id TEXT NOT NULL,
					device_id TEXT NOT NULL,
					public_key TEXT NOT NULL,
					fingerprint TEXT NOT NULL,
					display_name TEXT,
					enabled INTEGER NOT NULL DEFAULT 1,
					created_at TEXT NOT NULL,
					PRIMARY KEY (group_id, device_id)
				);
				INSERT INTO enrolled_devices(
					group_id, device_id, public_key, fingerprint, display_name, enabled, created_at
				) VALUES (
					'g1', 'legacy-device', 'legacy-key', 'legacy-fingerprint', 'Legacy device', 1,
					'2026-07-24T00:00:00Z'
				);
			`);
			legacy.close();

			// Act
			const store = new BetterSqliteCoordinatorStore(path);

			try {
				// Assert
				const columns = store.db.prepare("PRAGMA table_info(enrolled_devices)").all() as Array<{
					name: string;
				}>;
				expect(columns.map((column) => column.name)).toContain("identity_id");
				expect(
					store.db
						.prepare(
							"SELECT device_id, identity_id FROM enrolled_devices WHERE device_id = 'legacy-device'",
						)
						.get(),
				).toEqual({ device_id: "legacy-device", identity_id: null });
			} finally {
				await store.close();
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("upgrades an existing project-intent invite table additively", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "coord-upgrade-test-"));
			const path = join(tmpDir, "coordinator.sqlite");
			const legacy = new Database(path);
			legacy.exec(`
				CREATE TABLE coordinator_invites (
					invite_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
					policy TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
					created_by TEXT, team_name_snapshot TEXT, revoked_at TEXT, operation_id TEXT,
					reviewed_project_set_digest TEXT
				);
				INSERT INTO coordinator_invites(invite_id, group_id, token, policy, expires_at, created_at)
				VALUES ('legacy', 'g1', 'token', 'auto_admit', '2099-01-01T00:00:00Z',
					'2026-07-20T00:00:00Z');
			`);
			legacy.close();
			const store = new BetterSqliteCoordinatorStore(path);
			try {
				const row = store.db
					.prepare(
						`SELECT token, token_digest, consumed_at, bound_device_id, trust_state,
							invite_kind, policy_team_id, target_identity_id, assigned_identity_id,
							reviewed_preview_digest,
							reviewed_intent_json
						 FROM coordinator_invites`,
					)
					.get();
				expect(row).toEqual({
					token: "token",
					token_digest: null,
					consumed_at: null,
					bound_device_id: null,
					trust_state: null,
					invite_kind: "legacy_enrollment",
					policy_team_id: null,
					target_identity_id: null,
					assigned_identity_id: null,
					reviewed_preview_digest: null,
					reviewed_intent_json: null,
				});
			} finally {
				await store.close();
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});

		it("creates all expected tables", async () => {
			const { store, cleanup } = setupStore();
			try {
				const tables = store.db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
					)
					.all() as { name: string }[];
				const names = tables.map((t) => t.name).sort();
				expect(names).toEqual([
					"coordinator_bootstrap_grants",
					"coordinator_invites",
					"coordinator_join_requests",
					"coordinator_legacy_team_completions",
					"coordinator_reciprocal_approvals",
					"coordinator_scope_membership_audit_log",
					"coordinator_scope_membership_effect_receipts",
					"coordinator_scope_memberships",
					"coordinator_scopes",
					"enrolled_devices",
					"groups",
					"presence_records",
					"request_nonces",
				]);
			} finally {
				await cleanup();
			}
		});

		it("backfills project invite columns before creating their index", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "coord-upgrade-test-"));
			const dbPath = join(tmpDir, "coordinator.sqlite");
			const legacy = new Database(dbPath);
			legacy.exec(`CREATE TABLE coordinator_invites (
				invite_id TEXT PRIMARY KEY,
				group_id TEXT NOT NULL,
				token TEXT NOT NULL UNIQUE,
				policy TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				created_at TEXT NOT NULL,
				created_by TEXT,
				team_name_snapshot TEXT,
				revoked_at TEXT
			)`);
			legacy.close();

			const store = new BetterSqliteCoordinatorStore(dbPath);
			try {
				const columns = store.db.prepare("PRAGMA table_info(coordinator_invites)").all() as Array<{
					name: string;
				}>;
				expect(columns.map((column) => column.name)).toEqual(
					expect.arrayContaining([
						"operation_id",
						"reviewed_project_set_digest",
						"reviewed_intent_json",
					]),
				);
				expect(
					store.db
						.prepare(
							"SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_coordinator_invites_operation_id'",
						)
						.pluck()
						.get(),
				).toBe("idx_coordinator_invites_operation_id");
			} finally {
				await store.close();
				rmSync(tmpDir, { recursive: true, force: true });
			}
		});
	});

	describe("legacy Team completion list bounds", () => {
		it("rejects oversized manifests before returning completion rows", async () => {
			const { store, cleanup } = setupStore();
			try {
				await store.createGroup("g1");
				store.db
					.prepare(`INSERT INTO coordinator_legacy_team_completions(
						group_id, candidate_ref, manifest_version, manifest_json, completed_at, created_at
					) VALUES (?, ?, 1, ?, ?, ?)`)
					.run(
						"g1",
						"legacy-team-candidate:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						"x".repeat(COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES + 1),
						"2026-09-01T00:00:00.000Z",
						"2026-09-01T00:00:00.000Z",
					);

				await expect(store.listLegacyTeamCompletions(["g1"])).rejects.toThrow(
					"completion_results_too_large",
				);
			} finally {
				await cleanup();
			}
		});

		it("preserves detection of more than 500 completion records", async () => {
			const { store, cleanup } = setupStore();
			try {
				await store.createGroup("g1");
				const insert = store.db.prepare(`INSERT INTO coordinator_legacy_team_completions(
					group_id, candidate_ref, manifest_version, manifest_json, completed_at, created_at
				) VALUES (?, ?, 1, '{}', ?, ?)`);
				store.db.transaction(() => {
					for (let index = 0; index <= COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_RECORDS; index += 1) {
						insert.run(
							"g1",
							`legacy-team-candidate:${index.toString(16).padStart(32, "0")}`,
							"2026-09-01T00:00:00.000Z",
							"2026-09-01T00:00:00.000Z",
						);
					}
				})();

				await expect(store.listLegacyTeamCompletions(["g1"])).rejects.toThrow(
					"completion_results_too_large",
				);
			} finally {
				await cleanup();
			}
		});
	});

	runCoordinatorStoreContract("contract", setupStore);
});
