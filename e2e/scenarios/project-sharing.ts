import { assert, assertStatus } from "../lib/assert.js";
import {
	ADMIN_SECRET,
	CLI_PREFIX,
	GROUP_ID,
	parseJson,
	readPeerIdentity,
	writePeerConfig,
} from "../lib/coordinator.js";
import type { ScenarioContext } from "../lib/scenario-context.js";
import { waitFor } from "../lib/wait.js";

const POLICY_SELECTED_PROJECT = "https://example.invalid/acme/policy-selected.git";
const POLICY_UNRELATED_PROJECT = "https://example.invalid/acme/policy-unrelated.git";

interface FixtureSummary {
	device_id: string;
	actor_id: string;
	memories: Array<{ title: string; project: string | null; scope_id: string | null; active: number }>;
	actors: Array<{ actor_id: string; display_name: string; status: string }>;
	peers: Array<{ peer_device_id: string; name: string | null; actor_id: string | null }>;
	managed_memberships: Array<{ scope_id: string; device_id: string; status: string }>;
	source_memberships: Array<{ device_id: string; status: string }>;
	operations: Array<{
		operation_id: string;
		state: string;
		teammate_name: string;
		recipient_device_id: string | null;
		recipient_device_display_name: string | null;
	}>;
	policy: {
		team_memberships: Array<{ team_id: string; identity_id: string; status: string }>;
		identity_devices: Array<{
			identity_id: string;
			device_id: string;
			display_name: string;
			status: string;
		}>;
		project_recipients: Array<{
			canonical_project_identity: string;
			recipient_kind: string;
			recipient_id: string;
			status: string;
		}>;
		effective_projects: Array<{
			canonicalProjectIdentity: string;
			status: string;
			devices: Array<{
				identityId: string;
				deviceId: string;
				sources: Array<{ kind: "direct_identity" | "team_membership"; teamId?: string }>;
			}>;
		}>;
	};
	action_result?: Record<string, unknown> | null;
}

interface RecipientPolicyIntentGraph {
	teamMemberships: Array<{ teamId: string; identityId: string; status: string }>;
	projectRecipients: Array<{
		canonicalProjectIdentity: string;
		recipientKind: "identity" | "team";
		identityId?: string;
		teamId?: string;
		status: string;
	}>;
}

interface ReconciliationProof {
	unsupported: {
		result: { status: string; safeErrorCode: string | null };
		membership_unchanged: boolean;
		mutation_calls: string[];
	};
	offline_resume: {
		waiting: { status: string; safeErrorCode: string | null };
		resumed: { status: string };
		active: { status: string };
	};
	revocation: {
		revoking: { status: string; revokedDeviceIds: string[] };
		active: { status: string };
		members: string[];
		deny_overlays: unknown[];
	};
	rollback: {
		result: { status: string };
		authority: { authorityState: string } | null;
		mutation_calls: string[];
	};
}

function fixture(ctx: ScenarioContext, service: string, action: string, artifact: string): FixtureSummary {
	const result = ctx.compose.exec(
		service,
		[
			"pnpm",
			"exec",
			"tsx",
			"--conditions",
			"source",
			"e2e/scripts/project-sharing-fixture.ts",
			"--action",
			action,
		],
		artifact,
		120_000,
	);
	assertStatus(result.status, 0, `${service} fixture action ${action} failed`);
	return parseJson<FixtureSummary>(result.stdout, artifact);
}

function startServer(ctx: ScenarioContext, service: string, artifact: string): void {
	const staticResult = ctx.compose.exec(
		service,
		[
			"node",
			"--input-type=module",
			"-e",
			"import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('/tmp/viewer-static', { recursive: true }); writeFileSync('/tmp/viewer-static/index.html', '<!doctype html><title>e2e</title>');",
		],
		`${artifact}-static`,
		30_000,
	);
	assertStatus(staticResult.status, 0, `${service} static preparation failed`);
	const result = ctx.compose.execDetached(
		service,
		[
			"env",
			"CODEMEM_VIEWER_STATIC_DIR=/tmp/viewer-static",
			...CLI_PREFIX,
			"serve",
			"start",
			"--foreground",
			"--db-path",
			"/data/mem.sqlite",
			"--host",
			"0.0.0.0",
			"--port",
			"38888",
		],
		artifact,
	);
	assertStatus(result.status, 0, `${service} viewer/sync server failed to start`);
}

async function request<T>(
	ctx: ScenarioContext,
	service: string,
	path: string,
	artifact: string,
	body?: Record<string, unknown>,
): Promise<{ status: number; body: T }> {
	const script = `const response = await fetch(${JSON.stringify(`http://127.0.0.1:38888${path}`)}, ${JSON.stringify(
		body
			? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
			: {},
	)}); const text = await response.text(); console.log(JSON.stringify({ status: response.status, body: text ? JSON.parse(text) : null }));`;
	const result = ctx.compose.exec(service, ["node", "--input-type=module", "-e", script], artifact, 60_000);
	assertStatus(result.status, 0, `${service} request ${path} failed`);
	return parseJson<{ status: number; body: T }>(result.stdout, artifact);
}

async function waitForServer(ctx: ScenarioContext, service: string, artifact: string): Promise<void> {
	await waitFor(
		async () => {
			const response = await request(ctx, service, "/api/stats", artifact);
			assert(response.status === 200, `${service} viewer is not ready`);
		},
		{ description: `${service} viewer readiness`, timeoutMs: 120_000, intervalMs: 2_000 },
	);
}

function syncOnce(ctx: ScenarioContext, service: string, artifact: string): void {
	const result = ctx.compose.exec(
		service,
		[...CLI_PREFIX, "sync", "once", "--db-path", "/data/mem.sqlite"],
		artifact,
		180_000,
		true,
	);
	assert(
		result.status === 0 || result.stderr.includes("no accepted peers"),
		`${service} sync once failed: ${result.stderr || result.stdout}`,
	);
}

export async function runProjectSharingScenario(ctx: ScenarioContext): Promise<void> {
	ctx.recordNote(
		"scenario.txt",
		"Project-first sharing: two isolated peers, two canonical projects, one reviewed project invite, automatic identity/device linking, exact existing-and-future replication, and source-membership non-inheritance.",
	);
	ctx.compose.down("00-compose-down-pre", true);
	ctx.compose.up(["coordinator", "peer-a", "peer-b"], "01-compose-up");
	ctx.compose.ps("02-compose-ps");

	fixture(ctx, "peer-a", "init", "03-init-peer-a");
	fixture(ctx, "peer-b", "init", "04-init-peer-b");
	const peerA = readPeerIdentity(ctx, "peer-a", "05-peer-a-identity");
	const peerB = readPeerIdentity(ctx, "peer-b", "06-peer-b-identity");
	const seededA = fixture(ctx, "peer-a", "seed-a", "07-seed-peer-a");
	assert(
		seededA.source_memberships.some((member) => member.device_id === "source-bystander"),
		"source bystander fixture missing",
	);

	for (const [service, deviceName] of [
		["peer-a", "Adam's Test Mac"],
		["peer-b", "Brian's Test Mac"],
	] as const) {
		writePeerConfig(
			ctx,
			service,
			{
				actor_display_name: service === "peer-a" ? "Adam" : "Brian",
				sync_device_name: deviceName,
				sync_enabled: true,
				sync_host: "0.0.0.0",
				sync_port: 7337,
				sync_advertise: `http://${service}:7337`,
				sync_interval_s: 2,
				sync_coordinator_url: "http://coordinator:7347",
				sync_coordinator_group: GROUP_ID,
				sync_coordinator_admin_secret: ADMIN_SECRET,
			},
			`08-config-${service}`,
		);
	}

	const group = ctx.compose.exec(
		"coordinator",
		[...CLI_PREFIX, "sync", "coordinator", "group-create", GROUP_ID, "--db-path", "/data/coordinator.sqlite"],
		"09-group-create",
	);
	assertStatus(group.status, 0, "coordinator group creation failed");
	const enroll = ctx.compose.exec(
		"coordinator",
		[
			...CLI_PREFIX,
			"sync",
			"coordinator",
			"enroll-device",
			GROUP_ID,
			peerA.device_id,
			"--fingerprint",
			peerA.fingerprint,
			"--public-key",
			peerA.public_key,
			"--name",
			"Adam's Test Mac",
			"--db-path",
			"/data/coordinator.sqlite",
			"--json",
		],
		"10-enroll-peer-a",
	);
	assertStatus(enroll.status, 0, "peer-a enrollment failed");

	startServer(ctx, "peer-a", "11-start-peer-a");
	startServer(ctx, "peer-b", "12-start-peer-b");
	await waitForServer(ctx, "peer-a", "13-peer-a-ready");
	await waitForServer(ctx, "peer-b", "14-peer-b-ready");

	const inventory = await request<{ projects: Array<{ workspace_identity: string; display_project: string }> }>(
		ctx,
		"peer-a",
		"/api/sync/projects?limit=50",
		"15-project-inventory",
	);
	assert(inventory.status === 200, "project inventory failed");
	assert(inventory.body.projects.length >= 2, "expected at least two canonical projects");
	const selected = inventory.body.projects.find((project) => project.display_project === "selected-project");
	const unrelated = inventory.body.projects.find((project) => project.display_project === "unrelated-project");
	assert(selected && unrelated, "selected/unrelated canonical project fixtures missing");

	const preview = await request<{ reviewed_project_set_digest: string; existing_memory_count: number }>(
		ctx,
		"peer-a",
		"/api/sync/project-invites/preview",
		"16-preview-share",
		{ teammate_name: "Brian", project_ids: [selected.workspace_identity] },
	);
	assert(preview.status === 200, `project invite preview failed: ${JSON.stringify(preview.body)}`);
	assert(preview.body.existing_memory_count === 1, "preview must count the selected existing memory");
	const created = await request<{
		operation_id: string;
		invite: { encoded: string };
		projects: Array<{ project_id: string; existing_memory_count: number }>;
	}>(
		ctx,
		"peer-a",
		"/api/sync/project-invites",
		"17-create-share",
		{
			teammate_name: "Brian",
			project_ids: [selected.workspace_identity],
			reviewed_project_set_digest: preview.body.reviewed_project_set_digest,
		},
	);
	assert(created.status === 200, `project invite creation failed: ${JSON.stringify(created.body)}`);
	assert(created.body.projects.length === 1, "invite must contain exactly one reviewed project");
	assert(created.body.projects[0]?.project_id === selected.workspace_identity, "invite project changed after review");
	assert(created.body.projects[0]?.existing_memory_count === 1, "invite lost the reviewed memory count");

	const accepted = await request<Record<string, unknown>>(
		ctx,
		"peer-b",
		"/api/sync/invites/import",
		"18-accept-share",
		{ invite: created.body.invite.encoded, recipient_name: "Brian", device_name: "Brian's Test Mac" },
	);
	assert(accepted.status === 200, `project invite acceptance failed: ${JSON.stringify(accepted.body)}`);

	await waitFor(
		async () => {
			const reconciled = await request<Record<string, unknown>>(
				ctx,
				"peer-a",
				`/api/sync/project-invites/${created.body.operation_id}/reconcile`,
				"19-reconcile",
				{},
			);
			assert(reconciled.status === 200, `acceptance reconciliation failed: ${JSON.stringify(reconciled.body)}`);
			const advanced = await request<Record<string, unknown>>(
				ctx,
				"peer-a",
				`/api/sync/share-operations/${created.body.operation_id}/advance`,
				"20-advance",
				{},
			);
			assert(advanced.status === 200, `project provisioning not ready: ${JSON.stringify(advanced.body)}`);
		},
		{ description: "project share provisioning", timeoutMs: 180_000, intervalMs: 3_000 },
	);

	syncOnce(ctx, "peer-a", "20-sync-existing-a");
	syncOnce(ctx, "peer-b", "21-sync-existing-b");
	await waitFor(
		async () => {
			const summary = fixture(ctx, "peer-b", "summary", "22-peer-b-existing-summary");
			const titles = summary.memories.map((memory) => memory.title);
			assert(titles.includes("selected existing"), "selected existing memory has not arrived");
			assert(!titles.includes("unrelated existing"), "unrelated existing memory leaked to peer-b");
		},
		{ description: "selected existing memory on peer-b", timeoutMs: 120_000, intervalMs: 3_000 },
	);

	fixture(ctx, "peer-a", "add-future", "23-add-future-memories");
	syncOnce(ctx, "peer-a", "24-sync-future-a");
	syncOnce(ctx, "peer-b", "25-sync-future-b");
	await waitFor(
		async () => {
			const summary = fixture(ctx, "peer-b", "summary", "26-peer-b-future-summary");
			const titles = summary.memories.map((memory) => memory.title);
			assert(titles.includes("selected future"), "selected future memory has not arrived");
			for (const forbidden of ["unrelated existing", "unrelated future"]) {
				assert(!titles.includes(forbidden), `${forbidden} leaked to peer-b`);
			}
		},
		{ description: "selected future memory and unrelated-project isolation", timeoutMs: 120_000, intervalMs: 3_000 },
	);

	const finalA = fixture(ctx, "peer-a", "summary", "27-peer-a-final-summary");
	const operation = finalA.operations.find((item) => item.operation_id === created.body.operation_id);
	assert(operation?.state === "active", `share operation did not become active: ${operation?.state}`);
	assert(operation.recipient_device_id === peerB.device_id, "recipient device was not linked automatically");
	assert(
		operation.recipient_device_display_name === "Brian's Test Mac",
		"friendly recipient device name was not preserved",
	);
	assert(
		finalA.actors.some((actor) => actor.display_name === "Brian" && actor.status === "active"),
		"Brian Person was not activated",
	);
	assert(
		finalA.peers.some(
			(peer) => peer.peer_device_id === peerB.device_id && peer.name === "Brian's Test Mac",
		),
		"Brian's device was not named and linked on peer-a",
	);
	assert(
		finalA.source_memberships.some((member) => member.device_id === "source-bystander"),
		"source bystander membership fixture disappeared",
	);
	assert(
		!finalA.managed_memberships.some((member) => member.device_id === "source-bystander"),
		"managed project boundary inherited an unreviewed source member",
	);
	const recipientPeer = finalA.peers.find((peer) => peer.peer_device_id === peerB.device_id);
	assert(recipientPeer?.actor_id, "recipient Identity was not linked to the accepted device");
	assert(
		finalA.policy.project_recipients.some(
			(item) =>
				item.canonical_project_identity === selected.workspace_identity &&
				item.recipient_kind === "identity" &&
				item.recipient_id === finalA.actor_id &&
				item.status === "active",
		),
		"real direct invitation did not preserve the inviter Identity's selected Project access",
	);
	assert(
		finalA.policy.project_recipients.some(
			(item) =>
				item.canonical_project_identity === selected.workspace_identity &&
				item.recipient_kind === "identity" &&
				item.recipient_id === recipientPeer.actor_id &&
				item.status === "active",
		),
		"real direct invitation did not preserve the recipient Identity's selected Project access",
	);
	for (const [deviceId, label] of [
		[peerA.device_id, "inviter"],
		[peerB.device_id, "recipient"],
	] as const) {
		assert(
			finalA.managed_memberships.some(
				(member) => member.device_id === deviceId && member.status === "active",
			),
			`real direct invitation did not keep the ${label} device active`,
		);
	}

	// Arrange: seed isolated recipient intent without changing the real direct-invite Projects.
	const seededPolicy = fixture(ctx, "peer-a", "seed-policy", "28-seed-recipient-policy");
	// Act: read canonical intent and derive effective devices from the persisted graph.
	const initialIntent = await request<RecipientPolicyIntentGraph>(
		ctx,
		"peer-a",
		"/api/sync/recipient-policy/v1/intent",
		"29-initial-recipient-intent",
	);
	// Assert: direct Identity, Team, and Personal/Work Project boundaries are exact.
	assert(initialIntent.status === 200, "initial recipient-policy intent failed");
	const selectedPolicy = seededPolicy.policy.effective_projects.find(
		(item) => item.canonicalProjectIdentity === POLICY_SELECTED_PROJECT,
	);
	const unrelatedPolicy = seededPolicy.policy.effective_projects.find(
		(item) => item.canonicalProjectIdentity === POLICY_UNRELATED_PROJECT,
	);
	assert(selectedPolicy && unrelatedPolicy, "isolated policy Project projections missing");
	assert(
		initialIntent.body.projectRecipients.some(
			(item) =>
				item.canonicalProjectIdentity === POLICY_SELECTED_PROJECT &&
				item.recipientKind === "identity" &&
				item.identityId === "identity-direct-personal",
		),
		"direct Identity recipient missing from policy-selected Project",
	);
	assert(
		!seededPolicy.policy.team_memberships.some(
			(item) => item.identity_id === "identity-direct-personal" && item.status === "active",
		),
		"direct Identity unexpectedly gained Team membership",
	);
	assert(
		initialIntent.body.projectRecipients.some(
			(item) =>
				item.canonicalProjectIdentity === POLICY_SELECTED_PROJECT &&
				item.recipientKind === "team" &&
				item.teamId === "team-project-sharing",
		),
		"Team recipient missing from policy-selected Project",
	);
	assert(
		unrelatedPolicy.devices.length === 1 &&
			unrelatedPolicy.devices.every(
			(item) => item.identityId === "identity-work" && item.deviceId === "device-work",
			),
		"unrelated Work Project inherited Personal or Team devices",
	);
	assert(
		selectedPolicy.devices.every((item) => item.identityId !== "identity-work"),
		"Work Identity leaked into policy-selected Personal Project",
	);

	// Arrange/Act: add a future Team member and a second device to the direct Identity.
	const inheritedPolicy = fixture(ctx, "peer-a", "inherit-policy", "30-inherit-recipient-policy");
	const inheritedIntent = await request<RecipientPolicyIntentGraph>(
		ctx,
		"peer-a",
		"/api/sync/recipient-policy/v1/intent",
		"31-inherited-recipient-intent",
	);
	// Assert: future Team membership and add-device access inherit without new Project edges.
	assert(inheritedIntent.status === 200, "inherited recipient-policy intent failed");
	const inheritedSelected = inheritedPolicy.policy.effective_projects.find(
		(item) => item.canonicalProjectIdentity === POLICY_SELECTED_PROJECT,
	);
	assert(inheritedSelected, "inherited policy-selected Project projection missing");
	assert(
		inheritedSelected.devices.some(
			(item) =>
				item.deviceId === "device-team-future" &&
				item.sources.some(
					(source) =>
						source.kind === "team_membership" && source.teamId === "team-project-sharing",
				),
		),
		"future Team member did not inherit the policy-selected Project",
	);
	assert(
		inheritedSelected.devices.some(
			(item) =>
				item.deviceId === "device-direct-2" &&
				item.sources.some((source) => source.kind === "direct_identity"),
		),
		"new device did not inherit its Identity's direct Project",
	);
	assert(
		(inheritedPolicy.action_result as { add_device_commit?: { status?: string } } | null)
			?.add_device_commit?.status === "applied",
		"add-device intent commit was not applied",
	);

	// Arrange: preview adding the Work Identity to the isolated policy-selected Project.
	const edgeChange = {
		canonicalProjectIdentity: POLICY_SELECTED_PROJECT,
		recipient: { recipientKind: "identity", identityId: "identity-work" },
		action: "add",
	};
	const edgePreview = await request<{ reviewedPolicyDigest: string }>(
		ctx,
		"peer-a",
		"/api/sync/recipient-policy/v1/edges/preview",
		"32-preview-policy-edge",
		{ version: 1, changes: [edgeChange] },
	);
	assert(edgePreview.status === 200, "recipient-policy edge preview failed");
	fixture(ctx, "peer-a", "add-stale-memory", "33-stale-preview-change");
	const refreshedEdgePreview = await request<{ reviewedPolicyDigest: string }>(
		ctx,
		"peer-a",
		"/api/sync/recipient-policy/v1/edges/preview",
		"34-refreshed-policy-edge",
		{ version: 1, changes: [edgeChange] },
	);
	assert(refreshedEdgePreview.status === 200, "refreshed recipient-policy edge preview failed");
	assert(
		refreshedEdgePreview.body.reviewedPolicyDigest !== edgePreview.body.reviewedPolicyDigest,
		"synthetic policy-selected Project change did not stale the reviewed digest",
	);
	// Act: commit the now-stale preview.
	const staleCommit = await request<{ status: string; writeCount: number }>(
		ctx,
		"peer-a",
		"/api/sync/recipient-policy/v1/edges/commit",
		"35-reject-stale-policy-edge",
		{ version: 1, changes: [edgeChange], reviewedPolicyDigest: edgePreview.body.reviewedPolicyDigest },
	);
	// Assert: stale review is rejected with no recipient mutation.
	assert(staleCommit.status === 409, "stale recipient-policy preview was not rejected");
	assert(
		staleCommit.body.status === "stale" && staleCommit.body.writeCount === 0,
		"stale recipient-policy rejection reported a write",
	);
	const afterStale = fixture(ctx, "peer-a", "summary", "36-after-stale-summary");
	assert(
		!afterStale.policy.project_recipients.some(
			(item) =>
				item.canonical_project_identity === POLICY_SELECTED_PROJECT &&
				item.recipient_id === "identity-work",
		),
		"stale recipient-policy preview mutated policy-selected Project intent",
	);

	// Arrange/Act: revoke only the policy-selected Project's direct Identity recipient.
	const revokedPolicy = fixture(ctx, "peer-a", "revoke-policy", "37-revoke-direct-recipient");
	const revokedIntent = await request<RecipientPolicyIntentGraph>(
		ctx,
		"peer-a",
		"/api/sync/recipient-policy/v1/intent",
		"38-revoked-recipient-intent",
	);
	// Assert: Team access remains, direct devices disappear, and the unrelated Work Project is unchanged.
	assert(revokedIntent.status === 200, "revoked recipient-policy intent failed");
	const revokedSelected = revokedPolicy.policy.effective_projects.find(
		(item) => item.canonicalProjectIdentity === POLICY_SELECTED_PROJECT,
	);
	const revokedUnrelated = revokedPolicy.policy.effective_projects.find(
		(item) => item.canonicalProjectIdentity === POLICY_UNRELATED_PROJECT,
	);
	assert(revokedSelected && revokedUnrelated, "revoked policy projections missing");
	for (const identityId of [finalA.actor_id, recipientPeer.actor_id]) {
		assert(
			revokedIntent.body.projectRecipients.some(
				(item) =>
					item.canonicalProjectIdentity === selected.workspace_identity &&
					item.recipientKind === "identity" &&
					item.identityId === identityId &&
					item.status === "active",
			),
			"synthetic revocation changed real direct-invite recipient access",
		);
	}
	assert(
		revokedSelected.devices.some((item) =>
			item.sources.some((source) => source.kind === "team_membership"),
		) &&
			revokedSelected.devices.every(
				(item) =>
					item.identityId !== "identity-direct-personal" &&
					item.sources.every((source) => source.kind === "team_membership"),
			),
		"revoked direct Identity retained policy-selected Project access",
	);
	assert(
		revokedUnrelated.devices.some((item) => item.deviceId === "device-work"),
		"unrelated Work Project changed during selected Project revocation",
	);

	// Arrange/Act: resolve one migration review as Keep current and rerun migration.
	const keepCurrent = fixture(ctx, "peer-a", "keep-current", "39-keep-current-migration");
	const keepCurrentProof = keepCurrent.action_result as {
		resolved?: { status?: string };
		recipient_count_unchanged?: boolean;
		resolution_durable?: boolean;
		first_migration?: { results?: Array<{ status: string; writeCount: number }> };
		second_migration?: { results?: Array<{ status: string; writeCount: number }> };
	};
	// Assert: ambiguous migration under-shares, Keep current is durable, and reruns stay no-op.
	assert(keepCurrentProof.resolved?.status === "applied", "Keep current review was not applied");
	assert(keepCurrentProof.recipient_count_unchanged === true, "Keep current migration wrote recipients");
	assert(keepCurrentProof.resolution_durable === true, "Keep current review resolution was not durable");
	assert(
		keepCurrentProof.second_migration?.results?.every(
			(item) => item.status !== "migrated" && item.writeCount === 0,
		) === true,
		"repeated Keep current migration was not a no-op",
	);

	// Arrange/Act: exercise deterministic reconciliation against isolated fake coordinator effects.
	const reconciliation = fixture(
		ctx,
		"peer-a",
		"reconciliation-proof",
		"40-recipient-reconciliation-proof",
	).action_result as unknown as ReconciliationProof;
	// Assert: unsupported peers fail before mutation; offline work waits/resumes; revocation and rollback stay visible.
	assert(
		reconciliation.unsupported.result.status === "needs_attention" &&
			reconciliation.unsupported.result.safeErrorCode === "recipient_policy_capability_unsupported",
		"unsupported old peer did not fail closed",
	);
	assert(reconciliation.unsupported.membership_unchanged, "unsupported old peer mutated membership");
	assert(reconciliation.unsupported.mutation_calls.length === 0, "unsupported old peer ran mutations");
	assert(
		reconciliation.offline_resume.waiting.status === "waiting" &&
			reconciliation.offline_resume.waiting.safeErrorCode ===
				"recipient_policy_capability_undetermined",
		"offline recipient did not enter a safe waiting state",
	);
	assert(
		reconciliation.offline_resume.resumed.status === "parity_pending" &&
			reconciliation.offline_resume.active.status === "active",
		"offline reconciliation did not resume to active",
	);
	assert(
		reconciliation.revocation.revoking.revokedDeviceIds.includes("device-revocation-old") &&
			reconciliation.revocation.active.status === "active" &&
			!reconciliation.revocation.members.includes("device-revocation-old") &&
			reconciliation.revocation.deny_overlays.length === 0,
		"revocation did not converge and clear its deny overlay",
	);
	assert(
		reconciliation.rollback.result.status === "needs_attention" &&
			reconciliation.rollback.authority?.authorityState === "rolled_back" &&
			reconciliation.rollback.mutation_calls.length === 0,
		"unsupported active Project did not roll back without grants",
	);
	const reconciliationStatus = await request<{
		items: Array<{ canonicalProjectIdentity: string; state: string; explanation: string }>;
	}>(
		ctx,
		"peer-a",
		"/api/sync/recipient-policy/v1/reconciliation-status",
		"41-reconciliation-status",
	);
	assert(
		reconciliationStatus.body.items.some(
			(item) =>
				item.canonicalProjectIdentity === "https://example.invalid/e2e/rollback.git" &&
				item.state === "needs_attention" &&
				item.explanation.includes("Legacy scope enforcement remains in control"),
		),
		"rollback was not visible through the safe reconciliation API",
	);

	ctx.compose.copyFromContainer(
		"peer-a:/data/mem.sqlite",
		`${ctx.artifactsDir}/db/peer-a-project-sharing.sqlite`,
		"42-copy-peer-a-db",
	);
	ctx.compose.copyFromContainer(
		"peer-b:/data/mem.sqlite",
		`${ctx.artifactsDir}/db/peer-b-project-sharing.sqlite`,
		"43-copy-peer-b-db",
	);
	ctx.compose.copyFromContainer(
		"coordinator:/data/coordinator.sqlite",
		`${ctx.artifactsDir}/db/coordinator-project-sharing.sqlite`,
		"44-copy-coordinator-db",
	);
	if (!ctx.keepStackOnFailure) ctx.compose.down("45-compose-down-post");
}
