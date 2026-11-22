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

/** fixture-small sessions run in these directories, one per Project. */
const FIXTURE_PROJECT_PREFIX = "/workspace/e2e-fixture-";

export async function runDirectSyncScenario(ctx: ScenarioContext): Promise<void> {
	ctx.recordNote(
		"scenario.txt",
		"Direct sync scenario: seed peer-a with fixture-small, share both fixture Projects with peer-b through a Project invite so each gets its own boundary, run direct sync, and assert only shared fixture data replicates.",
	);

	ctx.compose.down("00-compose-down-pre", true);
	ctx.compose.up(["coordinator", "peer-a", "peer-b"], "01-compose-up");
	ctx.compose.ps("02-compose-ps");

	// Create peer-a's sync identity first so the seeded memories record it as
	// their origin, as they do when sync is enabled before memories are written.
	// Memories written before sync was enabled are tracked separately (codemem-yfla4).
	readPeerIdentity(ctx, "peer-a", "03-peer-a-identity-before-seed");
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
			sync_advertise: "http://peer-a:7337",
			sync_device_name: "Owner Mac",
			actor_display_name: "Owner",
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
		[...CLI_PREFIX, "coordinator", "group", "create", GROUP_ID, "--db-path", "/data/coordinator.sqlite"],
		"07-group-create",
		120_000,
	);
	assertStatus(groupCreate.status, 0, "failed to create coordinator group");

	const peerAIdentity = readPeerIdentity(ctx, "peer-a", "08-peer-a-identity");
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

	// peer-b joins by accepting a Project invite, which enrolls it, pins both
	// devices, and gives each shared fixture Project its own boundary. Memories
	// outside a shared Project stay Local only and never sync.
	writePeerConfig(
		ctx,
		"peer-b",
		{
			sync_enabled: false,
			sync_host: "0.0.0.0",
			sync_port: 7337,
			sync_interval_s: 5,
			sync_advertise: "http://peer-b:7337",
			sync_coordinator_url: COORDINATOR_URL,
			sync_coordinator_group: GROUP_ID,
		},
		"10-write-peer-b-config",
	);
	const peerBIdentity = readPeerIdentity(ctx, "peer-b", "12-peer-b-identity");

	startServer(ctx, "peer-a", "20-start-peer-a-sync-server");
	startServer(ctx, "peer-b", "21-start-peer-b-sync-server");
	await waitForServer(ctx, "peer-a", "22-peer-a-sync-ready");
	await waitForServer(ctx, "peer-b", "23-peer-b-sync-ready");

	const fixtureProjects = (await listInventoryProjects(ctx, "peer-a", "13-peer-a-projects")).filter((project) =>
		project.workspace_identity.startsWith(FIXTURE_PROJECT_PREFIX),
	);
	assert(fixtureProjects.length === 2, `expected 2 fixture Projects on peer-a, got ${fixtureProjects.length}`);
	await shareProjectsWithTeammate(ctx, {
		owner: "peer-a",
		recipient: "peer-b",
		recipientDeviceId: peerBIdentity.device_id,
		projects: fixtureProjects,
		expectedExistingMemories: 16,
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
			const body = fetchCoordinatorSnapshot<{ discovered_peer_count?: number }>(ctx, "peer-b", "16-peer-b-snapshot");
			assert((body.discovered_peer_count ?? 0) >= 1, "peer-b has no discovered peers yet");
		},
		{ description: "peer-b coordinator discovery", timeoutMs: 180_000, intervalMs: 3_000 },
	);

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
