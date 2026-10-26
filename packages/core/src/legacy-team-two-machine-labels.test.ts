import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	AUTH_LEGACY_ASSIGNMENT_CAPTURE_SQL,
	captureCurrentLegacyAssignment,
} from "./coordinator-auth-legacy-assignment.js";
import { type Fixture, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES } from "./coordinator-legacy-team-completion.js";
import { deriveLegacyTeamSetupCompletionManifest } from "./legacy-team-setup-completion-manifest.js";
import {
	refreshLegacyTeamSetupDraft,
	setLegacyTeamSetupDeviceAssignment,
	setLegacyTeamSetupDeviceDecision,
} from "./legacy-team-setup-draft.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";
import { ensureLegacyTeamSetupDraftSchema } from "./schema-bootstrap.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { initTestSchema } from "./test-utils.js";

const NOW = "2026-10-26T12:00:00.000Z";
const COORDINATOR_ID = "coordinator-shared";
const GROUP_ID = "group-shared";
const DEVICES = {
	work: {
		deviceId: "device-work",
		identityId: "local:device-work",
		publicKey: CANONICAL_PUBLIC_KEY,
	},
	personal: {
		deviceId: "device-personal",
		identityId: "local:device-personal",
		publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB",
	},
} as const;
type Machine = keyof typeof DEVICES;
const machines = Object.keys(DEVICES) as Machine[];
const fingerprint = (machine: Machine) => fingerprintPublicKey(DEVICES[machine].publicKey);
const closers: Array<() => unknown> = [];

afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

/** One legacy runtime that, like old installs, binds every same-person device to itself. */
function legacyRuntime(self: Machine) {
	const db = new Database(":memory:");
	closers.push(() => db.close());
	initTestSchema(db);
	const identityId = DEVICES[self].identityId;
	db.prepare(
		`INSERT INTO actors(actor_id, display_name, is_local, status, created_at, updated_at)
		 VALUES (?, 'Same person', 1, 'active', ?, ?)`,
	).run(identityId, NOW, NOW);
	db.prepare(
		"INSERT INTO sync_device(device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
	).run(DEVICES[self].deviceId, DEVICES[self].publicKey, fingerprint(self), NOW);
	db.prepare(
		`INSERT INTO replication_scopes(scope_id, label, kind, authority_type, coordinator_id,
		 group_id, membership_epoch, status, created_at, updated_at)
		 VALUES ('scope-shared', 'Shared', 'team', 'coordinator', ?, ?, 1, 'active', ?, ?)`,
	).run(COORDINATOR_ID, GROUP_ID, NOW, NOW);
	for (const machine of machines) {
		db.prepare(
			`INSERT INTO identity_devices(device_id, identity_id, display_name, status, provenance,
			 revision, migration_state, assignment_version, idempotency_key, created_at, updated_at)
			 VALUES (?, ?, ?, 'active', 'test', 'r1', 'complete', 1, ?, ?, ?)`,
		).run(DEVICES[machine].deviceId, identityId, machine, DEVICES[machine].deviceId, NOW, NOW);
	}
	return db;
}

/** The person includes every device under this runtime's Identity, as dogfood did. */
function migrate(db: InstanceType<typeof Database>, self: Machine) {
	let draft = refreshLegacyTeamSetupDraft(db, {
		candidateId: legacyTeamCandidateId(COORDINATOR_ID, GROUP_ID),
		coordinatorId: COORDINATOR_ID,
		groupId: GROUP_ID,
		displayName: "Shared Team",
		devices: machines.map((machine) => ({
			deviceId: DEVICES[machine].deviceId,
			fingerprint: fingerprint(machine),
			displayName: machine,
			enabled: true,
		})),
		projects: [],
		now: NOW,
	});
	for (const device of draft.devices) {
		draft = setLegacyTeamSetupDeviceAssignment(db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			targetIdentityId: DEVICES[self].identityId,
			expectation: device.expectation,
			now: NOW,
		});
		draft = setLegacyTeamSetupDeviceDecision(db, {
			attemptId: draft.attemptId,
			deviceRef: device.deviceRef,
			decision: "included",
			now: NOW,
		});
	}
	return {
		draft,
		manifest: deriveLegacyTeamSetupCompletionManifest(db, { ...draft, completedAt: NOW }),
	};
}

async function coordinatorWith(self: Machine, manifest: ReturnType<typeof migrate>["manifest"]) {
	const f: Fixture = setupStore("SQLite");
	closers.push(() => f.store.close());
	await f.store.createGroup(GROUP_ID);
	for (const machine of machines)
		await f.store.enrollDevice(GROUP_ID, {
			deviceId: DEVICES[machine].deviceId,
			publicKey: DEVICES[machine].publicKey,
			fingerprint: fingerprint(machine),
		});
	await f.store.createLegacyTeamCompletion(GROUP_ID, manifest);
	const snapshot = f.db
		.prepare(AUTH_LEGACY_ASSIGNMENT_CAPTURE_SQL)
		.pluck()
		.get(COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES, GROUP_ID, manifest.candidate_ref) as string;
	/** Whether the stored completion assigns `machine` to the uploader's Identity. */
	return (machine: Machine) =>
		captureCurrentLegacyAssignment(snapshot, {
			coordinatorId: COORDINATOR_ID,
			identityId: DEVICES[self].identityId,
			signer: {
				groupId: GROUP_ID,
				deviceId: DEVICES[machine].deviceId,
				publicKey: DEVICES[machine].publicKey,
				fingerprint: fingerprint(machine),
			},
			distinctKeys: [],
		}) !== null;
}

describe("two legacy runtimes that each claim both devices", () => {
	it.each(machines)("lets the %s runtime's migration assign only its own device", async (self) => {
		// Arrange
		const db = legacyRuntime(self);
		// Act
		const { draft, manifest } = migrate(db, self);
		const assigns = await coordinatorWith(self, manifest);
		// Assert: the other device's local record is shown, not suggested, and uploads as a label.
		const other = machines.find((machine) => machine !== self) as Machine;
		const view = Object.fromEntries(draft.devices.map((device) => [device.deviceRef, device]));
		expect(
			Object.values(view)
				.map((device) => [device.identityEvidence, device.suggestedIdentityId])
				.sort(),
		).toEqual([
			["label", null],
			["self", DEVICES[self].identityId],
		]);
		expect(
			Object.fromEntries(
				manifest.device_decisions.map((decision) => [
					decision.device_id,
					decision.identity_evidence,
				]),
			),
		).toEqual({ [DEVICES[self].deviceId]: "self", [DEVICES[other].deviceId]: "label" });
		expect(assigns(self)).toBe(true);
		expect(assigns(other)).toBe(false);
	});
});

describe("drafts saved before Identity evidence existed", () => {
	/** Simulates a database written by a version without the evidence column. */
	function upgrade(db: InstanceType<typeof Database>) {
		db.exec("ALTER TABLE legacy_team_setup_draft_devices DROP COLUMN identity_evidence");
		ensureLegacyTeamSetupDraftSchema(db);
	}
	const evidenceRows = (db: InstanceType<typeof Database>) =>
		db
			.prepare(
				"SELECT device_id, identity_evidence FROM legacy_team_setup_draft_devices ORDER BY device_id",
			)
			.all();

	it("marks an open draft at upgrade so its labels never upload as ownership", () => {
		// Arrange
		const db = legacyRuntime("work");
		const { draft } = migrate(db, "work");
		// Act
		upgrade(db);
		const manifest = deriveLegacyTeamSetupCompletionManifest(db, { ...draft, completedAt: NOW });
		// Assert
		expect(evidenceRows(db)).toEqual([
			{ device_id: DEVICES.personal.deviceId, identity_evidence: "label" },
			{ device_id: DEVICES.work.deviceId, identity_evidence: "self" },
		]);
		expect(manifest.device_decisions.map((decision) => decision.identity_evidence)).toEqual([
			"label",
			"self",
		]);
	});

	it("marks an open draft that an older process wrote after the upgrade", () => {
		// Arrange: the column exists, but an old process left this draft unmarked.
		const db = legacyRuntime("work");
		migrate(db, "work");
		db.exec("UPDATE legacy_team_setup_draft_devices SET identity_evidence = NULL");
		// Act
		ensureLegacyTeamSetupDraftSchema(db);
		// Assert
		expect(
			evidenceRows(db).map((row) => (row as { identity_evidence: string }).identity_evidence),
		).toEqual(["label", "self"]);
	});

	it("leaves a completed draft unmarked so republishing keeps its stored bytes", () => {
		// Arrange
		const db = legacyRuntime("work");
		migrate(db, "work");
		db.exec("UPDATE legacy_team_setup_drafts SET state = 'completed'");
		// Act
		upgrade(db);
		// Assert: manifestDeviceDecision omits the field for unmarked rows.
		expect(evidenceRows(db)).toEqual([
			{ device_id: DEVICES.personal.deviceId, identity_evidence: null },
			{ device_id: DEVICES.work.deviceId, identity_evidence: null },
		]);
	});
});
