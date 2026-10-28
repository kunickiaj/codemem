import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as legacyTeamCandidate from "./legacy-team-candidate.js";
import {
	applyLegacyTeamSetupCompletionManifest,
	deriveLegacyTeamSetupCompletionManifest,
} from "./legacy-team-setup-completion-manifest.js";
import {
	diagnoseLegacyTeamSetupCompletion,
	legacyTeamSetupFailureCheck,
} from "./legacy-team-setup-diagnosis.js";
import {
	getLegacyTeamSetupDraft,
	refreshLegacyTeamSetupDraft,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
} from "./legacy-team-setup-draft.js";
import { legacyTeamCandidateId, legacyTeamProjectRef } from "./recipient-policy-identifiers.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-09-01T12:00:00.000Z";
const COORDINATOR_ID = "coordinator-private";
const GROUP_ID = "group-private";
const CANDIDATE = legacyTeamCandidateId(COORDINATOR_ID, GROUP_ID);
const PROJECT_A = "https://git.example.invalid/acme/api.git";
const PROJECT_B = "https://git.example.invalid/acme/web.git";
const KEY_A = "a".repeat(64);
const PROJECTION = { localActorId: "identity-a", localDeviceId: "device-a" };
const FRESH_ROSTER = [
	{ deviceId: "device-a", fingerprint: KEY_A, displayName: "Laptop", enabled: true },
];

describe("legacy Team setup failure causes", () => {
	it("prefers the innermost check over reconciliation wrappers", () => {
		// Arrange: public-code wrappers must not replace the original failing check.
		const original = new Error("team_setup_completion_invalid");
		original.stack = [
			"Error: team_setup_completion_invalid",
			"    at fail (/repo/dist/legacy-team-setup-completion-manifest.js:140:8)",
			"    at requireIncludedDeviceEvidence (/repo/dist/legacy-team-setup-completion-manifest.js:930:8)",
		].join("\n");
		const intermediate = new Error("team_setup_completion_invalid", { cause: original });
		intermediate.stack =
			"Error: team_setup_completion_invalid\n    at applyCanonicalManifest (/repo/dist/team-setup.js:1700:8)";
		const wrapper = new Error("team_setup_completion_invalid", { cause: intermediate });
		wrapper.stack =
			"Error: team_setup_completion_invalid\n    at reconcileCompletions (/repo/dist/team-setup.js:2200:8)";

		// Act.
		const check = legacyTeamSetupFailureCheck(wrapper);

		// Assert.
		expect(check).toBe(
			"requireIncludedDeviceEvidence (legacy-team-setup-completion-manifest.js:930)",
		);
	});

	it.each([undefined, "upstream detail", new Error("no stack")])(
		"falls back to the wrapper when its cause has no usable frame: %s",
		(cause) => {
			// Arrange.
			if (cause instanceof Error) cause.stack = "Error: no stack";
			const wrapper = new Error("team_setup_completion_invalid", { cause });
			wrapper.stack =
				"Error: team_setup_completion_invalid\n    at reconcileCompletions (/repo/dist/team-setup.js:2200:8)";

			// Act.
			const check = legacyTeamSetupFailureCheck(wrapper);

			// Assert.
			expect(check).toBe("reconcileCompletions (team-setup.js:2200)");
		},
	);

	it("finds the deepest check in a cyclic cause chain", () => {
		// Arrange: cycles must terminate without losing the original check.
		const wrapper = new Error("team_setup_completion_invalid");
		wrapper.stack =
			"Error: team_setup_completion_invalid\n    at reconcileCompletions (/repo/dist/team-setup.js:2200:8)";
		const original = new Error("team_setup_completion_invalid", { cause: wrapper });
		original.stack =
			"Error: team_setup_completion_invalid\n    at validateLegacyTeamSetupCompletionManifest (/repo/dist/legacy-team-setup-completion-manifest.js:430:8)";
		wrapper.cause = original;

		// Act.
		const check = legacyTeamSetupFailureCheck(wrapper);

		// Assert.
		expect(check).toBe(
			"validateLegacyTeamSetupCompletionManifest (legacy-team-setup-completion-manifest.js:430)",
		);
	});

	it("returns no check for a self-referential cause without stack frames", () => {
		// Arrange.
		const error = new Error("team_setup_completion_invalid");
		error.stack = "Error: team_setup_completion_invalid";
		error.cause = error;

		// Act.
		const check = legacyTeamSetupFailureCheck(error);

		// Assert.
		expect(check).toBeNull();
	});
});

function insertScope(db: InstanceType<typeof Database>, scopeId: string): void {
	db.prepare(
		`INSERT INTO replication_scopes(
		 scope_id, label, kind, authority_type, coordinator_id, group_id,
		 membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, 'team', 'coordinator', ?, ?, 1, 'active', ?, ?)`,
	).run(scopeId, scopeId, COORDINATOR_ID, GROUP_ID, NOW, NOW);
}

function project(identity: string, scopeId: string) {
	return {
		projectRef: legacyTeamProjectRef(CANDIDATE, identity),
		sourceProjectIdentity: identity,
		displayName: identity,
		sourceFingerprint: `source-${scopeId}`,
		deterministicProjectIdentity: identity,
		targetScopeId: scopeId,
	};
}

function completedManifest(db: InstanceType<typeof Database>) {
	const input = {
		candidateId: CANDIDATE,
		coordinatorId: COORDINATOR_ID,
		groupId: GROUP_ID,
		displayName: "Engineering",
		devices: FRESH_ROSTER,
		projects: [project(PROJECT_A, "scope-engineering"), project(PROJECT_B, "scope-personal")],
	};
	let draft = refreshLegacyTeamSetupDraft(db, { ...input, now: NOW });
	const device = draft.devices[0];
	if (!device) throw new Error("missing test device");
	draft = setLegacyTeamSetupDeviceAssignment(db, {
		attemptId: draft.attemptId,
		deviceRef: device.deviceRef,
		targetIdentityId: "identity-a",
		expectation: device.expectation,
		now: NOW,
	});
	draft = setLegacyTeamSetupDeviceDecision(db, {
		attemptId: draft.attemptId,
		deviceRef: device.deviceRef,
		decision: "included",
		now: NOW,
	});
	const manifest = deriveLegacyTeamSetupCompletionManifest(db, {
		candidateRef: CANDIDATE,
		attemptId: draft.attemptId,
		completedAt: NOW,
	});
	refreshLegacyTeamSetupDraft(db, { ...input, now: "2026-09-01T12:01:00.000Z" });
	return manifest;
}

function policySnapshot(db: InstanceType<typeof Database>) {
	const tables = db
		.prepare(
			"SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
		)
		.all() as { name: string }[];
	return tables.map(({ name }) => [
		name,
		db
			.prepare(`SELECT * FROM "${name}"`)
			.all()
			.map((row) => JSON.stringify(row))
			.sort(),
	]);
}

function freshDiscoveryFixture() {
	const db = new Database(":memory:");
	initTestSchema(db);
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES ('identity-a', 'Person A', 1, 'active', ?, ?)`,
	).run(NOW, NOW);
	insertScope(db, "scope-engineering");
	db.prepare(
		`INSERT INTO project_scope_mappings(
		 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
		 ) VALUES (?, ?, 'scope-engineering', 1000, 'test', ?, ?)`,
	).run(PROJECT_A, PROJECT_A, NOW, NOW);
	const session = db
		.prepare(
			"INSERT INTO sessions(started_at, project, git_remote, git_branch) VALUES (?, 'api', ?, 'main')",
		)
		.run(NOW, PROJECT_A).lastInsertRowid;
	db.prepare(
		`INSERT INTO memory_items(
		 session_id, kind, title, body_text, active, created_at, updated_at, visibility, project, scope_id
		 ) VALUES (?, 'discovery', 'API', 'body', 1, ?, ?, 'shared', 'api', 'scope-engineering')`,
	).run(session, NOW, NOW);
	return db;
}

function discover(db: InstanceType<typeof Database>) {
	return legacyTeamCandidate.discoverLegacyTeamCandidates(db, {
		projection: PROJECTION,
		groups: [
			{
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				displayName: "Engineering",
				devices: FRESH_ROSTER,
			},
		],
		now: NOW,
	});
}

function discoveredManifest() {
	const db = freshDiscoveryFixture();
	try {
		discover(db);
		let draft = getLegacyTeamSetupDraft(db, CANDIDATE);
		const device = draft?.devices[0];
		if (!draft || !device) throw new Error("missing discovered test device");
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			targetIdentityId: "identity-a",
			expectation: device.expectation,
			now: NOW,
		});
		setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			decision: "included",
			now: NOW,
		});
		return deriveLegacyTeamSetupCompletionManifest(db, {
			candidateRef: CANDIDATE,
			attemptId: draft.attemptId,
			completedAt: NOW,
		});
	} finally {
		db.close();
	}
}

describe("legacy Team setup completion diagnosis", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-a', 'Person A', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		insertScope(db, "scope-engineering");
		insertScope(db, "scope-personal");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		db.close();
	});

	it("reports what the apply would grant without changing the database", async () => {
		// Arrange: an existing reviewed draft must not be refreshed by diagnosis.
		const manifest = completedManifest(db);
		db.prepare("UPDATE replication_scopes SET status = 'archived' WHERE scope_id = ?").run(
			"scope-personal",
		);
		const before = policySnapshot(db);
		const discovery = vi.spyOn(legacyTeamCandidate, "discoverLegacyTeamCandidates");

		// Act.
		const diagnosis = await diagnoseLegacyTeamSetupCompletion(db, {
			projection: PROJECTION,
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			completionManifest: manifest,
			freshRoster: FRESH_ROSTER,
		});

		// Assert.
		expect(diagnosis).toMatchObject({
			candidateRef: CANDIDATE,
			completedAt: NOW,
			manifest: { ok: true, projectMappings: 2 },
			unavailableScopeIds: ["scope-personal"],
			localCompletion: { ok: false, code: "team_setup_completion_invalid" },
			apply: { ok: true, teamStatus: "active", migrationState: "completed", grantedProjects: 1 },
		});
		expect(policySnapshot(db)).toEqual(before);
		expect(discovery).not.toHaveBeenCalled();
		expect(db.inTransaction).toBe(false);
	});

	it("names the check that rejects the completion", async () => {
		// Arrange.
		const manifest = completedManifest(db);
		const before = policySnapshot(db);

		// Act.
		const diagnosis = await diagnoseLegacyTeamSetupCompletion(db, {
			projection: PROJECTION,
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			completionManifest: manifest,
			freshRoster: [{ ...FRESH_ROSTER[0], fingerprint: "b".repeat(64) }],
		});

		// Assert.
		expect(diagnosis.apply).toMatchObject({
			ok: false,
			code: "team_setup_completion_invalid",
		});
		expect(diagnosis.apply?.ok === false && diagnosis.apply.check).toMatch(
			/^requireIncludedDeviceEvidence \(legacy-team-setup-completion-manifest\.[jt]s:\d+\)$/u,
		);
		expect(policySnapshot(db)).toEqual(before);
		expect(db.inTransaction).toBe(false);
	});

	it("reports a group without a coordinator completion", async () => {
		// Arrange: no coordinator manifest or local draft exists.
		const before = policySnapshot(db);

		// Act.
		const diagnosis = await diagnoseLegacyTeamSetupCompletion(db, {
			projection: PROJECTION,
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			completionManifest: null,
			freshRoster: FRESH_ROSTER,
		});

		// Assert.
		expect(diagnosis).toMatchObject({
			manifest: { ok: false, code: "coordinator_completion_absent" },
			apply: null,
		});
		expect(policySnapshot(db)).toEqual(before);
	});

	it("skips the internal failure helper when naming a check", () => {
		const error = new Error("team_setup_completion_invalid");
		error.stack = [
			"Error: team_setup_completion_invalid",
			"    at fail (/repo/dist/legacy-team-setup-completion-manifest.js:140:8)",
			"    at rewriteDraftRowsFromManifest (/repo/dist/legacy-team-setup-completion-manifest.js:765:15)",
		].join("\n");

		expect(legacyTeamSetupFailureCheck(error)).toBe(
			"rewriteDraftRowsFromManifest (legacy-team-setup-completion-manifest.js:765)",
		);
	});
});

describe("legacy Team setup diagnosis before draft discovery", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = freshDiscoveryFixture();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		db.close();
	});

	it("predicts the same successful completion as discovery and apply without persisting discovery", async () => {
		// Arrange: the coordinator's winner was derived independently of either fresh local database.
		const manifest = discoveredManifest();
		const viewerDb = freshDiscoveryFixture();
		const before = policySnapshot(db);
		expect(getLegacyTeamSetupDraft(db, CANDIDATE)).toBeNull();
		try {
			// Act: compare diagnosis with the viewer's real discovery-then-apply path.
			const diagnosis = await diagnoseLegacyTeamSetupCompletion(db, {
				projection: PROJECTION,
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				completionManifest: manifest,
				freshRoster: FRESH_ROSTER,
			});
			discover(viewerDb);
			await applyLegacyTeamSetupCompletionManifest(viewerDb, {
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				manifest,
				freshRoster: FRESH_ROSTER,
			});
			const team = viewerDb
				.prepare(
					"SELECT status AS teamStatus, migration_state AS migrationState FROM policy_teams WHERE team_id = ?",
				)
				.get(manifest.team_id) as { teamStatus: string; migrationState: string };
			const grantedProjects = viewerDb
				.prepare(
					"SELECT COUNT(*) FROM project_recipients WHERE recipient_kind = 'team' AND recipient_id = ? AND status = 'active'",
				)
				.pluck()
				.get(manifest.team_id);

			// Assert: all discovery and policy writes, including actors and mappings, roll back.
			expect(diagnosis.manifest).toEqual({ ok: true, projectMappings: 1 });
			expect(diagnosis.apply).toEqual({
				ok: true,
				teamStatus: "active",
				migrationState: "completed",
				grantedProjects: 1,
			});
			expect(diagnosis.apply).toEqual({ ok: true, ...team, grantedProjects });
			expect(discover(viewerDb)).toMatchObject([{ candidateRef: CANDIDATE, status: "ready" }]);
			expect(getLegacyTeamSetupDraft(db, CANDIDATE)).toBeNull();
			expect(db.prepare("SELECT * FROM policy_teams").all()).toEqual([]);
			expect(policySnapshot(db)).toEqual(before);
			expect(db.inTransaction).toBe(false);
		} finally {
			viewerDb.close();
		}
	});

	it("still rejects a genuinely changed included key and rolls back the newly discovered draft", async () => {
		// Arrange: discovery must not turn mismatched authenticated evidence into a valid completion.
		const manifest = discoveredManifest();
		const before = policySnapshot(db);

		// Act.
		const diagnosis = await diagnoseLegacyTeamSetupCompletion(db, {
			projection: PROJECTION,
			coordinatorId: COORDINATOR_ID,
			groupId: GROUP_ID,
			completionManifest: manifest,
			freshRoster: [{ ...FRESH_ROSTER[0], fingerprint: "b".repeat(64) }],
		});

		// Assert: the failure is the key check, not the missing-draft prerequisite.
		expect(diagnosis.apply).toMatchObject({ ok: false, code: "team_setup_completion_invalid" });
		expect(diagnosis.apply?.ok === false && diagnosis.apply.check).toMatch(
			/^requireIncludedDeviceEvidence \(legacy-team-setup-completion-manifest\.[jt]s:\d+\)$/u,
		);
		expect(getLegacyTeamSetupDraft(db, CANDIDATE)).toBeNull();
		expect(policySnapshot(db)).toEqual(before);
		expect(db.inTransaction).toBe(false);
	});

	it.each(["absent", "malformed", "wrong candidate"])(
		"does not discover a draft even temporarily when the completion is %s",
		async (kind) => {
			// Arrange: observing discovery distinguishes skipped writes from writes later rolled back.
			let completionManifest: unknown = null;
			if (kind === "malformed") completionManifest = {};
			if (kind === "wrong candidate")
				completionManifest = { ...discoveredManifest(), group_id: "other-group" };
			const discovery = vi.spyOn(legacyTeamCandidate, "discoverLegacyTeamCandidates");
			const before = policySnapshot(db);

			// Act.
			const diagnosis = await diagnoseLegacyTeamSetupCompletion(db, {
				projection: PROJECTION,
				coordinatorId: COORDINATOR_ID,
				groupId: GROUP_ID,
				completionManifest,
				freshRoster: FRESH_ROSTER,
			});

			// Assert: validation runs before discovery, including for a missing manifest.
			expect(diagnosis.manifest.ok).toBe(false);
			expect(diagnosis.apply).toBeNull();
			expect(discovery).not.toHaveBeenCalled();
			expect(getLegacyTeamSetupDraft(db, CANDIDATE)).toBeNull();
			expect(policySnapshot(db)).toEqual(before);
			expect(db.inTransaction).toBe(false);
		},
	);
});
