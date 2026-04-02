import { assert, assertStatus } from "../lib/assert.js";
import {
	ADMIN_SECRET,
	CLI_PREFIX,
	fetchCoordinatorSnapshot,
	GROUP_ID,
	parseJson,
	readPeerIdentity,
	writePeerConfig,
} from "../lib/coordinator.js";
import type { ScenarioContext } from "../lib/scenario-context.js";
import { seedPeer } from "../lib/seed.js";
import { waitFor } from "../lib/wait.js";

function startSyncServer(ctx: ScenarioContext, service: string, artifactName: string) {
	const prepareStaticDir = ctx.compose.exec(
		service,
		[
			"node",
			"--input-type=module",
			"-e",
			"import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('/tmp/viewer-static', { recursive: true }); writeFileSync('/tmp/viewer-static/index.html', '<!doctype html><title>e2e</title>');",
		],
		`${artifactName}-prepare-static`,
		30_000,
	);
	assertStatus(prepareStaticDir.status, 0, `failed to prepare static dir for ${service}`);
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
		artifactName,
		120_000,
	);
	assertStatus(result.status, 0, `failed to start sync protocol for ${service}`);
}

function waitForSyncServer(ctx: ScenarioContext, service: string, artifactName: string) {
	return waitFor(
		async () => {
			const result = ctx.compose.exec(
				service,
				[
					"node",
					"--input-type=module",
					"-e",
					"const res = await fetch('http://127.0.0.1:7337/'); process.exit(res.status === 404 ? 0 : 1);",
				],
				artifactName,
				30_000,
			);
			assertStatus(result.status, 0, `${service} sync server is not ready`);
		},
		{ description: `${service} sync server readiness`, timeoutMs: 120_000, intervalMs: 2_000 },
	);
}

function fetchFixtureSummary(
	ctx: ScenarioContext,
	service: string,
	artifactName: string,
	prefix: string,
): {
	total: number;
	shared_count: number;
	private_count: number;
	shared_titles: string[];
	private_titles: string[];
} {
	const result = ctx.compose.exec(
		service,
		[
			"pnpm",
			"exec",
			"tsx",
			"--conditions",
			"source",
			"e2e/scripts/fixture-summary.ts",
			"--db-path",
			"/data/mem.sqlite",
			"--prefix",
			prefix,
		],
		artifactName,
		60_000,
	);
	assertStatus(result.status, 0, `failed to fetch fixture summary for ${service}`);
	return parseJson(result.stdout, `${service}:fixture-summary`);
}

function bootstrapPeer(
	ctx: ScenarioContext,
	service: string,
	peerDeviceId: string,
	artifactName: string,
	force = false,
	allowFailure = false,
) {
	const args = [
		...CLI_PREFIX,
		"sync",
		"bootstrap",
		"--peer",
		peerDeviceId,
		"--db-path",
		"/data/mem.sqlite",
		"--keys-dir",
		"/keys",
		"--json",
	];
	if (force) args.push("--force");
	return ctx.compose.exec(service, args, artifactName, 300_000, allowFailure);
}

function addSharedMemory(ctx: ScenarioContext, service: string, artifactName: string) {
	const result = ctx.compose.exec(
		service,
		[
			"pnpm",
			"exec",
			"tsx",
			"--conditions",
			"source",
			"e2e/scripts/add-shared-memory.ts",
			"--db-path",
			"/data/mem.sqlite",
		],
		artifactName,
		120_000,
	);
	assertStatus(result.status, 0, `failed to add shared memory on ${service}`);
}

export async function runBootstrapScenario(ctx: ScenarioContext): Promise<void> {
	ctx.recordNote(
		"scenario.txt",
		"Bootstrap scenario: seed peer-a with fixture-large, enroll empty peer-c via coordinator, accept peer records, validate bootstrap to empty peer, then validate dirty-local bootstrap refusal.",
	);

	ctx.compose.down("00-compose-down-pre", true);
	ctx.compose.up(["coordinator", "peer-a", "peer-c"], "01-compose-up");
	ctx.compose.ps("02-compose-ps");

	seedPeer(ctx.compose, ctx.artifactsDir, "peer-a", "fixture-large", "03-seed-peer-a-large");
	seedPeer(ctx.compose, ctx.artifactsDir, "peer-c", "empty", "04-seed-peer-c-empty");

	writePeerConfig(
		ctx,
		"peer-a",
		{
			sync_enabled: true,
			sync_host: "0.0.0.0",
			sync_port: 7337,
			sync_interval_s: 5,
			sync_coordinator_url: "http://coordinator:7347",
			sync_coordinator_group: GROUP_ID,
			sync_coordinator_admin_secret: ADMIN_SECRET,
		},
		"05-write-peer-a-config",
	);

	const enablePeerA = ctx.compose.exec(
		"peer-a",
		[...CLI_PREFIX, "sync", "enable", "--db-path", "/data/mem.sqlite", "--host", "0.0.0.0", "--port", "7337", "--interval", "5"],
		"06-enable-peer-a",
		120_000,
	);
	assertStatus(enablePeerA.status, 0, "failed to enable sync on peer-a");

	const groupCreate = ctx.compose.exec(
		"coordinator",
		[...CLI_PREFIX, "sync", "coordinator", "group-create", GROUP_ID, "--db-path", "/data/coordinator.sqlite"],
		"07-group-create",
		120_000,
	);
	assertStatus(groupCreate.status, 0, "failed to create coordinator group");

	const peerAIdentity = readPeerIdentity(ctx, "peer-a", "08-peer-a-identity");
	const enrollPeerA = ctx.compose.exec(
		"coordinator",
		[
			...CLI_PREFIX,
			"sync",
			"coordinator",
			"enroll-device",
			GROUP_ID,
			peerAIdentity.device_id,
			"--fingerprint",
			peerAIdentity.fingerprint,
			"--public-key",
			peerAIdentity.public_key,
			"--db-path",
			"/data/coordinator.sqlite",
			"--json",
		],
		"09-enroll-peer-a",
		120_000,
	);
	assertStatus(enrollPeerA.status, 0, "failed to enroll peer-a in coordinator");

	const inviteResult = ctx.compose.exec(
		"peer-a",
		[...CLI_PREFIX, "sync", "coordinator", "create-invite", GROUP_ID, "--policy", "approval_required", "--json"],
		"10-create-invite",
		120_000,
	);
	assertStatus(inviteResult.status, 0, "failed to create invite");
	const invitePayload = parseJson<{ encoded: string }>(inviteResult.stdout, "invite payload");

	const importResult = ctx.compose.exec(
		"peer-c",
		[
			...CLI_PREFIX,
			"sync",
			"coordinator",
			"import-invite",
			invitePayload.encoded,
			"--db-path",
			"/data/mem.sqlite",
			"--keys-dir",
			"/keys",
			"--config",
			"/config/codemem.json",
			"--json",
		],
		"11-import-invite",
		120_000,
	);
	assertStatus(importResult.status, 0, "failed to import invite on peer-c");

	const enablePeerC = ctx.compose.exec(
		"peer-c",
		[...CLI_PREFIX, "sync", "enable", "--db-path", "/data/mem.sqlite", "--host", "0.0.0.0", "--port", "7337", "--interval", "5"],
		"12-enable-peer-c",
		120_000,
	);
	assertStatus(enablePeerC.status, 0, "failed to enable sync on peer-c");

	const joinRequestsResult = ctx.compose.exec(
		"coordinator",
		[...CLI_PREFIX, "sync", "coordinator", "list-join-requests", GROUP_ID, "--db-path", "/data/coordinator.sqlite", "--json"],
		"13-list-join-requests",
		120_000,
	);
	assertStatus(joinRequestsResult.status, 0, "failed to list join requests");
	const joinRequests = parseJson<Array<{ request_id: string }>>(joinRequestsResult.stdout, "join requests");
	assert(joinRequests.length === 1, `expected exactly one join request, got ${joinRequests.length}`);

	const approveResult = ctx.compose.exec(
		"coordinator",
		[
			...CLI_PREFIX,
			"sync",
			"coordinator",
			"approve-join-request",
			joinRequests[0]?.request_id ?? "",
			"--db-path",
			"/data/coordinator.sqlite",
			"--json",
		],
		"14-approve-join-request",
		120_000,
	);
	assertStatus(approveResult.status, 0, "failed to approve join request");

	await waitFor(
		async () => {
			const body = fetchCoordinatorSnapshot<{ discovered_peer_count?: number }>(ctx, "peer-a", "15-peer-a-snapshot");
			assert((body.discovered_peer_count ?? 0) >= 1, "peer-a has no discovered peers yet");
		},
		{ description: "peer-a coordinator discovery", timeoutMs: 180_000, intervalMs: 3_000 },
	);
	await waitFor(
		async () => {
			const body = fetchCoordinatorSnapshot<{ discovered_peer_count?: number }>(ctx, "peer-c", "16-peer-c-snapshot");
			assert((body.discovered_peer_count ?? 0) >= 1, "peer-c has no discovered peers yet");
		},
		{ description: "peer-c coordinator discovery", timeoutMs: 180_000, intervalMs: 3_000 },
	);

	const peerCIdentity = readPeerIdentity(ctx, "peer-c", "17-peer-c-identity");
	const acceptPeerC = ctx.compose.exec(
		"peer-a",
		[
			"pnpm",
			"exec",
			"tsx",
			"--conditions",
			"source",
			"e2e/scripts/accept-discovered.ts",
			"--peer-device-id",
			peerCIdentity.device_id,
			"--fingerprint",
			peerCIdentity.fingerprint,
			"--db-path",
			"/data/mem.sqlite",
		],
		"18-accept-peer-c",
		120_000,
	);
	assertStatus(acceptPeerC.status, 0, "failed to accept peer-c on peer-a");

	const acceptPeerA = ctx.compose.exec(
		"peer-c",
		[
			"pnpm",
			"exec",
			"tsx",
			"--conditions",
			"source",
			"e2e/scripts/accept-discovered.ts",
			"--peer-device-id",
			peerAIdentity.device_id,
			"--fingerprint",
			peerAIdentity.fingerprint,
			"--db-path",
			"/data/mem.sqlite",
		],
		"19-accept-peer-a",
		120_000,
	);
	assertStatus(acceptPeerA.status, 0, "failed to accept peer-a on peer-c");

	startSyncServer(ctx, "peer-a", "20-start-peer-a-sync-server");
	await waitForSyncServer(ctx, "peer-a", "21-peer-a-sync-ready");

	const bootstrapResult = bootstrapPeer(ctx, "peer-c", peerAIdentity.device_id, "22-bootstrap-peer-c", true);
	assertStatus(bootstrapResult.status, 0, "peer-c bootstrap command failed");
	const parsedBootstrap = parseJson<{ ok: boolean; applied: number; deleted: number; error: string | null }>(
		bootstrapResult.stdout,
		"bootstrap peer-c",
	);
	assert(parsedBootstrap.ok === true, `expected bootstrap ok=true, got ${JSON.stringify(parsedBootstrap)}`);

	await waitFor(
		async () => {
			const summary = fetchFixtureSummary(ctx, "peer-c", "23-peer-c-fixture-large-summary", "fixture-large memory ");
			assert(summary.shared_count === 1280, `expected 1280 shared fixture-large memories on peer-c, got ${summary.shared_count}`);
			assert(summary.private_count === 0, `expected 0 private fixture-large memories on peer-c, got ${summary.private_count}`);
			assert(summary.shared_titles.includes("fixture-large memory 0001"), "expected fixture-large memory 0001 on peer-c");
		},
		{ description: "peer-c bootstrap data arrival", timeoutMs: 120_000, intervalMs: 3_000 },
	);

	addSharedMemory(ctx, "peer-c", "24-add-local-shared-memory");
	const refusalResult = bootstrapPeer(
		ctx,
		"peer-c",
		peerAIdentity.device_id,
		"25-bootstrap-refusal",
		false,
		true,
	);
	assert(refusalResult.status !== 0, "expected bootstrap refusal to exit non-zero");
	const parsedRefusal = parseJson<{ ok: boolean; error: string; count?: number }>(
		refusalResult.stdout,
		"bootstrap refusal",
	);
	assert(parsedRefusal.ok === false, "expected bootstrap refusal ok=false");
	assert(parsedRefusal.error === "local_unsynced_changes", `unexpected refusal error: ${parsedRefusal.error}`);
	assert((parsedRefusal.count ?? 0) >= 1, "expected refusal count >= 1");

	ctx.compose.copyFromContainer(
		"peer-c:/data/mem.sqlite",
		`${ctx.artifactsDir}/db/peer-c-after-bootstrap.sqlite`,
		"26-copy-peer-c-db",
	);

	if (!ctx.keepStackOnFailure) {
		ctx.compose.down("27-compose-down-post");
	}
}
