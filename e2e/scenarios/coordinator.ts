import { assert, assertStatus } from "../lib/assert.js";
import type { ScenarioContext } from "../lib/scenario-context.js";
import { seedPeer } from "../lib/seed.js";
import { waitFor } from "../lib/wait.js";

const CLI_PREFIX = ["pnpm", "exec", "tsx", "--conditions", "source", "packages/cli/src/index.ts"];
const GROUP_ID = "e2e-team";
const ADMIN_SECRET = "e2e-admin-secret";

function parseJson<T>(raw: string, label: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		throw new Error(`Failed to parse JSON for ${label}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function readPeerIdentity(
	ctx: ScenarioContext,
	service: string,
	artifactName: string,
): { device_id: string; fingerprint: string; public_key: string } {
	const result = ctx.compose.exec(
		service,
		[
			"pnpm",
			"exec",
			"tsx",
			"--conditions",
			"source",
			"e2e/scripts/peer-identity.ts",
		],
		artifactName,
		60_000,
	);
	assertStatus(result.status, 0, `failed to read identity for ${service}`);
	return parseJson<{ device_id: string; fingerprint: string; public_key: string }>(
		result.stdout,
		`${service}:identity`,
	);
}

function writePeerConfig(ctx: ScenarioContext, service: string, values: Record<string, unknown>, artifactName: string) {
	const script = `import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('/config', { recursive: true }); writeFileSync('/config/codemem.json', JSON.stringify(${JSON.stringify(values)}, null, 2));`;
	const result = ctx.compose.exec(
		service,
		["node", "--input-type=module", "-e", script],
		artifactName,
		30_000,
	);
	assertStatus(result.status, 0, `failed to write config for ${service}`);
}

function fetchCoordinatorSnapshot<T>(ctx: ScenarioContext, service: string, artifactName: string): T {
	const result = ctx.compose.exec(
		service,
		[
			"pnpm",
			"exec",
			"tsx",
			"--conditions",
			"source",
			"e2e/scripts/coordinator-status.ts",
			"--db-path",
			"/data/mem.sqlite",
			"--run-tick",
		],
		artifactName,
		120_000,
	);
	assertStatus(result.status, 0, `failed to fetch coordinator snapshot from ${service}`);
	return parseJson<T>(result.stdout, `${service}:coordinator-snapshot`);
}

export async function runCoordinatorScenario(ctx: ScenarioContext): Promise<void> {
	ctx.recordNote(
		"scenario.txt",
		"Coordinator scenario: configure admin peer, create approval-required invite, import on joiner peer, approve join request, start both peer viewers, and wait for coordinator-discovered devices on both peers.",
	);

	ctx.compose.down("00-compose-down-pre", true);
	ctx.compose.up(["coordinator", "peer-a", "peer-b"], "01-compose-up");
	ctx.compose.ps("02-compose-ps");

	seedPeer(ctx.compose, ctx.artifactsDir, "peer-a", "empty", "03-seed-peer-a-empty");
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
	assert(peerAIdentity.device_id, "peer-a identity missing device_id");
	assert(peerAIdentity.fingerprint, "peer-a identity missing fingerprint");
	assert(peerAIdentity.public_key, "peer-a identity missing public key");

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
	assert(invitePayload.encoded, "invite payload missing encoded invite");

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
			const body = fetchCoordinatorSnapshot<{ discovered_peer_count?: number; discovered_devices?: Array<{ device_id: string }> }>(
				ctx,
				"peer-a",
				"13-peer-a-snapshot",
			);
			const devices = Array.isArray(body.discovered_devices) ? body.discovered_devices : [];
			assert((body.discovered_peer_count ?? 0) >= 1, "peer-a has no discovered peers yet");
			assert(devices.some((device) => String(device.device_id) !== ""), "peer-a discovered devices payload is empty");
		},
		{ description: "peer-a coordinator discovery", timeoutMs: 180_000, intervalMs: 3_000 },
	);

	await waitFor(
		async () => {
			const body = fetchCoordinatorSnapshot<{ discovered_peer_count?: number; discovered_devices?: Array<{ device_id: string }> }>(
				ctx,
				"peer-b",
				"14-peer-b-snapshot",
			);
			const devices = Array.isArray(body.discovered_devices) ? body.discovered_devices : [];
			assert((body.discovered_peer_count ?? 0) >= 1, "peer-b has no discovered peers yet");
			assert(devices.some((device) => String(device.device_id) !== ""), "peer-b discovered devices payload is empty");
		},
		{ description: "peer-b coordinator discovery", timeoutMs: 180_000, intervalMs: 3_000 },
	);

	const peerAStatus = fetchCoordinatorSnapshot<Record<string, unknown>>(
		ctx,
		"peer-a",
		"15-peer-a-final-snapshot",
	);
	const peerBStatus = fetchCoordinatorSnapshot<Record<string, unknown>>(
		ctx,
		"peer-b",
		"16-peer-b-final-snapshot",
	);
	ctx.recordNote("final-status-peer-a.json", JSON.stringify(peerAStatus, null, 2));
	ctx.recordNote("final-status-peer-b.json", JSON.stringify(peerBStatus, null, 2));

	if (!ctx.keepStackOnFailure) {
		ctx.compose.down("17-compose-down-post");
	}
}
