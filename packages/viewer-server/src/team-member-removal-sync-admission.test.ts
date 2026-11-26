import { afterEach, expect, it, vi } from "vitest";
import { applyTeamMemberRemovals } from "../../core/src/team-member-removal-policy.js";
import { linkTeamToCoordinatorGroup } from "../../core/src/team-member-removal-test-fixtures.js";
import { createSyncChannelDispatcher } from "./sync-channel-dispatch.js";
import {
	bytes,
	channelStore,
	memoryOp,
	SCOPE,
	signedRequest,
} from "./sync-channel-dispatch-test-fixtures.js";

const NOW = "2026-07-26T00:00:00.000Z";
const COORDINATOR = "https://coord.example.test";
const PROJECT = "https://git.example.invalid/team/project.git";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.unstubAllEnvs();
});

/** The pinned peer belongs to a Team member whose Team Project lives in the channel's scope. */
async function teamFixture() {
	const f = await channelStore();
	cleanups.push(f.cleanup);
	const db = f.store.db;
	const team = linkTeamToCoordinatorGroup(db, {
		candidateId: "candidate-a",
		coordinatorId: COORDINATOR,
		groupId: "group-a",
	});
	const insert = (table: string, values: Record<string, unknown>) => {
		const columns = Object.keys(values);
		db.prepare(
			`INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
		).run(...Object.values(values));
	};
	const stamps = { created_at: NOW, updated_at: NOW };
	const managed = { provenance: "test", revision: "r1", migration_state: "user_managed" };
	insert("actors", {
		actor_id: "identity-peer",
		display_name: "Peer",
		is_local: 0,
		status: "active",
		...stamps,
	});
	insert("identity_devices", {
		device_id: f.peerDeviceId,
		identity_id: "identity-peer",
		display_name: "Peer laptop",
		status: "active",
		idempotency_key: "binding-peer",
		...managed,
		...stamps,
	});
	insert("policy_teams", {
		team_id: team,
		display_name: "Team",
		status: "active",
		idempotency_key: "team",
		...managed,
		...stamps,
	});
	insert("policy_team_memberships", {
		team_id: team,
		identity_id: "identity-peer",
		role: "member",
		status: "active",
		idempotency_key: "membership-peer",
		...managed,
		...stamps,
	});
	insert("project_recipients", {
		canonical_project_identity: PROJECT,
		recipient_kind: "team",
		recipient_id: team,
		status: "active",
		provenance: "test",
		policy_revision: "r1",
		migration_state: "completed",
		idempotency_key: "recipient-team",
		...stamps,
	});
	insert("project_scope_mappings", {
		workspace_identity: PROJECT,
		project_pattern: PROJECT,
		scope_id: SCOPE,
		priority: 0,
		source: "user",
		...stamps,
	});
	const remove = () =>
		applyTeamMemberRemovals(db, {
			coordinatorId: COORDINATOR,
			groupId: "group-a",
			removals: [
				{
					group_id: "group-a",
					team_id: team,
					identity_id: "identity-peer",
					removal_seq: 1,
					removed_at: NOW,
					removed_by_device_id: null,
				},
			],
			now: NOW,
		});
	return { ...f, remove, dispatch: createSyncChannelDispatcher({ storeFactory: f.storeFactory }) };
}

function snapshotTarget(f: Awaited<ReturnType<typeof teamFixture>>) {
	return signedRequest(f).target.replace("/v1/ops?", "/v1/snapshot?");
}

it("refuses the removed person's pinned device a snapshot and operations right after the removal", async () => {
	const f = await teamFixture();
	const pull = () => f.dispatch(signedRequest(f));
	const snapshot = () => f.dispatch(signedRequest(f, { target: snapshotTarget(f) }));
	const push = () => {
		const op = memoryOp(f);
		return f.dispatch(
			signedRequest(f, {
				method: "POST",
				target: `/v1/ops?scope_id=${SCOPE}`,
				bodyBytes: bytes({ ops: [op] }),
			}),
		);
	};
	expect((await pull()).status).toBe(200);
	expect((await snapshot()).status).toBe(200);

	// No reconciliation or refresh runs between the removal and the requests.
	f.remove();

	for (const response of [await pull(), await snapshot(), await push()])
		expect(response.status).not.toBe(200);
	expect(
		f.store.db.prepare("SELECT COUNT(*) FROM memory_items WHERE scope_id = ?").pluck().get(SCOPE),
	).toBe(0);
});
