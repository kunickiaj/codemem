import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
		expect(second.rosterFingerprint).toBe(first.rosterFingerprint);
		expect(second.devices[0]?.displayName).toBe("Renamed Laptop");
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
		const first = refreshLegacyTeamSetupDraft(db, snapshot());
		db.prepare(
			`UPDATE legacy_team_setup_drafts
			 SET state = 'completed', completed_at = ?, updated_at = ?
			 WHERE attempt_id = ?`,
		).run(NOW, NOW, first.attemptId);

		const second = refreshLegacyTeamSetupDraft(db, snapshot());

		expect(second.attemptId).not.toBe(first.attemptId);
		// A confirmation token from the prior attempt is never valid for the
		// replacement review cycle.
		expect(second.finishDigest).not.toBe(first.finishDigest);
		expect(db.prepare("SELECT COUNT(*) FROM legacy_team_setup_drafts").pluck().get()).toBe(2);
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

		expect(second.rosterFingerprint).toBe(first.rosterFingerprint);
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

	it("rejects non-canonical explicit Project resolution targets", () => {
		const draft = refreshLegacyTeamSetupDraft(db, snapshot());
		const projectRef = draft.projects.find((p) => p.resolution === "unresolved")?.projectRef;
		if (!projectRef) throw new Error("invalid test fixture");
		for (const target of [
			"C:\\repos\\acme",
			"https://git.example.invalid/acme/web.git/",
			`https://git.example.invalid/${"a".repeat(2100)}`,
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
		const carriedRef = draft.devices.find((device) => device.fingerprint === "key-gone")
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
		expect(replacement.devices.find((device) => device.fingerprint === "key-gone")?.decision).toBe(
			"removed",
		);
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
		const carried = third.devices.find((device) => device.fingerprint === "key-gone");
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
		expect(second.rosterFingerprint).not.toBe(first.rosterFingerprint);
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
