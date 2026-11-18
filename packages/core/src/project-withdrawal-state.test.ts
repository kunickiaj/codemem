import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { managedProjectScopeId } from "./managed-project-scope.js";
import {
	isProjectScopeWithdrawn,
	listProjectScopeWithdrawals,
} from "./project-scope-withdrawal.js";
import {
	projectWithdrawalStates,
	resumeProjectOnThisDevice,
	stopProjectOnThisDevice,
} from "./project-withdrawal-state.js";
import { initTestSchema } from "./test-utils.js";

const LOCAL = "dev-local";
const GROUP = "group-a";
const ATLAS = "git:example/atlas";
const ATLAS_BOUNDARY = managedProjectScopeId(GROUP, ATLAS);
// How the Viewer's inventory names a Project received on its own boundary.
const RECEIVED_ATLAS = `peer-received:scope:${ATLAS_BOUNDARY}`;
const NOW = "2026-11-18T10:00:00.000Z";

let db: InstanceType<typeof Database>;

function addBoundary(
	identity: string,
	options: { membership?: "active" | "revoked"; status?: string; kind?: string } = {},
): string {
	const scopeId = managedProjectScopeId(GROUP, identity);
	db.prepare(
		`INSERT INTO replication_scopes(
		 scope_id, label, kind, authority_type, coordinator_id, group_id, membership_epoch, status, created_at, updated_at
		 ) VALUES (?, ?, ?, 'coordinator', 'coord-1', ?, 1, ?, ?, ?)`,
	).run(
		scopeId,
		identity,
		options.kind ?? "managed_project",
		GROUP,
		options.status ?? "active",
		NOW,
		NOW,
	);
	db.prepare(
		`INSERT INTO scope_memberships(scope_id, device_id, role, status, membership_epoch, updated_at)
		 VALUES (?, ?, 'member', ?, 1, ?)`,
	).run(scopeId, LOCAL, options.membership ?? "active", NOW);
	return scopeId;
}

function stop(workspaceIdentity: string) {
	return stopProjectOnThisDevice(db, { deviceId: LOCAL, workspaceIdentity, now: NOW });
}

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});

afterEach(() => db.close());

describe("projectWithdrawalStates", () => {
	it("finds the boundary of a received Project and of this device's own Project", () => {
		addBoundary(ATLAS);

		const states = projectWithdrawalStates(db, LOCAL, [
			RECEIVED_ATLAS,
			ATLAS,
			"git:example/unknown",
			"peer-received:dev-a:project:atlas",
		]);

		const expected = { scopeId: ATLAS_BOUNDARY, groupId: GROUP, withdrawnAt: null };
		expect(states.get(RECEIVED_ATLAS)).toEqual(expected);
		expect(states.get(ATLAS)).toEqual(expected);
		expect(states.size).toBe(2);
	});

	it("leaves out boundaries this device isn't an active member of, and other kinds of scope", () => {
		addBoundary(ATLAS, { membership: "revoked" });
		addBoundary("git:example/team-space", { kind: "team" });
		addBoundary("git:example/archived", { status: "archived" });

		const states = projectWithdrawalStates(db, LOCAL, [
			RECEIVED_ATLAS,
			"git:example/team-space",
			"git:example/archived",
		]);

		expect(states.size).toBe(0);
	});

	it("keeps a stopped Project listed after its boundary is gone, so it can be resumed", () => {
		addBoundary(ATLAS);
		stop(RECEIVED_ATLAS);
		db.prepare("UPDATE scope_memberships SET status = 'revoked'").run();

		const states = projectWithdrawalStates(db, LOCAL, [RECEIVED_ATLAS]);

		expect(states.get(RECEIVED_ATLAS)).toMatchObject({ scopeId: ATLAS_BOUNDARY, withdrawnAt: NOW });
	});
});

describe("a Project stopped by its own identity", () => {
	it("stays resumable after this device leaves the last boundary in that group", () => {
		// Arrange: stopped as this device's own Project, then its only membership ends.
		addBoundary(ATLAS);
		stop(ATLAS);
		db.prepare("UPDATE scope_memberships SET status = 'revoked'").run();

		// Act
		const states = projectWithdrawalStates(db, LOCAL, [ATLAS]);
		const resumed = resumeProjectOnThisDevice(db, {
			deviceId: LOCAL,
			workspaceIdentity: ATLAS,
			now: "2026-11-18T11:00:00.000Z",
		});

		// Assert
		expect(states.get(ATLAS)).toMatchObject({ scopeId: ATLAS_BOUNDARY, withdrawnAt: NOW });
		expect(resumed).toBe(true);
		expect(isProjectScopeWithdrawn(db, ATLAS_BOUNDARY)).toBe(false);
	});
});

describe("stopping and resuming a Project on this device", () => {
	it("stops a received Project and resumes it", () => {
		addBoundary(ATLAS);

		const stopped = stop(RECEIVED_ATLAS);
		const stoppedState = isProjectScopeWithdrawn(db, ATLAS_BOUNDARY);
		const resumed = resumeProjectOnThisDevice(db, {
			deviceId: LOCAL,
			workspaceIdentity: RECEIVED_ATLAS,
			now: "2026-11-18T11:00:00.000Z",
		});

		expect(stopped).toEqual({ scopeId: ATLAS_BOUNDARY, groupId: GROUP, withdrawnAt: NOW });
		expect(stoppedState).toBe(true);
		expect(resumed).toBe(true);
		expect(isProjectScopeWithdrawn(db, ATLAS_BOUNDARY)).toBe(false);
	});

	it("records the canonical identity when a known identity hashes to the boundary", () => {
		addBoundary(ATLAS);
		db.prepare(
			`INSERT INTO recipient_policy_authority_states(
			 canonical_project_identity, state_changed_at, created_at, updated_at
			 ) VALUES (?, ?, ?, ?)`,
		).run(ATLAS, NOW, NOW, NOW);

		stop(RECEIVED_ATLAS);

		expect(listProjectScopeWithdrawals(db)[0]?.canonicalProjectIdentity).toBe(ATLAS);
	});

	it("records the boundary ID as the identity when none is known", () => {
		addBoundary(ATLAS);

		stop(RECEIVED_ATLAS);

		expect(listProjectScopeWithdrawals(db)[0]?.canonicalProjectIdentity).toBe(ATLAS_BOUNDARY);
	});

	it("refuses a Project that isn't on its own boundary, and a resume with nothing stopped", () => {
		const stopped = stop(RECEIVED_ATLAS);
		addBoundary(ATLAS);
		const resumed = resumeProjectOnThisDevice(db, {
			deviceId: LOCAL,
			workspaceIdentity: RECEIVED_ATLAS,
			now: NOW,
		});

		expect(stopped).toBeNull();
		expect(resumed).toBe(false);
	});
});
