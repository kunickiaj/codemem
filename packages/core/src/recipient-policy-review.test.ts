import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LegacyRecipientPolicyProjectionV1 } from "./legacy-recipient-policy-projection.js";
import {
	listRecipientPolicyReview,
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

		expect(result.blockedItems[0]).toMatchObject({
			ownerLabel: "Project owner",
			repairAction: expect.any(String),
		});
		expect(result.blockedItems[0]).not.toHaveProperty("options");
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
		expect(listRecipientPolicyReview(db, context).reviewItems).toEqual([]);
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

	it("fails closed when the deciding local Identity is unavailable", () => {
		db.prepare("UPDATE actors SET status = 'deactivated' WHERE actor_id = ?").run(LOCAL_ACTOR_ID);
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
