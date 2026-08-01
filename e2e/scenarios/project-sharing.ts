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
const RECIPIENT_LOCAL_EXCLUDED_PROJECTS = ["project-sharing-source", "shared:default"];

interface FixtureSummary {
	device_id: string;
	actor_id: string;
	memories: Array<{ title: string; project: string | null; scope_id: string | null; active: number }>;
	actors: Array<{ actor_id: string; display_name: string; status: string }>;
	peers: Array<{
		peer_device_id: string;
		name: string | null;
		actor_id: string | null;
		pinned_fingerprint: string | null;
		trust_provenance: string | null;
		last_sync_at: string | null;
		discovered_via_coordinator_id: string | null;
		discovered_via_group_id: string | null;
	}>;
	managed_memberships: Array<{ scope_id: string; device_id: string; status: string }>;
	source_memberships: Array<{ device_id: string; status: string }>;
	operations: Array<{
		operation_id: string;
		state: string;
		teammate_name: string;
		recipient_device_id: string | null;
		recipient_device_display_name: string | null;
		updated_at: string;
	}>;
	policy: {
		authority_states: Array<{
			canonical_project_identity: string;
			authority_state: string;
			attempt_count: number;
		}>;
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
		result: { status: string; revokedDeviceIds: string[] };
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

function restartServer(ctx: ScenarioContext, service: string, artifact: string): void {
	const restarted = ctx.compose.restart(service, `${artifact}-container`);
	assertStatus(restarted.status, 0, `${service} container failed to restart`);
	startServer(ctx, service, `${artifact}-start`);
}

function readConfig(
	ctx: ScenarioContext,
	service: string,
	artifact: string,
): Record<string, unknown> {
	const result = ctx.compose.exec(
		service,
		[
			"node",
			"--input-type=module",
			"-e",
			"import { readFileSync } from 'node:fs'; console.log(readFileSync('/config/codemem.json', 'utf8'));",
		],
		artifact,
		30_000,
	);
	assertStatus(result.status, 0, `${service} config read failed`);
	return parseJson<Record<string, unknown>>(result.stdout, artifact);
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

function syncOnce(ctx: ScenarioContext, service: string, artifact: string, peerDeviceId?: string): void {
	const peerArgs = peerDeviceId ? ["--peer", peerDeviceId] : [];
	const result = ctx.compose.exec(
		service,
		[
			...CLI_PREFIX,
			"sync",
			"once",
			"--db-path",
			"/data/mem.sqlite",
			...peerArgs,
			"--json",
		],
		artifact,
		180_000,
		true,
	);
	const attempts =
		result.status === 0
			? null
			: ctx.compose.exec(
					service,
					[...CLI_PREFIX, "sync", "attempts", "--db-path", "/data/mem.sqlite", "--json"],
					`${artifact}-attempts`,
					60_000,
					true,
				);
	assert(
		result.status === 0 || result.stderr.includes("no accepted peers"),
		`${service} sync once failed: ${result.stderr || result.stdout}${attempts?.stdout ? `\nAttempts:\n${attempts.stdout}` : ""}`,
	);
}

export async function runProjectSharingScenario(ctx: ScenarioContext): Promise<void> {
	ctx.recordNote(
		"scenario.txt",
		"Project-first sharing: two isolated peers, two canonical projects, one reviewed project invite, automatic identity/device linking, exact existing-and-future replication, and source-membership non-inheritance.",
	);
	ctx.compose.down("00-compose-down-pre", true);
	ctx.compose.up(["coordinator", "peer-a", "peer-b", "peer-c"], "01-compose-up");
	ctx.compose.ps("02-compose-ps");

	fixture(ctx, "peer-a", "init", "03-init-peer-a");
	fixture(ctx, "peer-b", "init", "04-init-peer-b");
	fixture(ctx, "peer-c", "init", "04-init-peer-c");
	const peerA = readPeerIdentity(ctx, "peer-a", "05-peer-a-identity");
	const peerB = readPeerIdentity(ctx, "peer-b", "06-peer-b-identity");
	const peerC = readPeerIdentity(ctx, "peer-c", "06-peer-c-identity");
	const seededA = fixture(ctx, "peer-a", "seed-a", "07-seed-peer-a");
	assert(
		seededA.source_memberships.some((member) => member.device_id === "source-bystander"),
		"source bystander fixture missing",
	);

	// Keep periodic maintenance outside this scenario so explicit steps own the provisioning order.
	for (const [service, deviceName, syncEnabled, hasAdminSecret] of [
		["peer-a", "Adam's Test Mac", true, true],
		["peer-b", "Brian's Test Mac", false, false],
		["peer-c", "Brian's Second Mac", false, false],
	] as const) {
		writePeerConfig(
			ctx,
			service,
			{
				actor_display_name: service === "peer-a" ? "Adam" : "Brian",
				sync_device_name: deviceName,
				sync_enabled: syncEnabled,
				sync_host: "0.0.0.0",
				sync_port: 7337,
				sync_advertise: `http://${service}:7337`,
				sync_interval_s: 3600,
				sync_coordinator_url: "http://coordinator:7347",
				sync_coordinator_group: GROUP_ID,
				...(hasAdminSecret ? { sync_coordinator_admin_secret: ADMIN_SECRET } : {}),
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
	await waitFor(
		async () => {
			const status = await request<{ daemon_state: string; daemon_last_ok_at?: string | null }>(
				ctx,
				"peer-a",
				"/api/sync/status?includeDiagnostics=true",
				"14-owner-initial-sync-complete",
			);
			assert(status.status === 200, "owner sync status failed");
			assert(status.body.daemon_state !== "starting", "owner initial sync is still starting");
			assert(status.body.daemon_last_ok_at, "owner initial sync has not completed");
		},
		{ description: "owner initial sync before Project invite", timeoutMs: 120_000, intervalMs: 2_000 },
	);

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
	assert(
		accepted.body.status === "pending_setup" &&
			accepted.body.sync_enabled === true &&
			accepted.body.type === "project_share" &&
			accepted.body.setup_state === "restart_required" &&
			accepted.body.restart_required === true,
		"disabled recipient acceptance must remain pending and require restart",
	);
	assert(
		String(accepted.body.detail ?? "").includes("Restart codemem"),
		"restart-required acceptance did not provide actionable detail",
	);
	const enabledRecipientConfig = readConfig(ctx, "peer-b", "19-read-enabled-peer-b-config");
	assert(enabledRecipientConfig.sync_enabled === true, "project acceptance did not persist recipient sync");
	restartServer(ctx, "peer-b", "20-restart-peer-b");
	await waitForServer(ctx, "peer-b", "21-peer-b-ready-after-restart");
	await waitFor(
		async () => {
			const status = await request<{ daemon_state: string; daemon_last_ok_at?: string | null }>(
				ctx,
				"peer-b",
				"/api/sync/status?includeDiagnostics=true",
				"21-recipient-initial-sync-complete",
			);
			assert(status.status === 200, "recipient sync status failed");
			assert(status.body.daemon_state !== "starting", "recipient initial sync is still starting");
			assert(status.body.daemon_last_ok_at, "recipient initial sync has not completed");
		},
		{ description: "recipient initial sync after restart", timeoutMs: 120_000, intervalMs: 2_000 },
	);
	const startupRecipient = fixture(ctx, "peer-b", "summary", "22-peer-b-post-startup-summary");
	const startupTitles = startupRecipient.memories.map((memory) => memory.title);
	assert(
		!startupTitles.includes("selected existing"),
		"selected existing memory reached peer-b during its startup sync",
	);
	assert(
		!startupTitles.includes("unrelated existing"),
		"unrelated existing memory leaked to peer-b during its startup sync",
	);
	const ownerPresence = await request<Record<string, unknown>>(
		ctx,
		"peer-a",
		"/api/sync/status?includeDiagnostics=true",
		"23-refresh-owner-presence",
	);
	assert(ownerPresence.status === 200, "owner presence refresh failed before recipient sync");

	// The recipient's bootstrap-grant snapshot pull is the pre-provisioning leak window.
	syncOnce(ctx, "peer-b", "24-sync-recipient-before-provisioning");
	const preProvisioning = fixture(ctx, "peer-b", "summary", "25-peer-b-pre-provisioning-summary");
	const preProvisioningTitles = preProvisioning.memories.map((memory) => memory.title);
	assert(
		!preProvisioningTitles.includes("selected existing"),
		"selected existing memory reached peer-b before Project provisioning became active",
	);
	assert(
		!preProvisioningTitles.includes("unrelated existing"),
		"unrelated existing memory leaked to peer-b while Project provisioning was non-active",
	);
	const preProvisioningOwner = fixture(ctx, "peer-a", "summary", "26-peer-a-pre-provisioning-summary");
	const pendingOperation = preProvisioningOwner.operations.find(
		(item) => item.operation_id === created.body.operation_id,
	);
	assert(
		pendingOperation?.state === "waiting_for_acceptance",
		`owner provisioning advanced before the pre-provisioning sync: ${pendingOperation?.state ?? "missing"}`,
	);
	assert(
		preProvisioning.peers.some((peer) => peer.peer_device_id === peerA.device_id),
		"peer-b has no peer-a record after the pre-provisioning sync",
	);
	const reconciled = await request<Record<string, unknown>>(
		ctx,
		"peer-a",
		`/api/sync/project-invites/${created.body.operation_id}/reconcile`,
		"27-reconcile-owner-after-pre-provisioning-sync",
		{},
	);
	assert(reconciled.status === 200, `acceptance reconciliation failed: ${JSON.stringify(reconciled.body)}`);
	const provisioningOwner = fixture(ctx, "peer-a", "summary", "28-peer-a-provisioning-summary");
	const provisioningOperation = provisioningOwner.operations.find(
		(item) => item.operation_id === created.body.operation_id,
	);
	assert(
		provisioningOperation?.state === "provisioning",
		`owner operation did not enter provisioning after reconciliation: ${provisioningOperation?.state ?? "missing"}`,
	);
	assert(
		provisioningOperation.recipient_device_id === peerB.device_id,
		"owner reconciliation did not link the recipient device",
	);
	assert(
		provisioningOwner.peers.some((peer) => peer.peer_device_id === peerB.device_id),
		"peer-a has no peer-b record after reconciliation",
	);

	const recipientBeforeOfflineWait = await request<{ daemon_last_ok_at?: string | null }>(
		ctx,
		"peer-b",
		"/api/sync/status?includeDiagnostics=true",
		"29-recipient-before-offline-wait",
	);
	const stoppedRecipient = ctx.compose.stop("peer-b", "29-stop-recipient-before-provisioning");
	assertStatus(stoppedRecipient.status, 0, "recipient failed to stop before offline provisioning check");
	const offlineAdvance = await request<{ error?: string }>(
		ctx,
		"peer-a",
		`/api/sync/share-operations/${created.body.operation_id}/advance`,
		"29-advance-project-share-offline",
		{},
	);
	assert(
		offlineAdvance.status === 409 && offlineAdvance.body.error === "waiting_for_device",
		`offline recipient did not enter a safe waiting state: ${JSON.stringify(offlineAdvance.body)}`,
	);
	const waitingOwner = fixture(ctx, "peer-a", "summary", "29-peer-a-waiting-summary");
	const waitingOperation = waitingOwner.operations.find(
		(item) => item.operation_id === created.body.operation_id,
	);
	assert(
		waitingOperation?.state === "waiting_for_device",
		`offline recipient did not persist waiting_for_device: ${waitingOperation?.state ?? "missing"}`,
	);

	const startedRecipient = ctx.compose.start("peer-b", "30-start-recipient-for-auto-resume-container");
	assertStatus(startedRecipient.status, 0, "recipient container failed to start for automatic resume");
	startServer(ctx, "peer-b", "30-start-recipient-for-auto-resume-server");
	await waitForServer(ctx, "peer-b", "30-recipient-ready-for-auto-resume");
	await waitFor(
		async () => {
			const status = await request<{ daemon_state: string; daemon_last_ok_at?: string | null }>(
				ctx,
				"peer-b",
				"/api/sync/status?includeDiagnostics=true",
				"30-recipient-sync-ready-after-reconnect",
			);
			assert(status.body.daemon_state !== "starting", "recipient sync is still starting");
			assert(status.body.daemon_last_ok_at, "recipient sync has not completed after reconnect");
			assert(
				!recipientBeforeOfflineWait.body.daemon_last_ok_at ||
					status.body.daemon_last_ok_at > recipientBeforeOfflineWait.body.daemon_last_ok_at,
				"recipient sync status did not advance after reconnect",
			);
		},
		{ description: "recipient sync readiness after reconnect", timeoutMs: 120_000, intervalMs: 2_000 },
	);
	syncOnce(ctx, "peer-a", "30-sync-reconnected-recipient", peerB.device_id);
	const reconnectReadModel = await request<{
		lifecycle: { state: string; label: string; explanation: string };
	}>(
		ctx,
		"peer-a",
		`/api/sync/share-operations/${created.body.operation_id}`,
		"30-reconnected-operation-read-model",
	);
	assert(reconnectReadModel.status === 200, "reconnected operation read model failed");
	assert(
		reconnectReadModel.body.lifecycle.label !== "Checking device compatibility",
		`recipient reachability did not resolve capability preflight: ${JSON.stringify(reconnectReadModel.body.lifecycle)}`,
	);
	assert(
		reconnectReadModel.body.lifecycle.state === "waiting_for_device" &&
			reconnectReadModel.body.lifecycle.label === "Finishing project setup" &&
			!reconnectReadModel.body.lifecycle.explanation.includes("Waiting to reach"),
		`online recipient was still described as offline: ${JSON.stringify(reconnectReadModel.body.lifecycle)}`,
	);
	const syncedOwner = fixture(ctx, "peer-a", "summary", "30-peer-a-reconnected-sync-summary");
	const reconnectedPeer = syncedOwner.peers.find((peer) => peer.peer_device_id === peerB.device_id);
	assert(
		reconnectedPeer?.last_sync_at && reconnectedPeer.last_sync_at > waitingOperation.updated_at,
		`owner did not record successful recipient sync after the wait: ${reconnectedPeer?.last_sync_at ?? "missing"}`,
	);
	const ownerConfigBeforeAutoResume = readConfig(
		ctx,
		"peer-a",
		"31-read-owner-config-for-auto-resume",
	);
	writePeerConfig(
		ctx,
		"peer-a",
		{ ...ownerConfigBeforeAutoResume, sync_interval_s: 2 },
		"31-enable-owner-maintenance-for-auto-resume",
	);
	restartServer(ctx, "peer-a", "31-restart-owner-for-automatic-maintenance");
	await waitForServer(ctx, "peer-a", "31-owner-ready-for-automatic-maintenance");
	await waitFor(
		async () => {
			const resumedOwner = fixture(ctx, "peer-a", "summary", "31-peer-a-auto-resumed-summary");
			const resumedOperation = resumedOwner.operations.find(
				(item) => item.operation_id === created.body.operation_id,
			);
			assert(
				resumedOperation?.state === "active",
				`project provisioning did not resume automatically: ${resumedOperation?.state ?? "missing"}`,
			);
		},
		{ description: "automatic Project setup resume", timeoutMs: 180_000, intervalMs: 3_000 },
	);
	writePeerConfig(
		ctx,
		"peer-a",
		ownerConfigBeforeAutoResume,
		"31-restore-owner-config-after-auto-resume",
	);
	// The running daemon captures its interval at startup; restart to keep the owner quiet
	// until the second-device no-leak check deliberately re-enables reconciliation below.
	restartServer(ctx, "peer-a", "31-restart-owner-after-auto-resume");
	await waitForServer(ctx, "peer-a", "31-owner-ready-after-auto-resume");

	syncOnce(ctx, "peer-a", "32-sync-existing-a");
	syncOnce(ctx, "peer-b", "33-sync-existing-b");
	await waitFor(
		async () => {
			const summary = fixture(ctx, "peer-b", "summary", "34-peer-b-existing-summary");
			const titles = summary.memories.map((memory) => memory.title);
			assert(titles.includes("selected existing"), "selected existing memory has not arrived");
			assert(!titles.includes("unrelated existing"), "unrelated existing memory leaked to peer-b");
		},
		{ description: "selected existing memory on peer-b", timeoutMs: 120_000, intervalMs: 3_000 },
	);

	fixture(ctx, "peer-a", "add-future", "35-add-future-memories");
	syncOnce(ctx, "peer-a", "36-sync-future-a");
	syncOnce(ctx, "peer-b", "37-sync-future-b");
	await waitFor(
		async () => {
			const summary = fixture(ctx, "peer-b", "summary", "38-peer-b-future-summary");
			const titles = summary.memories.map((memory) => memory.title);
			assert(titles.includes("selected future"), "selected future memory has not arrived");
			for (const forbidden of ["unrelated existing", "unrelated future"]) {
				assert(!titles.includes(forbidden), `${forbidden} leaked to peer-b`);
			}
		},
		{ description: "selected future memory and unrelated-project isolation", timeoutMs: 120_000, intervalMs: 3_000 },
	);

	const finalA = fixture(ctx, "peer-a", "summary", "39-peer-a-final-summary");
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

	const recipientIdentityId = String(enabledRecipientConfig.actor_id ?? "").trim();
	assert(recipientIdentityId, "recipient Identity was not persisted after direct-share acceptance");
	const beforeAddDeviceInviterRestart = await request<{ daemon_last_ok_at?: string | null }>(
		ctx,
		"peer-b",
		"/api/sync/status?includeDiagnostics=true",
		"39-add-device-inviter-before-restart",
	);
	restartServer(ctx, "peer-b", "39-restart-add-device-inviter");
	await waitForServer(ctx, "peer-b", "39-add-device-inviter-ready");
	await waitFor(
		async () => {
			const status = await request<{ daemon_last_ok_at?: string | null }>(
				ctx,
				"peer-b",
				"/api/sync/status?includeDiagnostics=true",
				"39-add-device-inviter-presence",
			);
			assert(status.body.daemon_last_ok_at, "add-device inviter presence has not refreshed");
			assert(
				!beforeAddDeviceInviterRestart.body.daemon_last_ok_at ||
					status.body.daemon_last_ok_at > beforeAddDeviceInviterRestart.body.daemon_last_ok_at,
				"add-device inviter presence did not advance after restart",
			);
		},
		{ description: "add-device inviter presence", timeoutMs: 120_000, intervalMs: 2_000 },
	);
	const addDevicePreview = await request<{
		preview: {
			reviewedOnboardingDigest: string;
			projects: Array<{
				canonicalProjectIdentity: string;
				sources: Array<{ kind: "direct" } | { kind: "team"; teamId: string }>;
			}>;
			excludedProjects: Array<{ canonicalProjectIdentity: string }>;
		};
	}>(ctx, "peer-b", "/api/sync/recipient-policy/v1/invites/preview", "39-add-device-preview", {
		kind: "add_device",
		target_identity_id: recipientIdentityId,
	});
	assert(addDevicePreview.status === 200, "add-device preview failed");
	const reviewedProjectIdentities = addDevicePreview.body.preview.projects.map(
		(project) => project.canonicalProjectIdentity,
	);
	const excludedProjectIdentities = addDevicePreview.body.preview.excludedProjects.map(
		(project) => project.canonicalProjectIdentity,
	);
	assert(
		JSON.stringify(reviewedProjectIdentities) === JSON.stringify([selected.workspace_identity]),
		"add-device preview did not contain exactly the directly inherited selected canonical Project",
	);
	const reviewedSelectedProject = addDevicePreview.body.preview.projects[0];
	assert(
		JSON.stringify(reviewedSelectedProject?.sources) === JSON.stringify([{ kind: "direct" }]),
		"selected canonical Project was not sourced only from direct recipient inheritance",
	);
	assert(
		!reviewedProjectIdentities.includes(unrelated.workspace_identity),
		"unrelated canonical Project appeared in the reviewed add-device selection",
	);
	assert(
		JSON.stringify(excludedProjectIdentities) ===
			JSON.stringify(RECIPIENT_LOCAL_EXCLUDED_PROJECTS),
		"add-device preview did not preserve the exact recipient-local Project exclusions",
	);
	assert(
		!excludedProjectIdentities.includes(selected.workspace_identity),
		"selected canonical Project was incorrectly excluded from add-device inheritance",
	);
	const addDeviceCreated = await request<{
		invite: { encoded: string };
	}>(ctx, "peer-b", "/api/sync/recipient-policy/v1/invites", "39-add-device-create", {
		kind: "add_device",
		target_identity_id: recipientIdentityId,
		reviewed_onboarding_digest: addDevicePreview.body.preview.reviewedOnboardingDigest,
		ttl_hours: 24,
	});
	assert(addDeviceCreated.status === 200, "signed add-device invitation creation failed");
	startServer(ctx, "peer-c", "39-start-peer-c-for-add-device");
	await waitForServer(ctx, "peer-c", "39-peer-c-ready-for-add-device");
	const addDeviceInspected = await request<{
		reviewed_intent: {
			projects: Array<{
				canonicalProjectIdentity: string;
				sources: Array<{ kind: "direct" } | { kind: "team"; teamId: string }>;
			}>;
			excludedProjects: Array<{ canonicalProjectIdentity: string }>;
		};
		onboarding: {
			reviewedOnboardingDigest: string;
			projects: Array<{ canonicalProjectIdentity: string }>;
			excludedProjects: Array<{ canonicalProjectIdentity: string }>;
		};
	}>(ctx, "peer-c", "/api/sync/invites/inspect", "39-add-device-inspect", {
		invite: addDeviceCreated.body.invite.encoded,
		device_name: "Brian's Second Mac",
	});
	assert(addDeviceInspected.status === 200, "add-device invitation inspection failed");
	const inspectedProjectIdentities = addDeviceInspected.body.onboarding.projects.map(
		(project) => project.canonicalProjectIdentity,
	);
	const inspectedExcludedProjectIdentities = addDeviceInspected.body.onboarding.excludedProjects.map(
		(project) => project.canonicalProjectIdentity,
	);
	assert(
		JSON.stringify(inspectedProjectIdentities) === JSON.stringify(reviewedProjectIdentities),
		"peer-c inspection changed the exact reviewed canonical Project selection",
	);
	assert(
		JSON.stringify(inspectedExcludedProjectIdentities) === JSON.stringify(excludedProjectIdentities),
		"peer-c inspection changed the exact excluded canonical Project identities",
	);
	const storedReviewedProjectIdentities = addDeviceInspected.body.reviewed_intent.projects.map(
		(project) => project.canonicalProjectIdentity,
	);
	const storedExcludedProjectIdentities = addDeviceInspected.body.reviewed_intent.excludedProjects.map(
		(project) => project.canonicalProjectIdentity,
	);
	assert(
		JSON.stringify(storedReviewedProjectIdentities) === JSON.stringify(reviewedProjectIdentities),
		"coordinator-stored reviewed intent changed the selected canonical Project before acceptance",
	);
	assert(
		JSON.stringify(addDeviceInspected.body.reviewed_intent.projects[0]?.sources) ===
			JSON.stringify([{ kind: "direct" }]),
		"coordinator-stored reviewed intent did not preserve direct recipient inheritance",
	);
	assert(
		JSON.stringify(storedExcludedProjectIdentities) === JSON.stringify(excludedProjectIdentities),
		"coordinator-stored reviewed intent changed the excluded canonical identities before acceptance",
	);
	const addDeviceAccepted = await request<Record<string, unknown>>(
		ctx,
		"peer-c",
		"/api/sync/invites/import",
		"39-add-device-accept",
		{
			invite: addDeviceCreated.body.invite.encoded,
			device_name: "Brian's Second Mac",
			reviewed_onboarding_digest: addDeviceInspected.body.onboarding.reviewedOnboardingDigest,
		},
	);
	assert(addDeviceAccepted.status === 200, "add-device invitation acceptance failed");
	restartServer(ctx, "peer-c", "39-restart-peer-c");
	await waitForServer(ctx, "peer-c", "39-peer-c-ready-after-restart");
	const adoptedSecondDeviceConfig = readConfig(ctx, "peer-c", "39-read-peer-c-adopted-identity");
	assert(
		String(adoptedSecondDeviceConfig.actor_id ?? "").trim() === recipientIdentityId,
		"second device did not persist the invited recipient Identity",
	);
	await waitFor(
		async () => {
			const status = await request<{ daemon_state: string; daemon_last_ok_at?: string | null }>(
				ctx,
				"peer-c",
				"/api/sync/status?includeDiagnostics=true",
				"39-peer-c-initial-sync-complete",
			);
			assert(status.status === 200, "second-device sync status failed");
			assert(status.body.daemon_state !== "starting", "second-device initial sync is still starting");
			assert(status.body.daemon_last_ok_at, "second-device initial sync has not completed");
		},
		{ description: "second-device initial sync", timeoutMs: 120_000, intervalMs: 2_000 },
	);
	const beforeEnrollmentReconcile = fixture(ctx, "peer-c", "summary", "39-peer-c-before-reconcile");
	assert(
		beforeEnrollmentReconcile.memories.every(
			(memory) =>
				memory.title !== "selected existing" &&
				memory.title !== "selected future" &&
				memory.title !== "unrelated existing" &&
				memory.title !== "unrelated future",
		),
		"second device received Project data before owner reconciliation",
	);

	const ownerConfig = readConfig(ctx, "peer-a", "39-read-owner-config");
	writePeerConfig(
		ctx,
		"peer-a",
		{ ...ownerConfig, sync_interval_s: 2 },
		"39-enable-owner-reconciliation",
	);
	restartServer(ctx, "peer-a", "39-restart-owner-for-reconciliation");
	await waitForServer(ctx, "peer-a", "39-owner-ready-for-reconciliation");
	await waitFor(
		async () => {
			const owner = fixture(ctx, "peer-a", "summary", "39-owner-enrollment-reconciled");
			assert(
				owner.policy.identity_devices.some(
					(device) =>
						device.identity_id === recipientIdentityId &&
						device.device_id === peerC.device_id &&
						device.status === "active",
				),
				"owner policy has not ingested the second device",
			);
			assert(
				owner.managed_memberships.some(
					(member) => member.device_id === peerC.device_id && member.status === "active",
				),
				"owner reconciliation has not granted the managed Project boundary",
			);
		},
		{ description: "second-device owner reconciliation", timeoutMs: 180_000, intervalMs: 3_000 },
	);
	const beforeBootstrapGrantRefresh = await request<{ daemon_last_ok_at?: string | null }>(
		ctx,
		"peer-b",
		"/api/sync/status?includeDiagnostics=true",
		"39-inviter-before-bootstrap-grant-refresh",
	);
	restartServer(ctx, "peer-b", "39-restart-inviter-after-add-device-acceptance");
	await waitForServer(ctx, "peer-b", "39-inviter-ready-after-add-device-acceptance");
	await waitFor(
		async () => {
			const status = await request<{ daemon_state: string; daemon_last_ok_at?: string | null }>(
				ctx,
				"peer-b",
				"/api/sync/status?includeDiagnostics=true",
				"39-inviter-bootstrap-grant-refresh",
			);
			assert(status.body.daemon_state !== "starting", "inviter bootstrap-grant refresh is starting");
			assert(status.body.daemon_last_ok_at, "inviter bootstrap-grant refresh has not completed");
			assert(
				!beforeBootstrapGrantRefresh.body.daemon_last_ok_at ||
					status.body.daemon_last_ok_at > beforeBootstrapGrantRefresh.body.daemon_last_ok_at,
				"inviter bootstrap-grant refresh did not advance after restart",
			);
		},
		{ description: "inviter bootstrap-grant refresh", timeoutMs: 120_000, intervalMs: 2_000 },
	);
	const beforePostGrantRestart = await request<{ last_sync_at?: string | null }>(
		ctx,
		"peer-c",
		"/api/sync/status?includeDiagnostics=true",
		"39-peer-c-before-post-grant-restart",
	);
	restartServer(ctx, "peer-c", "39-restart-peer-c-after-grant");
	await waitForServer(ctx, "peer-c", "39-peer-c-ready-after-grant");
	await waitFor(
		async () => {
			const status = await request<{
				peers: Array<{ peer_device_id: string; pinned: boolean }>;
				last_sync_at?: string | null;
				daemon_last_ok_at?: string | null;
			}>(
				ctx,
				"peer-c",
				"/api/sync/status?includeDiagnostics=true",
				"39-peer-c-discovery-after-grant",
			);
			assert(status.body.daemon_last_ok_at, "second-device post-grant sync has not completed");
			assert(
				status.body.last_sync_at &&
					status.body.last_sync_at !== beforePostGrantRestart.body.last_sync_at,
				"second-device post-grant sync has not advanced",
			);
			assert(
				status.body.peers.some(
					(peer) => peer.peer_device_id === peerA.device_id && peer.pinned === true,
				),
				"second device has not established direct trust with the Project owner",
			);
		},
		{ description: "second-device discovery after grant", timeoutMs: 120_000, intervalMs: 2_000 },
	);
	syncOnce(ctx, "peer-c", "39-sync-peer-c-after-reconciliation", peerA.device_id);
	await waitFor(
		async () => {
			const summary = fixture(ctx, "peer-c", "summary", "39-peer-c-existing-after-reconcile");
			const titles = summary.memories.map((memory) => memory.title);
			assert(titles.includes("selected existing"), "second device did not receive existing Project data");
			assert(titles.includes("selected future"), "second device did not receive pre-enrollment history");
			assert(!titles.includes("unrelated existing"), "unrelated Project leaked to the second device");
		},
		{ description: "existing Project data on second device", timeoutMs: 120_000, intervalMs: 3_000 },
	);
	fixture(ctx, "peer-a", "add-device-future", "39-add-post-device-memory");
	syncOnce(ctx, "peer-a", "39-sync-post-device-owner", peerB.device_id);
	syncOnce(ctx, "peer-c", "39-sync-post-device-recipient");
	await waitFor(
		async () => {
			const summary = fixture(ctx, "peer-c", "summary", "39-peer-c-post-device-future");
			const titles = summary.memories.map((memory) => memory.title);
			assert(titles.includes("selected after device"), "second device did not receive future Project data");
			assert(!titles.includes("unrelated future"), "unrelated future data leaked to the second device");
			assert(
				!titles.includes("unrelated after device"),
				"post-enrollment unrelated data leaked to the second device",
			);
		},
		{ description: "future Project data on second device", timeoutMs: 120_000, intervalMs: 3_000 },
	);

	// Arrange: retain a local-only anchor, then disable peer-c in the exact coordinator group.
	const localAnchor = fixture(ctx, "peer-c", "add-stale-memory", "39-seed-peer-c-local-anchor");
	assert(
		localAnchor.memories.some(
			(memory) => memory.title === "policy selected stale-preview change" && memory.active === 1,
		),
		"second-device local anchor was not created before enrollment revocation",
	);
	const beforeEnrollmentDisable = fixture(
		ctx,
		"peer-a",
		"summary",
		"39-owner-before-peer-c-enrollment-disable",
	);
	const selectedScopeMembership = beforeEnrollmentDisable.managed_memberships.find(
		(member) => member.device_id === peerC.device_id && member.status === "active",
	);
	assert(selectedScopeMembership, "peer-c was not active in the selected managed Project before disable");
	assert(
		beforeEnrollmentDisable.peers.some(
			(peer) =>
				peer.peer_device_id === peerC.device_id &&
				peer.pinned_fingerprint &&
				peer.trust_provenance === "coordinator_policy" &&
				peer.discovered_via_group_id === GROUP_ID,
		),
		"owner did not hold group-derived coordinator-policy trust for peer-c before disable",
	);
	const disabledEnrollment = ctx.compose.exec(
		"coordinator",
		[
			...CLI_PREFIX,
			"sync",
			"coordinator",
			"disable-device",
			GROUP_ID,
			peerC.device_id,
			"--db-path",
			"/data/coordinator.sqlite",
			"--json",
		],
		"39-disable-peer-c-enrollment",
	);
	assertStatus(disabledEnrollment.status, 0, "peer-c coordinator enrollment disable failed");

	// Act: periodic owner maintenance reads the disabled enrollment and reconciles the exact Project scope.
	let revocationAttemptCount = -1;
	await waitFor(
		async () => {
			const owner = fixture(ctx, "peer-a", "summary", "39-owner-peer-c-revocation-convergence");
			assert(
				owner.managed_memberships.some(
					(member) =>
						member.scope_id === selectedScopeMembership.scope_id &&
						member.device_id === peerC.device_id &&
						member.status === "revoked",
				),
				"owner maintenance has not revoked peer-c from the selected managed Project",
			);
			assert(
				owner.policy.identity_devices.some(
					(device) => device.device_id === peerC.device_id && device.status === "active",
				),
				"group-scoped enrollment disable globally revoked peer-c's Identity device",
			);
			assert(
				!owner.peers.some(
					(peer) =>
						peer.peer_device_id === peerC.device_id &&
						(peer.pinned_fingerprint || peer.trust_provenance === "coordinator_policy"),
				),
				"coordinator-policy-derived peer-c trust survived the scope refresh",
			);
			const authority = owner.policy.authority_states.find(
				(state) => state.canonical_project_identity === selected.workspace_identity,
			);
			assert(authority, "selected Project recipient-policy authority state is missing");
			revocationAttemptCount = authority.attempt_count;
		},
		{ description: "group-scoped peer-c enrollment revocation", timeoutMs: 180_000, intervalMs: 3_000 },
	);

	// Act: let another deterministic maintenance tick run to exercise retry convergence.
	await waitFor(
		async () => {
			const owner = fixture(
				ctx,
				"peer-a",
				"summary",
				"39-owner-peer-c-revocation-retry-attempt",
			);
			const authority = owner.policy.authority_states.find(
				(state) => state.canonical_project_identity === selected.workspace_identity,
			);
			assert(
				authority && authority.attempt_count > revocationAttemptCount,
				"selected Project reconciliation retry has not advanced",
			);
		},
		{ description: "idempotent enrollment revocation retry", timeoutMs: 120_000, intervalMs: 2_000 },
	);
	const afterRevocationRetry = fixture(
		ctx,
		"peer-a",
		"summary",
		"39-owner-after-peer-c-revocation-retry",
	);
	assert(
		afterRevocationRetry.managed_memberships.filter(
			(member) =>
				member.scope_id === selectedScopeMembership.scope_id && member.device_id === peerC.device_id,
		).length === 1 &&
			afterRevocationRetry.managed_memberships.some(
				(member) =>
					member.scope_id === selectedScopeMembership.scope_id &&
					member.device_id === peerC.device_id &&
					member.status === "revoked",
			),
		"repeated disabled-enrollment maintenance did not remain idempotently revoked",
	);
	assert(
		!afterRevocationRetry.peers.some(
			(peer) =>
				peer.peer_device_id === peerC.device_id &&
				(peer.pinned_fingerprint || peer.trust_provenance === "coordinator_policy"),
		),
		"repeated disabled-enrollment maintenance restored coordinator-policy trust",
	);

	// Act: publish new selected-Project data and make peer-c attempt a direct refresh from the owner.
	fixture(ctx, "peer-a", "add-after-revocation", "39-add-selected-memory-after-revocation");
	const revokedSync = ctx.compose.exec(
		"peer-c",
		[
			...CLI_PREFIX,
			"sync",
			"once",
			"--db-path",
			"/data/mem.sqlite",
			"--peer",
			peerA.device_id,
			"--json",
		],
		"39-sync-peer-c-after-revocation",
		180_000,
		true,
	);
	assertStatus(revokedSync.status, 1, "revoked peer-c sync was not blocked by the owner");
	const revokedSyncResult = parseJson<{
		ok: boolean;
		results: Array<{ peer_device_id: string; ok: boolean; error?: string }>;
	}>(revokedSync.stdout, "39-sync-peer-c-after-revocation");
	assert(
		revokedSyncResult.ok === false &&
			revokedSyncResult.results.some(
				(result) =>
					result.peer_device_id === peerA.device_id &&
					result.ok === false &&
					String(result.error ?? "").includes("unauthorized:unknown_peer"),
			),
		"revoked peer-c sync did not fail through the owner's trust boundary",
	);
	const peerCAfterRevocation = fixture(
		ctx,
		"peer-c",
		"summary",
		"39-peer-c-after-revocation-summary",
	);
	// Assert: revoked Project data is blocked while unrelated local data remains intact.
	assert(
		!peerCAfterRevocation.memories.some((memory) => memory.title === "selected after revocation"),
		"peer-c received selected Project data after its group-scoped enrollment was revoked",
	);
	assert(
		peerCAfterRevocation.memories.some(
			(memory) => memory.title === "policy selected stale-preview change" && memory.active === 1,
		),
		"group-scoped enrollment revocation removed unrelated local data from peer-c",
	);

	const ownerConfigBeforePolicyProof = readConfig(
		ctx,
		"peer-a",
		"39-read-owner-config-before-policy-proof",
	);
	writePeerConfig(
		ctx,
		"peer-a",
		{ ...ownerConfigBeforePolicyProof, sync_enabled: false, sync_interval_s: 3600 },
		"39-disable-owner-maintenance-before-policy-proof",
	);
	restartServer(ctx, "peer-a", "39-restart-owner-without-maintenance");
	await waitForServer(ctx, "peer-a", "39-owner-ready-without-maintenance");

	// Arrange: seed isolated recipient intent without changing the real direct-invite Projects.
	const seededPolicy = fixture(ctx, "peer-a", "seed-policy", "40-seed-recipient-policy");
	// Act: read canonical intent and derive effective devices from the persisted graph.
	const initialIntent = await request<RecipientPolicyIntentGraph>(
		ctx,
		"peer-a",
		"/api/sync/recipient-policy/v1/intent",
		"41-initial-recipient-intent",
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
	const inheritedPolicy = fixture(ctx, "peer-a", "inherit-policy", "42-inherit-recipient-policy");
	const inheritedIntent = await request<RecipientPolicyIntentGraph>(
		ctx,
		"peer-a",
		"/api/sync/recipient-policy/v1/intent",
		"43-inherited-recipient-intent",
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
		"44-preview-policy-edge",
		{ version: 1, changes: [edgeChange] },
	);
	assert(edgePreview.status === 200, "recipient-policy edge preview failed");
	fixture(ctx, "peer-a", "add-stale-memory", "45-stale-preview-change");
	const refreshedEdgePreview = await request<{ reviewedPolicyDigest: string }>(
		ctx,
		"peer-a",
		"/api/sync/recipient-policy/v1/edges/preview",
		"46-refreshed-policy-edge",
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
		"47-reject-stale-policy-edge",
		{ version: 1, changes: [edgeChange], reviewedPolicyDigest: edgePreview.body.reviewedPolicyDigest },
	);
	// Assert: stale review is rejected with no recipient mutation.
	assert(staleCommit.status === 409, "stale recipient-policy preview was not rejected");
	assert(
		staleCommit.body.status === "stale" && staleCommit.body.writeCount === 0,
		"stale recipient-policy rejection reported a write",
	);
	const afterStale = fixture(ctx, "peer-a", "summary", "48-after-stale-summary");
	assert(
		!afterStale.policy.project_recipients.some(
			(item) =>
				item.canonical_project_identity === POLICY_SELECTED_PROJECT &&
				item.recipient_id === "identity-work",
		),
		"stale recipient-policy preview mutated policy-selected Project intent",
	);

	// Arrange/Act: revoke only the policy-selected Project's direct Identity recipient.
	const revokedPolicy = fixture(ctx, "peer-a", "revoke-policy", "49-revoke-direct-recipient");
	const revokedIntent = await request<RecipientPolicyIntentGraph>(
		ctx,
		"peer-a",
		"/api/sync/recipient-policy/v1/intent",
		"50-revoked-recipient-intent",
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
	const keepCurrent = fixture(ctx, "peer-a", "keep-current", "51-keep-current-migration");
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
		"52-recipient-reconciliation-proof",
	).action_result as unknown as ReconciliationProof;
	// Assert: unsupported grant candidates fail before mutation; offline work waits/resumes; revocation and rollback stay visible.
	assert(
		reconciliation.unsupported.result.status === "needs_attention" &&
			reconciliation.unsupported.result.safeErrorCode === "recipient_policy_capability_unsupported",
		"unsupported grant candidate did not fail closed",
	);
	assert(
		reconciliation.unsupported.membership_unchanged,
		"unsupported grant candidate mutated membership",
	);
	assert(
		reconciliation.unsupported.mutation_calls.length === 0,
		"unsupported grant candidate ran mutations",
	);
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
			reconciliation.rollback.result.revokedDeviceIds.includes("device-rollback-old") &&
			reconciliation.rollback.authority?.authorityState === "rolled_back" &&
			reconciliation.rollback.mutation_calls.join(",") ===
				"revoke:device-rollback-old,refresh",
		"unsupported active Project did not revoke stale access and roll back without grants",
	);
	const reconciliationStatus = await request<{
		items: Array<{ canonicalProjectIdentity: string; state: string; explanation: string }>;
	}>(
		ctx,
		"peer-a",
		"/api/sync/recipient-policy/v1/reconciliation-status",
		"53-reconciliation-status",
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
		"54-copy-peer-a-db",
	);
	ctx.compose.copyFromContainer(
		"peer-b:/data/mem.sqlite",
		`${ctx.artifactsDir}/db/peer-b-project-sharing.sqlite`,
		"55-copy-peer-b-db",
	);
	ctx.compose.copyFromContainer(
		"peer-c:/data/mem.sqlite",
		`${ctx.artifactsDir}/db/peer-c-project-sharing.sqlite`,
		"55-copy-peer-c-db",
	);
	ctx.compose.copyFromContainer(
		"coordinator:/data/coordinator.sqlite",
		`${ctx.artifactsDir}/db/coordinator-project-sharing.sqlite`,
		"56-copy-coordinator-db",
	);
	if (!ctx.keepStackOnFailure) ctx.compose.down("57-compose-down-post");
}
