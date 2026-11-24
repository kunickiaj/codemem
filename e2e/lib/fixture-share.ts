import { assert, assertStatus } from "./assert.js";
import {
	ADMIN_SECRET,
	CLI_PREFIX,
	COORDINATOR_URL,
	fetchCoordinatorSnapshot,
	GROUP_ID,
	type PeerIdentity,
	readPeerIdentity,
	writePeerConfig,
} from "./coordinator.js";
import { type InventoryProject, listInventoryProjects, shareProjectsWithTeammate } from "./project-share.js";
import type { ScenarioContext } from "./scenario-context.js";
import { seedPeer } from "./seed.js";
import { startServer, waitForServer } from "./viewer.js";
import { waitFor } from "./wait.js";

/** fixture-small sessions run in these directories, one per Project. */
export const FIXTURE_PROJECT_PREFIX = "/workspace/e2e-fixture-";

export interface SharedFixturePeers {
	peerAIdentity: PeerIdentity;
	peerBIdentity: PeerIdentity;
	fixtureProjects: InventoryProject[];
}

/**
 * Seeds peer-a with fixture-small and shares both fixture Projects with an empty
 * peer-b through a Project invite, so each Project gets its own boundary. Both
 * devices keep their sync services running and sync every 5 seconds.
 *
 * By default peer-a gets its sync identity before seeding, as when sync is
 * enabled before memories are written. With `seedBeforeIdentity`, the seeded
 * memories are written first, so they keep origin "local" until shared.
 */
export async function shareFixtureProjectsWithPeerB(
	ctx: ScenarioContext,
	options: {
		seedBeforeIdentity?: boolean;
		/** Extra owner setup after seeding, before sync is set up. */
		afterSeed?: () => void;
		/** Imported memories without a known author the review must report as left out. */
		expectedUnattributedImports?: number;
	} = {},
): Promise<SharedFixturePeers> {
	ctx.compose.down("00-compose-down-pre", true);
	ctx.compose.up(["coordinator", "peer-a", "peer-b"], "01-compose-up");
	ctx.compose.ps("02-compose-ps");

	if (!options.seedBeforeIdentity) {
		readPeerIdentity(ctx, "peer-a", "03-peer-a-identity-before-seed");
	}
	seedPeer(ctx.compose, ctx.artifactsDir, "peer-a", "fixture-small", "03-seed-peer-a-small");
	seedPeer(ctx.compose, ctx.artifactsDir, "peer-b", "empty", "04-seed-peer-b-empty");
	options.afterSeed?.();

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
		expectedUnattributedImports: options.expectedUnattributedImports,
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

	return { peerAIdentity, peerBIdentity, fixtureProjects };
}
