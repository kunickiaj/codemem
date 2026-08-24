import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewLegacyTeamSetupActivation } from "./legacy-team-setup-activation.js";
import {
	getLegacyTeamSetupDraft,
	legacyTeamResolvedProjectRef,
	refreshLegacyTeamSetupDraft,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
	setLegacyTeamSetupProjectMapping,
} from "./legacy-team-setup-draft.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-08-21T12:00:00.000Z";
const CANDIDATE = "legacy-team-candidate:test";

function snapshot(overrides: { fingerprint?: string; deviceName?: string } = {}) {
	return {
		candidateId: CANDIDATE,
		coordinatorId: "coordinator-private",
		groupId: "group-private",
		displayName: "Legacy Team",
		devices: [
			{
				deviceId: "device-a",
				fingerprint: overrides.fingerprint ?? "key-a",
				displayName: overrides.deviceName ?? "Laptop",
				enabled: true,
			},
		],
		projects: [
			{
				projectRef: "project-ref-a",
				sourceProjectIdentity: "https://example.invalid/repo-a.git",
				displayName: "Repo A",
				sourceFingerprint: "source-a",
				deterministicProjectIdentity: "https://example.invalid/repo-a.git",
			},
			{
				projectRef: "project-ref-b",
				sourceProjectIdentity: "unmapped:repo-b",
				displayName: "Repo B",
				sourceFingerprint: "source-b",
				deterministicProjectIdentity: null,
			},
		],
		now: NOW,
	};
}

function devices(count: number, start = 0) {
	return Array.from({ length: count }, (_, index) => {
		const id = index + start;
		return {
			deviceId: `device-${id}`,
			fingerprint: `key-${id}`,
			displayName: `Device ${id}`,
			enabled: true,
		};
	});
}

function projects(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		projectRef: `project-ref-${index}`,
		sourceProjectIdentity: `https://example.invalid/repo-${index}.git`,
		displayName: `Project ${index}`,
		sourceFingerprint: `source-${index}`,
		deterministicProjectIdentity: `https://example.invalid/repo-${index}.git`,
	}));
}

function readyDraft(db: InstanceType<typeof Database>) {
	let draft = refreshLegacyTeamSetupDraft(db, snapshot());
	const device = draft.devices[0];
	if (!device) throw new Error("invalid test fixture");
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
	return setLegacyTeamSetupProjectMapping(db, {
		attemptId: draft.attemptId,
		projectRef: "project-ref-b",
		resolvedProjectIdentity: "https://example.invalid/repo-b.git",
		now: NOW,
	});
}

describe("legacy Team setup drafts", () => {
	let db: InstanceType<typeof Database>;

	beforeEach(() => {
		db = new Database(":memory:");
		initTestSchema(db);
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-a', 'Person A', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		// canFinish requires an active scope for the group whenever the draft
		// has Project rows; the snapshot fixture always has Projects.
		db.prepare(
			`INSERT INTO replication_scopes(
				scope_id, label, kind, authority_type, coordinator_id, group_id,
				membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-draft', 'Engineering', 'team', 'coordinator',
				'coordinator-private', 'group-private', 1, 'active', ?, ?)`,
		).run(NOW, NOW);
	});

	afterEach(() => db.close());

	it("persists inventory without changing canonical authorization state", () => {
		const before = {
			teams: db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get(),
			memberships: db.prepare("SELECT COUNT(*) FROM policy_team_memberships").pluck().get(),
			decisions: db.prepare("SELECT COUNT(*) FROM policy_team_device_decisions").pluck().get(),
			mappings: db.prepare("SELECT COUNT(*) FROM project_scope_mappings").pluck().get(),
		};

		const draft = refreshLegacyTeamSetupDraft(db, snapshot());

		expect(draft.projects).toHaveLength(2);
		expect(draft.unresolvedProjectCount).toBe(1);
		expect(draft.canFinish).toBe(false);
		expect({
			teams: db.prepare("SELECT COUNT(*) FROM policy_teams").pluck().get(),
			memberships: db.prepare("SELECT COUNT(*) FROM policy_team_memberships").pluck().get(),
			decisions: db.prepare("SELECT COUNT(*) FROM policy_team_device_decisions").pluck().get(),
			mappings: db.prepare("SELECT COUNT(*) FROM project_scope_mappings").pluck().get(),
		}).toEqual(before);
		expect(
			db
				.prepare("SELECT finish_digest FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(draft.attemptId),
		).toBe(draft.finishDigest);
	});

	it("keeps the attempt and fingerprint for label-only changes", () => {
		const first = refreshLegacyTeamSetupDraft(db, snapshot());
		const second = refreshLegacyTeamSetupDraft(db, snapshot({ deviceName: "Renamed Laptop" }));

		expect(second.attemptId).toBe(first.attemptId);
		// The fingerprint is persisted freshness state only — the view no
		// longer exposes it (a stable unsalted roster digest would let API
		// consumers correlate private rosters across candidates).
		expect(
			db
				.prepare("SELECT roster_fingerprint FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(second.attemptId),
		).toBeTruthy();
		expect(second.devices[0]?.displayName).toBe("Renamed Laptop");
	});

	it("bounds assignment, actor, and label statement preparation for multi-row refreshes", () => {
		const input = { ...snapshot(), devices: devices(8), projects: projects(8) };
		const first = refreshLegacyTeamSetupDraft(db, input);
		const insertActor = db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES (?, ?, 0, 'active', ?, ?)`,
		);
		const includeDevice = db.prepare(
			`UPDATE legacy_team_setup_draft_devices
			 SET decision = 'included', target_identity_id = ?
			 WHERE attempt_id = ? AND device_id = ?`,
		);
		for (const [index, device] of input.devices.entries()) {
			const actorId = `identity-${index}`;
			insertActor.run(actorId, `Person ${index}`, NOW, NOW);
			includeDevice.run(actorId, first.attemptId, device.deviceId);
		}
		const prepare = vi.spyOn(db, "prepare");
		try {
			const refreshed = refreshLegacyTeamSetupDraft(db, {
				...input,
				displayName: "Renamed Team",
				devices: input.devices.map((device) => ({
					...device,
					displayName: `Renamed ${device.deviceId}`,
				})),
				projects: input.projects.map((project) => ({
					...project,
					displayName: `Renamed ${project.projectRef}`,
				})),
			});

			expect(refreshed.attemptId).toBe(first.attemptId);
			expect(refreshed.devices).toHaveLength(8);
			expect(refreshed.projects).toHaveLength(8);
			const prepared = prepare.mock.calls.map(([sql]) => String(sql));
			expect(
				prepared.filter((sql) => /FROM identity_devices\s+WHERE device_id = \?/u.test(sql)),
			).toHaveLength(2);
			expect(
				prepared.filter((sql) =>
					/SELECT actor_id FROM actors\s+WHERE actor_id IN \([^)]*\)\s+AND status = 'active'/u.test(
						sql,
					),
				),
			).toHaveLength(1);
			expect(
				prepared.filter((sql) =>
					/SELECT actor_id FROM actors\s+WHERE status = 'active'/u.test(sql),
				),
			).toHaveLength(0);
			expect(
				prepared.filter((sql) =>
					/UPDATE legacy_team_setup_draft_devices\s+SET display_name/u.test(sql),
				),
			).toHaveLength(1);
			expect(
				prepared.filter((sql) =>
					/UPDATE legacy_team_setup_draft_projects\s+SET display_name/u.test(sql),
				),
			).toHaveLength(1);
		} finally {
			prepare.mockRestore();
		}
	});

	it("keeps reads side-effect-free when a persisted digest is absent", () => {
		const draft = refreshLegacyTeamSetupDraft(db, snapshot());
		db.prepare("UPDATE legacy_team_setup_drafts SET finish_digest = NULL WHERE attempt_id = ?").run(
			draft.attemptId,
		);

		const loaded = getLegacyTeamSetupDraft(db, CANDIDATE);

		expect(loaded?.finishDigest).toBe(draft.finishDigest);
		expect(
			db
				.prepare("SELECT finish_digest FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(draft.attemptId),
		).toBeNull();
	});

	it("returns the newest attempt even when its timestamp is older", () => {
		const first = refreshLegacyTeamSetupDraft(db, snapshot());
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', completed_at = ?, updated_at = ?
			 WHERE attempt_id = ?`,
		).run(NOW, NOW, first.attemptId);

		// A backward clock (or caller-supplied earlier `now`) gives the
		// replacement a lexically smaller created_at; insertion order must
		// still select the newer attempt.
		const second = refreshLegacyTeamSetupDraft(db, {
			...snapshot(),
			now: "2026-08-20T00:00:00.000Z",
		});

		expect(second.attemptId).not.toBe(first.attemptId);
		expect(getLegacyTeamSetupDraft(db, CANDIDATE)?.attemptId).toBe(second.attemptId);
	});

	it("binds the finish digest to its attempt even for equivalent replacements", () => {
		// Arrange
		const first = refreshLegacyTeamSetupDraft(db, snapshot());
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', completed_at = ?, updated_at = ?
			 WHERE attempt_id = ?`,
		).run(NOW, NOW, first.attemptId);

		// Act
		const second = refreshLegacyTeamSetupDraft(db, snapshot());

		// Assert
		expect(second.attemptId).not.toBe(first.attemptId);
		// A confirmation token from the prior attempt is never valid for the
		// replacement review cycle.
		expect(second.finishDigest).not.toBe(first.finishDigest);
		expect(
			db
				.prepare(
					`SELECT state, superseded_at FROM legacy_team_setup_drafts
					 WHERE attempt_id = ?`,
				)
				.get(first.attemptId),
		).toEqual({ state: "completed", superseded_at: NOW });
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(2);
	});

	describe.each([
		"needs_setup",
		"in_progress",
	] as const)("with an older non-current attempt manually left %s", (state) => {
		it.each([
			[
				"device assignment",
				(draft: ReturnType<typeof refreshLegacyTeamSetupDraft>) =>
					setLegacyTeamSetupDeviceAssignment(db, {
						attemptId: draft.attemptId,
						deviceRef: draft.devices[0]?.deviceRef as string,
						targetIdentityId: "identity-a",
						expectation: { kind: "absent" },
						now: NOW,
					}),
			],
			[
				"device decision",
				(draft: ReturnType<typeof refreshLegacyTeamSetupDraft>) =>
					setLegacyTeamSetupDeviceDecision(db, {
						attemptId: draft.attemptId,
						deviceRef: draft.devices[0]?.deviceRef as string,
						decision: "excluded",
						now: NOW,
					}),
			],
			[
				"Project mapping",
				(draft: ReturnType<typeof refreshLegacyTeamSetupDraft>) =>
					setLegacyTeamSetupProjectMapping(db, {
						attemptId: draft.attemptId,
						projectRef: "project-ref-b",
						resolvedProjectIdentity: "https://example.invalid/repo-b.git",
						now: NOW,
					}),
			],
		] as const)("rejects %s mutations", (_label, mutate) => {
			// Arrange
			const older = refreshLegacyTeamSetupDraft(db, snapshot());
			const current = refreshLegacyTeamSetupDraft(db, snapshot({ fingerprint: `key-${state}` }));
			db.prepare("UPDATE legacy_team_setup_drafts SET state = ? WHERE attempt_id = ?").run(
				state,
				older.attemptId,
			);
			const before = {
				device: db
					.prepare(
						`SELECT decision, target_identity_id FROM legacy_team_setup_draft_devices
						 WHERE attempt_id = ? AND device_ref = ?`,
					)
					.get(older.attemptId, older.devices[0]?.deviceRef),
				project: db
					.prepare(
						`SELECT resolution_kind, resolved_project_identity
						 FROM legacy_team_setup_draft_projects
						 WHERE attempt_id = ? AND project_ref = 'project-ref-b'`,
					)
					.get(older.attemptId),
			};

			// Act
			const act = () => mutate(older);

			// Assert
			expect(act).toThrow("legacy_team_setup_draft_stale");
			expect(getLegacyTeamSetupDraft(db, CANDIDATE)?.attemptId).toBe(current.attemptId);
			expect({
				device: db
					.prepare(
						`SELECT decision, target_identity_id FROM legacy_team_setup_draft_devices
						 WHERE attempt_id = ? AND device_ref = ?`,
					)
					.get(older.attemptId, older.devices[0]?.deviceRef),
				project: db
					.prepare(
						`SELECT resolution_kind, resolved_project_identity
						 FROM legacy_team_setup_draft_projects
						 WHERE attempt_id = ? AND project_ref = 'project-ref-b'`,
					)
					.get(older.attemptId),
			}).toEqual(before);
		});
	});

	it.each([
		// URLs, scp endpoints, key material
		"Team https://coordinator.example.test/private",
		"git@example.test:secret/device",
		"ssh-ed25519 AAAAC3NzaPrivate material",
		"Team -----BEGIN PRIVATE KEY----- secret -----END PRIVATE KEY----- suffix",
		`${"-----BEGIN ,-----".repeat(200)}secret`,
		// IP literals, endpoints, CIDR, encodings
		"192.0.2.17",
		"2001:db8::17",
		"10.20.30.40:8443",
		"[fd00::1]:8443",
		"[2001:db8::17]",
		"Office subnet 10.0.0.5/24",
		"NAS ip=10.0.0.5",
		"hosts 10.0.0.5,10.0.0.6",
		"fe80::1%en0",
		"Gateway 010.020.030.040",
		"10.20.30.\u200B40",
		// hostnames, including dotless, IDN, and full-width forms
		"nas:5000",
		"alice@nas",
		"m\u00fcnchen.corp",
		"\uff4e\uff41\uff53\uff0e\uff43\uff4f\uff52\uff50",
		// filesystem paths in every shape found across six review rounds
		"Team ~/secret/team-repo",
		"~alice/private-repo",
		"/home/user/private-repo",
		"home/alice/projects",
		"$HOME/clients/acme-private",
		"%2FUsers%2Falice",
		"C:\\Users\\adam\\private-repo",
		"Device (\\Users\\Alice\\private-repo)",
		"\\\\fileserver\\share\\repo",
		"Workspace ../clients/acme",
		"Device ./private/config",
		// ambiguous forms that a denylist cannot separate from safe text
		"Team v1.2 review. 50/50 split",
	])("falls back to generic names for unsafe label %j", (label) => {
		const input = snapshot();
		const device = input.devices[0];
		const project = input.projects[0];
		if (!device || !project) throw new Error("invalid test fixture");
		input.displayName = label;
		device.displayName = label;
		project.displayName = label;

		const draft = refreshLegacyTeamSetupDraft(db, input);

		expect(draft.displayName).toBe("Legacy Team");
		expect(draft.devices[0]?.displayName).toBe("Device");
		expect(draft.projects[0]?.displayName).toBe("Project");
	});

	it.each([
		"Dave's MacBook (work)",
		"B\u00fcro M\u00fcnchen",
		"Engineering & Data, LLC",
		"api_prod-3",
		"Team v2 release. Next up",
		"50-50 split",
	])("keeps allowlisted display label %j", (label) => {
		const input = snapshot();
		input.displayName = label;

		const draft = refreshLegacyTeamSetupDraft(db, input);

		expect(draft.displayName).toBe(label);
	});

	it("keeps devices with inactive assignment rows reviewable but never includable", () => {
		db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-a', 'identity-a', 'Laptop', 'revoked', 'test', 'r1',
				'complete', 3, 'device-a', ?, ?)`,
		).run(NOW, NOW);

		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const deviceRef = draft.devices[0]?.deviceRef as string;

		expect(draft.devices[0]).toMatchObject({
			existingIdentityId: "identity-a",
			suggestedIdentityId: null,
			verifiedEvidenceKind: null,
			expectation: { kind: "existing", assignmentVersion: 3, identityId: "identity-a" },
		});
		// An inactive row is never an absent assignment.
		expect(() =>
			setLegacyTeamSetupDeviceAssignment(db, {
				attemptId: draft.attemptId,
				deviceRef,
				targetIdentityId: "identity-a",
				expectation: { kind: "absent" },
				now: NOW,
			}),
		).toThrow("legacy_team_setup_assignment_changed");
		// The stored existing evidence still matches, so the device can be
		// reviewed and excluded despite the revoked row.
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef,
			targetIdentityId: "identity-a",
			expectation: { kind: "existing", assignmentVersion: 3, identityId: "identity-a" },
			now: NOW,
		});
		expect(() =>
			setLegacyTeamSetupDeviceDecision(db, {
				attemptId: draft.attemptId,
				deviceRef,
				decision: "included",
				now: NOW,
			}),
		).toThrow("legacy_team_setup_device_not_eligible");
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef,
			decision: "excluded",
			now: NOW,
		});
		expect(draft.devices[0]?.decision).toBe("excluded");
	});

	it("replaces the attempt when an assignment version advances without changing identity", () => {
		db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-a', 'identity-a', 'Laptop', 'active', 'test', 'r1',
				'complete', 3, 'device-a', ?, ?)`,
		).run(NOW, NOW);
		const first = refreshLegacyTeamSetupDraft(db, snapshot());
		// Reassign A -> B -> A: the roster fingerprint is restored but the
		// stored CAS version is now stale.
		db.prepare(
			"UPDATE identity_devices SET identity_id = 'identity-b', assignment_version = 4 WHERE device_id = 'device-a'",
		).run();
		db.prepare(
			"UPDATE identity_devices SET identity_id = 'identity-a', assignment_version = 5 WHERE device_id = 'device-a'",
		).run();

		const second = refreshLegacyTeamSetupDraft(db, snapshot());

		const rosterFingerprint = (attemptId: string) =>
			db
				.prepare("SELECT roster_fingerprint FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(attemptId);
		expect(rosterFingerprint(second.attemptId)).toBe(rosterFingerprint(first.attemptId));
		expect(second.attemptId).not.toBe(first.attemptId);
		expect(second.devices[0]?.expectation).toEqual({
			kind: "existing",
			assignmentVersion: 5,
			identityId: "identity-a",
		});
		expect(
			db
				.prepare("SELECT state FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(first.attemptId),
		).toBe("stale");
	});

	it("binds assignment saves to the stored CAS token, not the live rows", () => {
		db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-a', 'identity-a', 'Laptop', 'active', 'test', 'r1',
				'complete', 3, 'device-a', ?, ?)`,
		).run(NOW, NOW);
		const draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const deviceRef = draft.devices[0]?.deviceRef as string;
		// A -> B -> A reassignment after the snapshot: live rows show version 5.
		db.prepare(
			"UPDATE identity_devices SET identity_id = 'identity-b', assignment_version = 4 WHERE device_id = 'device-a'",
		).run();
		db.prepare(
			"UPDATE identity_devices SET identity_id = 'identity-a', assignment_version = 5 WHERE device_id = 'device-a'",
		).run();

		// Submitting the fresh live token must not let the stale attempt rebase.
		expect(() =>
			setLegacyTeamSetupDeviceAssignment(db, {
				attemptId: draft.attemptId,
				deviceRef,
				targetIdentityId: "identity-a",
				expectation: { kind: "existing", assignmentVersion: 5, identityId: "identity-a" },
				now: NOW,
			}),
		).toThrow("legacy_team_setup_assignment_changed");
		expect(() =>
			setLegacyTeamSetupDeviceAssignment(db, {
				attemptId: draft.attemptId,
				deviceRef,
				targetIdentityId: "identity-a",
				expectation: { kind: "absent" },
				now: NOW,
			}),
		).toThrow("legacy_team_setup_assignment_changed");
	});

	it("resets carried decisions when an assignment row becomes inactive", () => {
		db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-a', 'identity-a', 'Laptop', 'active', 'test', 'r1',
				'complete', 3, 'device-a', ?, ?)`,
		).run(NOW, NOW);
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const deviceRef = draft.devices[0]?.deviceRef as string;
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef,
			targetIdentityId: "identity-a",
			expectation: { kind: "existing", assignmentVersion: 3, identityId: "identity-a" },
			now: NOW,
		});
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef,
			decision: "included",
			now: NOW,
		});
		db.prepare("UPDATE identity_devices SET status = 'revoked' WHERE device_id = 'device-a'").run();

		const refreshed = refreshLegacyTeamSetupDraft(db, snapshot());

		expect(refreshed.attemptId).not.toBe(draft.attemptId);
		expect(refreshed.devices[0]?.decision).toBe("unresolved");
		expect(refreshed.devices[0]?.targetIdentityId).toBeNull();
	});

	it("rejects assignments and included decisions for disabled devices", () => {
		const input = snapshot();
		const device = input.devices[0];
		if (!device) throw new Error("invalid test fixture");
		device.enabled = false;

		const draft = refreshLegacyTeamSetupDraft(db, input);
		const deviceRef = draft.devices[0]?.deviceRef as string;

		expect(() =>
			setLegacyTeamSetupDeviceAssignment(db, {
				attemptId: draft.attemptId,
				deviceRef,
				targetIdentityId: "identity-a",
				expectation: { kind: "absent" },
				now: NOW,
			}),
		).toThrow("legacy_team_setup_device_not_eligible");
		expect(() =>
			setLegacyTeamSetupDeviceDecision(db, {
				attemptId: draft.attemptId,
				deviceRef,
				decision: "included",
				now: NOW,
			}),
		).toThrow("legacy_team_setup_device_not_eligible");
		const removed = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef,
			decision: "removed",
			now: NOW,
		});
		expect(removed.devices[0]?.decision).toBe("removed");
	});

	it("rejects invalid caller-supplied timestamps before persisting", () => {
		expect(() => refreshLegacyTeamSetupDraft(db, { ...snapshot(), now: "not-a-time" })).toThrow(
			"legacy_team_setup_time_invalid",
		);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(0);
	});

	it("accepts exactly 500 Devices", () => {
		const draft = refreshLegacyTeamSetupDraft(db, { ...snapshot(), devices: devices(500) });

		expect(draft.devices).toHaveLength(500);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(1);
	});

	it("rejects 501 Devices without creating partial attempt rows", () => {
		expect(() => refreshLegacyTeamSetupDraft(db, { ...snapshot(), devices: devices(501) })).toThrow(
			"legacy_team_setup_roster_too_large",
		);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_draft_devices").pluck().get()).toBe(
			0,
		);
	});

	it("preserves the current reviewed attempt after raw snapshot overflow", () => {
		const reviewed = readyDraft(db);
		const before = getLegacyTeamSetupDraft(db, CANDIDATE);

		expect(() => refreshLegacyTeamSetupDraft(db, { ...snapshot(), devices: devices(501) })).toThrow(
			"legacy_team_setup_roster_too_large",
		);
		expect(getLegacyTeamSetupDraft(db, CANDIDATE)).toEqual(before);
		expect(getLegacyTeamSetupDraft(db, CANDIDATE)?.attemptId).toBe(reviewed.attemptId);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(1);
	});

	it("accepts exactly 500 Projects", () => {
		const draft = refreshLegacyTeamSetupDraft(db, { ...snapshot(), projects: projects(500) });

		expect(draft.projects).toHaveLength(500);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(1);
	});

	it("rejects 501 Projects without creating partial attempt rows", () => {
		expect(() =>
			refreshLegacyTeamSetupDraft(db, { ...snapshot(), projects: projects(501) }),
		).toThrow("legacy_team_setup_roster_too_large");
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(0);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_draft_projects").pluck().get()).toBe(
			0,
		);
	});

	it("rejects carried-device overflow and preserves the reviewed attempt", () => {
		const current = refreshLegacyTeamSetupDraft(db, { ...snapshot(), devices: devices(500) });
		db.prepare(
			"UPDATE legacy_team_setup_drafts SET state = 'in_progress' WHERE attempt_id = ?",
		).run(current.attemptId);
		const before = db
			.prepare(
				`SELECT attempt_id, state, finish_digest, superseded_at, updated_at
				 FROM legacy_team_setup_drafts WHERE attempt_id = ?`,
			)
			.get(current.attemptId);

		expect(() =>
			refreshLegacyTeamSetupDraft(db, { ...snapshot(), devices: devices(500, 1) }),
		).toThrow("legacy_team_setup_roster_too_large");
		expect(
			db
				.prepare(
					`SELECT attempt_id, state, finish_digest, superseded_at, updated_at
					 FROM legacy_team_setup_drafts WHERE attempt_id = ?`,
				)
				.get(current.attemptId),
		).toEqual(before);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(1);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_draft_devices").pluck().get()).toBe(
			500,
		);
	});

	it("rejects oversized attempts created before draft limits", () => {
		const current = refreshLegacyTeamSetupDraft(db, { ...snapshot(), devices: devices(500) });
		db.prepare(
			`INSERT INTO legacy_team_setup_draft_devices(
				attempt_id, device_id, device_ref, key_fingerprint, display_name, enabled,
				existing_identity_id, existing_assignment_version, verified_evidence_kind,
				decision, target_identity_id, expected_assignment_kind,
				expected_assignment_version, updated_at
			 ) VALUES (?, 'legacy-extra', 'legacy-extra-ref', 'legacy-extra-key',
			           'Legacy extra', 0, NULL, NULL, NULL, 'unresolved', NULL,
			           'absent', NULL, ?)`,
		).run(current.attemptId, NOW);

		expect(() => refreshLegacyTeamSetupDraft(db, { ...snapshot(), devices: [] })).toThrow(
			"legacy_team_setup_roster_too_large",
		);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(1);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_draft_devices").pluck().get()).toBe(
			501,
		);
	});

	it("rejects non-canonical explicit Project resolution targets", () => {
		const draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const projectRef = draft.projects.find((p) => p.resolution === "unresolved")?.projectRef;
		if (!projectRef) throw new Error("invalid test fixture");
		for (const target of [
			"C:\\repos\\acme",
			"https://git.example.invalid/acme/web.git/",
			"https://git.example.invalid/acme/web\u200b.git",
			`https://git.example.invalid/${"a".repeat(2100)}`,
			// Local paths round-trip unchanged through canonicalWorkspaceIdentity,
			// so they must be rejected by shape.
			"/home/alice/private-repo",
			"../clients/acme",
			"~alice/private-repo",
			"\\\\fileserver\\share\\repo",
			"$HOME/clients/private-repo",
			"%USERPROFILE%\\repos\\acme",
			// Ordinary relative paths must fail the allowlist: a separator is
			// only acceptable inside a remote form.
			"clients/acme",
			"private/repo",
			"repo\\nested",
			// A local path wrapped in a file: URL is still a local path, and a
			// hostless scheme URL is the same trick with a supported scheme.
			"file:///home/alice/private-repo",
			"ssh:///home/alice/private-repo",
			"git:///Users/alice/repo",
		]) {
			expect(() =>
				setLegacyTeamSetupProjectMapping(db, {
					attemptId: draft.attemptId,
					projectRef,
					resolvedProjectIdentity: target,
					now: NOW,
				}),
			).toThrow("legacy_team_setup_project_mapping_invalid");
		}
	});

	it("rejects decisions outside the activation contract at runtime", () => {
		const draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const deviceRef = draft.devices[0]?.deviceRef as string;

		// The TypeScript union is erased at runtime; an unvalidated caller could
		// pass any string, and persisting it would zero the unresolved count.
		expect(() =>
			setLegacyTeamSetupDeviceDecision(db, {
				attemptId: draft.attemptId,
				deviceRef,
				decision: "include" as never,
				now: NOW,
			}),
		).toThrow("legacy_team_setup_decision_invalid");
		expect(getLegacyTeamSetupDraft(db, CANDIDATE)?.devices[0]?.decision).toBe("unresolved");
	});

	it("preserves reviewed removals across replacement attempts from unrelated changes", () => {
		const withGone = {
			...snapshot(),
			devices: [
				...snapshot().devices,
				{ deviceId: "device-gone", fingerprint: "key-gone", displayName: "Old", enabled: true },
			],
		};
		refreshLegacyTeamSetupDraft(db, withGone);
		// The device disappears; the replacement attempt carries it disabled.
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const carriedRef = draft.devices.find((device) => device.displayName === "Removed device")
			?.deviceRef as string;
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef: carriedRef,
			decision: "removed",
			now: NOW,
		});

		// An unrelated roster change (a brand-new device) replaces the attempt.
		const withNewDevice = {
			...snapshot(),
			devices: [
				...snapshot().devices,
				{ deviceId: "device-new", fingerprint: "key-new", displayName: "New", enabled: true },
			],
		};
		const replacement = refreshLegacyTeamSetupDraft(db, withNewDevice);

		expect(replacement.attemptId).not.toBe(draft.attemptId);
		expect(
			replacement.devices.find((device) => device.displayName === "Removed device")?.decision,
		).toBe("removed");
	});

	it("preserves an unconfirmed identity selection across an unrelated Project replacement", () => {
		// Arrange
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const device = draft.devices[0];
		if (!device) throw new Error("invalid test fixture");
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			targetIdentityId: "identity-a",
			expectation: device.expectation,
			now: NOW,
		});
		expect(draft.devices[0]).toMatchObject({
			decision: "unresolved",
			targetIdentityId: "identity-a",
		});

		// Act
		const replacement = refreshLegacyTeamSetupDraft(db, {
			...snapshot(),
			projects: [
				...snapshot().projects,
				{
					projectRef: "project-ref-c",
					sourceProjectIdentity: "https://example.invalid/repo-c.git",
					displayName: "Repo C",
					sourceFingerprint: "source-c",
					deterministicProjectIdentity: "https://example.invalid/repo-c.git",
				},
			],
		});

		// Assert
		expect(replacement.attemptId).not.toBe(draft.attemptId);
		expect(replacement.devices[0]).toMatchObject({
			decision: "unresolved",
			targetIdentityId: "identity-a",
		});
	});

	it("replaces the attempt when a carried removed device's assignment changes", () => {
		const first = refreshLegacyTeamSetupDraft(db, {
			...snapshot(),
			devices: [
				...snapshot().devices,
				{ deviceId: "device-gone", fingerprint: "key-gone", displayName: "Old", enabled: true },
			],
		});
		// The device disappears from the roster; the replacement attempt carries
		// it as a disabled row.
		const second = refreshLegacyTeamSetupDraft(db, snapshot());
		expect(second.attemptId).not.toBe(first.attemptId);
		// Its canonical assignment then changes while the attempt is open.
		db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-gone', 'identity-a', 'Old', 'active', 'test', 'r1',
				'complete', 7, 'device-gone', ?, ?)`,
		).run(NOW, NOW);

		const third = refreshLegacyTeamSetupDraft(db, snapshot());

		expect(third.attemptId).not.toBe(second.attemptId);
		const carried = third.devices.find((device) => device.displayName === "Removed device");
		expect(carried?.expectation).toEqual({
			kind: "existing",
			assignmentVersion: 7,
			identityId: "identity-a",
		});
	});

	it("falls back to generic labels when display names embed lookup identifiers", () => {
		const input = snapshot();
		const device = input.devices[0];
		const project = input.projects[0];
		if (!device || !project) throw new Error("invalid test fixture");
		input.displayName = "group-private";
		device.displayName = "Device device-a";
		// Project labels must redact the same contextual identifiers as Team
		// and device labels — the group ID is just as private in a Project row.
		project.displayName = "Project group-private";

		const draft = refreshLegacyTeamSetupDraft(db, input);

		expect(draft.displayName).toBe("Legacy Team");
		expect(draft.devices[0]?.displayName).toBe("Device");
		expect(draft.projects[0]?.displayName).toBe("Project");

		// The key fingerprint is a stable device correlator; a label embedding
		// it must fall back even though the fingerprint field itself is no
		// longer exported — in ANY casing, since the coordinator controls the
		// casing of both the label and the identifier it embeds.
		const withFingerprint = refreshLegacyTeamSetupDraft(db, {
			...snapshot(),
			devices: [
				{ deviceId: "device-a", fingerprint: "key-a", displayName: "Device KEY-A", enabled: true },
			],
		});
		expect(withFingerprint.devices[0]?.displayName).toBe("Device");
	});

	it("falls back to generic labels for scheme-less hostnames", () => {
		const input = snapshot();
		const device = input.devices[0];
		if (!device) throw new Error("invalid test fixture");
		const project = input.projects[0];
		if (!project) throw new Error("invalid test fixture");
		input.displayName = "Coordinator build.example.invalid";
		device.displayName = "Device cache.example.invalid";
		project.displayName = "Project source.example.invalid";

		const draft = refreshLegacyTeamSetupDraft(db, input);

		expect(draft.displayName).toBe("Legacy Team");
		expect(draft.devices[0]?.displayName).toBe("Device");
		expect(draft.projects[0]?.displayName).toBe("Project");
	});

	it("rejects merged identities as assignment targets", () => {
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at)
			 VALUES ('identity-merged', 'Merged Person', 0, 'active', 'identity-a', ?, ?)`,
		).run(NOW, NOW);
		const draft = refreshLegacyTeamSetupDraft(db, snapshot());

		expect(() =>
			setLegacyTeamSetupDeviceAssignment(db, {
				attemptId: draft.attemptId,
				deviceRef: draft.devices[0]?.deviceRef as string,
				targetIdentityId: "identity-merged",
				expectation: { kind: "absent" },
				now: NOW,
			}),
		).toThrow("legacy_team_setup_identity_invalid");
	});

	it("returns an opaque confirmable reference for persisted migration targets", () => {
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const projectA = draft.projects.find((project) => project.projectRef === "project-ref-a");
		expect(projectA?.resolvedProjectRef).toBe(
			legacyTeamResolvedProjectRef("project-ref-a", "https://example.invalid/repo-a.git"),
		);
		expect(
			draft.projects.find((project) => project.projectRef === "project-ref-b")?.resolvedProjectRef,
		).toBeNull();

		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: "https://example.invalid/repo-b.git",
			now: NOW,
		});
		const projectB = draft.projects.find((project) => project.projectRef === "project-ref-b");
		expect(projectB?.resolvedProjectRef).toBe(
			legacyTeamResolvedProjectRef("project-ref-b", "https://example.invalid/repo-b.git"),
		);
		// The raw identity never leaves the view.
		expect(JSON.stringify(draft)).not.toContain("repo-b.git");
	});

	it("resets an included decision when the assignment target changes", () => {
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-b', 'Person B', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const deviceRef = draft.devices[0]?.deviceRef as string;
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef,
			targetIdentityId: "identity-a",
			expectation: { kind: "absent" },
			now: NOW,
		});
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef,
			decision: "included",
			now: NOW,
		});
		expect(draft.devices[0]?.decision).toBe("included");

		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef,
			targetIdentityId: "identity-b",
			expectation: { kind: "absent" },
			now: NOW,
		});

		expect(draft.devices[0]?.decision).toBe("unresolved");
		expect(draft.canFinish).toBe(false);
	});

	it("reports canFinish false when the stored CAS evidence no longer matches", () => {
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const deviceRef = draft.devices[0]?.deviceRef as string;
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef,
			targetIdentityId: "identity-a",
			expectation: { kind: "absent" },
			now: NOW,
		});
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef,
			decision: "included",
			now: NOW,
		});
		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: "https://example.invalid/repo-b.git",
			now: NOW,
		});
		expect(draft.canFinish).toBe(true);

		// A canonical assignment row appears after the absent expectation was saved.
		db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-a', 'identity-a', 'Laptop', 'active', 'test', 'r1',
				'complete', 1, 'device-a', ?, ?)`,
		).run(NOW, NOW);

		expect(getLegacyTeamSetupDraft(db, CANDIDATE)?.canFinish).toBe(false);
	});

	it("reports canFinish false when an excluded device assignment changes", () => {
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision,
			 migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-a', 'identity-a', 'Laptop', 'active', 'test', 'r1',
			 'complete', 0, 'device-a', ?, ?)`,
		).run(NOW, NOW);
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const deviceRef = draft.devices[0]?.deviceRef as string;
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef,
			targetIdentityId: "identity-a",
			expectation: { kind: "existing", identityId: "identity-a", assignmentVersion: 0 },
			now: NOW,
		});
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef,
			decision: "excluded",
			now: NOW,
		});
		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: "https://example.invalid/repo-b.git",
			now: NOW,
		});
		expect(draft.canFinish).toBe(true);

		db.prepare(
			"UPDATE identity_devices SET assignment_version = 1 WHERE device_id = 'device-a'",
		).run();

		expect(getLegacyTeamSetupDraft(db, CANDIDATE)?.canFinish).toBe(false);
	});

	it("reports canFinish false for a malformed excluded assignment expectation", () => {
		db.prepare(
			`INSERT INTO identity_devices(
			 device_id, identity_id, display_name, status, provenance, revision,
			 migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-a', 'identity-a', 'Laptop', 'active', 'test', 'r1',
			 'complete', 0, 'device-a', ?, ?)`,
		).run(NOW, NOW);
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const deviceRef = draft.devices[0]?.deviceRef as string;
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef,
			targetIdentityId: "identity-a",
			expectation: { kind: "existing", identityId: "identity-a", assignmentVersion: 0 },
			now: NOW,
		});
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef,
			decision: "excluded",
			now: NOW,
		});
		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: "https://example.invalid/repo-b.git",
			now: NOW,
		});
		expect(draft.canFinish).toBe(true);
		db.prepare(
			`UPDATE legacy_team_setup_draft_devices SET expected_assignment_version = -1
			 WHERE attempt_id = ? AND device_ref = ?`,
		).run(draft.attemptId, deviceRef);

		expect(getLegacyTeamSetupDraft(db, CANDIDATE)?.canFinish).toBe(false);
	});

	it.each([
		["missing kind", null, 3],
		["missing version", "existing", null],
		["negative version", "existing", -1],
		["fractional version", "existing", 1.5],
		["unsafe version", "existing", Number.MAX_SAFE_INTEGER + 1],
		["stale but well-formed version", "existing", 2],
	] as const)("replaces an existing expectation with %s using normalized evidence", (_variant, expectedKind, expectedVersion) => {
		// Arrange
		db.prepare(
			`INSERT INTO identity_devices(
				 device_id, identity_id, display_name, status, provenance, revision,
				 migration_state, assignment_version, idempotency_key, created_at, updated_at
				 ) VALUES ('device-a', 'identity-a', 'Laptop', 'active', 'test', 'r1',
				 'complete', 3, 'device-a', ?, ?)`,
		).run(NOW, NOW);
		const current = readyDraft(db);
		expect(current.canFinish).toBe(true);
		const deviceRef = current.devices[0]?.deviceRef as string;
		db.prepare(
			`UPDATE legacy_team_setup_draft_devices
			 SET expected_assignment_kind = ?, expected_assignment_version = ?
			 WHERE attempt_id = ? AND device_ref = ?`,
		).run(expectedKind, expectedVersion, current.attemptId, deviceRef);

		// Act
		const corrupt = getLegacyTeamSetupDraft(db, CANDIDATE);
		const cannotFinish = () =>
			previewLegacyTeamSetupActivation(db, {
				candidateRef: current.candidateRef,
				attemptId: current.attemptId,
			});
		expect(corrupt?.canFinish).toBe(false);
		expect(cannotFinish).toThrow(/team_setup_(?:assignment_changed|incomplete)/u);
		const replacement = refreshLegacyTeamSetupDraft(db, snapshot());

		// Assert
		expect(replacement).toMatchObject({
			state: "needs_setup",
			devices: [
				{
					decision: "unresolved",
					targetIdentityId: null,
					expectation: { kind: "existing", identityId: "identity-a", assignmentVersion: 3 },
				},
			],
		});
		expect(replacement.attemptId).not.toBe(current.attemptId);
		expect(refreshLegacyTeamSetupDraft(db, snapshot()).attemptId).toBe(replacement.attemptId);
		expect(
			db
				.prepare(
					`SELECT draft.state, device.expected_assignment_kind, device.expected_assignment_version
						 FROM legacy_team_setup_drafts AS draft
						 JOIN legacy_team_setup_draft_devices AS device USING(attempt_id)
						 WHERE draft.attempt_id = ? AND device.device_ref = ?`,
				)
				.get(current.attemptId, deviceRef),
		).toEqual({
			state: "stale",
			expected_assignment_kind: expectedKind,
			expected_assignment_version: expectedVersion,
		});
	});

	it("replaces a contradictory absent expectation with normalized evidence", () => {
		// Arrange
		const current = readyDraft(db);
		expect(current.canFinish).toBe(true);
		const deviceRef = current.devices[0]?.deviceRef as string;
		db.prepare(
			`UPDATE legacy_team_setup_draft_devices SET expected_assignment_version = 0
			 WHERE attempt_id = ? AND device_ref = ?`,
		).run(current.attemptId, deviceRef);

		// Act
		const corrupt = getLegacyTeamSetupDraft(db, CANDIDATE);
		const cannotFinish = () =>
			previewLegacyTeamSetupActivation(db, {
				candidateRef: current.candidateRef,
				attemptId: current.attemptId,
			});
		expect(corrupt?.canFinish).toBe(false);
		expect(cannotFinish).toThrow("team_setup_incomplete");
		const replacement = refreshLegacyTeamSetupDraft(db, snapshot());

		// Assert
		expect(replacement.attemptId).not.toBe(current.attemptId);
		expect(refreshLegacyTeamSetupDraft(db, snapshot()).attemptId).toBe(replacement.attemptId);
		expect(replacement.devices[0]).toMatchObject({
			decision: "unresolved",
			targetIdentityId: null,
			expectation: { kind: "absent" },
		});
		expect(
			db
				.prepare(
					`SELECT draft.state, device.expected_assignment_kind, device.expected_assignment_version
					 FROM legacy_team_setup_drafts AS draft
					 JOIN legacy_team_setup_draft_devices AS device USING(attempt_id)
					 WHERE draft.attempt_id = ? AND device.device_ref = ?`,
				)
				.get(current.attemptId, deviceRef),
		).toEqual({
			state: "stale",
			expected_assignment_kind: "absent",
			expected_assignment_version: 0,
		});
	});

	it.each([
		["excluded", true],
		["removed", false],
	] as const)("clears %s targets and produces a deterministic target-free finish digest", (decision, enabled) => {
		// Arrange
		db.prepare(
			`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
			 VALUES ('identity-b', 'Person B', 0, 'active', ?, ?)`,
		).run(NOW, NOW);
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const deviceRef = draft.devices[0]?.deviceRef as string;
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef,
			targetIdentityId: "identity-a",
			expectation: { kind: "absent" },
			now: NOW,
		});
		db.prepare(
			`UPDATE legacy_team_setup_draft_devices SET enabled = ?
			 WHERE attempt_id = ? AND device_ref = ?`,
		).run(enabled ? 1 : 0, draft.attemptId, deviceRef);

		// Act
		const decisionAfterA = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef,
			decision,
			now: NOW,
		});
		db.prepare(
			`UPDATE legacy_team_setup_draft_devices
			 SET decision = 'unresolved', target_identity_id = 'identity-b'
			 WHERE attempt_id = ? AND device_ref = ?`,
		).run(draft.attemptId, deviceRef);
		const decisionAfterB = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef,
			decision,
			now: NOW,
		});

		// Assert
		expect(decisionAfterA.devices[0]).toMatchObject({
			decision,
			targetIdentityId: null,
		});
		expect(decisionAfterB.devices[0]).toMatchObject({
			decision,
			targetIdentityId: null,
		});
		expect(decisionAfterB.finishDigest).toBe(decisionAfterA.finishDigest);
	});

	it.each([
		-1,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
	])("reports canFinish false for malformed assignment version %s", (assignmentVersion) => {
		db.prepare(
			`INSERT INTO identity_devices(
					device_id, identity_id, display_name, status, provenance, revision,
					migration_state, assignment_version, idempotency_key, created_at, updated_at
				 ) VALUES ('device-a', 'identity-a', 'Laptop', 'active', 'test', 'r1',
					'complete', ?, 'device-a', ?, ?)`,
		).run(assignmentVersion, NOW, NOW);
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const deviceRef = draft.devices[0]?.deviceRef as string;
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef,
			targetIdentityId: "identity-a",
			expectation: {
				kind: "existing",
				identityId: "identity-a",
				assignmentVersion,
			},
			now: NOW,
		});
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef,
			decision: "included",
			now: NOW,
		});
		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: "https://example.invalid/repo-b.git",
			now: NOW,
		});

		expect(draft.canFinish).toBe(false);
		expect(refreshLegacyTeamSetupDraft(db, snapshot()).attemptId).toBe(draft.attemptId);
		expect(refreshLegacyTeamSetupDraft(db, snapshot()).attemptId).toBe(draft.attemptId);
	});

	it("reports canFinish false when an included person is later deactivated", () => {
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const deviceRef = draft.devices[0]?.deviceRef as string;
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef,
			targetIdentityId: "identity-a",
			expectation: { kind: "absent" },
			now: NOW,
		});
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef,
			decision: "included",
			now: NOW,
		});
		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: "https://example.invalid/repo-b.git",
			now: NOW,
		});
		expect(draft.canFinish).toBe(true);

		db.prepare("UPDATE actors SET status = 'deactivated' WHERE actor_id = 'identity-a'").run();

		expect(getLegacyTeamSetupDraft(db, CANDIDATE)?.canFinish).toBe(false);
	});

	it.each([
		[
			"the coordinator group has no active scope",
			() => {
				db.prepare("UPDATE replication_scopes SET status = 'retired'").run();
			},
		],
		[
			"a new mapping is ambiguous across active scopes",
			() => {
				db.prepare(
					`INSERT INTO replication_scopes(
					 scope_id, label, kind, authority_type, coordinator_id, group_id,
					 membership_epoch, status, created_at, updated_at
					 ) VALUES ('scope-draft-2', 'Engineering 2', 'managed_project', 'coordinator',
					 'coordinator-private', 'group-private', 1, 'active', ?, ?)`,
				).run(NOW, NOW);
			},
		],
		[
			"a foreign mapping conflicts with the source pattern",
			() => {
				db.prepare(
					`INSERT INTO project_scope_mappings(
					 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
					 ) VALUES ('https://example.invalid/foreign.git', 'unmapped:repo-b',
					 'scope-foreign', 1000, 'user', ?, ?)`,
				).run(NOW, NOW);
			},
		],
		[
			"another active Team claims the Project",
			() => {
				db.prepare(
					`INSERT INTO project_recipients(
					 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
					 policy_revision, migration_state, idempotency_key, created_at, updated_at
					 ) VALUES ('https://example.invalid/repo-a.git', 'team', 'policy-team-v1:foreign',
					 'active', 'user', 'r1', 'completed', 'foreign-team-claim', ?, ?)`,
				).run(NOW, NOW);
			},
		],
		[
			"an active Project recipient has an unsupported kind",
			() => {
				db.prepare(
					`INSERT INTO project_recipients(
					 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
					 policy_revision, migration_state, idempotency_key, created_at, updated_at
					 ) VALUES ('https://example.invalid/repo-a.git', 'service', 'service-a',
					 'active', 'user', 'r1', 'completed', 'unsupported-recipient', ?, ?)`,
				).run(NOW, NOW);
			},
		],
	] as const)("reports canFinish false when %s", (_label, createConflict) => {
		createConflict();

		const draft = readyDraft(db);

		expect(draft.canFinish).toBe(false);
	});

	it("keeps canFinish true for selected mappings across scopes and a direct Identity recipient", () => {
		db.prepare(
			`INSERT INTO replication_scopes(
			 scope_id, label, kind, authority_type, coordinator_id, group_id,
			 membership_epoch, status, created_at, updated_at
			 ) VALUES ('scope-draft-2', 'Engineering 2', 'managed_project', 'coordinator',
			 'coordinator-private', 'group-private', 1, 'active', ?, ?)`,
		).run(NOW, NOW);
		const insertMapping = db.prepare(
			`INSERT INTO project_scope_mappings(
			 workspace_identity, project_pattern, scope_id, priority, source, created_at, updated_at
			 ) VALUES (?, ?, ?, 1000, 'user', ?, ?)`,
		);
		insertMapping.run(
			"https://example.invalid/repo-a.git",
			"https://example.invalid/repo-a.git",
			"scope-draft",
			NOW,
			NOW,
		);
		insertMapping.run(
			"https://example.invalid/repo-b.git",
			"unmapped:repo-b",
			"scope-draft-2",
			NOW,
			NOW,
		);
		db.prepare(
			`INSERT INTO project_recipients(
			 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
			 policy_revision, migration_state, idempotency_key, created_at, updated_at
			 ) VALUES ('https://example.invalid/repo-a.git', 'identity', 'identity-a',
			 'active', 'user', 'r1', 'completed', 'direct-identity-recipient', ?, ?)`,
		).run(NOW, NOW);

		const draft = readyDraft(db);

		expect(draft.canFinish).toBe(true);
	});

	it("revalidates the selected identity when saving an included decision", () => {
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const deviceRef = draft.devices[0]?.deviceRef as string;
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef,
			targetIdentityId: "identity-a",
			expectation: { kind: "absent" },
			now: NOW,
		});
		db.prepare(
			"UPDATE actors SET status = 'active', merged_into_actor_id = 'identity-z' WHERE actor_id = 'identity-a'",
		).run();

		expect(() =>
			setLegacyTeamSetupDeviceDecision(db, {
				attemptId: draft.attemptId,
				deviceRef,
				decision: "included",
				now: NOW,
			}),
		).toThrow("legacy_team_setup_identity_invalid");
	});

	it("rejects explicit mapping overrides for deterministic Projects", () => {
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());

		expect(() =>
			setLegacyTeamSetupProjectMapping(db, {
				attemptId: draft.attemptId,
				projectRef: "project-ref-a",
				resolvedProjectIdentity: "https://example.invalid/unrelated.git",
				now: NOW,
			}),
		).toThrow("legacy_team_setup_project_not_ambiguous");

		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: "https://example.invalid/repo-b.git",
			now: NOW,
		});
		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: "https://example.invalid/repo-b-corrected.git",
			now: NOW,
		});
		expect(
			draft.projects.find((project) => project.projectRef === "project-ref-b")?.resolution,
		).toBe("explicit");
	});

	it("creates an immutable replacement attempt when key evidence changes", () => {
		const first = refreshLegacyTeamSetupDraft(db, snapshot());
		const second = refreshLegacyTeamSetupDraft(db, snapshot({ fingerprint: "key-b" }));

		expect(second.attemptId).not.toBe(first.attemptId);
		const persistedFingerprints = db
			.prepare(
				`SELECT attempt_id, roster_fingerprint FROM legacy_team_setup_drafts
				 ORDER BY rowid`,
			)
			.all() as Array<{ attempt_id: string; roster_fingerprint: string }>;
		expect(persistedFingerprints).toHaveLength(2);
		expect(persistedFingerprints[0]?.roster_fingerprint).not.toBe(
			persistedFingerprints[1]?.roster_fingerprint,
		);
		expect(
			db
				.prepare("SELECT state FROM legacy_team_setup_drafts WHERE attempt_id = ?")
				.pluck()
				.get(first.attemptId),
		).toBe("stale");
	});

	it("requires CAS assignment confirmation and explicit ambiguous Project repair", () => {
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const deviceRef = draft.devices[0]?.deviceRef as string;

		expect(draft.devices[0]?.suggestedIdentityId).toBeNull();
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef,
			targetIdentityId: "identity-a",
			expectation: { kind: "absent" },
			now: NOW,
		});
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef,
			decision: "included",
			now: NOW,
		});
		expect(draft.canFinish).toBe(false);

		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: "https://example.invalid/repo-b.git",
			now: NOW,
		});
		expect(draft.canFinish).toBe(true);
	});

	it("emits active local assignments only as unselected verified suggestions", () => {
		db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-a', 'identity-a', 'Laptop', 'active', 'test', 'r1',
				'complete', 3, 'device-a', ?, ?)`,
		).run(NOW, NOW);

		const draft = refreshLegacyTeamSetupDraft(db, snapshot());

		expect(draft.devices[0]).toMatchObject({
			suggestedIdentityId: "identity-a",
			verifiedEvidenceKind: "active_assignment",
			decision: "unresolved",
			targetIdentityId: null,
		});
	});

	it("preserves only Project mappings whose source evidence is unchanged", () => {
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		draft = setLegacyTeamSetupProjectMapping(db, {
			attemptId: draft.attemptId,
			projectRef: "project-ref-b",
			resolvedProjectIdentity: "https://example.invalid/repo-b.git",
			now: NOW,
		});

		const unchanged = refreshLegacyTeamSetupDraft(db, {
			...snapshot(),
			projects: snapshot().projects.toReversed(),
		});
		expect(
			unchanged.projects.find((project) => project.projectRef === "project-ref-b")?.resolution,
		).toBe("explicit");

		const changedInput = snapshot();
		const changedProject = changedInput.projects[1];
		if (!changedProject) throw new Error("invalid test fixture");
		changedProject.sourceFingerprint = "project-b-changed";
		const changed = refreshLegacyTeamSetupDraft(db, changedInput);
		expect(
			changed.projects.find((project) => project.projectRef === "project-ref-b")?.resolution,
		).toBe("unresolved");
	});

	it("rejects a changed existing assignment and leaves the draft unchanged", () => {
		db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-a', 'identity-a', 'Laptop', 'active', 'test', 'r1',
				'complete', 3, 'device-a', ?, ?)`,
		).run(NOW, NOW);
		const draft = refreshLegacyTeamSetupDraft(db, snapshot());
		db.prepare(
			"UPDATE identity_devices SET assignment_version = 4 WHERE device_id = 'device-a'",
		).run();

		expect(() =>
			setLegacyTeamSetupDeviceAssignment(db, {
				attemptId: draft.attemptId,
				deviceRef: draft.devices[0]?.deviceRef as string,
				targetIdentityId: "identity-a",
				expectation: { kind: "existing", assignmentVersion: 3, identityId: "identity-a" },
			}),
		).toThrow("legacy_team_setup_assignment_changed");
		expect(draft.devices[0]?.decision).toBe("unresolved");
	});

	it("rechecks assignment CAS evidence when saving a Team decision", () => {
		let draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const deviceRef = draft.devices[0]?.deviceRef as string;
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef,
			targetIdentityId: "identity-a",
			expectation: { kind: "absent" },
			now: NOW,
		});
		db.prepare(
			`INSERT INTO identity_devices(
				device_id, identity_id, display_name, status, provenance, revision,
				migration_state, assignment_version, idempotency_key, created_at, updated_at
			 ) VALUES ('device-a', 'identity-a', 'Laptop', 'active', 'test', 'r1',
				'complete', 1, 'device-a', ?, ?)`,
		).run(NOW, NOW);

		expect(() =>
			setLegacyTeamSetupDeviceDecision(db, {
				attemptId: draft.attemptId,
				deviceRef,
				decision: "included",
				now: NOW,
			}),
		).toThrow("legacy_team_setup_assignment_changed");
	});
});
