import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listLegacyRecipientPolicyProjections } from "./legacy-recipient-policy-projection.js";
import { listRecipientPolicyIntent } from "./recipient-policy-intent.js";
import {
	deterministicPolicyTeamId,
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
		`device-${input.recipientActorId}`,
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

describe("recipient policy intent migration", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		insertActor(db, LOCAL_ACTOR_ID, "Personal", true);
		db.prepare(
			`INSERT INTO sync_device(device_id, public_key, fingerprint, created_at)
			 VALUES (?, 'local-key', 'transport-fingerprint', ?)`,
		).run(LOCAL_DEVICE_ID, NOW);
	});

	afterEach(() => db.close());

	function exactFixture(input?: {
		projectId?: string;
		displayName?: string;
		recipientActorId?: string;
		digestOverride?: string;
	}): { projectId: string; recipientActorId: string; deviceId: string } {
		const projectId = input?.projectId ?? "https://git.example.invalid/acme/api.git";
		const displayName = input?.displayName ?? "api";
		const recipientActorId = input?.recipientActorId ?? "identity-work";
		const scopeId = `scope-${recipientActorId}`;
		const deviceId = `device-${recipientActorId}`;
		if (!db.prepare("SELECT 1 FROM actors WHERE actor_id = ?").get(recipientActorId)) {
			insertActor(
				db,
				recipientActorId,
				recipientActorId === "identity-work" ? "Work" : "Recipient",
			);
		}
		insertProject(db, { projectId, displayName, scopeId });
		insertScope(db, { scopeId, projectId });
		assignDevice(db, { scopeId, deviceId, actorId: recipientActorId, displayName: "Work laptop" });
		insertLinkedOperation(db, {
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

	it("never writes diagnostic-only blocked Projects", () => {
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

		const result = migrateRecipientPolicyIntent(db, context);

		expect(result.results.every((entry) => entry.status === "skipped")).toBe(true);
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

	it("mints a policy Team distinct from a coordinator group and projects memberships", () => {
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
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "choose_recipients",
			decisionInput: { recipientIds: [teamCandidate.teamCandidateId] },
		});
		const previewJson = db
			.prepare(
				`SELECT preview_json FROM recipient_policy_review_resolutions
				 WHERE review_item_id = ? AND source_fingerprint = ?`,
			)
			.pluck()
			.get(item.reviewItemId, item.sourceFingerprint) as string;
		const preview = JSON.parse(previewJson) as { effectiveDevices: unknown[] };
		db.prepare(
			`UPDATE recipient_policy_review_resolutions SET preview_json = ?
			 WHERE review_item_id = ? AND source_fingerprint = ?`,
		).run(
			JSON.stringify({ ...preview, effectiveDevices: preview.effectiveDevices.slice(0, 1) }),
			item.reviewItemId,
			item.sourceFingerprint,
		);
		const stalePreview = migrateRecipientPolicyIntent(db, context);
		expect(stalePreview.results).toContainEqual(
			expect.objectContaining({ status: "blocked", errorCode: "review_preview_stale" }),
		);
		expect(db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get()).toBe(0);
		db.prepare(
			`UPDATE recipient_policy_review_resolutions SET preview_json = ?
			 WHERE review_item_id = ? AND source_fingerprint = ?`,
		).run(previewJson, item.reviewItemId, item.sourceFingerprint);

		migrateRecipientPolicyIntent(db, context);
		const intent = listRecipientPolicyIntent(db);
		const teamId = deterministicPolicyTeamId(teamCandidate.teamCandidateId);

		expect(teamId).not.toBe("coordinator-group-private");
		expect(intent.teams).toContainEqual(
			expect.objectContaining({ teamId, displayName: "Docs Team" }),
		);
		expect(intent.teamMemberships).toContainEqual(
			expect.objectContaining({ teamId, identityId: "identity-member" }),
		);
		expect(intent.teamMemberships).toContainEqual(
			expect.objectContaining({ teamId, identityId: "identity-second-member" }),
		);
		expect(intent.projectRecipients).toContainEqual(
			expect.objectContaining({
				canonicalProjectIdentity: projectId,
				recipientKind: "team",
				teamId,
			}),
		);
	});
});
