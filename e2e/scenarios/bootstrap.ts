import { assert, assertStatus } from "../lib/assert.js";
import {
	ADMIN_SECRET,
	CLI_PREFIX,
	COORDINATOR_URL,
	fetchCoordinatorSnapshot,
	GROUP_ID,
	parseJson,
	readPeerIdentity,
	writePeerConfig,
} from "../lib/coordinator.js";
import { listInventoryProjects, shareProjectsWithTeammate } from "../lib/project-share.js";
import type { ScenarioContext } from "../lib/scenario-context.js";
import { seedPeer } from "../lib/seed.js";
import { startServer, waitForServer } from "../lib/viewer.js";
import { waitFor } from "../lib/wait.js";

/** fixture-large sessions run in these directories, one per Project. */
const FIXTURE_PROJECT_PREFIX = "/workspace/e2e-fixture-";

interface PeerScopeState {
	peer_device_id: string;
	scopes: Array<{ scope_id: string; bootstrapped: boolean }>;
}

function peerScopes(ctx: ScenarioContext, service: string, peerDeviceId: string, artifactName: string) {
	const result = ctx.compose.exec(
		service,
		[...CLI_PREFIX, "sync", "peers", "--db-path", "/data/mem.sqlite", "--json"],
		artifactName,
		60_000,
	);
	assertStatus(result.status, 0, `failed to list sync peers on ${service}`);
	const peers = parseJson<PeerScopeState[]>(result.stdout, artifactName);
	return peers.find((peer) => peer.peer_device_id === peerDeviceId)?.scopes ?? [];
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

function unsyncedCount(ctx: ScenarioContext, service: string, artifactName: string): number {
	const result = ctx.compose.exec(
		service,
		["pnpm", "exec", "tsx", "--conditions", "source", "e2e/scripts/unsynced-count.ts"],
		artifactName,
		60_000,
	);
	assertStatus(result.status, 0, `failed to count unsynced shared memories on ${service}`);
	return parseJson<{ count: number }>(result.stdout, artifactName).count;
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
		"Bootstrap scenario: seed peer-a with fixture-large, share its fixture Projects with empty peer-c through a Project invite, let peer-c's sync pull each Project's boundary snapshot, then validate dirty-local bootstrap refusal.",
	);

	ctx.compose.down("00-compose-down-pre", true);
	ctx.compose.up(["coordinator", "peer-a", "peer-c"], "01-compose-up");
	ctx.compose.ps("02-compose-ps");

	// Create peer-a's sync identity first so the seeded memories record it as
	// their origin, as they do when sync is enabled before memories are written.
	// Memories written before sync was enabled are tracked separately (codemem-yfla4).
	const peerAIdentity = readPeerIdentity(ctx, "peer-a", "03-peer-a-identity-before-seed");
	seedPeer(ctx.compose, ctx.artifactsDir, "peer-a", "fixture-large", "03-seed-peer-a-large");
	seedPeer(ctx.compose, ctx.artifactsDir, "peer-c", "empty", "04-seed-peer-c-empty");

	// peer-a syncs rarely, so peer-c's own pull of each new boundary, the
	// per-Project bootstrap, delivers the data rather than peer-a's push.
	writePeerConfig(
		ctx,
		"peer-a",
		{
			sync_enabled: true,
			sync_host: "0.0.0.0",
			sync_port: 7337,
			sync_interval_s: 3600,
			sync_advertise: "http://peer-a:7337",
			sync_device_name: "Owner Mac",
			actor_display_name: "Owner",
			sync_coordinator_url: "http://coordinator:7347",
			sync_coordinator_group: GROUP_ID,
			sync_coordinator_admin_secret: ADMIN_SECRET,
		},
		"05-write-peer-a-config",
	);

	const enablePeerA = ctx.compose.exec(
		"peer-a",
		[...CLI_PREFIX, "sync", "enable", "--db-path", "/data/mem.sqlite", "--host", "0.0.0.0", "--port", "7337", "--interval", "3600"],
		"06-enable-peer-a",
		120_000,
	);
	assertStatus(enablePeerA.status, 0, "failed to enable sync on peer-a");

	const groupCreate = ctx.compose.exec(
		"coordinator",
		[...CLI_PREFIX, "coordinator", "group", "create", GROUP_ID, "--db-path", "/data/coordinator.sqlite"],
		"07-group-create",
		120_000,
	);
	assertStatus(groupCreate.status, 0, "failed to create coordinator group");

	const enrollPeerA = ctx.compose.exec(
		"coordinator",
		[
			...CLI_PREFIX,
			"coordinator",
			"device", "enroll",
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

	// peer-c joins by accepting a Project invite, which enrolls it, pins both
	// devices, and gives each shared fixture Project its own boundary.
	writePeerConfig(
		ctx,
		"peer-c",
		{
			sync_enabled: false,
			sync_host: "0.0.0.0",
			sync_port: 7337,
			sync_interval_s: 5,
			sync_advertise: "http://peer-c:7337",
			sync_coordinator_url: COORDINATOR_URL,
			sync_coordinator_group: GROUP_ID,
		},
		"10-write-peer-c-config",
	);
	const peerCIdentity = readPeerIdentity(ctx, "peer-c", "12-peer-c-identity");

	startServer(ctx, "peer-a", "20-start-peer-a-sync-server");
	startServer(ctx, "peer-c", "21-start-peer-c-sync-server");
	await waitForServer(ctx, "peer-a", "21-peer-a-sync-ready");
	await waitForServer(ctx, "peer-c", "21-peer-c-sync-ready");

	const fixtureProjects = (await listInventoryProjects(ctx, "peer-a", "13-peer-a-projects")).filter((project) =>
		project.workspace_identity.startsWith(FIXTURE_PROJECT_PREFIX),
	);
	assert(fixtureProjects.length === 8, `expected 8 fixture Projects on peer-a, got ${fixtureProjects.length}`);
	await shareProjectsWithTeammate(ctx, {
		owner: "peer-a",
		recipient: "peer-c",
		recipientDeviceId: peerCIdentity.device_id,
		projects: fixtureProjects,
		expectedExistingMemories: 1280,
		teammateName: "Teammate",
		deviceName: "Teammate Mac",
		artifactPrefix: "14-share",
	});

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

	await waitFor(
		async () => {
			const summary = fetchFixtureSummary(ctx, "peer-c", "23-peer-c-fixture-large-summary", "fixture-large memory ");
			assert(summary.shared_count === 1280, `expected 1280 shared fixture-large memories on peer-c, got ${summary.shared_count}`);
			assert(summary.private_count === 0, `expected 0 private fixture-large memories on peer-c, got ${summary.private_count}`);
			assert(summary.shared_titles.includes("fixture-large memory 0001"), "expected fixture-large memory 0001 on peer-c");
		},
		{ description: "peer-c bootstrap data arrival", timeoutMs: 120_000, intervalMs: 3_000 },
	);
	const sharedBoundaries = peerScopes(ctx, "peer-c", peerAIdentity.device_id, "23-peer-c-boundaries").filter(
		(scope) => scope.scope_id.startsWith("managed-project:"),
	);
	assert(sharedBoundaries.length === 8, `expected 8 shared Project boundaries on peer-c, got ${sharedBoundaries.length}`);
	assert(
		sharedBoundaries.every((scope) => scope.bootstrapped),
		"peer-c has not finished its first pull of every shared Project boundary",
	);

	// Stop peer-c's sync service so nothing changes its rows between the counts.
	const stopped = ctx.compose.restart("peer-c", "24-stop-peer-c-service");
	assertStatus(stopped.status, 0, "failed to stop peer-c's sync service");
	const unsyncedBefore = unsyncedCount(ctx, "peer-c", "24-unsynced-before");
	addSharedMemory(ctx, "peer-c", "24-add-local-shared-memory");
	const unsyncedAfter = unsyncedCount(ctx, "peer-c", "24-unsynced-after");
	assert(
		unsyncedAfter === unsyncedBefore + 1,
		`expected one more unsynced shared memory after the local change, got ${unsyncedBefore} -> ${unsyncedAfter}`,
	);
	const refusalResult = bootstrapPeer(
		ctx,
		"peer-c",
		peerAIdentity.device_id,
		"25-bootstrap-refusal",
		false,
		true,
	);
	assert(refusalResult.status !== 0, "expected bootstrap refusal to exit non-zero");
	// CLI JSON errors are {error, message} (docs/cli-design-conventions.md).
	const parsedRefusal = parseJson<Record<string, unknown>>(refusalResult.stdout, "bootstrap refusal");
	assert(
		Object.keys(parsedRefusal).toSorted().join(",") === "error,message" &&
			typeof parsedRefusal.message === "string" &&
			parsedRefusal.message.length > 0,
		`unexpected bootstrap refusal shape: ${refusalResult.stdout}`,
	);
	assert(parsedRefusal.error === "local_unsynced_changes", `unexpected refusal error: ${String(parsedRefusal.error)}`);

	ctx.compose.copyFromContainer(
		"peer-c:/data/mem.sqlite",
		`${ctx.artifactsDir}/db/peer-c-after-bootstrap.sqlite`,
		"26-copy-peer-c-db",
	);

	if (!ctx.keepStackOnFailure) {
		ctx.compose.down("27-compose-down-post");
	}
}
