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

function fetchFixtureSummary(
	ctx: ScenarioContext,
	service: string,
	artifactName: string,
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
		],
		artifactName,
		60_000,
	);
	assertStatus(result.status, 0, `failed to fetch fixture summary for ${service}`);
	return parseJson(result.stdout, `${service}:fixture-summary`);
}

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

function acceptDiscoveredPeer(
	ctx: ScenarioContext,
	service: string,
	peerDeviceId: string,
	fingerprint: string,
	artifactName: string,
) {
	const result = ctx.compose.exec(
		service,
		[
			"pnpm",
			"exec",
			"tsx",
			"--conditions",
			"source",
			"e2e/scripts/accept-discovered.ts",
			"--peer-device-id",
			peerDeviceId,
			"--fingerprint",
			fingerprint,
			"--db-path",
			"/data/mem.sqlite",
		],
		artifactName,
		120_000,
	);
	assertStatus(result.status, 0, `failed to accept discovered peer ${peerDeviceId} on ${service}`);
	return parseJson<{ ok: boolean; created: boolean; updated: boolean }>(result.stdout, artifactName);
}

export async function runDirectSyncScenario(ctx: ScenarioContext): Promise<void> {
	ctx.recordNote(
		"scenario.txt",
		"Direct sync scenario: seed peer-a with fixture-small, onboard peer-b via coordinator, accept discovered peers on both sides, run direct sync, and assert only shared fixture data replicates.",
	);

	ctx.compose.down("00-compose-down-pre", true);
	ctx.compose.up(["coordinator", "peer-a", "peer-b"], "01-compose-up");
	ctx.compose.ps("02-compose-ps");

	seedPeer(ctx.compose, ctx.artifactsDir, "peer-a", "fixture-small", "03-seed-peer-a-small");
	seedPeer(ctx.compose, ctx.artifactsDir, "peer-b", "empty", "04-seed-peer-b-empty");

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
		"peer-b",
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
	assertStatus(importResult.status, 0, "failed to import invite on peer-b");

	const enablePeerB = ctx.compose.exec(
		"peer-b",
		[...CLI_PREFIX, "sync", "enable", "--db-path", "/data/mem.sqlite", "--host", "0.0.0.0", "--port", "7337", "--interval", "5"],
		"12-enable-peer-b",
		120_000,
	);
	assertStatus(enablePeerB.status, 0, "failed to enable sync on peer-b");

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
			const body = fetchCoordinatorSnapshot<{ discovered_peer_count?: number }>(ctx, "peer-b", "16-peer-b-snapshot");
			assert((body.discovered_peer_count ?? 0) >= 1, "peer-b has no discovered peers yet");
		},
		{ description: "peer-b coordinator discovery", timeoutMs: 180_000, intervalMs: 3_000 },
	);

	const peerBIdentity = readPeerIdentity(ctx, "peer-b", "17-peer-b-identity");
	acceptDiscoveredPeer(ctx, "peer-a", peerBIdentity.device_id, peerBIdentity.fingerprint, "18-accept-peer-b");
	acceptDiscoveredPeer(ctx, "peer-b", peerAIdentity.device_id, peerAIdentity.fingerprint, "19-accept-peer-a");

	startSyncServer(ctx, "peer-a", "20-start-peer-a-sync-server");
	startSyncServer(ctx, "peer-b", "21-start-peer-b-sync-server");
	await waitForSyncServer(ctx, "peer-a", "22-peer-a-sync-ready");
	await waitForSyncServer(ctx, "peer-b", "23-peer-b-sync-ready");

	const syncPeerA = ctx.compose.exec(
		"peer-a",
		[...CLI_PREFIX, "sync", "once", "--db-path", "/data/mem.sqlite"],
		"24-sync-peer-a-once",
		180_000,
	);
	assertStatus(syncPeerA.status, 0, "peer-a sync once failed");

	const syncPeerB = ctx.compose.exec(
		"peer-b",
		[...CLI_PREFIX, "sync", "once", "--db-path", "/data/mem.sqlite"],
		"25-sync-peer-b-once",
		180_000,
	);
	assertStatus(syncPeerB.status, 0, "peer-b sync once failed");

	await waitFor(
		async () => {
			const summary = fetchFixtureSummary(ctx, "peer-b", "26-peer-b-fixture-summary");
			assert(summary.shared_count === 16, `expected 16 shared fixture memories on peer-b, got ${summary.shared_count}`);
			assert(summary.private_count === 0, `expected 0 private fixture memories on peer-b, got ${summary.private_count}`);
			assert(summary.shared_titles.includes("fixture-small memory 0001"), "expected shared fixture memory 0001 on peer-b");
			assert(!summary.shared_titles.includes("fixture-small memory 0000"), "private fixture memory 0000 should not replicate as shared");
		},
		{ description: "peer-b replicated fixture data", timeoutMs: 120_000, intervalMs: 3_000 },
	);

	const attemptsA = ctx.compose.exec(
		"peer-a",
		[...CLI_PREFIX, "sync", "attempts", "--db-path", "/data/mem.sqlite", "--json"],
		"27-peer-a-attempts",
		60_000,
	);
	assertStatus(attemptsA.status, 0, "failed to read peer-a sync attempts");
	const attemptsB = ctx.compose.exec(
		"peer-b",
		[...CLI_PREFIX, "sync", "attempts", "--db-path", "/data/mem.sqlite", "--json"],
		"28-peer-b-attempts",
		60_000,
	);
	assertStatus(attemptsB.status, 0, "failed to read peer-b sync attempts");
	const parsedAttemptsA = parseJson<Array<{ ok: number }>>(attemptsA.stdout, "peer-a attempts");
	const parsedAttemptsB = parseJson<Array<{ ok: number }>>(attemptsB.stdout, "peer-b attempts");
	assert(parsedAttemptsA.length > 0, "expected at least one sync attempt on peer-a");
	assert(parsedAttemptsB.length > 0, "expected at least one sync attempt on peer-b");

	ctx.compose.copyFromContainer(
		"peer-b:/data/mem.sqlite",
		`${ctx.artifactsDir}/db/peer-b-after-direct-sync.sqlite`,
		"29-copy-peer-b-db",
	);

	if (!ctx.keepStackOnFailure) {
		ctx.compose.down("30-compose-down-post");
	}
}
