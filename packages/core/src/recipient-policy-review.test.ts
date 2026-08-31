import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type LegacyRecipientPolicyProjectionV1,
	listLegacyRecipientPolicyProjections,
} from "./legacy-recipient-policy-projection.js";
import { deterministicPolicyTeamId } from "./recipient-policy-identifiers.js";
import {
	deriveRecipientPolicyReviewState,
	deriveSelectableRecipientIds,
	listRecipientPolicyReview,
	type RecipientPolicyReviewResolveRequestV1,
	recipientPolicyReviewSourceFingerprint,
	resolveRecipientPolicyReview,
	resolveRecipientPolicyReviewBulk,
} from "./recipient-policy-review.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-07-21T12:00:00.000Z";
const PROJECT_ID = "https://git.example.invalid/acme/review.git";
const LOCAL_ACTOR_ID = "actor-local";
const LOCAL_DEVICE_ID = "device-local";
const context = {
	localActorId: LOCAL_ACTOR_ID,
	localDeviceId: LOCAL_DEVICE_ID,
	now: () => NOW,
};

function projection(): LegacyRecipientPolicyProjectionV1 {
	return {
		version: 1,
		project: { version: 1, canonicalIdentity: PROJECT_ID, displayName: "review" },
		intent: [],
		identityCandidates: [
			{
				version: 1,
				identityId: LOCAL_ACTOR_ID,
				displayName: "Local Person",
				status: "active",
				mergedIntoIdentityId: null,
				isLocal: true,
				suggestedKind: "personal",
				confidence: "high",
				provenance: ["personal_scope", "local_identity"],
			},
		],
		teamCandidates: [],
		effectiveDevices: [
			{
				version: 1,
				deviceId: LOCAL_DEVICE_ID,
				displayName: "This device",
				identityId: LOCAL_ACTOR_ID,
				assignment: "assigned",
				access: "current_effective",
				provenance: "local_runtime",
			},
		],
		enforcement: {
			version: 1,
			authority: "legacy_scope",
			parity: "unknown",
			cutoverState: "legacy",
			state: "local_only",
			currentDeviceIds: [LOCAL_DEVICE_ID],
			safeErrorCode: null,
		},
		conditions: [
			{
				version: 1,
				code: "suggest_local_identity",
				kind: "actionable",
				message: "Use local Identity",
			},
		],
	};
}

function insertLocalFixture(db: InstanceType<typeof Database>): void {
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES (?, 'Local Person', 1, 'active', ?, ?)`,
	).run(LOCAL_ACTOR_ID, NOW, NOW);
	db.prepare(
		`INSERT INTO sync_device(device_id, public_key, fingerprint, created_at)
		 VALUES (?, 'public-key', 'transport-fingerprint', ?)`,
	).run(LOCAL_DEVICE_ID, NOW);
	const sessionId = Number(
		db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, git_remote, git_branch)
				 VALUES (?, '/workspace/review', 'review', ?, 'main')`,
			)
			.run(NOW, PROJECT_ID).lastInsertRowid,
	);
	db.prepare(
		`INSERT INTO memory_items(
			session_id, kind, title, body_text, active, created_at, updated_at,
			visibility, project, scope_id
		 ) VALUES (?, 'discovery', 'Review fixture', 'body', 1, ?, ?, 'private', 'review', 'local-default')`,
	).run(sessionId, NOW, NOW);
}

function insertLegacyScope(
	db: InstanceType<typeof Database>,
	scopeId: string,
	kind = "team",
): void {
	db.prepare(
		`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id,
			membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, ?, 'coordinator', 'coordinator', 'group', 1, 'active', ?, ?)`,
	).run(scopeId, scopeId, kind, NOW, NOW);
}

function mapProject(
	db: InstanceType<typeof Database>,
	projectId: string | null,
	projectPattern: string,
	scopeId: string,
): void {
	db.prepare(
		`INSERT INTO project_scope_mappings(
			workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
		 ) VALUES (?, ?, ?, 1000, 'test', ?, ?)`,
	).run(projectId, projectPattern, scopeId, NOW, NOW);
}

function configureUmbrellaScope(db: InstanceType<typeof Database>, kind = "team"): void {
	const scopeId = "legacy-umbrella";
	const secondProjectId = "https://git.example.invalid/acme/review-second.git";
	insertLegacyScope(db, scopeId, kind);
	db.prepare("UPDATE memory_items SET scope_id = ?").run(scopeId);
	mapProject(db, PROJECT_ID, PROJECT_ID, scopeId);
	const sessionId = Number(
		db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, git_remote, git_branch)
				 VALUES (?, '/workspace/review-second', 'review-second', ?, 'main')`,
			)
			.run(NOW, secondProjectId).lastInsertRowid,
	);
	db.prepare(
		`INSERT INTO memory_items(
			session_id, kind, title, body_text, active, created_at, updated_at,
			visibility, project, scope_id
		 ) VALUES (?, 'discovery', 'Second fixture', 'body', 1, ?, ?, 'shared', 'review-second', ?)`,
	).run(sessionId, NOW, NOW, scopeId);
	mapProject(db, secondProjectId, secondProjectId, scopeId);
}

function configureUnassignedDeviceReview(
	db: InstanceType<typeof Database>,
	unassignedDeviceIds = ["device-unassigned"],
): void {
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES ('actor-candidate', 'Candidate Person', 0, 'active', ?, ?)`,
	).run(NOW, NOW);
	db.prepare(
		`INSERT INTO replication_scopes(
			scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at
		 ) VALUES ('managed-review', 'Review', 'managed_project', 'local', 1, 'active', ?, ?)`,
	).run(NOW, NOW);
	db.prepare(
		`INSERT INTO project_scope_mappings(
			workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
		 ) VALUES (?, ?, 'managed-review', 1000, 'test', ?, ?)`,
	).run(PROJECT_ID, PROJECT_ID, NOW, NOW);
	db.prepare("UPDATE memory_items SET scope_id = 'managed-review'").run();
	for (const [deviceId, actorId] of [
		["device-candidate", "actor-candidate"],
		...unassignedDeviceIds.map((deviceId) => [deviceId, null] as const),
	] as const) {
		db.prepare(
			`INSERT INTO sync_peers(peer_device_id, name, actor_id, created_at)
			 VALUES (?, ?, ?, ?)`,
		).run(deviceId, deviceId, actorId, NOW);
		db.prepare(
			`INSERT INTO scope_memberships(
				scope_id, device_id, role, status, membership_epoch, updated_at
			 ) VALUES ('managed-review', ?, 'member', 'active', 1, ?)`,
		).run(deviceId, NOW);
	}
}

function insertPolicyTeam(
	db: InstanceType<typeof Database>,
	teamId: string,
	status = "active",
): void {
	db.prepare(
		`INSERT INTO policy_teams(
		 team_id, display_name, status, provenance, revision, migration_state,
		 idempotency_key, created_at, updated_at
		 ) VALUES (?, 'Canonical Team', ?, 'test', 'revision', 'projected', ?, ?, ?)`,
	).run(teamId, status, `idempotency-${teamId}`, NOW, NOW);
}

function protectedSnapshot(db: InstanceType<typeof Database>): string {
	const tables = [
		"replication_scopes",
		"project_scope_mappings",
		"scope_memberships",
		"memory_items",
		"replication_ops",
		"replication_cursors",
		"actors",
		"sync_peers",
	];
	return JSON.stringify(
		Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM ${table}`).all()])),
	);
}

describe("recipient policy review fingerprint", () => {
	it("is deterministic and order-insensitive", () => {
		const first = projection();
		const reordered = projection();
		const candidate = reordered.identityCandidates[0];
		if (!candidate) throw new Error("candidate missing");
		reordered.identityCandidates[0] = {
			...candidate,
			provenance: ["local_identity", "personal_scope"],
		};

		expect(recipientPolicyReviewSourceFingerprint(reordered, "suggest_local_identity")).toBe(
			recipientPolicyReviewSourceFingerprint(first, "suggest_local_identity"),
		);
	});

	it("ignores labels and transport-only fields while changing for semantic state", () => {
		const first = projection();
		const renamed = projection();
		renamed.project.displayName = "renamed";
		const candidate = renamed.identityCandidates[0];
		const device = renamed.effectiveDevices[0];
		if (!candidate || !device) throw new Error("projection fixture incomplete");
		renamed.identityCandidates[0] = { ...candidate, displayName: "Renamed" };
		renamed.effectiveDevices[0] = { ...device, displayName: "Renamed device" };
		const baseline = recipientPolicyReviewSourceFingerprint(first, "suggest_local_identity");

		expect(recipientPolicyReviewSourceFingerprint(renamed, "suggest_local_identity")).toBe(
			baseline,
		);
		for (const changed of [
			{ ...projection(), identityCandidates: [] },
			{ ...projection(), effectiveDevices: [] },
			{
				...projection(),
				enforcement: { ...projection().enforcement, currentDeviceIds: ["different-device"] },
			},
		]) {
			expect(recipientPolicyReviewSourceFingerprint(changed, "suggest_local_identity")).not.toBe(
				baseline,
			);
		}
	});

	it("isolates same-name Projects by canonical identity", () => {
		const other = projection();
		other.project.canonicalIdentity = "https://git.example.invalid/other/review.git";

		expect(recipientPolicyReviewSourceFingerprint(other, "suggest_local_identity")).not.toBe(
			recipientPolicyReviewSourceFingerprint(projection(), "suggest_local_identity"),
		);
	});
});

describe("recipient policy review persistence", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		insertLocalFixture(db);
	});

	afterEach(() => db.close());

	it("derives safe exact options and performs no writes under query_only", () => {
		const before = Number(db.prepare("SELECT total_changes()").pluck().get());
		db.pragma("query_only = ON");

		const result = listRecipientPolicyReview(db, context);

		expect(result.continuity).toEqual({
			findingCount: 1,
			state: "legacy_access_preserved",
		});
		expect(result.reviewItems).toHaveLength(1);
		const item = result.reviewItems[0];
		expect(new Set(item?.options.map((option) => option.decision)).size).toBe(item?.options.length);
		expect(item?.options.map((option) => option.decision)).toContain(item?.recommendedDecision);
		for (const option of item?.options ?? []) {
			expect(option.preview).toMatchObject({
				projects: [{ canonicalIdentity: PROJECT_ID }],
				affectedProjectCount: 1,
				affectedMemoryCount: 1,
			});
		}
		expect(Number(db.prepare("SELECT total_changes()").pluck().get())).toBe(before);
		db.pragma("query_only = OFF");
	});

	it("ignores unrelated transport metadata changes in the current source fingerprint", () => {
		db.prepare(
			`INSERT INTO sync_peers(
				peer_device_id, name, public_key, pinned_fingerprint, addresses_json, created_at
			 ) VALUES ('unrelated-peer', 'Peer', 'key-one', 'fingerprint-one', '["address-one"]', ?)`,
		).run(NOW);
		const first = listRecipientPolicyReview(db, context).reviewItems[0]?.sourceFingerprint;

		db.prepare(
			`UPDATE sync_peers SET public_key = 'key-two', pinned_fingerprint = 'fingerprint-two',
			 addresses_json = '["address-two"]', last_seen_at = ? WHERE peer_device_id = 'unrelated-peer'`,
		).run(NOW);

		expect(listRecipientPolicyReview(db, context).reviewItems[0]?.sourceFingerprint).toBe(first);
	});

	it("maps diagnostics to Blocked items without resolve options", () => {
		db.prepare("UPDATE sessions SET git_remote = NULL, cwd = NULL, project = 'display-only'").run();

		const result = listRecipientPolicyReview(db, context);

		expect(result.continuity).toBeNull();
		expect(result.blockedItems[0]).toMatchObject({
			ownerLabel: "Project owner",
			repairAction: expect.any(String),
			repair: {
				kind: "open_project_administration",
				label: "Open Project administration",
			},
		});
		expect(result.blockedItems[0]).not.toHaveProperty("options");
	});

	it("does not offer local recipient-policy repair for peer-received Projects", () => {
		const sessionId = Number(
			db
				.prepare(
					`INSERT INTO sessions(started_at, project, tool_version)
					 VALUES (?, 'peer-only', 'sync_replication')`,
				)
				.run(NOW).lastInsertRowid,
		);
		db.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, active, created_at, updated_at,
				visibility, project, scope_id
			 ) VALUES (?, 'discovery', 'Peer fixture', 'body', 1, ?, ?, 'shared', 'peer-only', 'local-default')`,
		).run(sessionId, NOW, NOW);

		const projections = listLegacyRecipientPolicyProjections(db, context);

		expect(projections).toHaveLength(1);
		expect(projections[0]?.project.canonicalIdentity).toBe(PROJECT_ID);
	});

	it("keeps an ambiguous umbrella scope as continuity without repair cards", () => {
		configureUmbrellaScope(db);

		const projections = listLegacyRecipientPolicyProjections(db, context);
		const result = listRecipientPolicyReview(db, context);

		expect(projections).toHaveLength(2);
		expect(
			projections.every(
				(item) =>
					item.enforcement.state === "ambiguous" &&
					item.enforcement.safeErrorCode === "ambiguous_multi_project_scope",
			),
		).toBe(true);
		expect(result).toMatchObject({
			blockedItems: [],
			continuity: { findingCount: 2, state: "legacy_access_preserved" },
			reviewItems: [],
		});
	});

	it.each([
		"managed_project",
		"future_project_boundary",
	])("keeps a %s multi-project scope repairable", (kind) => {
		configureUmbrellaScope(db, kind);

		const result = listRecipientPolicyReview(db, context);

		expect(result).toMatchObject({
			blockedItems: [
				{
					ownerLabel: "Local administrator",
					repairAction:
						"Assign each Project to its own managed scope and move its memories out of the shared boundary.",
				},
				{
					ownerLabel: "Local administrator",
					repairAction:
						"Assign each Project to its own managed scope and move its memories out of the shared boundary.",
				},
			],
			continuity: null,
			reviewItems: [],
		});
	});

	it("keeps a wildcard scope mapping as continuity without repair cards", () => {
		const scopeId = "legacy-wildcard";
		insertLegacyScope(db, scopeId);
		db.prepare("UPDATE memory_items SET scope_id = ?").run(scopeId);
		mapProject(db, null, "*", scopeId);

		const [legacyProjection] = listLegacyRecipientPolicyProjections(db, context);
		const result = listRecipientPolicyReview(db, context);

		expect(legacyProjection?.enforcement).toMatchObject({
			state: "ambiguous",
			safeErrorCode: "wildcard_scope_mapping",
		});
		expect(result).toMatchObject({
			blockedItems: [],
			continuity: { findingCount: 1, state: "legacy_access_preserved" },
			reviewItems: [],
		});
	});

	it("emits only repairable cards for mixed diagnostics and keeps blocked IDs stable", () => {
		const repairableCondition = {
			version: 1 as const,
			code: "noncanonical_project_identity" as const,
			kind: "diagnostic" as const,
			message: "Project identity is unstable.",
		};
		const mixed = projection();
		mixed.conditions = [
			repairableCondition,
			{
				version: 1,
				code: "ambiguous_multi_project_scope",
				kind: "diagnostic",
				message: "Scope contains multiple Projects.",
				scopeKinds: ["team"],
			},
			...mixed.conditions,
		];
		const repairableOnly = projection();
		repairableOnly.conditions = [repairableCondition];

		const mixedState = deriveRecipientPolicyReviewState(db, context, [mixed]);
		const repairableState = deriveRecipientPolicyReviewState(db, context, [repairableOnly]);

		expect(mixedState.allReviewItems).toEqual([]);
		expect(mixedState.preservedDiagnosticFindings).toEqual([
			{
				canonicalProjectIdentity: PROJECT_ID,
				conditionCode: "ambiguous_multi_project_scope",
			},
		]);
		expect(mixedState.blockedItems).toHaveLength(1);
		expect(mixedState.blockedItems[0]?.blockedItemId).toBe(
			repairableState.blockedItems[0]?.blockedItemId,
		);
	});

	it("keeps synthetic shared compatibility identities out of repair targets", () => {
		const shared = projection();
		shared.project = { version: 1, canonicalIdentity: "shared:default", displayName: "Shared" };
		shared.conditions = [
			{
				version: 1,
				code: "ambiguous_scope_mapping",
				kind: "diagnostic",
				message: "Legacy shared scope remains in compatibility mode.",
			},
		];

		const state = deriveRecipientPolicyReviewState(db, context, [shared]);

		expect(state.blockedItems).toEqual([]);
		expect(state.preservedDiagnosticFindings).toEqual([
			{
				canonicalProjectIdentity: "shared:default",
				conditionCode: "ambiguous_scope_mapping",
			},
		]);
	});

	it("records only the immutable resolution with server-derived attribution", () => {
		const item = listRecipientPolicyReview(db, context).reviewItems[0];
		if (!item) throw new Error("review item missing");
		const before = protectedSnapshot(db);

		const result = resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "keep_current_setup",
		});
		const row = db.prepare("SELECT * FROM recipient_policy_review_resolutions").get() as Record<
			string,
			unknown
		>;

		expect(result).toMatchObject({ status: "applied", idempotent: false });
		expect(row).toMatchObject({
			decision: "keep_current_setup",
			decision_input_json: "{}",
			decided_by_identity_id: LOCAL_ACTOR_ID,
			decided_by_device_id: LOCAL_DEVICE_ID,
			resolved_at: NOW,
		});
		expect(JSON.parse(String(row.preview_json))).toMatchObject({
			projects: [{ canonicalIdentity: PROJECT_ID }],
			effect: "none",
			requiresDecisionInput: false,
		});
		expect(protectedSnapshot(db)).toBe(before);
		const resolvedReview = listRecipientPolicyReview(db, context);
		expect(resolvedReview.reviewItems).toEqual([]);
		expect(resolvedReview.continuity).toBeNull();
	});

	it("rejects stale fingerprints without writing", () => {
		const item = listRecipientPolicyReview(db, context).reviewItems[0];
		if (!item) throw new Error("review item missing");

		const result = resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: "stale",
			decision: "keep_current_setup",
		});

		expect(result.status).toBe("stale");
		expect(
			db.prepare("SELECT COUNT(*) FROM recipient_policy_review_resolutions").pluck().get(),
		).toBe(0);
	});

	it("rejects malformed requests before deriving review state", () => {
		const prepare = vi.spyOn(db, "prepare");
		const malformed = [
			{
				reviewItemId: " ",
				sourceFingerprint: "source-fingerprint",
				decision: "keep_current_setup",
			},
			{
				reviewItemId: "review-item",
				sourceFingerprint: "source-fingerprint",
				decision: "unsupported",
			} as RecipientPolicyReviewResolveRequestV1,
		];

		try {
			expect(
				malformed.map((request) => resolveRecipientPolicyReview(db, context, request)),
			).toEqual([
				expect.objectContaining({ status: "invalid", errorCode: "request_invalid" }),
				expect.objectContaining({ status: "invalid", errorCode: "request_invalid" }),
			]);
			expect(prepare).not.toHaveBeenCalled();
		} finally {
			prepare.mockRestore();
		}
	});

	it("rejects malformed bulk requests before deriving shared review state", () => {
		const prepare = vi.spyOn(db, "prepare");
		const malformed = [
			{
				reviewItemId: " ",
				sourceFingerprint: "source-fingerprint",
				decision: "keep_current_setup",
			},
			{
				reviewItemId: "review-item",
				sourceFingerprint: "source-fingerprint",
				decision: "unsupported",
			} as RecipientPolicyReviewResolveRequestV1,
		];

		try {
			expect(resolveRecipientPolicyReviewBulk(db, context, malformed).results).toEqual([
				expect.objectContaining({ status: "invalid", errorCode: "request_invalid" }),
				expect.objectContaining({ status: "invalid", errorCode: "request_invalid" }),
			]);
			expect(prepare).not.toHaveBeenCalled();
		} finally {
			prepare.mockRestore();
		}
	});

	it.each([
		["deactivated", null],
		["active", "actor-survivor"],
	] as const)("fails closed when the deciding local Identity is %s or merged", (status, merged) => {
		db.prepare("UPDATE actors SET status = ?, merged_into_actor_id = ? WHERE actor_id = ?").run(
			status,
			merged,
			LOCAL_ACTOR_ID,
		);
		const item = listRecipientPolicyReview(db, context).reviewItems[0];
		if (!item) throw new Error("review item missing");

		const result = resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "keep_current_setup",
		});

		expect(result).toMatchObject({ status: "invalid", errorCode: "local_identity_unavailable" });
		expect(
			db.prepare("SELECT COUNT(*) FROM recipient_policy_review_resolutions").pluck().get(),
		).toBe(0);
	});

	it("uses the shared no-op vocabulary for exact review previews", () => {
		const base = projection();
		const firstDevice = base.effectiveDevices[0];
		if (!firstDevice) throw new Error("effective device fixture missing");
		const unassignedProjection: LegacyRecipientPolicyProjectionV1 = {
			...base,
			effectiveDevices: [{ ...firstDevice, identityId: null, assignment: "unassigned" }],
			conditions: [
				{
					version: 1,
					code: "unassigned_effective_device",
					kind: "actionable",
					message: "Review unassigned device",
				},
			],
		};
		const state = deriveRecipientPolicyReviewState(db, context, [base, unassignedProjection]);
		const effects = new Map(
			state.allReviewItems.flatMap((item) =>
				item.options.map((option) => [option.decision, option.effect] as const),
			),
		);

		for (const decision of [
			"keep_current_setup",
			"reject_suggestion",
			"keep_project_local",
			"keep_identities_separate",
			"remove_stale_device",
		] as const) {
			expect(effects.get(decision)).toBe("none");
		}
	});

	it("is idempotent for matching input and fails closed for conflicting re-resolution", () => {
		const item = listRecipientPolicyReview(db, context).reviewItems[0];
		if (!item) throw new Error("review item missing");
		const request = {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "keep_current_setup" as const,
		};

		expect(resolveRecipientPolicyReview(db, context, request).status).toBe("applied");
		expect(resolveRecipientPolicyReview(db, context, request)).toMatchObject({
			status: "applied",
			idempotent: true,
		});
		expect(
			resolveRecipientPolicyReview(db, context, { ...request, decision: "reject_suggestion" })
				.status,
		).toBe("conflict");
		expect(
			db.prepare("SELECT COUNT(*) FROM recipient_policy_review_resolutions").pluck().get(),
		).toBe(1);
	});

	it("keeps durable no-op history through memory churn and reopens on semantic change", () => {
		const item = listRecipientPolicyReview(db, context).reviewItems[0];
		if (!item) throw new Error("review item missing");
		resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision: "reject_suggestion",
		});
		db.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, active, created_at, updated_at, visibility, project, scope_id
			 ) SELECT session_id, 'discovery', 'second', 'changed payload', 1, ?, ?, visibility, project,
				scope_id FROM memory_items LIMIT 1`,
		).run(NOW, NOW);
		expect(listRecipientPolicyReview(db, context).reviewItems).toEqual([]);
		db.prepare("UPDATE actors SET status = 'deactivated', updated_at = ? WHERE actor_id = ?").run(
			NOW,
			LOCAL_ACTOR_ID,
		);

		const reopened = listRecipientPolicyReview(db, context).reviewItems.find(
			(candidate) => candidate.reviewItemId === item.reviewItemId,
		);

		expect(reopened?.reviewItemId).toBe(item.reviewItemId);
		expect(reopened?.sourceFingerprint).not.toBe(item.sourceFingerprint);
		expect(
			db.prepare("SELECT COUNT(*) FROM recipient_policy_review_resolutions").pluck().get(),
		).toBe(1);
	});

	it("validates decision input and resolves bulk items independently in request order", () => {
		const item = listRecipientPolicyReview(db, context).reviewItems[0];
		if (!item) throw new Error("review item missing");
		expect(
			resolveRecipientPolicyReview(db, context, {
				reviewItemId: item.reviewItemId,
				sourceFingerprint: item.sourceFingerprint,
				decision: "choose_recipients",
				decisionInput: { recipientIds: [LOCAL_ACTOR_ID, LOCAL_ACTOR_ID] },
			}),
		).toMatchObject({ status: "invalid", errorCode: "decision_input_invalid" });
		const duplicate = { ...item, reviewItemId: "duplicate" };
		const result = resolveRecipientPolicyReviewBulk(db, context, [
			{
				reviewItemId: item.reviewItemId,
				sourceFingerprint: item.sourceFingerprint,
				decision: "keep_current_setup",
			},
			{
				reviewItemId: duplicate.reviewItemId,
				sourceFingerprint: duplicate.sourceFingerprint,
				decision: "keep_current_setup",
			},
			{
				reviewItemId: duplicate.reviewItemId,
				sourceFingerprint: duplicate.sourceFingerprint,
				decision: "keep_current_setup",
			},
		]);

		expect(result.results.map((entry) => entry.status)).toEqual(["applied", "invalid", "invalid"]);
		expect(result.results.map((entry) => entry.errorCode)).toEqual([
			null,
			"duplicate_review_item_id",
			"duplicate_review_item_id",
		]);
		expect(
			db.prepare("SELECT COUNT(*) FROM recipient_policy_review_resolutions").pluck().get(),
		).toBe(1);
	});

	it("batches saved-resolution existence checks while preserving open-item order", () => {
		configureUnassignedDeviceReview(db, [
			"device-unassigned-a",
			"device-unassigned-b",
			"device-unassigned-c",
		]);
		const initial = listRecipientPolicyReview(db, context).reviewItems;
		const resolved = initial[1];
		if (!resolved) throw new Error("saved resolution fixture incomplete");
		db.prepare(
			`INSERT INTO recipient_policy_review_resolutions(
			 review_item_id, source_fingerprint, decision, decision_input_json, preview_json,
			 decided_by_identity_id, decided_by_device_id, resolved_at
			 ) VALUES (?, ?, 'keep_current_setup', '{}', '{}', ?, ?, ?)`,
		).run(resolved.reviewItemId, resolved.sourceFingerprint, LOCAL_ACTOR_ID, LOCAL_DEVICE_ID, NOW);
		const prepare = vi.spyOn(db, "prepare");
		try {
			const listed = listRecipientPolicyReview(db, context);

			expect(listed.reviewItems.map((item) => item.reviewItemId)).toEqual([
				initial[0]?.reviewItemId,
				initial[2]?.reviewItemId,
			]);
			expect(
				prepare.mock.calls.filter(([sql]) =>
					/SELECT review_item_id, source_fingerprint, decision, decision_input_json\s+FROM recipient_policy_review_resolutions/u.test(
						String(sql),
					),
				),
			).toHaveLength(1);
		} finally {
			prepare.mockRestore();
		}
	});

	it("derives bulk review state once and isolates constraint failures by request", () => {
		configureUnassignedDeviceReview(db, [
			"device-unassigned-a",
			"device-unassigned-b",
			"device-unassigned-c",
		]);
		const items = listRecipientPolicyReview(db, context).reviewItems;
		const [first, blocked, third] = items;
		if (!first || !blocked || !third) throw new Error("bulk review fixture incomplete");
		db.exec(`CREATE TRIGGER reject_one_review_resolution
			BEFORE INSERT ON recipient_policy_review_resolutions
			WHEN NEW.review_item_id = '${blocked.reviewItemId.replaceAll("'", "''")}'
			BEGIN SELECT RAISE(ABORT, 'test conflict'); END;`);
		const prepare = vi.spyOn(db, "prepare");
		try {
			const result = resolveRecipientPolicyReviewBulk(
				db,
				context,
				[first, blocked, third].map((item) => ({
					reviewItemId: item.reviewItemId,
					sourceFingerprint: item.sourceFingerprint,
					decision: "keep_current_setup" as const,
				})),
			);

			expect(
				result.results.map(({ reviewItemId, status, errorCode }) => ({
					reviewItemId,
					status,
					errorCode,
				})),
			).toEqual([
				{ reviewItemId: first.reviewItemId, status: "applied", errorCode: null },
				{
					reviewItemId: blocked.reviewItemId,
					status: "conflict",
					errorCode: "review_resolution_conflict",
				},
				{ reviewItemId: third.reviewItemId, status: "applied", errorCode: null },
			]);
			expect(
				db
					.prepare("SELECT review_item_id FROM recipient_policy_review_resolutions ORDER BY rowid")
					.pluck()
					.all(),
			).toEqual([first.reviewItemId, third.reviewItemId]);
			expect(
				prepare.mock.calls.filter(([sql]) =>
					/FROM memory_items mi\s+JOIN sessions s ON s.id = mi.session_id/u.test(String(sql)),
				),
			).toHaveLength(1);
			expect(
				prepare.mock.calls.filter(([sql]) =>
					/SELECT review_item_id, source_fingerprint, decision, decision_input_json\s+FROM recipient_policy_review_resolutions/u.test(
						String(sql),
					),
				),
			).toHaveLength(1);
		} finally {
			prepare.mockRestore();
		}
	});

	it("rolls back all savepoint writes when the outer bulk commit loses its lock", () => {
		const directory = mkdtempSync(join(tmpdir(), "codemem-recipient-review-bulk-"));
		const path = join(directory, "review.sqlite");
		const primary = new Database(path);
		const competing = new Database(path);
		try {
			primary.pragma("journal_mode = DELETE");
			primary.pragma("busy_timeout = 1");
			initTestSchema(primary);
			insertLocalFixture(primary);
			configureUnassignedDeviceReview(primary, [
				"device-unassigned-a",
				"device-unassigned-b",
				"device-unassigned-c",
			]);
			const items = listRecipientPolicyReview(primary, context).reviewItems;
			const [first, second, third] = items;
			if (!first || !second || !third) throw new Error("bulk lock fixture incomplete");
			primary
				.prepare(
					`INSERT INTO recipient_policy_review_resolutions(
					 review_item_id, source_fingerprint, decision, decision_input_json, preview_json,
					 decided_by_identity_id, decided_by_device_id, resolved_at
					 ) VALUES (?, ?, 'keep_current_setup', '{}', '{}', ?, ?, ?)`,
				)
				.run(third.reviewItemId, third.sourceFingerprint, LOCAL_ACTOR_ID, LOCAL_DEVICE_ID, NOW);
			const duplicate = {
				reviewItemId: "duplicate-review-item",
				sourceFingerprint: "duplicate-source",
				decision: "keep_current_setup" as const,
			};
			const requests: RecipientPolicyReviewResolveRequestV1[] = [
				{
					reviewItemId: first.reviewItemId,
					sourceFingerprint: first.sourceFingerprint,
					decision: "keep_current_setup",
				},
				duplicate,
				{
					reviewItemId: second.reviewItemId,
					sourceFingerprint: "stale-fingerprint",
					decision: "keep_current_setup",
				},
				duplicate,
				{
					reviewItemId: "missing-review-item",
					sourceFingerprint: "missing-source",
					decision: "keep_current_setup",
				},
				{
					reviewItemId: "invalid-review-item",
					sourceFingerprint: "invalid-source",
					decision: "unsupported",
				} as RecipientPolicyReviewResolveRequestV1,
				{
					reviewItemId: third.reviewItemId,
					sourceFingerprint: third.sourceFingerprint,
					decision: "keep_current_setup",
				},
			];
			competing.exec("BEGIN");
			competing.prepare("SELECT COUNT(*) FROM recipient_policy_review_resolutions").get();
			const changesBefore = Number(primary.prepare("SELECT total_changes()").pluck().get());

			const result = resolveRecipientPolicyReviewBulk(primary, context, requests);

			expect(result.results.map((entry) => [entry.status, entry.errorCode])).toEqual([
				["conflict", "review_resolution_conflict"],
				["invalid", "duplicate_review_item_id"],
				["stale", "source_fingerprint_stale"],
				["invalid", "duplicate_review_item_id"],
				["not_found", "review_item_not_found"],
				["invalid", "request_invalid"],
				["applied", null],
			]);
			expect(result.results.at(-1)?.idempotent).toBe(true);
			// SQLite counts executed writes even when the enclosing transaction is
			// rolled back, proving the write request completed before COMMIT
			// lost the competing reader lock.
			expect(Number(primary.prepare("SELECT total_changes()").pluck().get()) - changesBefore).toBe(
				1,
			);
			expect(primary.inTransaction).toBe(false);
			competing.exec("ROLLBACK");
			expect(
				primary.prepare("SELECT COUNT(*) FROM recipient_policy_review_resolutions").pluck().get(),
			).toBe(1);
		} finally {
			if (competing.inTransaction) competing.exec("ROLLBACK");
			primary.close();
			competing.close();
			rmSync(directory, { force: true, recursive: true });
		}
	});

	it("retains earlier non-write results when a later request aborts the outer transaction", () => {
		configureUnassignedDeviceReview(db, ["device-unassigned-a", "device-unassigned-b"]);
		const [first, second] = listRecipientPolicyReview(db, context).reviewItems;
		if (!first || !second) throw new Error("bulk rollback fixture incomplete");
		db.exec(`CREATE TRIGGER rollback_second_review
			BEFORE INSERT ON recipient_policy_review_resolutions
			WHEN NEW.review_item_id = '${second.reviewItemId}'
			BEGIN
				SELECT RAISE(ROLLBACK, 'forced rollback');
			END`);

		const result = resolveRecipientPolicyReviewBulk(db, context, [
			{
				reviewItemId: first.reviewItemId,
				sourceFingerprint: "stale-fingerprint",
				decision: "keep_current_setup",
			},
			{
				reviewItemId: second.reviewItemId,
				sourceFingerprint: second.sourceFingerprint,
				decision: "keep_current_setup",
			},
		]);

		expect(result.results.map((entry) => [entry.status, entry.errorCode])).toEqual([
			["stale", "source_fingerprint_stale"],
			["conflict", "review_resolution_conflict"],
		]);
		expect(db.inTransaction).toBe(false);
		expect(
			db.prepare("SELECT COUNT(*) FROM recipient_policy_review_resolutions").pluck().get(),
		).toBe(0);
	});

	it("preserves invalid preflight results when the outer bulk begin is busy", () => {
		const directory = mkdtempSync(join(tmpdir(), "codemem-recipient-review-bulk-begin-"));
		const path = join(directory, "review.sqlite");
		const primary = new Database(path);
		const competing = new Database(path);
		try {
			primary.pragma("busy_timeout = 1");
			initTestSchema(primary);
			insertLocalFixture(primary);
			configureUnassignedDeviceReview(primary, ["device-unassigned-a"]);
			const item = listRecipientPolicyReview(primary, context).reviewItems[0];
			if (!item) throw new Error("bulk begin lock fixture incomplete");
			competing.exec("BEGIN IMMEDIATE");

			const result = resolveRecipientPolicyReviewBulk(primary, context, [
				{
					reviewItemId: "invalid-review-item",
					sourceFingerprint: "invalid-source",
					decision: "unsupported",
				} as RecipientPolicyReviewResolveRequestV1,
				{
					reviewItemId: item.reviewItemId,
					sourceFingerprint: item.sourceFingerprint,
					decision: "keep_current_setup",
				},
			]);

			expect(result.results.map((entry) => [entry.status, entry.errorCode])).toEqual([
				["invalid", "request_invalid"],
				["conflict", "review_resolution_conflict"],
			]);
			expect(primary.inTransaction).toBe(false);
			expect(
				primary.prepare("SELECT COUNT(*) FROM recipient_policy_review_resolutions").pluck().get(),
			).toBe(0);
		} finally {
			if (competing.inTransaction) competing.exec("ROLLBACK");
			primary.close();
			competing.close();
			rmSync(directory, { force: true, recursive: true });
		}
	});

	it("rejects unresolved legacy Team candidates but accepts active canonical Teams", () => {
		const scopeId = "legacy-team-review";
		insertLegacyScope(db, scopeId);
		db.prepare("UPDATE memory_items SET scope_id = ?").run(scopeId);
		mapProject(db, PROJECT_ID, PROJECT_ID, scopeId);
		db.prepare(
			`INSERT INTO sync_peers(peer_device_id, name, actor_id, created_at)
			 VALUES ('legacy-team-device', 'Legacy Team device', ?, ?)`,
		).run(LOCAL_ACTOR_ID, NOW);
		db.prepare(
			`INSERT INTO scope_memberships(scope_id, device_id, status, membership_epoch, updated_at)
			 VALUES (?, 'legacy-team-device', 'active', 1, ?)`,
		).run(scopeId, NOW);
		const projection = listLegacyRecipientPolicyProjections(db, context)[0];
		const teamCandidateId = projection?.teamCandidates[0]?.teamCandidateId;
		const item = listRecipientPolicyReview(db, context).reviewItems.find((candidate) =>
			candidate.options.some((option) => option.decision === "choose_recipients"),
		);
		if (!teamCandidateId || !item) throw new Error("legacy Team review fixture incomplete");

		expect(
			resolveRecipientPolicyReview(db, context, {
				reviewItemId: item.reviewItemId,
				sourceFingerprint: item.sourceFingerprint,
				decision: "choose_recipients",
				decisionInput: { recipientIds: [teamCandidateId] },
			}),
		).toMatchObject({ status: "invalid", errorCode: "decision_input_invalid" });

		const readyTeamId = deterministicPolicyTeamId(teamCandidateId);
		insertPolicyTeam(db, readyTeamId);
		expect(
			resolveRecipientPolicyReview(db, context, {
				reviewItemId: item.reviewItemId,
				sourceFingerprint: item.sourceFingerprint,
				decision: "choose_recipients",
				decisionInput: { recipientIds: [readyTeamId] },
			}),
		).toMatchObject({ status: "invalid", errorCode: "decision_input_invalid" });
		db.prepare(
			`UPDATE policy_teams
			 SET device_eligibility_mode = 'reviewed_allowlist', source_fingerprint = 'roster-ready'
			 WHERE team_id = ?`,
		).run(readyTeamId);
		db.prepare(
			`INSERT INTO legacy_team_setup_drafts(
			 attempt_id, candidate_id, coordinator_id, group_id, state, display_name,
			 roster_fingerprint, projection_fingerprint, finish_digest, completed_team_id,
			 created_at, updated_at, completed_at
			 ) VALUES ('ready-attempt', ?, 'coordinator', 'group', 'completed', 'Ready Team',
			 'roster-ready', 'projection-ready', 'finish-ready', ?, ?, ?, ?)`,
		).run(teamCandidateId, readyTeamId, NOW, NOW, NOW);
		expect(deriveSelectableRecipientIds(db, projection).teams.has(readyTeamId)).toBe(true);

		// Canonical drift after completion (a decision row the completed draft
		// never reviewed) makes the Team unselectable even though the header
		// fingerprint still matches.
		db.prepare(
			`INSERT INTO policy_team_device_decisions(
			 team_id, device_id, decision, assignment_version, provenance, revision,
			 created_at, updated_at
			 ) VALUES (?, 'device-drifted', 'included', 0, 'test', 'r1', ?, ?)`,
		).run(readyTeamId, NOW, NOW);
		expect(deriveSelectableRecipientIds(db, projection).teams.has(readyTeamId)).toBe(false);
		db.prepare("DELETE FROM policy_team_device_decisions WHERE team_id = ?").run(readyTeamId);
		expect(deriveSelectableRecipientIds(db, projection).teams.has(readyTeamId)).toBe(true);

		// A legacy materialization for a different candidate is excluded globally
		// even though it is an active Team and absent from this projection.
		const foreignLegacyTeamId = deterministicPolicyTeamId("legacy-team-candidate:other");
		db.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, device_eligibility_mode, provenance, revision,
			 migration_state, source_fingerprint, idempotency_key, created_at, updated_at
			 ) VALUES (?, 'Foreign Legacy Team', 'active', 'person_all_devices',
			 'reviewed_team_candidate', 'r1', 'projected', 'foreign-source', 'foreign-team', ?, ?)`,
		).run(foreignLegacyTeamId, NOW, NOW);
		const selectable = deriveSelectableRecipientIds(db, projection);
		expect(selectable.teams.has(foreignLegacyTeamId)).toBe(false);
		expect(
			resolveRecipientPolicyReview(db, context, {
				reviewItemId: item.reviewItemId,
				sourceFingerprint: item.sourceFingerprint,
				decision: "choose_recipients",
				decisionInput: { recipientIds: [foreignLegacyTeamId] },
			}),
		).toMatchObject({ status: "invalid", errorCode: "decision_input_invalid" });

		insertPolicyTeam(db, "canonical-team");
		expect(
			resolveRecipientPolicyReview(db, context, {
				reviewItemId: item.reviewItemId,
				sourceFingerprint: item.sourceFingerprint,
				decision: "choose_recipients",
				decisionInput: { recipientIds: ["canonical-team"] },
			}),
		).toMatchObject({ status: "applied", errorCode: null });
	});

	it.each([
		[
			"attach_device_to_identity",
			{ deviceId: "device-unassigned", identityId: "actor-candidate" },
			'{"deviceId":"device-unassigned","identityId":"actor-candidate"}',
		],
		[
			"create_identity",
			{ deviceId: "device-unassigned", displayName: "  New Identity  " },
			'{"deviceId":"device-unassigned","displayName":"New Identity"}',
		],
		[
			"choose_recipients",
			{ recipientIds: ["actor-candidate"] },
			'{"recipientIds":["actor-candidate"]}',
		],
		["remove_stale_device", { deviceId: "device-unassigned" }, '{"deviceId":"device-unassigned"}'],
	] as const)("normalizes and stores %s decision input", (decision, decisionInput, expectedJson) => {
		configureUnassignedDeviceReview(db);
		const item = listRecipientPolicyReview(db, context).reviewItems.find((candidate) =>
			candidate.options.some((option) => option.decision === decision),
		);
		if (!item) throw new Error("unassigned review item missing");

		const result = resolveRecipientPolicyReview(db, context, {
			reviewItemId: item.reviewItemId,
			sourceFingerprint: item.sourceFingerprint,
			decision,
			decisionInput,
		});

		expect(result.status).toBe("applied");
		expect(
			db
				.prepare("SELECT decision_input_json FROM recipient_policy_review_resolutions")
				.pluck()
				.get(),
		).toBe(expectedJson);
	});

	it("keeps unassigned-device resolutions durable and scoped to one device", () => {
		configureUnassignedDeviceReview(db, ["device-unassigned-a", "device-unassigned-b"]);
		const initial = listRecipientPolicyReview(db, context).reviewItems;
		expect(initial).toHaveLength(2);
		const first = initial.find((item) =>
			item.options.some((option) =>
				option.preview.effectiveDevices.some((device) => device.deviceId === "device-unassigned-a"),
			),
		);
		if (!first) throw new Error("first unassigned-device review item missing");
		const request = {
			reviewItemId: first.reviewItemId,
			sourceFingerprint: first.sourceFingerprint,
			decision: "keep_current_setup" as const,
		};

		expect(resolveRecipientPolicyReview(db, context, request)).toMatchObject({
			status: "applied",
			idempotent: false,
		});
		expect(resolveRecipientPolicyReview(db, context, request)).toMatchObject({
			status: "applied",
			idempotent: true,
		});
		const remaining = listRecipientPolicyReview(db, context).reviewItems;
		expect(remaining).toHaveLength(1);
		expect(remaining[0]?.options[0]?.preview.effectiveDevices).toEqual([
			expect.objectContaining({ deviceId: "device-unassigned-b" }),
		]);
		expect(
			db.prepare("SELECT COUNT(*) FROM recipient_policy_review_resolutions").pluck().get(),
		).toBe(1);
	});
});
