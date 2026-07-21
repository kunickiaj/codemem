import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	commitRecipientPolicyEdges,
	parseRecipientPolicyEdgeCommitRequest,
	parseRecipientPolicyEdgePreviewRequest,
	previewRecipientPolicyEdges,
	RecipientPolicyEdgeRequestError,
} from "./recipient-policy-edges.js";
import { listRecipientPolicyIntent } from "./recipient-policy-intent.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-07-21T12:00:00.000Z";
const PROJECT_A = "https://git.example.invalid/acme/alpha.git";
const PROJECT_B = "https://git.example.invalid/acme/beta.git";
const STALE_PROJECT = "https://git.example.invalid/acme/removed.git";

const openDatabases: Array<InstanceType<typeof Database>> = [];
const temporaryDirectories: string[] = [];

function createDb(): InstanceType<typeof Database> {
	const db = new Database(":memory:");
	initTestSchema(db);
	openDatabases.push(db);
	return db;
}

function insertActor(
	db: InstanceType<typeof Database>,
	identityId: string,
	displayName: string,
	status = "active",
): void {
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES (?, ?, 0, ?, ?, ?)`,
	).run(identityId, displayName, status, NOW, NOW);
}

function insertProject(
	db: InstanceType<typeof Database>,
	projectId: string,
	displayName: string,
	memoryCount = 1,
): void {
	const sessionId = Number(
		db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, git_remote, git_branch)
				 VALUES (?, ?, ?, ?, 'main')`,
			)
			.run(NOW, `/workspace/${displayName}`, displayName, projectId).lastInsertRowid,
	);
	for (let index = 0; index < memoryCount; index += 1) {
		db.prepare(
			`INSERT INTO memory_items(
			 session_id, kind, title, body_text, active, created_at, updated_at,
			 visibility, project, scope_id
			 ) VALUES (?, 'discovery', ?, 'body', 1, ?, ?, 'shared', ?, 'local-default')`,
		).run(sessionId, `${displayName}-${index}`, NOW, NOW, displayName);
	}
}

function insertDevice(
	db: InstanceType<typeof Database>,
	identityId: string,
	deviceId: string,
	displayName: string,
): void {
	db.prepare(
		`INSERT INTO identity_devices(
		 device_id, identity_id, display_name, status, provenance, revision,
		 migration_state, source_fingerprint, idempotency_key, created_at, updated_at
		 ) VALUES (?, ?, ?, 'active', 'user', ?, 'user_managed', NULL, ?, ?, ?)`,
	).run(deviceId, identityId, displayName, `revision-${deviceId}`, `key-${deviceId}`, NOW, NOW);
}

function insertTeam(
	db: InstanceType<typeof Database>,
	teamId: string,
	displayName: string,
	members: string[],
): void {
	db.prepare(
		`INSERT INTO policy_teams(
		 team_id, display_name, status, provenance, revision, migration_state,
		 source_fingerprint, idempotency_key, created_at, updated_at
		 ) VALUES (?, ?, 'active', 'user', ?, 'user_managed', NULL, ?, ?, ?)`,
	).run(teamId, displayName, `revision-${teamId}`, `key-${teamId}`, NOW, NOW);
	for (const identityId of members) {
		db.prepare(
			`INSERT INTO policy_team_memberships(
			 team_id, identity_id, role, status, provenance, revision, migration_state,
			 source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, 'member', 'active', 'user', ?, 'user_managed', NULL, ?, ?, ?)`,
		).run(
			teamId,
			identityId,
			`revision-${teamId}-${identityId}`,
			`key-${teamId}-${identityId}`,
			NOW,
			NOW,
		);
	}
}

function insertProjectRecipient(
	db: InstanceType<typeof Database>,
	projectId: string,
	recipientId: string,
	recipientKind: "identity" | "team" = "identity",
): void {
	db.prepare(
		`INSERT INTO project_recipients(
		 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
		 policy_revision, migration_state, idempotency_key, created_at, updated_at
		 ) VALUES (?, ?, ?, 'active', 'user', ?, 'user_managed', ?, ?, ?)`,
	).run(
		projectId,
		recipientKind,
		recipientId,
		`revision-${projectId}-${recipientKind}-${recipientId}`,
		`key-${projectId}-${recipientKind}-${recipientId}`,
		NOW,
		NOW,
	);
}

function seedGraph(): InstanceType<typeof Database> {
	const db = createDb();
	insertProject(db, PROJECT_A, "alpha", 2);
	insertProject(db, PROJECT_B, "beta", 1);
	insertActor(db, "identity-a", "Ada");
	insertActor(db, "identity-b", "Bea", "pending");
	insertActor(db, "identity-inactive", "Inactive", "deactivated");
	insertDevice(db, "identity-a", "device-a", "Ada laptop");
	insertDevice(db, "identity-b", "device-b", "Bea laptop");
	insertTeam(db, "team-a", "Core Team", ["identity-a", "identity-b"]);
	return db;
}

function identityChange(projectId: string, identityId: string, action: "add" | "remove" = "add") {
	return {
		canonicalProjectIdentity: projectId,
		recipient: { recipientKind: "identity" as const, identityId },
		action,
	};
}

function teamChange(projectId: string, teamId: string, action: "add" | "remove" = "add") {
	return {
		canonicalProjectIdentity: projectId,
		recipient: { recipientKind: "team" as const, teamId },
		action,
	};
}

function rowSnapshot(db: InstanceType<typeof Database>): unknown[] {
	return db
		.prepare(
			`SELECT canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 FROM project_recipients ORDER BY canonical_project_identity, recipient_kind, recipient_id`,
		)
		.all();
}

afterEach(() => {
	for (const db of openDatabases.splice(0)) db.close();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("recipient-policy edge changes", () => {
	it("strictly parses only the canonical direction-free request", () => {
		const valid = {
			version: 1,
			changes: [identityChange(PROJECT_A, "identity-a")],
		};
		expect(parseRecipientPolicyEdgePreviewRequest(valid)).toEqual(valid);
		expect(
			parseRecipientPolicyEdgeCommitRequest({
				...valid,
				reviewedPolicyDigest: `edge-preview-v1:${"0".repeat(64)}`,
			}),
		).not.toBeNull();
		expect(
			parseRecipientPolicyEdgeCommitRequest({
				...valid,
				reviewedPolicyDigest: "edge-preview-v1:not-a-digest",
			}),
		).toBeNull();

		for (const invalid of [
			{ ...valid, direction: "project-first" },
			{ ...valid, version: 2 },
			{ version: 1, changes: [] },
			{
				version: 1,
				changes: [
					identityChange(PROJECT_A, "identity-a"),
					identityChange(PROJECT_A, "identity-a", "remove"),
				],
			},
			{ version: 1, changes: [identityChange(` ${PROJECT_A}`, "identity-a")] },
			{ version: 1, changes: [identityChange(PROJECT_A, "identity-a\n")] },
			{
				version: 1,
				changes: [
					{
						...identityChange(PROJECT_A, "identity-a"),
						displayName: "alpha",
					},
				],
			},
		]) {
			expect(parseRecipientPolicyEdgePreviewRequest(invalid)).toBeNull();
		}
	});

	it("normalizes project-first and recipient-first ordering identically and writes identical rows", () => {
		const changes = [
			teamChange(PROJECT_B, "team-a"),
			identityChange(PROJECT_A, "identity-a"),
			teamChange(PROJECT_A, "team-a"),
		];
		const firstDb = seedGraph();
		const secondDb = seedGraph();
		const first = previewRecipientPolicyEdges(firstDb, { version: 1, changes });
		const second = previewRecipientPolicyEdges(secondDb, {
			version: 1,
			changes: changes.toReversed(),
		});
		expect(second).toEqual(first);

		expect(
			commitRecipientPolicyEdges(
				firstDb,
				{ version: 1, changes, reviewedPolicyDigest: first.reviewedPolicyDigest },
				{ now: () => NOW },
			),
		).toMatchObject({ status: "applied", writeCount: 3 });
		expect(
			commitRecipientPolicyEdges(
				secondDb,
				{
					version: 1,
					changes: changes.toReversed(),
					reviewedPolicyDigest: second.reviewedPolicyDigest,
				},
				{ now: () => NOW },
			),
		).toMatchObject({ status: "applied", writeCount: 3 });
		expect(rowSnapshot(secondDb)).toEqual(rowSnapshot(firstDb));
	});

	it("keeps preview read-only and rejects display names, unmapped identities, and inactive recipients", () => {
		const db = seedGraph();
		const before = Number(db.prepare("SELECT total_changes()").pluck().get());
		const preview = previewRecipientPolicyEdges(db, {
			version: 1,
			changes: [identityChange(PROJECT_A, "identity-a")],
		});
		expect(preview.projects).toEqual([
			{
				canonicalProjectIdentity: PROJECT_A,
				displayName: "alpha",
				existingMemoryCount: 2,
				futureMemoriesShared: true,
			},
		]);
		expect(Number(db.prepare("SELECT total_changes()").pluck().get())).toBe(before);
		expect(rowSnapshot(db)).toEqual([]);

		for (const change of [
			identityChange("alpha", "identity-a"),
			identityChange("unmapped:alpha", "identity-a"),
			identityChange(PROJECT_A, "identity-inactive"),
		]) {
			expect(() => previewRecipientPolicyEdges(db, { version: 1, changes: [change] })).toThrow(
				RecipientPolicyEdgeRequestError,
			);
		}
	});

	for (const staleStatus of ["merged", "deactivated"] as const) {
		it(`removes an exact active edge for a ${staleStatus} identity without weakening add validation`, () => {
			const db = seedGraph();
			insertActor(db, "identity-stale", "Stale recipient");
			insertActor(db, "identity-survivor", "Surviving recipient");
			insertProjectRecipient(db, PROJECT_A, "identity-stale");
			insertProjectRecipient(db, PROJECT_A, "identity-a");
			db.prepare(
				`UPDATE actors SET status = ?, merged_into_actor_id = ?, updated_at = ?
					 WHERE actor_id = 'identity-stale'`,
			).run(staleStatus, staleStatus === "merged" ? "identity-survivor" : null, NOW);

			const changes = [identityChange(PROJECT_A, "identity-stale", "remove")];
			const preview = previewRecipientPolicyEdges(db, { version: 1, changes });
			expect(preview).toMatchObject({
				selectedRecipients: [],
				removeCount: 1,
				netWriteCount: 1,
			});

			db.prepare(
				`UPDATE project_recipients SET status = 'revoked'
					 WHERE canonical_project_identity = ? AND recipient_id = 'identity-a'`,
			).run(PROJECT_A);
			const beforeStaleCommit = rowSnapshot(db);
			expect(
				commitRecipientPolicyEdges(db, {
					version: 1,
					changes,
					reviewedPolicyDigest: preview.reviewedPolicyDigest,
				}),
			).toMatchObject({ status: "stale", writeCount: 0 });
			expect(rowSnapshot(db)).toEqual(beforeStaleCommit);

			db.prepare(
				`UPDATE project_recipients SET status = 'active'
					 WHERE canonical_project_identity = ? AND recipient_id = 'identity-a'`,
			).run(PROJECT_A);
			const freshPreview = previewRecipientPolicyEdges(db, { version: 1, changes });
			expect(
				commitRecipientPolicyEdges(db, {
					version: 1,
					changes,
					reviewedPolicyDigest: freshPreview.reviewedPolicyDigest,
				}),
			).toMatchObject({
				status: "applied",
				writeCount: 1,
				outcomes: [{ outcome: "removed" }],
			});
			expect(
				db
					.prepare(
						`SELECT recipient_id, status FROM project_recipients
							 WHERE canonical_project_identity = ? ORDER BY recipient_id`,
					)
					.all(PROJECT_A),
			).toEqual([
				{ recipient_id: "identity-a", status: "active" },
				{ recipient_id: "identity-stale", status: "revoked" },
			]);

			expect(() =>
				previewRecipientPolicyEdges(db, {
					version: 1,
					changes: [identityChange(PROJECT_A, "identity-stale")],
				}),
			).toThrow(RecipientPolicyEdgeRequestError);
			expect(() =>
				previewRecipientPolicyEdges(db, {
					version: 1,
					changes: [identityChange(PROJECT_B, "identity-stale", "remove")],
				}),
			).toThrow(RecipientPolicyEdgeRequestError);
		});
	}

	it("removes an exact active edge for an archived Team without allowing stale additions", () => {
		const db = seedGraph();
		insertProjectRecipient(db, PROJECT_A, "team-a", "team");
		db.prepare("UPDATE policy_teams SET status = 'archived' WHERE team_id = 'team-a'").run();
		const changes = [teamChange(PROJECT_A, "team-a", "remove")];
		const preview = previewRecipientPolicyEdges(db, { version: 1, changes });
		expect(preview).toMatchObject({
			selectedRecipients: [],
			removeCount: 1,
			netWriteCount: 1,
		});

		expect(
			commitRecipientPolicyEdges(db, {
				version: 1,
				changes,
				reviewedPolicyDigest: preview.reviewedPolicyDigest,
			}),
		).toMatchObject({
			status: "applied",
			writeCount: 1,
			outcomes: [{ outcome: "removed" }],
		});
		expect(
			db
				.prepare(
					`SELECT status FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND recipient_id = 'team-a'`,
				)
				.pluck()
				.get(PROJECT_A),
		).toBe("revoked");
		expect(() =>
			previewRecipientPolicyEdges(db, {
				version: 1,
				changes: [teamChange(PROJECT_A, "team-a")],
			}),
		).toThrow(RecipientPolicyEdgeRequestError);
		expect(() =>
			previewRecipientPolicyEdges(db, {
				version: 1,
				changes: [teamChange(PROJECT_B, "team-a", "remove")],
			}),
		).toThrow(RecipientPolicyEdgeRequestError);
	});

	it("removes an exact active edge for a Project absent from current facts", () => {
		const db = seedGraph();
		insertProjectRecipient(db, STALE_PROJECT, "identity-a");
		const changes = [identityChange(STALE_PROJECT, "identity-a", "remove")];
		const preview = previewRecipientPolicyEdges(db, { version: 1, changes });

		expect(preview).toMatchObject({
			projects: [
				{
					canonicalProjectIdentity: STALE_PROJECT,
					displayName: STALE_PROJECT,
					existingMemoryCount: 0,
				},
			],
			removeCount: 1,
			netWriteCount: 1,
		});
		for (const rejected of [
			identityChange(STALE_PROJECT, "identity-a"),
			identityChange(STALE_PROJECT, "identity-b", "remove"),
		]) {
			expect(() => previewRecipientPolicyEdges(db, { version: 1, changes: [rejected] })).toThrow(
				RecipientPolicyEdgeRequestError,
			);
		}
		expect(
			commitRecipientPolicyEdges(db, {
				version: 1,
				changes,
				reviewedPolicyDigest: preview.reviewedPolicyDigest,
			}),
		).toMatchObject({
			status: "applied",
			writeCount: 1,
			outcomes: [{ outcome: "removed" }],
		});

		expect(() =>
			previewRecipientPolicyEdges(db, {
				version: 1,
				changes: [identityChange(STALE_PROJECT, "identity-a", "remove")],
			}),
		).toThrow(RecipientPolicyEdgeRequestError);
	});

	it("shows Team current members, future inheritance, and resulting effective devices", () => {
		const db = seedGraph();
		const preview = previewRecipientPolicyEdges(db, {
			version: 1,
			changes: [teamChange(PROJECT_A, "team-a")],
		});
		expect(preview.selectedRecipients).toEqual([
			{
				recipientKind: "team",
				teamId: "team-a",
				displayName: "Core Team",
				currentMembers: [
					{ identityId: "identity-a", displayName: "Ada", verification: "local" },
					{ identityId: "identity-b", displayName: "Bea", verification: "local" },
				],
				futureMembersInherit: true,
			},
		]);
		expect(preview.effectiveDevices).toEqual([
			{
				canonicalProjectIdentity: PROJECT_A,
				identityId: "identity-a",
				deviceId: "device-a",
				displayName: "Ada laptop",
			},
			{
				canonicalProjectIdentity: PROJECT_A,
				identityId: "identity-b",
				deviceId: "device-b",
				displayName: "Bea laptop",
			},
		]);
	});

	it("rejects stale digests after membership, device, memory, or other edge changes", () => {
		const mutations: Array<(db: InstanceType<typeof Database>) => void> = [
			(db) => {
				db.prepare(
					"UPDATE policy_team_memberships SET status = 'revoked' WHERE team_id = 'team-a' AND identity_id = 'identity-b'",
				).run();
			},
			(db) => {
				db.prepare(
					"UPDATE identity_devices SET status = 'revoked' WHERE device_id = 'device-b'",
				).run();
			},
			(db) => {
				const sessionId = Number(
					db.prepare("SELECT id FROM sessions WHERE git_remote = ?").pluck().get(PROJECT_A),
				);
				db.prepare(
					`INSERT INTO memory_items(
					 session_id, kind, title, body_text, active, created_at, updated_at, visibility, project, scope_id
					 ) VALUES (?, 'discovery', 'new', 'body', 1, ?, ?, 'shared', 'alpha', 'local-default')`,
				).run(sessionId, NOW, NOW);
			},
			(db) => {
				db.prepare(
					`INSERT INTO project_recipients(
					 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
					 policy_revision, migration_state, idempotency_key, created_at, updated_at
					 ) VALUES (?, 'identity', 'identity-b', 'active', 'user', 'other-revision',
					 'user_managed', 'other-edge', ?, ?)`,
				).run(PROJECT_A, NOW, NOW);
			},
		];
		for (const mutate of mutations) {
			const db = seedGraph();
			const changes = [teamChange(PROJECT_A, "team-a")];
			const preview = previewRecipientPolicyEdges(db, { version: 1, changes });
			mutate(db);
			const before = rowSnapshot(db);
			expect(
				commitRecipientPolicyEdges(db, {
					version: 1,
					changes,
					reviewedPolicyDigest: preview.reviewedPolicyDigest,
				}),
			).toMatchObject({ status: "stale", writeCount: 0 });
			expect(rowSnapshot(db)).toEqual(before);
		}
	});

	it("makes a second overlapping preview stale after the first commit changes desired edges", () => {
		const db = seedGraph();
		const identityChanges = [identityChange(PROJECT_A, "identity-a")];
		const teamChanges = [teamChange(PROJECT_A, "team-a")];
		const identityPreview = previewRecipientPolicyEdges(db, {
			version: 1,
			changes: identityChanges,
		});
		const teamPreview = previewRecipientPolicyEdges(db, { version: 1, changes: teamChanges });

		expect(
			commitRecipientPolicyEdges(db, {
				version: 1,
				changes: identityChanges,
				reviewedPolicyDigest: identityPreview.reviewedPolicyDigest,
			}),
		).toMatchObject({ status: "applied", writeCount: 1 });
		expect(
			commitRecipientPolicyEdges(db, {
				version: 1,
				changes: teamChanges,
				reviewedPolicyDigest: teamPreview.reviewedPolicyDigest,
			}),
		).toMatchObject({ status: "stale", writeCount: 0 });
		expect(rowSnapshot(db)).toHaveLength(1);
	});

	it("fails closed when another connection holds the write lock", () => {
		const directory = mkdtempSync(join(tmpdir(), "codemem-recipient-policy-edge-test-"));
		temporaryDirectories.push(directory);
		const path = join(directory, "policy.sqlite");
		const db = new Database(path);
		const competing = new Database(path);
		openDatabases.push(db, competing);
		initTestSchema(db);
		insertProject(db, PROJECT_A, "alpha", 1);
		insertActor(db, "identity-a", "Ada");
		const changes = [identityChange(PROJECT_A, "identity-a")];
		const preview = previewRecipientPolicyEdges(db, { version: 1, changes });
		db.pragma("busy_timeout = 1");
		competing.exec("BEGIN IMMEDIATE");

		expect(() =>
			commitRecipientPolicyEdges(db, {
				version: 1,
				changes,
				reviewedPolicyDigest: preview.reviewedPolicyDigest,
			}),
		).toThrow();
		expect(rowSnapshot(db)).toEqual([]);
		competing.exec("ROLLBACK");
	});

	it("adds, removes, preserves row identity metadata, and replays idempotently", () => {
		const db = seedGraph();
		const add = [identityChange(PROJECT_A, "identity-a")];
		const preview = previewRecipientPolicyEdges(db, { version: 1, changes: add });
		const applied = commitRecipientPolicyEdges(
			db,
			{ version: 1, changes: add, reviewedPolicyDigest: preview.reviewedPolicyDigest },
			{ now: () => NOW },
		);
		expect(applied).toMatchObject({
			status: "applied",
			writeCount: 1,
			idempotent: false,
			outcomes: [{ outcome: "added" }],
		});
		expect(listRecipientPolicyIntent(db).projectRecipients[0]).toMatchObject({
			intentSource: "user",
			status: "active",
		});
		const inserted = rowSnapshot(db)[0] as Record<string, unknown>;

		const replay = commitRecipientPolicyEdges(db, {
			version: 1,
			changes: add,
			reviewedPolicyDigest: preview.reviewedPolicyDigest,
		});
		expect(replay).toMatchObject({
			status: "applied",
			writeCount: 0,
			idempotent: true,
			outcomes: [{ outcome: "already_present" }],
		});

		const remove = [identityChange(PROJECT_A, "identity-a", "remove")];
		const removePreview = previewRecipientPolicyEdges(db, { version: 1, changes: remove });
		expect(
			commitRecipientPolicyEdges(
				db,
				{
					version: 1,
					changes: remove,
					reviewedPolicyDigest: removePreview.reviewedPolicyDigest,
				},
				{ now: () => "2026-07-21T13:00:00.000Z" },
			),
		).toMatchObject({ status: "applied", writeCount: 1, outcomes: [{ outcome: "removed" }] });
		const removed = rowSnapshot(db)[0] as Record<string, unknown>;
		expect(removed).toMatchObject({
			status: "revoked",
			created_at: inserted.created_at,
			idempotency_key: inserted.idempotency_key,
			provenance: "user",
			migration_state: "user_managed",
			source_fingerprint: null,
		});

		const absentPreview = previewRecipientPolicyEdges(db, { version: 1, changes: remove });
		expect(absentPreview.reviewedPolicyDigest).toBe(removePreview.reviewedPolicyDigest);
		expect(absentPreview.unchangedProjects).toEqual(absentPreview.projects);
		expect(
			commitRecipientPolicyEdges(db, {
				version: 1,
				changes: remove,
				reviewedPolicyDigest: removePreview.reviewedPolicyDigest,
			}),
		).toMatchObject({
			status: "applied",
			writeCount: 0,
			idempotent: true,
			outcomes: [{ outcome: "already_absent" }],
		});

		expect(
			commitRecipientPolicyEdges(
				db,
				{ version: 1, changes: add, reviewedPolicyDigest: preview.reviewedPolicyDigest },
				{ now: () => "2026-07-21T14:00:00.000Z" },
			),
		).toMatchObject({ status: "applied", writeCount: 1, outcomes: [{ outcome: "added" }] });
		const reactivated = rowSnapshot(db)[0] as Record<string, unknown>;
		expect(reactivated).toMatchObject({
			status: "active",
			created_at: inserted.created_at,
			idempotency_key: inserted.idempotency_key,
		});
	});

	it("rolls back the whole transaction and never mutates protected tables", () => {
		const db = seedGraph();
		const protectedTables = [
			"actors",
			"policy_teams",
			"policy_team_memberships",
			"identity_devices",
			"sessions",
			"memory_items",
			"replication_scopes",
			"project_scope_mappings",
			"scope_memberships",
			"sync_peers",
			"replication_ops",
			"replication_cursors",
			"share_operations",
		];
		const snapshot = () =>
			JSON.stringify(
				Object.fromEntries(
					protectedTables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()]),
				),
			);
		const before = snapshot();
		const changes = [
			identityChange(PROJECT_A, "identity-a"),
			identityChange(PROJECT_B, "identity-a"),
		];
		const preview = previewRecipientPolicyEdges(db, { version: 1, changes });
		db.exec(
			`CREATE TRIGGER fail_second_edge BEFORE INSERT ON project_recipients
			 WHEN NEW.canonical_project_identity = '${PROJECT_B}'
			 BEGIN SELECT RAISE(ABORT, 'test conflict'); END`,
		);
		expect(
			commitRecipientPolicyEdges(db, {
				version: 1,
				changes,
				reviewedPolicyDigest: preview.reviewedPolicyDigest,
			}),
		).toMatchObject({ status: "conflict", writeCount: 0 });
		expect(rowSnapshot(db)).toEqual([]);
		expect(snapshot()).toBe(before);
	});
});
