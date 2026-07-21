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

interface FixtureSummary {
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

	ctx.compose.copyFromContainer(
		"peer-a:/data/mem.sqlite",
		`${ctx.artifactsDir}/db/peer-a-project-sharing.sqlite`,
		"28-copy-peer-a-db",
	);
	ctx.compose.copyFromContainer(
		"peer-b:/data/mem.sqlite",
		`${ctx.artifactsDir}/db/peer-b-project-sharing.sqlite`,
		"29-copy-peer-b-db",
	);
	ctx.compose.copyFromContainer(
		"coordinator:/data/coordinator.sqlite",
		`${ctx.artifactsDir}/db/coordinator-project-sharing.sqlite`,
		"30-copy-coordinator-db",
	);
	if (!ctx.keepStackOnFailure) ctx.compose.down("31-compose-down-post");
}
