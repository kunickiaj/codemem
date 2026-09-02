import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listLegacyRecipientPolicyProjections } from "./legacy-recipient-policy-projection.js";
import {
	compareCodepoints,
	deterministicPolicyTeamId,
	legacyRecipientPolicyDigest,
} from "./recipient-policy-identifiers.js";
import { listRecipientPolicyIntent } from "./recipient-policy-intent.js";
import {
	assertAllowedRecipientPolicyIntentRow,
	migrateRecipientPolicyIntent,
} from "./recipient-policy-migration.js";
import {
	listRecipientPolicyReview,
	resolveRecipientPolicyReview,
} from "./recipient-policy-review.js";
import { shareProjectSetDigest } from "./share-operation.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-07-21T12:00:00.000Z";
const LOCAL_ACTOR_ID = "identity-personal";
const LOCAL_DEVICE_ID = "device-local";
const context = {
	localActorId: LOCAL_ACTOR_ID,
	localDeviceId: LOCAL_DEVICE_ID,
	now: () => NOW,
};

function insertActor(
	db: InstanceType<typeof Database>,
	actorId: string,
	displayName: string,
	isLocal = false,
): void {
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES (?, ?, ?, 'active', ?, ?)`,
	).run(actorId, displayName, isLocal ? 1 : 0, NOW, NOW);
}

function insertProject(
	db: InstanceType<typeof Database>,
	input: { projectId: string; displayName: string; scopeId?: string },
): void {
	const sessionId = Number(
		db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, git_remote, git_branch)
				 VALUES (?, ?, ?, ?, 'main')`,
			)
			.run(NOW, `/workspace/${input.displayName}`, input.displayName, input.projectId)
			.lastInsertRowid,
	);
	db.prepare(
		`INSERT INTO memory_items(
			session_id, kind, title, body_text, active, created_at, updated_at,
			visibility, project, scope_id
		 ) VALUES (?, 'discovery', ?, 'body', 1, ?, ?, 'shared', ?, ?)`,
	).run(
		sessionId,
		input.displayName,
		NOW,
		NOW,
		input.displayName,
		input.scopeId ?? "local-default",
	);
}

function insertScope(
	db: InstanceType<typeof Database>,
	input: {
		scopeId: string;
		projectId: string;
		kind?: string;
		label?: string;
		coordinatorId?: string | null;
		groupId?: string | null;
	},
): void {
	db.prepare(
		`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id,
			membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?)`,
	).run(
		input.scopeId,
		input.label ?? input.scopeId,
		input.kind ?? "managed_project",
		input.coordinatorId ? "coordinator" : "local",
		input.coordinatorId ?? null,
		input.groupId ?? null,
		NOW,
		NOW,
	);
	db.prepare(
		`INSERT INTO project_scope_mappings(
			workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
		 ) VALUES (?, ?, ?, 1000, 'test', ?, ?)`,
	).run(input.projectId, input.projectId, input.scopeId, NOW, NOW);
}

function assignDevice(
	db: InstanceType<typeof Database>,
	input: { scopeId: string; deviceId: string; actorId: string; displayName?: string },
): void {
	db.prepare(
		`INSERT INTO sync_peers(peer_device_id, name, actor_id, addresses_json, created_at)
		 VALUES (?, ?, ?, '["private-address"]', ?)`,
	).run(input.deviceId, input.displayName ?? input.deviceId, input.actorId, NOW);
	db.prepare(
		`INSERT INTO scope_memberships(
			scope_id, device_id, role, status, membership_epoch, updated_at
		 ) VALUES (?, ?, 'member', 'active', 1, ?)`,
	).run(input.scopeId, input.deviceId, NOW);
}

function insertLinkedOperation(
	db: InstanceType<typeof Database>,
	input: {
		operationId: string;
		projectId: string;
		displayName: string;
		recipientActorId: string;
		recipientDeviceId?: string;
		digestOverride?: string;
		inviterActorId?: string;
		accepted?: boolean;
	},
): void {
	const projects = [
		{
			canonicalIdentity: input.projectId,
			displayName: input.displayName,
			identitySource: "git_remote",
			existingMemoryCount: 1,
		},
	];
	const reviewedDigest = input.digestOverride ?? shareProjectSetDigest(projects);
	db.prepare(
		`INSERT INTO share_operations(
			operation_id, state, inviter_actor_id, inviter_device_ids_json, person_id,
			person_kind, teammate_name, history_policy, reviewed_project_set_digest,
			coordinator_group_id, invite_token_digest, invite_expires_at,
			recipient_actor_id, recipient_device_id, acceptance_consumed_at, created_at, updated_at
		 ) VALUES (?, 'active', ?, ?, ?, 'existing', ?, 'existing_and_future', ?,
			'coordinator-group-only', ?, '2099-01-01T00:00:00.000Z', ?, ?, ?, ?, ?)`,
	).run(
		input.operationId,
		input.inviterActorId ?? LOCAL_ACTOR_ID,
		JSON.stringify([LOCAL_DEVICE_ID]),
		input.recipientActorId,
		input.recipientActorId,
		reviewedDigest,
		`invite-${input.operationId}`,
		input.recipientActorId,
		input.recipientDeviceId ?? `device-${input.recipientActorId}`,
		input.accepted === false ? null : NOW,
		NOW,
		NOW,
	);
	db.prepare(
		`INSERT INTO share_operation_projects(
			operation_id, canonical_project_identity, display_name, identity_source,
			existing_memory_count, ordinal
		 ) VALUES (?, ?, ?, 'git_remote', 1, 0)`,
	).run(input.operationId, input.projectId, input.displayName);
}

function protectedSnapshot(db: InstanceType<typeof Database>): string {
	const tables = [
		"replication_scopes",
		"project_scope_mappings",
		"scope_memberships",
		"memory_items",
		"replication_ops",
		"replication_cursors",
		"sync_peers",
		"share_operations",
		"share_operation_projects",
	];
	return JSON.stringify(
		Object.fromEntries(
			tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
		),
	);
}

function initializeMigrationDb(db: InstanceType<typeof Database>): void {
	initTestSchema(db);
	insertActor(db, LOCAL_ACTOR_ID, "Personal", true);
	db.prepare(
		`INSERT INTO sync_device(device_id, public_key, fingerprint, created_at)
		 VALUES (?, 'local-key', 'transport-fingerprint', ?)`,
	).run(LOCAL_DEVICE_ID, NOW);
}

describe("recipient policy intent migration", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initializeMigrationDb(db);
	});

	afterEach(() => db.close());

	function exactFixture(input?: {
		projectId?: string;
		displayName?: string;
		recipientActorId?: string;
		digestOverride?: string;
		targetDb?: InstanceType<typeof Database>;
	}): { projectId: string; recipientActorId: string; deviceId: string } {
		const targetDb = input?.targetDb ?? db;
		const projectId = input?.projectId ?? "https://git.example.invalid/acme/api.git";
		const displayName = input?.displayName ?? "api";
		const recipientActorId = input?.recipientActorId ?? "identity-work";
		const scopeId = `scope-${recipientActorId}`;
		const deviceId = `device-${recipientActorId}`;
		if (!targetDb.prepare("SELECT 1 FROM actors WHERE actor_id = ?").get(recipientActorId)) {
			insertActor(
				targetDb,
				recipientActorId,
				recipientActorId === "identity-work" ? "Work" : "Recipient",
			);
		}
		insertProject(targetDb, { projectId, displayName, scopeId });
		insertScope(targetDb, { scopeId, projectId });
		assignDevice(targetDb, {
			scopeId,
			deviceId,
			actorId: recipientActorId,
			displayName: "Work laptop",
		});
		insertLinkedOperation(targetDb, {
			operationId: `operation-${scopeId}`,
			projectId,
			displayName,
			recipientActorId,
			digestOverride: input?.digestOverride,
		});
		return { projectId, recipientActorId, deviceId };
	}

	function reviewDeviceFixture(input: {
		projectId: string;
		displayName: string;
		unassignedDeviceId: string;
		recipientActorId?: string;
	}): { projectId: string; recipientActorId: string; unassignedDeviceId: string } {
		const recipientActorId = input.recipientActorId ?? "identity-review-recipient";
		const scopeId = `scope-${recipientActorId}`;
		if (!db.prepare("SELECT 1 FROM actors WHERE actor_id = ?").get(recipientActorId)) {
			insertActor(db, recipientActorId, "Review recipient");
		}
		insertProject(db, {
			projectId: input.projectId,
			displayName: input.displayName,
			scopeId,
		});
		insertScope(db, { scopeId, projectId: input.projectId });
		assignDevice(db, {
			scopeId,
			deviceId: `device-${recipientActorId}`,
			actorId: recipientActorId,
			displayName: "Assigned laptop",
		});
		if (
			!db.prepare("SELECT 1 FROM sync_peers WHERE peer_device_id = ?").get(input.unassignedDeviceId)
		) {
			db.prepare(
				`INSERT INTO sync_peers(peer_device_id, name, actor_id, created_at)
				 VALUES (?, 'Unassigned laptop', NULL, ?)`,
			).run(input.unassignedDeviceId, NOW);
		}
		db.prepare(
			`INSERT INTO scope_memberships(scope_id, device_id, status, membership_epoch, updated_at)
			 VALUES (?, ?, 'active', 1, ?)`,
		).run(scopeId, input.unassignedDeviceId, NOW);
		return {
			projectId: input.projectId,
			recipientActorId,
			unassignedDeviceId: input.unassignedDeviceId,
		};
	}

	function resolvedAttachFixture(input?: { projectId?: string; deviceId?: string }): {
		projectId: string;
		recipientActorId: string;
		deviceId: string;
		sourceFingerprint: string;
	} {
		const fixture = reviewDeviceFixture({
			projectId: input?.projectId ?? "https://git.example.invalid/acme/evidence.git",
			displayName: "evidence",
			unassignedDeviceId: input?.deviceId ?? "device-evidence",
		});
		const item = listRecipientPolicyReview(db, context).reviewItems.find((candidate) =>
			candidate.options.some((option) => option.decision === "attach_device_to_identity"),
		);
		if (!item) throw new Error("attach-device review item missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "attach_device_to_identity",
			decisionInput: {
				deviceId: fixture.unassignedDeviceId,
				identityId: fixture.recipientActorId,
			},
		});
		return {
			projectId: fixture.projectId,
			recipientActorId: fixture.recipientActorId,
			deviceId: fixture.unassignedDeviceId,
			sourceFingerprint: item.sourceFingerprint,
		};
	}

	it("revalidates exact operation digests, writes direct intent, and replays idempotently", () => {
		const fixture = exactFixture();
		const protectedBefore = protectedSnapshot(db);
		const actorsBefore = JSON.stringify(db.prepare("SELECT * FROM actors ORDER BY actor_id").all());

		const first = migrateRecipientPolicyIntent(db, context);
		const second = migrateRecipientPolicyIntent(db, context);
		const intent = listRecipientPolicyIntent(db);

		expect(first.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				status: "migrated",
			}),
		);
		expect(second.results).toContainEqual(
			expect.objectContaining({ status: "unchanged", idempotent: true, writeCount: 0 }),
		);
		expect(intent.projectRecipients).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				recipientKind: "identity",
				identityId: fixture.recipientActorId,
			}),
		);
		expect(intent.identityDevices).toContainEqual(
			expect.objectContaining({
				deviceId: fixture.deviceId,
				identityId: fixture.recipientActorId,
			}),
		);
		expect(protectedSnapshot(db)).toBe(protectedBefore);
		expect(JSON.stringify(db.prepare("SELECT * FROM actors ORDER BY actor_id").all())).toBe(
			actorsBefore,
		);
	});

	it("applies fingerprint-bound attach-device intent without automatic operation evidence", () => {
		const fixture = reviewDeviceFixture({
			projectId: "https://git.example.invalid/acme/attach-device.git",
			displayName: "attach-device",
			unassignedDeviceId: "device-unassigned",
		});
		const protectedBefore = protectedSnapshot(db);
		const item = listRecipientPolicyReview(db, context).reviewItems.find((candidate) =>
			candidate.options.some((option) => option.decision === "attach_device_to_identity"),
		);
		if (!item) throw new Error("attach-device review item missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "attach_device_to_identity",
			decisionInput: {
				deviceId: fixture.unassignedDeviceId,
				identityId: fixture.recipientActorId,
			},
		});

		const first = migrateRecipientPolicyIntent(db, context);
		const retry = migrateRecipientPolicyIntent(db, context);
		const intent = listRecipientPolicyIntent(db);
		const recipientMetadata = db
			.prepare(
				`SELECT provenance, source_fingerprint FROM project_recipients
				 WHERE canonical_project_identity = ? AND recipient_kind = 'identity' AND recipient_id = ?`,
			)
			.get(fixture.projectId, fixture.recipientActorId);

		expect(db.prepare("SELECT COUNT(*) FROM share_operations").pluck().get()).toBe(0);
		expect(first.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				status: "migrated",
			}),
		);
		expect(retry.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				status: "unchanged",
				writeCount: 0,
				idempotent: true,
			}),
		);
		expect(intent.identityDevices).toContainEqual(
			expect.objectContaining({
				deviceId: fixture.unassignedDeviceId,
				identityId: fixture.recipientActorId,
			}),
		);
		expect(intent.projectRecipients).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				identityId: fixture.recipientActorId,
			}),
		);
		expect(recipientMetadata).toEqual({
			provenance: "review_resolution",
			source_fingerprint: item.sourceFingerprint,
		});
		expect(protectedSnapshot(db)).toBe(protectedBefore);
	});

	it("blocks a digest mismatch without a partial graph write", () => {
		const fixture = exactFixture({ digestOverride: "not-the-reviewed-digest" });

		const result = migrateRecipientPolicyIntent(db, context);

		expect(result.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				status: "blocked",
				errorCode: "reviewed_project_set_digest_mismatch",
			}),
		);
		expect(db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
	});

	it("ignores non-local and unaccepted operations when applying valid exact-project evidence", () => {
		const fixture = exactFixture();
		for (const operation of [
			{ operationId: "operation-non-local", inviterActorId: "identity-other" },
			{ operationId: "operation-unaccepted", accepted: false },
		]) {
			insertLinkedOperation(db, {
				...operation,
				projectId: fixture.projectId,
				displayName: "api",
				recipientActorId: fixture.recipientActorId,
				digestOverride: "invalid-ignored-digest",
			});
		}

		const result = migrateRecipientPolicyIntent(db, context);

		expect(result.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				status: "migrated",
				errorCode: null,
			}),
		);
		expect(listRecipientPolicyIntent(db).projectRecipients).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				identityId: fixture.recipientActorId,
			}),
		);
	});

	it("performs no writes in dry-run mode", () => {
		exactFixture();
		const before = protectedSnapshot(db);

		const result = migrateRecipientPolicyIntent(db, context, { dryRun: true });

		expect(result.dryRun).toBe(true);
		expect(result.results).toContainEqual(
			expect.objectContaining({ status: "would_migrate", writeCount: 0, idempotent: false }),
		);
		expect(db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
		expect(protectedSnapshot(db)).toBe(before);
	});

	it("acquires immediate write authority before its first migration read", () => {
		// Arrange: intercept the first read and synchronously attempt a write from another connection.
		const directory = mkdtempSync(join(tmpdir(), "codemem-recipient-policy-migration-"));
		const path = join(directory, "migration.sqlite");
		const primary = new Database(path);
		const competing = new Database(path);
		let competingError: unknown;
		let attempted = false;
		let firstPreparedSql: string | null = null;
		try {
			initializeMigrationDb(primary);
			const fixture = exactFixture({ targetDb: primary });
			competing.pragma("busy_timeout = 1");
			const prepare = primary.prepare.bind(primary);
			primary.prepare = ((sql: string) => {
				if (!attempted) {
					attempted = true;
					firstPreparedSql = sql;
					try {
						competing
							.prepare("UPDATE share_operations SET reviewed_project_set_digest = 'tampered'")
							.run();
					} catch (error) {
						competingError = error;
					}
				}
				return prepare(sql);
			}) as typeof primary.prepare;

			// Act
			const result = migrateRecipientPolicyIntent(primary, context);

			// Assert: the contender observed the lock before any projection/evidence read ran.
			expect(attempted).toBe(true);
			expect(firstPreparedSql?.trimStart()).toMatch(/^SELECT/u);
			expect(competingError).toMatchObject({ code: "SQLITE_BUSY" });
			expect(result.results).toContainEqual(
				expect.objectContaining({
					canonicalProjectIdentity: fixture.projectId,
					status: "migrated",
				}),
			);
		} finally {
			primary.close();
			competing.close();
			rmSync(directory, { force: true, recursive: true });
		}
	});

	it("keeps dry-run on a read transaction without taking writer authority", () => {
		// Arrange
		const directory = mkdtempSync(join(tmpdir(), "codemem-recipient-policy-dry-run-"));
		const path = join(directory, "migration.sqlite");
		const primary = new Database(path);
		const competing = new Database(path);
		let competingError: unknown;
		let attempted = false;
		let firstPreparedSql: string | null = null;
		try {
			initializeMigrationDb(primary);
			exactFixture({ targetDb: primary });
			competing.pragma("busy_timeout = 1");
			const prepare = primary.prepare.bind(primary);
			primary.prepare = ((sql: string) => {
				if (!attempted) {
					attempted = true;
					firstPreparedSql = sql;
					try {
						competing.prepare("UPDATE share_operations SET updated_at = '2026-07-22'").run();
					} catch (error) {
						competingError = error;
					}
				}
				return prepare(sql);
			}) as typeof primary.prepare;

			// Act
			const result = migrateRecipientPolicyIntent(primary, context, { dryRun: true });

			// Assert
			expect(attempted).toBe(true);
			expect(firstPreparedSql?.trimStart()).toMatch(/^SELECT/u);
			expect(competingError).toBeUndefined();
			expect(result.results).toContainEqual(
				expect.objectContaining({ status: "would_migrate", writeCount: 0 }),
			);
			expect(primary.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
		} finally {
			primary.close();
			competing.close();
			rmSync(directory, { force: true, recursive: true });
		}
	});

	it("fails closed when one device is already assigned to another Identity", () => {
		const fixture = exactFixture();
		const metadata = {
			revision: "existing-revision",
			idempotency: "existing-idempotency",
		};
		db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, 'Conflicting device', 'active', 'user', ?, 'projected', NULL, ?, ?, ?)`,
		).run(fixture.deviceId, LOCAL_ACTOR_ID, metadata.revision, metadata.idempotency, NOW, NOW);

		const result = migrateRecipientPolicyIntent(db, context);

		expect(result.results).toContainEqual(
			expect.objectContaining({ status: "blocked", errorCode: "device_identity_conflict" }),
		);
		expect(db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
	});

	it("rolls back one conflicting Project savepoint while another Project commits", () => {
		// Arrange
		const blocked = resolvedAttachFixture({
			projectId: "https://git.example.invalid/acme/a-blocked.git",
			deviceId: "device-project-rollback",
		});
		const committed = exactFixture({
			projectId: "https://git.example.invalid/acme/z-committed.git",
			displayName: "committed",
			recipientActorId: "identity-committed",
		});
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity', ?, 'revoked', 'tampered', 'tampered', 'projected', ?,
			 'tampered', ?, ?)`,
		).run(blocked.projectId, blocked.recipientActorId, blocked.sourceFingerprint, NOW, NOW);

		// Act
		const result = migrateRecipientPolicyIntent(db, context);

		// Assert: identity-device was staged before the conflicting recipient and must be gone.
		expect(result.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					canonicalProjectIdentity: blocked.projectId,
					status: "blocked",
					errorCode: "intent_conflict",
				}),
				expect.objectContaining({
					canonicalProjectIdentity: committed.projectId,
					status: "migrated",
				}),
			]),
		);
		expect(
			db.prepare("SELECT 1 FROM identity_devices WHERE device_id = ?").get(blocked.deviceId),
		).toBeUndefined();
		expect(
			db
				.prepare(
					`SELECT 1 FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_id = ? AND status = 'active'`,
				)
				.get(committed.projectId, committed.recipientActorId),
		).toBeDefined();
	});

	it("rolls back all pending Projects when SQLite aborts the outer transaction", () => {
		// Arrange
		const first = exactFixture({
			projectId: "https://git.example.invalid/acme/a-first.git",
			displayName: "a-first",
			recipientActorId: "identity-first",
		});
		const aborting = exactFixture({
			projectId: "https://git.example.invalid/acme/m-aborting.git",
			displayName: "m-aborting",
			recipientActorId: "identity-aborting",
		});
		const later = exactFixture({
			projectId: "https://git.example.invalid/acme/z-later.git",
			displayName: "z-later",
			recipientActorId: "identity-later",
		});
		expect(
			listLegacyRecipientPolicyProjections(db, context).map(
				(projection) => projection.project.canonicalIdentity,
			),
		).toEqual([first.projectId, aborting.projectId, later.projectId]);
		db.exec(`CREATE TRIGGER abort_recipient_policy_migration
			BEFORE INSERT ON project_recipients
			WHEN NEW.canonical_project_identity = '${aborting.projectId}'
			BEGIN
				SELECT RAISE(ROLLBACK, 'forced_outer_abort');
			END`);

		// Act
		const migrate = () => migrateRecipientPolicyIntent(db, context);

		// Assert
		expect(migrate).toThrow("forced_outer_abort");
		expect(db.inTransaction).toBe(false);
		expect(
			db
				.prepare(
					`SELECT COUNT(*) FROM project_recipients
					 WHERE canonical_project_identity IN (?, ?, ?)`,
				)
				.pluck()
				.get(first.projectId, aborting.projectId, later.projectId),
		).toBe(0);
	});

	it("propagates an unknown live-transaction failure and rolls back pending Projects", () => {
		// Arrange
		const first = exactFixture({
			projectId: "https://git.example.invalid/acme/a-unknown-first.git",
			displayName: "a-unknown-first",
			recipientActorId: "identity-unknown-first",
		});
		exactFixture({
			projectId: "https://git.example.invalid/acme/z-unknown-failure.git",
			displayName: "z-unknown-failure",
			recipientActorId: "identity-unknown-failure",
		});
		const prepare = db.prepare.bind(db);
		let recipientInsertCount = 0;
		db.prepare = ((sql: string) => {
			if (sql.trimStart().startsWith("INSERT INTO project_recipients")) {
				recipientInsertCount += 1;
				if (recipientInsertCount === 2) throw new TypeError("forced_unknown_failure");
			}
			return prepare(sql);
		}) as typeof db.prepare;

		// Act / Assert
		try {
			expect(() => migrateRecipientPolicyIntent(db, context)).toThrow("forced_unknown_failure");
		} finally {
			db.prepare = prepare;
		}
		expect(recipientInsertCount).toBe(2);
		expect(db.inTransaction).toBe(false);
		expect(
			db
				.prepare("SELECT 1 FROM project_recipients WHERE canonical_project_identity = ?")
				.get(first.projectId),
		).toBeUndefined();
	});

	it.each([
		{ table: "not_a_table", key: { device_id: "device-a" }, values: { status: "active" } },
		{
			table: "identity_devices",
			key: { device_id: "device-a", injected: "x" },
			values: { status: "active" },
		},
		{ table: "identity_devices", key: { wrong_id: "device-a" }, values: { status: "active" } },
		{ table: "identity_devices", key: { device_id: 1 }, values: { status: "active" } },
		{
			table: "project_recipients",
			key: {
				canonical_project_identity: "project-a",
				recipient_kind: "identity",
				wrong_recipient_id: "identity-a",
			},
			values: { status: "active" },
		},
		{
			table: "identity_devices",
			key: { device_id: "device-a" },
			values: { injected: "x" },
		},
		{ table: "identity_devices", key: { device_id: "device-a" }, values: {} },
		{
			table: "identity_devices",
			key: { device_id: "device-a" },
			values: { device_id: "device-a", status: "active" },
		},
	] as const)("rejects invalid dynamic intent identifiers before SQL preparation", (row) => {
		expect(() => assertAllowedRecipientPolicyIntentRow(row as never)).toThrow("intent_conflict");
	});

	it("rejects an unknown intent provenance before SQL preparation", () => {
		expect(() =>
			assertAllowedRecipientPolicyIntentRow({
				table: "project_recipients",
				key: {
					canonical_project_identity: "project-a",
					recipient_kind: "identity",
					recipient_id: "identity-a",
				},
				values: {
					status: "active",
					provenance: "unknown_provenance",
					migration_state: "projected",
					source_fingerprint: null,
					policy_revision: "revision-a",
					idempotency_key: "idempotency-a",
					created_at: NOW,
					updated_at: NOW,
				},
				releasedV1Metadata: { revision: "revision-v1", idempotencyKey: "idempotency-v1" },
			}),
		).toThrow("intent_conflict");
	});

	it("rejects review device evidence without a source fingerprint", () => {
		expect(() =>
			assertAllowedRecipientPolicyIntentRow({
				table: "identity_devices",
				key: { device_id: "device-a" },
				values: {
					identity_id: "identity-a",
					display_name: "Laptop",
					status: "active",
					provenance: "review_resolution",
					migration_state: "projected",
					source_fingerprint: null,
					revision: "revision-a",
					idempotency_key: "idempotency-a",
					created_at: NOW,
					updated_at: NOW,
				},
				releasedV1Metadata: { revision: "revision-v1", idempotencyKey: "idempotency-v1" },
			}),
		).toThrow("device_identity_conflict");
	});

	it.each([
		["provenance", "tampered-provenance"],
		["source_fingerprint", "tampered-source"],
		["policy_revision", "tampered-revision"],
		["idempotency_key", "tampered-idempotency"],
	] as const)("blocks replay when stored %s evidence is tampered", (column, tamperedValue) => {
		// Arrange
		const fixture = resolvedAttachFixture();
		migrateRecipientPolicyIntent(db, context);
		db.prepare(
			`UPDATE project_recipients SET ${column} = ?
			 WHERE canonical_project_identity = ? AND recipient_kind = 'identity' AND recipient_id = ?`,
		).run(tamperedValue, fixture.projectId, fixture.recipientActorId);

		// Act
		const replay = migrateRecipientPolicyIntent(db, context);

		// Assert
		expect(replay.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				status: "blocked",
				errorCode: "intent_conflict",
			}),
		);
	});

	it("replays released v1 metadata when provenance and source evidence still match", () => {
		// Arrange
		const fixture = resolvedAttachFixture();
		const recipientIdentity = [fixture.projectId, "identity", fixture.recipientActorId];
		const deviceIdentity = [fixture.deviceId, fixture.recipientActorId];
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity', ?, 'active', 'review_resolution', ?, 'projected', ?, ?, ?, ?)`,
		).run(
			fixture.projectId,
			fixture.recipientActorId,
			legacyRecipientPolicyDigest(
				"recipient-policy-project-recipient-revision-v1",
				recipientIdentity,
			),
			fixture.sourceFingerprint,
			legacyRecipientPolicyDigest(
				"recipient-policy-project-recipient-idempotency-v1",
				recipientIdentity,
			),
			NOW,
			NOW,
		);
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, 'Unassigned laptop', 'active', 'review_resolution', ?, 'projected', ?, ?, ?, ?)`,
		).run(
			fixture.deviceId,
			fixture.recipientActorId,
			legacyRecipientPolicyDigest("recipient-policy-identity-device-revision-v1", deviceIdentity),
			fixture.sourceFingerprint,
			legacyRecipientPolicyDigest(
				"recipient-policy-identity-device-idempotency-v1",
				deviceIdentity,
			),
			NOW,
			NOW,
		);

		// Act
		const result = migrateRecipientPolicyIntent(db, context);

		// Assert
		expect(result.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				status: "unchanged",
				writeCount: 0,
				idempotent: true,
			}),
		);
	});

	it("writes v2 metadata bound to provenance and source evidence", () => {
		// Arrange
		const fixture = resolvedAttachFixture();

		// Act
		const result = migrateRecipientPolicyIntent(db, context);
		const recipient = db
			.prepare(
				`SELECT provenance, source_fingerprint, policy_revision, idempotency_key
				 FROM project_recipients
				 WHERE canonical_project_identity = ? AND recipient_kind = 'identity' AND recipient_id = ?`,
			)
			.get(fixture.projectId, fixture.recipientActorId) as Record<string, string>;
		const device = db
			.prepare(
				`SELECT provenance, source_fingerprint, revision, idempotency_key
				 FROM identity_devices WHERE device_id = ?`,
			)
			.get(fixture.deviceId) as Record<string, string>;

		// Assert
		expect(result.results).toContainEqual(expect.objectContaining({ status: "migrated" }));
		expect(recipient).toMatchObject({
			provenance: "review_resolution",
			source_fingerprint: fixture.sourceFingerprint,
		});
		expect(recipient.policy_revision).toContain("-v2:");
		expect(recipient.idempotency_key).toContain("-v2:");
		expect(device).toMatchObject({
			provenance: "review_resolution",
			source_fingerprint: fixture.sourceFingerprint,
		});
		expect(device.revision).toContain("-v2:");
		expect(device.idempotency_key).toContain("-v2:");
	});

	it("keeps Personal and Work actor IDs and same-name canonical Projects isolated", () => {
		const personalProject = exactFixture({
			projectId: "https://git.example.invalid/personal/api.git",
			displayName: "api",
			recipientActorId: LOCAL_ACTOR_ID,
		});
		const workProject = exactFixture({
			projectId: "https://git.example.invalid/work/api.git",
			displayName: "api",
			recipientActorId: "identity-work",
		});
		migrateRecipientPolicyIntent(db, context);
		const recipients = listRecipientPolicyIntent(db).projectRecipients;

		expect(recipients).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: personalProject.projectId,
				identityId: LOCAL_ACTOR_ID,
			}),
		);
		expect(recipients).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: workProject.projectId,
				identityId: "identity-work",
			}),
		);
		expect(recipients).not.toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: personalProject.projectId,
				identityId: "identity-work",
			}),
		);
	});

	it("requires a current review resolution and applies a local Identity recommendation", () => {
		const projectId = "https://git.example.invalid/personal/notes.git";
		insertProject(db, { projectId, displayName: "notes" });

		const missing = migrateRecipientPolicyIntent(db, context);
		expect(missing.results).toContainEqual(
			expect.objectContaining({ status: "skipped", errorCode: "review_resolution_missing" }),
		);
		const item = listRecipientPolicyReview(db, context).reviewItems[0];
		if (!item) throw new Error("review item missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "apply_recommendation",
		});

		const result = migrateRecipientPolicyIntent(db, context);

		expect(result.results).toContainEqual(expect.objectContaining({ status: "migrated" }));
		expect(listRecipientPolicyIntent(db).projectRecipients).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: projectId,
				identityId: LOCAL_ACTOR_ID,
			}),
		);
	});

	it("applies recipient choices against the exact device-scoped review preview", () => {
		const projectId = "https://git.example.invalid/acme/scoped-review.git";
		const scopeId = "scope-scoped-review";
		insertActor(db, "identity-assigned", "Assigned recipient");
		insertProject(db, { projectId, displayName: "scoped-review", scopeId });
		insertScope(db, { scopeId, projectId });
		assignDevice(db, {
			scopeId,
			deviceId: "device-assigned",
			actorId: "identity-assigned",
		});
		db.prepare(
			`INSERT INTO sync_peers(peer_device_id, name, actor_id, created_at)
			 VALUES ('device-unassigned', 'Unassigned laptop', NULL, ?)`,
		).run(NOW);
		db.prepare(
			`INSERT INTO scope_memberships(scope_id, device_id, status, membership_epoch, updated_at)
			 VALUES (?, 'device-unassigned', 'active', 1, ?)`,
		).run(scopeId, NOW);
		const item = listRecipientPolicyReview(db, context).reviewItems.find((candidate) =>
			candidate.options.some(
				(option) =>
					option.decision === "choose_recipients" &&
					option.preview.effectiveDevices.some((device) => device.deviceId === "device-unassigned"),
			),
		);
		if (!item) throw new Error("device-scoped review item missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "choose_recipients",
			decisionInput: { recipientIds: ["identity-assigned"] },
		});

		const result = migrateRecipientPolicyIntent(db, context);

		expect(result.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: projectId,
				status: "migrated",
				errorCode: null,
			}),
		);
		expect(listRecipientPolicyIntent(db).projectRecipients).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: projectId,
				identityId: "identity-assigned",
			}),
		);
	});

	it("prefers automatic evidence when a matching review selects the same recipient", () => {
		// Arrange
		const fixture = exactFixture();
		const scopeId = `scope-${fixture.recipientActorId}`;
		db.prepare(
			`INSERT INTO sync_peers(peer_device_id, name, actor_id, created_at)
			 VALUES ('device-review-extra', 'Review laptop', NULL, ?)`,
		).run(NOW);
		db.prepare(
			`INSERT INTO scope_memberships(scope_id, device_id, status, membership_epoch, updated_at)
			 VALUES (?, 'device-review-extra', 'active', 1, ?)`,
		).run(scopeId, NOW);
		const item = listRecipientPolicyReview(db, context).reviewItems.find((candidate) =>
			candidate.options.some((option) => option.decision === "choose_recipients"),
		);
		if (!item) throw new Error("matching review item missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "choose_recipients",
			decisionInput: { recipientIds: [fixture.recipientActorId] },
		});

		// Act
		const result = migrateRecipientPolicyIntent(db, context);
		const replay = migrateRecipientPolicyIntent(db, context);

		// Assert
		expect(result.results).toContainEqual(expect.objectContaining({ status: "migrated" }));
		expect(replay.results).toContainEqual(
			expect.objectContaining({ status: "unchanged", idempotent: true }),
		);
		expect(
			db
				.prepare(
					`SELECT provenance, source_fingerprint FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_kind = 'identity'
					   AND recipient_id = ?`,
				)
				.get(fixture.projectId, fixture.recipientActorId),
		).toEqual({ provenance: "exact_project_invite", source_fingerprint: null });
		expect(
			db
				.prepare("SELECT provenance, source_fingerprint FROM identity_devices WHERE device_id = ?")
				.get(fixture.deviceId),
		).toEqual({ provenance: "managed_exact_project", source_fingerprint: null });
	});

	it("accepts review device evidence when matching automatic evidence is preferred", () => {
		// Arrange
		const fixture = exactFixture({
			projectId: "https://git.example.invalid/acme/device-replay.git",
		});
		const scopeId = `scope-${fixture.recipientActorId}`;
		db.prepare(
			`INSERT INTO sync_peers(peer_device_id, name, actor_id, created_at)
			 VALUES ('device-review-replay', 'Review replay laptop', NULL, ?)`,
		).run(NOW);
		db.prepare(
			`INSERT INTO scope_memberships(scope_id, device_id, status, membership_epoch, updated_at)
			 VALUES (?, 'device-review-replay', 'active', 1, ?)`,
		).run(scopeId, NOW);
		const item = listRecipientPolicyReview(db, context).reviewItems.find((candidate) =>
			candidate.options.some((option) => option.decision === "choose_recipients"),
		);
		if (!item) throw new Error("device replay review item missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "choose_recipients",
			decisionInput: { recipientIds: [fixture.recipientActorId] },
		});
		const evidenceIdentity = {
			identity: [fixture.deviceId, fixture.recipientActorId],
			provenance: "review_resolution",
			sourceFingerprint: null,
		};
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision, migration_state,
			 source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, ?, 'Work laptop', 'active', 'review_resolution', ?, 'projected', ?, ?, ?, ?)`,
		).run(
			fixture.deviceId,
			fixture.recipientActorId,
			legacyRecipientPolicyDigest("recipient-policy-identity-device-revision-v2", evidenceIdentity),
			item.sourceFingerprint,
			legacyRecipientPolicyDigest(
				"recipient-policy-identity-device-idempotency-v2",
				evidenceIdentity,
			),
			NOW,
			NOW,
		);

		// Act
		const result = migrateRecipientPolicyIntent(db, context);
		const replay = migrateRecipientPolicyIntent(db, context);

		// Assert
		expect(result.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				status: "migrated",
				errorCode: null,
			}),
		);
		expect(replay.results).toContainEqual(
			expect.objectContaining({ status: "unchanged", idempotent: true }),
		);
		expect(
			db
				.prepare("SELECT provenance FROM identity_devices WHERE device_id = ?")
				.pluck()
				.get(fixture.deviceId),
		).toBe("review_resolution");

		db.prepare(
			"UPDATE identity_devices SET source_fingerprint = 'not-a-current-review' WHERE device_id = ?",
		).run(fixture.deviceId);
		const rejected = migrateRecipientPolicyIntent(db, context);
		expect(rejected.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				status: "blocked",
				errorCode: "device_identity_conflict",
			}),
		);
	});

	it("accepts current cross-Project device evidence with a different provenance", () => {
		const fixture = reviewDeviceFixture({
			projectId: "https://git.example.invalid/acme/review-device-source.git",
			displayName: "review-device-source",
			unassignedDeviceId: "device-review-trigger",
			recipientActorId: "identity-cross-provenance",
		});
		const reviewItem = listRecipientPolicyReview(db, context).reviewItems.find((candidate) =>
			candidate.options.some((option) => option.decision === "choose_recipients"),
		);
		if (!reviewItem) throw new Error("cross-provenance review item missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: reviewItem.reviewItemId,
			sourceFingerprint: reviewItem.sourceFingerprint,
			decision: "choose_recipients",
			decisionInput: { recipientIds: [fixture.recipientActorId] },
		});
		const assignedDeviceId = `device-${fixture.recipientActorId}`;
		const first = migrateRecipientPolicyIntent(db, context);
		expect(first.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				status: "migrated",
			}),
		);

		const automaticProjectId = "https://git.example.invalid/acme/automatic-device-source.git";
		const automaticScopeId = "scope-automatic-device-source";
		insertProject(db, {
			projectId: automaticProjectId,
			displayName: "automatic-device-source",
			scopeId: automaticScopeId,
		});
		insertScope(db, { scopeId: automaticScopeId, projectId: automaticProjectId });
		db.prepare(
			`INSERT INTO scope_memberships(scope_id, device_id, status, membership_epoch, updated_at)
			 VALUES (?, ?, 'active', 1, ?)`,
		).run(automaticScopeId, assignedDeviceId, NOW);
		insertLinkedOperation(db, {
			operationId: "operation-automatic-device-source",
			projectId: automaticProjectId,
			displayName: "automatic-device-source",
			recipientActorId: fixture.recipientActorId,
			recipientDeviceId: assignedDeviceId,
		});

		const second = migrateRecipientPolicyIntent(db, context);
		expect(second.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: automaticProjectId,
				status: "migrated",
				errorCode: null,
			}),
		);
		expect(
			db
				.prepare("SELECT provenance, source_fingerprint FROM identity_devices WHERE device_id = ?")
				.get(assignedDeviceId),
		).toEqual({
			provenance: "review_resolution",
			source_fingerprint: reviewItem.sourceFingerprint,
		});
	});

	it("deterministically selects one compatible source from two matching reviews", () => {
		// Arrange
		const projectId = "https://git.example.invalid/acme/multi-review.git";
		const scopeId = "scope-multi-review";
		const recipientId = "identity-multi-review";
		insertActor(db, recipientId, "Multi-review recipient");
		insertProject(db, { projectId, displayName: "multi-review", scopeId });
		insertScope(db, { scopeId, projectId });
		assignDevice(db, { scopeId, deviceId: "device-multi-assigned", actorId: recipientId });
		for (const deviceId of ["device-multi-a", "device-multi-b"]) {
			db.prepare(
				`INSERT INTO sync_peers(peer_device_id, name, actor_id, created_at)
				 VALUES (?, ?, NULL, ?)`,
			).run(deviceId, deviceId, NOW);
			db.prepare(
				`INSERT INTO scope_memberships(scope_id, device_id, status, membership_epoch, updated_at)
				 VALUES (?, ?, 'active', 1, ?)`,
			).run(scopeId, deviceId, NOW);
		}
		const items = listRecipientPolicyReview(db, context).reviewItems.filter((candidate) =>
			candidate.options.some((option) => option.decision === "choose_recipients"),
		);
		expect(items).toHaveLength(2);
		expect(new Set(items.map((item) => item.sourceFingerprint)).size).toBe(2);
		for (const item of items) {
			resolveRecipientPolicyReview(db, context, {
				reviewItemId: item.reviewItemId,
				sourceFingerprint: item.sourceFingerprint,
				decision: "choose_recipients",
				decisionInput: { recipientIds: [recipientId] },
			});
		}
		const [expectedFingerprint] = items
			.map((item) => item.sourceFingerprint)
			.toSorted(compareCodepoints);
		if (!expectedFingerprint) throw new Error("review fingerprint missing");

		// Act
		const result = migrateRecipientPolicyIntent(db, context);
		const replay = migrateRecipientPolicyIntent(db, context);

		// Assert
		expect(result.results).toContainEqual(expect.objectContaining({ status: "migrated" }));
		expect(replay.results).toContainEqual(
			expect.objectContaining({ status: "unchanged", idempotent: true }),
		);
		expect(
			db
				.prepare(
					`SELECT source_fingerprint FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_kind = 'identity'
					   AND recipient_id = ?`,
				)
				.pluck()
				.get(projectId, recipientId),
		).toBe(expectedFingerprint);
		expect(
			db
				.prepare("SELECT source_fingerprint FROM identity_devices WHERE device_id = ?")
				.pluck()
				.get("device-multi-assigned"),
		).toBe(expectedFingerprint);
		expect(
			db
				.prepare("SELECT COUNT(*) FROM project_recipients WHERE canonical_project_identity = ?")
				.pluck()
				.get(projectId),
		).toBe(1);
	});

	it.each(["v1", "v2"] as const)(
		"accepts a stored %s recipient edge authorized by a non-preferred current review",
		(metadataVersion) => {
			// Arrange
			const projectId = `https://git.example.invalid/acme/replay-${metadataVersion}.git`;
			const scopeId = `scope-replay-${metadataVersion}`;
			const recipientId = `identity-replay-${metadataVersion}`;
			insertActor(db, recipientId, "Replay recipient");
			insertProject(db, { projectId, displayName: `replay-${metadataVersion}`, scopeId });
			insertScope(db, { scopeId, projectId });
			assignDevice(db, {
				scopeId,
				deviceId: `device-replay-assigned-${metadataVersion}`,
				actorId: recipientId,
			});
			for (const deviceId of [
				`device-replay-${metadataVersion}-a`,
				`device-replay-${metadataVersion}-b`,
			]) {
				db.prepare(
					`INSERT INTO sync_peers(peer_device_id, name, actor_id, created_at)
					 VALUES (?, ?, NULL, ?)`,
				).run(deviceId, deviceId, NOW);
				db.prepare(
					`INSERT INTO scope_memberships(scope_id, device_id, status, membership_epoch, updated_at)
					 VALUES (?, ?, 'active', 1, ?)`,
				).run(scopeId, deviceId, NOW);
			}
			const items = listRecipientPolicyReview(db, context).reviewItems.filter((candidate) =>
				candidate.options.some((option) => option.decision === "choose_recipients"),
			);
			expect(items).toHaveLength(2);
			expect(new Set(items.map((item) => item.sourceFingerprint)).size).toBe(2);
			for (const item of items) {
				resolveRecipientPolicyReview(db, context, {
					reviewItemId: item.reviewItemId,
					sourceFingerprint: item.sourceFingerprint,
					decision: "choose_recipients",
					decisionInput: { recipientIds: [recipientId] },
				});
			}
			const [, storedFingerprint] = items
				.map((item) => item.sourceFingerprint)
				.toSorted(compareCodepoints);
			if (!storedFingerprint) throw new Error("stored review fingerprint missing");
			const identity = [projectId, "identity", recipientId];
			const evidenceIdentity = {
				identity,
				provenance: "review_resolution",
				sourceFingerprint: storedFingerprint,
			};
			const metadataIdentity = metadataVersion === "v1" ? identity : evidenceIdentity;
			db.prepare(
				`INSERT INTO project_recipients(
				 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
				 policy_revision, migration_state, source_fingerprint, idempotency_key, created_at, updated_at
				 ) VALUES (?, 'identity', ?, 'active', 'review_resolution', ?, 'projected', ?, ?, ?, ?)`,
			).run(
				projectId,
				recipientId,
				legacyRecipientPolicyDigest(
					`recipient-policy-project-recipient-revision-${metadataVersion}`,
					metadataIdentity,
				),
				storedFingerprint,
				legacyRecipientPolicyDigest(
					`recipient-policy-project-recipient-idempotency-${metadataVersion}`,
					metadataIdentity,
				),
				NOW,
				NOW,
			);

			// Act
			const result = migrateRecipientPolicyIntent(db, context);
			const replay = migrateRecipientPolicyIntent(db, context);

			// Assert
			expect(result.results).toContainEqual(
				expect.objectContaining({
					canonicalProjectIdentity: projectId,
					status: "migrated",
					errorCode: null,
				}),
			);
			expect(replay.results).toContainEqual(
				expect.objectContaining({
					canonicalProjectIdentity: projectId,
					status: "unchanged",
					idempotent: true,
				}),
			);
			expect(
				db
					.prepare(
						`SELECT source_fingerprint FROM project_recipients
						 WHERE canonical_project_identity = ? AND recipient_kind = 'identity'
						   AND recipient_id = ?`,
					)
					.pluck()
					.get(projectId, recipientId),
			).toBe(storedFingerprint);

			db.prepare(
				`UPDATE project_recipients SET source_fingerprint = 'not-a-current-review'
				 WHERE canonical_project_identity = ? AND recipient_kind = 'identity' AND recipient_id = ?`,
			).run(projectId, recipientId);
			const rejected = migrateRecipientPolicyIntent(db, context);
			expect(rejected.results).toContainEqual(
				expect.objectContaining({
					canonicalProjectIdentity: projectId,
					status: "blocked",
					errorCode: "intent_conflict",
				}),
			);

			db.prepare(
				`UPDATE project_recipients SET source_fingerprint = ?, policy_revision = 'tampered-revision'
			 WHERE canonical_project_identity = ? AND recipient_kind = 'identity' AND recipient_id = ?`,
			).run(storedFingerprint, projectId, recipientId);
			const metadataRejected = migrateRecipientPolicyIntent(db, context);
			expect(metadataRejected.results).toContainEqual(
				expect.objectContaining({
					canonicalProjectIdentity: projectId,
					status: "blocked",
					errorCode: "intent_conflict",
				}),
			);
		},
	);

	it("keeps reviewed preserve-current Projects on legacy enforcement", () => {
		const projectId = "https://git.example.invalid/acme/preserve-current.git";
		const scopeId = "scope-preserve-current";
		insertActor(db, "identity-assigned", "Assigned recipient");
		insertProject(db, { projectId, displayName: "preserve-current", scopeId });
		insertScope(db, { scopeId, projectId });
		assignDevice(db, {
			scopeId,
			deviceId: "device-assigned",
			actorId: "identity-assigned",
		});
		db.prepare(
			`INSERT INTO sync_peers(peer_device_id, name, actor_id, created_at)
			 VALUES ('device-unassigned', 'Unassigned laptop', NULL, ?)`,
		).run(NOW);
		db.prepare(
			`INSERT INTO scope_memberships(scope_id, device_id, status, membership_epoch, updated_at)
			 VALUES (?, 'device-unassigned', 'active', 1, ?)`,
		).run(scopeId, NOW);
		const item = listRecipientPolicyReview(db, context).reviewItems.find((candidate) =>
			candidate.options.some(
				(option) =>
					option.decision === "preserve_current_access" &&
					option.preview.effectiveDevices.some((device) => device.deviceId === "device-unassigned"),
			),
		);
		if (!item) throw new Error("device-scoped preserve-current review item missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "preserve_current_access",
		});

		const result = migrateRecipientPolicyIntent(db, context);

		expect(result.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: projectId,
				status: "skipped",
				writeCount: 0,
				idempotent: true,
				errorCode: "review_preserves_legacy_access",
			}),
		);
		expect(db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
	});

	it("lets preserve-current dominate automatic evidence and sibling review choices", () => {
		const fixture = exactFixture({ digestOverride: "stale-automatic-evidence" });
		const scopeId = `scope-${fixture.recipientActorId}`;
		for (const deviceId of ["device-unassigned-a", "device-unassigned-z"]) {
			db.prepare(
				`INSERT INTO sync_peers(peer_device_id, name, actor_id, created_at)
				 VALUES (?, ?, NULL, ?)`,
			).run(deviceId, deviceId, NOW);
			db.prepare(
				`INSERT INTO scope_memberships(scope_id, device_id, status, membership_epoch, updated_at)
				 VALUES (?, ?, 'active', 1, ?)`,
			).run(scopeId, deviceId, NOW);
		}
		const items = listRecipientPolicyReview(db, context).reviewItems;
		const itemFor = (deviceId: string) =>
			items.find((item) =>
				item.options.some((option) =>
					option.preview.effectiveDevices.some((device) => device.deviceId === deviceId),
				),
			);
		const chooseItem = itemFor("device-unassigned-a");
		const preserveItem = itemFor("device-unassigned-z");
		if (!chooseItem || !preserveItem) throw new Error("device-scoped review items missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: chooseItem.reviewItemId,
			sourceFingerprint: chooseItem.sourceFingerprint,
			decision: "choose_recipients",
			decisionInput: { recipientIds: [fixture.recipientActorId] },
		});
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: preserveItem.reviewItemId,
			sourceFingerprint: preserveItem.sourceFingerprint,
			decision: "preserve_current_access",
		});

		const result = migrateRecipientPolicyIntent(db, context);

		expect(result.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				status: "skipped",
				errorCode: "review_preserves_legacy_access",
			}),
		);
		expect(db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
	});

	it("treats durable keep-current review outcomes as migration no-ops", () => {
		insertProject(db, {
			projectId: "https://git.example.invalid/personal/keep.git",
			displayName: "keep",
		});
		const item = listRecipientPolicyReview(db, context).reviewItems[0];
		if (!item) throw new Error("review item missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "keep_current_setup",
		});

		const result = migrateRecipientPolicyIntent(db, context);

		expect(result.results).toContainEqual(
			expect.objectContaining({ status: "unchanged", writeCount: 0, idempotent: true }),
		);
		expect(db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
	});

	it("keeps preserved diagnostic-only Projects skipped without migration evidence", () => {
		const scopeId = "ambiguous-scope";
		for (const projectId of [
			"https://git.example.invalid/acme/blocked-one.git",
			"https://git.example.invalid/acme/blocked-two.git",
		]) {
			insertProject(db, { projectId, displayName: "blocked", scopeId });
			if (!db.prepare("SELECT 1 FROM replication_scopes WHERE scope_id = ?").get(scopeId)) {
				insertScope(db, {
					scopeId,
					projectId,
					kind: "team",
					coordinatorId: "coordinator",
					groupId: "group",
				});
			} else {
				db.prepare(
					`INSERT INTO project_scope_mappings(
						workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
					 ) VALUES (?, ?, ?, 1000, 'test', ?, ?)`,
				).run(projectId, projectId, scopeId, NOW, NOW);
			}
		}

		const projections = listLegacyRecipientPolicyProjections(db, context);
		const review = listRecipientPolicyReview(db, context);
		const result = migrateRecipientPolicyIntent(db, context);

		expect(
			projections.every((projection) =>
				projection.conditions.some(
					(condition) => condition.code === "ambiguous_multi_project_scope",
				),
			),
		).toBe(true);
		expect(review).toMatchObject({
			blockedItems: [],
			continuity: { findingCount: 2, state: "legacy_access_preserved" },
			reviewItems: [],
		});
		expect(result.results).toHaveLength(2);
		expect(
			result.results.every(
				(entry) => entry.status === "skipped" && entry.errorCode === "migration_evidence_missing",
			),
		).toBe(true);
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
	});

	it("skips stale resolved review rows", () => {
		insertProject(db, {
			projectId: "https://git.example.invalid/personal/stale.git",
			displayName: "stale",
		});
		const item = listRecipientPolicyReview(db, context).reviewItems[0];
		if (!item) throw new Error("review item missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "apply_recommendation",
		});
		db.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
			 ) VALUES ('local-default', 'Local only', 'system', 'local', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-change', 'Changed', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		db.prepare(
			`INSERT INTO sync_peers(peer_device_id, name, actor_id, created_at)
			 VALUES ('device-change', 'Changed', 'identity-change', ?)`,
		).run(NOW);
		db.prepare(
			`INSERT INTO scope_memberships(scope_id, device_id, status, membership_epoch, updated_at)
			 VALUES ('local-default', 'device-change', 'active', 1, ?)`,
		).run(NOW);

		const result = migrateRecipientPolicyIntent(db, context);

		expect(result.results).toContainEqual(
			expect.objectContaining({ status: "skipped", errorCode: "review_resolution_stale" }),
		);
		expect(db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
	});

	it("reuses one created Identity for the same unassigned device across Projects", () => {
		const firstFixture = reviewDeviceFixture({
			projectId: "https://git.example.invalid/acme/first.git",
			displayName: "first",
			unassignedDeviceId: "device-new-identity",
		});
		const firstItem = listRecipientPolicyReview(db, context).reviewItems.find((candidate) =>
			candidate.options.some(
				(option) =>
					option.decision === "create_identity" &&
					option.preview.projects.some(
						(project) => project.canonicalIdentity === firstFixture.projectId,
					),
			),
		);
		if (!firstItem) throw new Error("first create-identity review item missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: firstItem.reviewItemId,
			sourceFingerprint: firstItem.sourceFingerprint,
			decision: "create_identity",
			decisionInput: { deviceId: "device-new-identity", displayName: "Separate Identity" },
		});

		const first = migrateRecipientPolicyIntent(db, context);
		const firstDevice = listRecipientPolicyIntent(db).identityDevices.find(
			(candidate) => candidate.deviceId === "device-new-identity",
		);
		const actor = firstDevice
			? db
					.prepare("SELECT display_name, is_local, status FROM actors WHERE actor_id = ?")
					.get(firstDevice.identityId)
			: null;
		const firstRecipientMetadata = firstDevice
			? db
					.prepare(
						`SELECT provenance, source_fingerprint FROM project_recipients
						 WHERE canonical_project_identity = ? AND recipient_kind = 'identity' AND recipient_id = ?`,
					)
					.get(firstFixture.projectId, firstDevice.identityId)
			: null;

		expect(first.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: firstFixture.projectId,
				status: "migrated",
			}),
		);
		expect(firstDevice?.identityId).toMatch(/^policy-identity-v1:/u);
		expect(actor).toEqual({ display_name: "Separate Identity", is_local: 0, status: "active" });
		expect(firstRecipientMetadata).toEqual({
			provenance: "review_resolution",
			source_fingerprint: firstItem.sourceFingerprint,
		});
		expect(listRecipientPolicyIntent(db).projectRecipients).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: firstFixture.projectId,
				identityId: firstDevice?.identityId,
			}),
		);

		const secondFixture = reviewDeviceFixture({
			projectId: "https://git.example.invalid/acme/second.git",
			displayName: "second",
			unassignedDeviceId: "device-new-identity",
			recipientActorId: "identity-second-project",
		});
		const secondItem = listRecipientPolicyReview(db, context).reviewItems.find((candidate) =>
			candidate.options.some(
				(option) =>
					option.decision === "create_identity" &&
					option.preview.projects.some(
						(project) => project.canonicalIdentity === secondFixture.projectId,
					),
			),
		);
		if (!secondItem) throw new Error("second create-identity review item missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: secondItem.reviewItemId,
			sourceFingerprint: secondItem.sourceFingerprint,
			decision: "create_identity",
			decisionInput: { deviceId: "device-new-identity", displayName: "Other Project Name" },
		});

		const second = migrateRecipientPolicyIntent(db, context);
		const retry = migrateRecipientPolicyIntent(db, context);
		const matchingDevices = listRecipientPolicyIntent(db).identityDevices.filter(
			(candidate) => candidate.deviceId === "device-new-identity",
		);
		const projectRecipients = listRecipientPolicyIntent(db).projectRecipients;

		expect(db.prepare("SELECT COUNT(*) FROM share_operations").pluck().get()).toBe(0);
		expect(second.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: secondFixture.projectId,
				status: "migrated",
				errorCode: null,
			}),
		);
		expect(second.results).not.toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: secondFixture.projectId,
				errorCode: "device_identity_conflict",
			}),
		);
		expect(matchingDevices).toHaveLength(1);
		expect(matchingDevices[0]?.identityId).toBe(firstDevice?.identityId);
		expect(projectRecipients).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					canonicalProjectIdentity: firstFixture.projectId,
					identityId: firstDevice?.identityId,
				}),
				expect.objectContaining({
					canonicalProjectIdentity: secondFixture.projectId,
					identityId: firstDevice?.identityId,
				}),
			]),
		);
		expect(
			db
				.prepare("SELECT COUNT(*) FROM actors WHERE actor_id LIKE 'policy-identity-v1:%'")
				.pluck()
				.get(),
		).toBe(1);
		expect(retry.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					canonicalProjectIdentity: firstFixture.projectId,
					status: "unchanged",
					writeCount: 0,
					idempotent: true,
				}),
				expect.objectContaining({
					canonicalProjectIdentity: secondFixture.projectId,
					status: "unchanged",
					writeCount: 0,
					idempotent: true,
				}),
			]),
		);
	});

	it("rolls back a created actor and device when its Project recipient conflicts", () => {
		const fixture = reviewDeviceFixture({
			projectId: "https://git.example.invalid/acme/create-rollback.git",
			displayName: "create-rollback",
			unassignedDeviceId: "device-create-rollback",
		});
		const item = listRecipientPolicyReview(db, context).reviewItems.find((candidate) =>
			candidate.options.some((option) => option.decision === "create_identity"),
		);
		if (!item) throw new Error("create-identity review item missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "create_identity",
			decisionInput: {
				deviceId: fixture.unassignedDeviceId,
				displayName: "Rollback Identity",
			},
		});
		const first = migrateRecipientPolicyIntent(db, context);
		const identityId = db
			.prepare("SELECT identity_id FROM identity_devices WHERE device_id = ?")
			.pluck()
			.get(fixture.unassignedDeviceId) as string;
		expect(first.results).toContainEqual(expect.objectContaining({ status: "migrated" }));

		db.prepare("DELETE FROM identity_devices WHERE device_id = ?").run(fixture.unassignedDeviceId);
		db.prepare("DELETE FROM actors WHERE actor_id = ?").run(identityId);
		db.prepare(
			`UPDATE project_recipients SET status = 'revoked'
			 WHERE canonical_project_identity = ? AND recipient_kind = 'identity' AND recipient_id = ?`,
		).run(fixture.projectId, identityId);

		const retry = migrateRecipientPolicyIntent(db, context);

		expect(retry.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				status: "blocked",
				writeCount: 0,
				errorCode: "intent_conflict",
			}),
		);
		expect(db.prepare("SELECT 1 FROM actors WHERE actor_id = ?").get(identityId)).toBeUndefined();
		expect(
			db
				.prepare("SELECT 1 FROM identity_devices WHERE device_id = ?")
				.get(fixture.unassignedDeviceId),
		).toBeUndefined();
	});

	it("blocks stale saved recipient choices targeting unresolved legacy Team candidates", () => {
		const projectId = "https://git.example.invalid/acme/team-docs.git";
		const scopeId = "legacy-team-scope";
		insertActor(db, "identity-member", "Member");
		insertProject(db, { projectId, displayName: "docs", scopeId });
		insertScope(db, {
			scopeId,
			projectId,
			kind: "team",
			label: "Docs Team",
			coordinatorId: "coordinator-private",
			groupId: "coordinator-group-private",
		});
		assignDevice(db, {
			scopeId,
			deviceId: "device-member",
			actorId: "identity-member",
		});
		insertActor(db, "identity-second-member", "Second member");
		assignDevice(db, {
			scopeId,
			deviceId: "device-second-member",
			actorId: "identity-second-member",
		});
		const projection = listLegacyRecipientPolicyProjections(db, context)[0];
		const teamCandidate = projection?.teamCandidates[0];
		const item = listRecipientPolicyReview(db, context).reviewItems[0];
		if (!teamCandidate || !item) throw new Error("team review fixture incomplete");
		const chooseOption = item.options.find((option) => option.decision === "choose_recipients");
		if (!chooseOption) throw new Error("choose recipients option missing");
		db.prepare(
			`INSERT INTO recipient_policy_review_resolutions(
			 review_item_id, source_fingerprint, decision, decision_input_json, preview_json,
			 decided_by_identity_id, decided_by_device_id, resolved_at
			 ) VALUES (?, ?, 'choose_recipients', ?, ?, ?, ?, ?)`,
		).run(
			item.reviewItemId,
			item.sourceFingerprint,
			JSON.stringify({ recipientIds: [teamCandidate.teamCandidateId] }),
			JSON.stringify(chooseOption.preview),
			LOCAL_ACTOR_ID,
			LOCAL_DEVICE_ID,
			NOW,
		);

		const result = migrateRecipientPolicyIntent(db, context);

		expect(result.results).toContainEqual(
			expect.objectContaining({ status: "blocked", errorCode: "review_recipient_stale" }),
		);
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM project_recipients").pluck().get()).toBe(0);
	});

	it("translates saved candidate selections to the completed guided-setup Team", () => {
		const projectId = "https://git.example.invalid/acme/team-translated.git";
		const scopeId = "legacy-team-translated-scope";
		insertActor(db, "identity-member", "Member");
		insertProject(db, { projectId, displayName: "translated", scopeId });
		insertScope(db, {
			scopeId,
			projectId,
			kind: "team",
			label: "Translated Team",
			coordinatorId: "coordinator-private",
			groupId: "coordinator-group-private",
		});
		assignDevice(db, {
			scopeId,
			deviceId: "device-member",
			actorId: "identity-member",
		});
		const projection = listLegacyRecipientPolicyProjections(db, context)[0];
		const teamCandidate = projection?.teamCandidates[0];
		const item = listRecipientPolicyReview(db, context).reviewItems[0];
		if (!teamCandidate || !item) throw new Error("team review fixture incomplete");
		const chooseOption = item.options.find((option) => option.decision === "choose_recipients");
		if (!chooseOption) throw new Error("choose recipients option missing");
		db.prepare(
			`INSERT INTO recipient_policy_review_resolutions(
			 review_item_id, source_fingerprint, decision, decision_input_json, preview_json,
			 decided_by_identity_id, decided_by_device_id, resolved_at
			 ) VALUES (?, ?, 'choose_recipients', ?, ?, ?, ?, ?)`,
		).run(
			item.reviewItemId,
			item.sourceFingerprint,
			JSON.stringify({ recipientIds: [teamCandidate.teamCandidateId] }),
			JSON.stringify(chooseOption.preview),
			LOCAL_ACTOR_ID,
			LOCAL_DEVICE_ID,
			NOW,
		);
		// Guided setup already materialized the roster device with its own
		// activation revision; migration must accept it as satisfied.
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision,
			 migration_state, assignment_version, source_fingerprint, idempotency_key,
			 created_at, updated_at
			 ) VALUES ('device-member', 'identity-member', 'Member laptop', 'active',
			 'reviewed_team_setup', 'activation-revision', 'completed', 0, 'key-member',
			 'setup-device-member', ?, ?)`,
		).run(NOW, NOW);
		const completedTeamId = deterministicPolicyTeamId(teamCandidate.teamCandidateId);
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, device_eligibility_mode, provenance, revision,
			 migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Translated Team', 'active', 'reviewed_allowlist', 'reviewed_team_candidate',
			 'setup-r1', 'completed', 'roster-translated', 'translated-team', ?, ?)`,
		).run(completedTeamId, NOW, NOW);
		db.prepare(
			`INSERT INTO legacy_team_setup_drafts(
			 attempt_id, candidate_id, coordinator_id, group_id, state, display_name,
			 roster_fingerprint, projection_fingerprint, finish_digest, completed_team_id,
			 created_at, updated_at, completed_at
			 ) VALUES ('translated-attempt', ?, 'coordinator-private', 'coordinator-group-private',
			 'completed', 'Translated Team', 'roster-translated', 'projection-translated',
			 'finish-translated', ?, ?, ?, ?)`,
		).run(teamCandidate.teamCandidateId, completedTeamId, NOW, NOW, NOW);
		// The completion-bound Project row keeps the live inventory accounted
		// for; selection freshness would otherwise treat the completed setup
		// as drifted and block the candidate.
		db.prepare(
			`INSERT INTO legacy_team_setup_draft_projects(
			 attempt_id, project_ref, source_project_identity, display_name,
			 source_fingerprint, resolution_kind, resolved_project_identity, updated_at
			 ) VALUES ('translated-attempt', 'translated-project-ref', ?, 'Team Project',
			 'source-translated', 'deterministic', ?, ?)`,
		).run(projectId, projectId, NOW);
		// Activation always creates the Team/project recipient edge with its own
		// revision; migration must treat it as satisfying the translated intent.
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_setup', 'activation-revision',
			 'completed', 'setup-recipient-edge', ?, ?)`,
		).run(projectId, completedTeamId, NOW, NOW);

		const result = migrateRecipientPolicyIntent(db, context);

		// The setup-created edge already satisfies the translated selection, so
		// the Project completes without conflict (idempotently unchanged).
		expect(result.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: projectId,
				status: "unchanged",
				errorCode: null,
			}),
		);
		expect(
			db
				.prepare(
					`SELECT recipient_id FROM project_recipients
					 WHERE canonical_project_identity = ? AND recipient_kind = 'team' AND status = 'active'`,
				)
				.pluck()
				.get(projectId),
		).toBe(completedTeamId);
	});

	it("accepts a device reassigned by completed setup despite foreign provenance", () => {
		const projectId = "https://git.example.invalid/acme/team-reassigned.git";
		const scopeId = "legacy-team-reassigned-scope";
		insertActor(db, "identity-member", "Member");
		insertProject(db, { projectId, displayName: "reassigned", scopeId });
		insertScope(db, {
			scopeId,
			projectId,
			kind: "team",
			label: "Reassigned Team",
			coordinatorId: "coordinator-private",
			groupId: "coordinator-group-private",
		});
		assignDevice(db, {
			scopeId,
			deviceId: "device-member",
			actorId: "identity-member",
		});
		const projection = listLegacyRecipientPolicyProjections(db, context)[0];
		const teamCandidate = projection?.teamCandidates[0];
		const item = listRecipientPolicyReview(db, context).reviewItems[0];
		if (!teamCandidate || !item) throw new Error("team review fixture incomplete");
		const chooseOption = item.options.find((option) => option.decision === "choose_recipients");
		if (!chooseOption) throw new Error("choose recipients option missing");
		db.prepare(
			`INSERT INTO recipient_policy_review_resolutions(
			 review_item_id, source_fingerprint, decision, decision_input_json, preview_json,
			 decided_by_identity_id, decided_by_device_id, resolved_at
			 ) VALUES (?, ?, 'choose_recipients', ?, ?, ?, ?, ?)`,
		).run(
			item.reviewItemId,
			item.sourceFingerprint,
			JSON.stringify({ recipientIds: [teamCandidate.teamCandidateId] }),
			JSON.stringify(chooseOption.preview),
			LOCAL_ACTOR_ID,
			LOCAL_DEVICE_ID,
			NOW,
		);
		// Guided setup reassigned a pre-existing enrollment row: the assignment
		// write preserves the original provenance and revision, so neither
		// matches the migration intent nor `reviewed_team_setup`.
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision,
			 migration_state, assignment_version, source_fingerprint, idempotency_key,
			 created_at, updated_at
			 ) VALUES ('device-member', 'identity-member', 'Member laptop', 'active',
			 'coordinator_enrollment', 'enrollment-revision', 'completed', 3, 'key-member',
			 'enrollment-device-member', ?, ?)`,
		).run(NOW, NOW);
		const completedTeamId = deterministicPolicyTeamId(teamCandidate.teamCandidateId);
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, device_eligibility_mode, provenance, revision,
			 migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Reassigned Team', 'active', 'reviewed_allowlist', 'reviewed_team_candidate',
			 'setup-r1', 'completed', 'roster-reassigned', 'reassigned-team', ?, ?)`,
		).run(completedTeamId, NOW, NOW);
		db.prepare(
			`INSERT INTO legacy_team_setup_drafts(
			 attempt_id, candidate_id, coordinator_id, group_id, state, display_name,
			 roster_fingerprint, projection_fingerprint, finish_digest, completed_team_id,
			 created_at, updated_at, completed_at
			 ) VALUES ('reassigned-attempt', ?, 'coordinator-private', 'coordinator-group-private',
			 'completed', 'Reassigned Team', 'roster-reassigned', 'projection-reassigned',
			 'finish-reassigned', ?, ?, ?, ?)`,
		).run(teamCandidate.teamCandidateId, completedTeamId, NOW, NOW, NOW);
		// The completion-bound Project row keeps the live inventory accounted
		// for; selection freshness would otherwise treat the completed setup
		// as drifted and block the candidate.
		db.prepare(
			`INSERT INTO legacy_team_setup_draft_projects(
			 attempt_id, project_ref, source_project_identity, display_name,
			 source_fingerprint, resolution_kind, resolved_project_identity, updated_at
			 ) VALUES ('reassigned-attempt', 'reassigned-project-ref', ?, 'Reassigned Project',
			 'source-reassigned', 'deterministic', ?, ?)`,
		).run(projectId, projectId, NOW);
		// Completion-bound draft evidence proves setup reviewed this assignment.
		db.prepare(
			`INSERT INTO legacy_team_setup_draft_devices(
			 attempt_id, device_id, device_ref, key_fingerprint, display_name, enabled,
			 decision, target_identity_id, updated_at
			 ) VALUES ('reassigned-attempt', 'device-member', 'device-ref-member', 'key-member',
			 'Member laptop', 1, 'included', 'identity-member', ?)`,
		).run(NOW);
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
			 team_id, device_id, decision, assignment_version, provenance, revision,
			 created_at, updated_at
			 ) VALUES (?, 'device-member', 'included', 3, 'reviewed_team_setup', 'setup-r1', ?, ?)`,
		).run(completedTeamId, NOW, NOW);
		db.prepare(
			`INSERT INTO policy_team_memberships(
			 team_id, identity_id, role, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES (?, 'identity-member', 'member', 'reviewed_active', 'reviewed_team_setup',
			 'setup-r1', 'completed', 'reassigned-membership', ?, ?)`,
		).run(completedTeamId, NOW, NOW);
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'team', ?, 'active', 'reviewed_team_setup', 'activation-revision',
			 'completed', 'setup-recipient-edge-reassigned', ?, ?)`,
		).run(projectId, completedTeamId, NOW, NOW);

		const result = migrateRecipientPolicyIntent(db, context);

		// The reviewed assignment must satisfy the migration intent instead of
		// permanently blocking with device_identity_conflict.
		expect(result.results).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: projectId,
				status: "unchanged",
				errorCode: null,
			}),
		);
	});

	it("migrates an active canonical Team recipient without materializing a candidate", () => {
		const fixture = reviewDeviceFixture({
			projectId: "https://git.example.invalid/acme/canonical-team.git",
			displayName: "canonical-team",
			unassignedDeviceId: "device-canonical-team-unassigned",
		});
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES ('canonical-team', 'Canonical Team', 'active', 'test', 'revision',
			 'projected', 'canonical-team-idempotency', ?, ?)`,
		).run(NOW, NOW);
		const item = listRecipientPolicyReview(db, context).reviewItems.find((candidate) =>
			candidate.options.some((option) => option.decision === "choose_recipients"),
		);
		if (!item) throw new Error("canonical Team review item missing");
		expect(
			resolveRecipientPolicyReview(db, context, {
				reviewItemId: item.reviewItemId,
				sourceFingerprint: item.sourceFingerprint,
				decision: "choose_recipients",
				decisionInput: { recipientIds: ["canonical-team"] },
			}).status,
		).toBe("applied");

		const result = migrateRecipientPolicyIntent(db, context);

		expect(result.results).toContainEqual(
			expect.objectContaining({ canonicalProjectIdentity: fixture.projectId, status: "migrated" }),
		);
		expect(listRecipientPolicyIntent(db).projectRecipients).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: fixture.projectId,
				recipientKind: "team",
				teamId: "canonical-team",
			}),
		);
	});
});
