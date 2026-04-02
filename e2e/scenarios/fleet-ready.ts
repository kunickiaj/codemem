import { assert, assertStatus } from "../lib/assert.js";
import {
	ADMIN_SECRET,
	CLI_PREFIX,
	fetchCoordinatorSnapshot,
	parseJson,
	readPeerIdentity,
	writePeerConfig,
} from "../lib/coordinator.js";
import { createFleetStatusSnapshot, type FleetNodeStatus, updateFleetNodeStatus } from "../fleet/readiness.js";
import { collectComposeServices, loadFleetSpec } from "../fleet/spec.js";
import type { ScenarioContext } from "../lib/scenario-context.js";
import { seedPeer } from "../lib/seed.js";
import { waitFor } from "../lib/wait.js";

const DEFAULT_SPEC_PATH = "e2e/fleet/examples/compose-shared-seed.json";
const processRef = globalThis as typeof globalThis & {
	process: { env: Record<string, string | undefined> };
};

function buildInitialStatuses(specPath: string) {
	const spec = loadFleetSpec(specPath);
	const nodes: FleetNodeStatus[] = [
		{
			id: spec.coordinator.runtime.service ?? "coordinator",
			role: "coordinator",
			swarm_id: null,
			coordinator_group: null,
			runtime_type: spec.coordinator.runtime.type,
			runtime_target: spec.coordinator.runtime.service ?? spec.coordinator.runtime.selector ?? null,
			identity: null,
			state: "pending",
			detail: "Coordinator declared in fleet spec.",
		},
		{
			id: spec.seed_peer.id,
			role: "seed-peer",
			swarm_id: null,
			coordinator_group: null,
			runtime_type: spec.seed_peer.runtime.type,
			runtime_target: spec.seed_peer.runtime.service ?? spec.seed_peer.runtime.selector ?? null,
			identity: spec.seed_peer.identity,
			state: "pending",
			detail: "Seed peer declared in fleet spec.",
		},
		...spec.swarms.flatMap((swarm) =>
			swarm.workers.map((worker) => ({
				id: worker.id,
				role: "worker-peer" as const,
				swarm_id: swarm.id,
				coordinator_group: swarm.coordinator_group,
				runtime_type: worker.runtime.type,
				runtime_target: worker.runtime.service ?? worker.runtime.selector ?? null,
				identity: worker.identity,
				state: "pending" as const,
				detail: "Worker declared in fleet spec.",
			})),
		),
	];
	return { spec, nodes };
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

function bootstrapPeer(ctx: ScenarioContext, service: string, peerDeviceId: string, artifactName: string) {
	const result = ctx.compose.exec(
		service,
		[
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
			"--force",
		],
		artifactName,
		300_000,
	);
	assertStatus(result.status, 0, `${service} bootstrap failed`);
	return parseJson<{ ok: boolean }>(result.stdout, artifactName);
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
}

export async function runFleetReadyScenario(ctx: ScenarioContext): Promise<void> {
	const specPath = processRef.process.env.CODEMEM_E2E_FLEET_SPEC?.trim() || DEFAULT_SPEC_PATH;
	const { spec, nodes } = buildInitialStatuses(specPath);
	const coordinatorService = spec.coordinator.runtime.service ?? "coordinator";
	const seedService = spec.seed_peer.runtime.service;
	assert(seedService, "seed peer compose service missing");

	ctx.recordNote(
		"scenario.txt",
		"Fleet ready scenario: materialize swarm groups from the fleet spec, join workers to the correct coordinator groups, bootstrap them from the shared seed peer, and record readiness states.",
	);
	ctx.recordNote("fleet-spec.json", JSON.stringify(spec, null, 2));

	ctx.compose.down("00-compose-down-pre", true);
	ctx.compose.up(collectComposeServices(spec), "01-compose-up");
	ctx.compose.ps("02-compose-ps");
	updateFleetNodeStatus(nodes, coordinatorService, "reachable", "Compose services started successfully.");

	seedPeer(ctx.compose, ctx.artifactsDir, seedService, "fixture-small", "03-seed-shared-seed");
	for (const swarm of spec.swarms) {
		for (const worker of swarm.workers) {
			const service = worker.runtime.service;
			assert(service, `worker '${worker.id}' missing compose service`);
			seedPeer(ctx.compose, ctx.artifactsDir, service, "empty", `04-seed-${worker.id}-empty`);
		}
	}

	writePeerConfig(
		ctx,
		seedService,
		{
			sync_enabled: true,
			sync_host: "0.0.0.0",
			sync_port: 7337,
			sync_interval_s: 5,
			sync_coordinator_url: "http://coordinator:7347",
			sync_coordinator_group: spec.swarms[0]?.coordinator_group ?? "",
			sync_coordinator_groups: spec.swarms.map((swarm) => swarm.coordinator_group),
			sync_coordinator_admin_secret: ADMIN_SECRET,
		},
		"05-write-seed-config",
	);
	const enableSeed = ctx.compose.exec(
		seedService,
		[...CLI_PREFIX, "sync", "enable", "--db-path", "/data/mem.sqlite", "--host", "0.0.0.0", "--port", "7337", "--interval", "5"],
		"06-enable-seed",
		120_000,
	);
	assertStatus(enableSeed.status, 0, "failed to enable sync on seed peer");
	updateFleetNodeStatus(nodes, spec.seed_peer.id, "reachable", "Seed peer CLI and sync configuration initialized.");

	const seedIdentity = readPeerIdentity(ctx, seedService, "07-seed-identity");
	for (const swarm of spec.swarms) {
		const groupCreate = ctx.compose.exec(
			coordinatorService,
			[...CLI_PREFIX, "sync", "coordinator", "group-create", swarm.coordinator_group, "--db-path", "/data/coordinator.sqlite"],
			`08-group-create-${swarm.id}`,
			120_000,
		);
		assertStatus(groupCreate.status, 0, `failed to create coordinator group for ${swarm.id}`);
		const enrollSeed = ctx.compose.exec(
			coordinatorService,
			[
				...CLI_PREFIX,
				"sync",
				"coordinator",
				"enroll-device",
				swarm.coordinator_group,
				seedIdentity.device_id,
				"--fingerprint",
				seedIdentity.fingerprint,
				"--public-key",
				seedIdentity.public_key,
				"--db-path",
				"/data/coordinator.sqlite",
				"--json",
			],
			`09-enroll-seed-${swarm.id}`,
			120_000,
		);
		assertStatus(enrollSeed.status, 0, `failed to enroll seed peer in ${swarm.coordinator_group}`);

		const inviteResult = ctx.compose.exec(
			seedService,
			[...CLI_PREFIX, "sync", "coordinator", "create-invite", swarm.coordinator_group, "--policy", "approval_required", "--json"],
			`10-create-invite-${swarm.id}`,
			120_000,
		);
		assertStatus(inviteResult.status, 0, `failed to create invite for ${swarm.id}`);
		const invitePayload = parseJson<{ encoded: string }>(inviteResult.stdout, `invite-${swarm.id}`);

		for (const worker of swarm.workers) {
			const service = worker.runtime.service;
			assert(service, `worker '${worker.id}' missing compose service`);
			writePeerConfig(
				ctx,
				service,
				{
					sync_enabled: true,
					sync_host: "0.0.0.0",
					sync_port: 7337,
					sync_interval_s: 5,
					sync_coordinator_url: "http://coordinator:7347",
					sync_coordinator_group: swarm.coordinator_group,
					sync_coordinator_admin_secret: ADMIN_SECRET,
				},
				`11-write-config-${worker.id}`,
			);
			updateFleetNodeStatus(nodes, worker.id, "joining", `Preparing join for coordinator group '${swarm.coordinator_group}'.`);
			const importResult = ctx.compose.exec(
				service,
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
				`12-import-invite-${worker.id}`,
				120_000,
			);
			assertStatus(importResult.status, 0, `failed to import invite on ${worker.id}`);
			const enableWorker = ctx.compose.exec(
				service,
				[...CLI_PREFIX, "sync", "enable", "--db-path", "/data/mem.sqlite", "--host", "0.0.0.0", "--port", "7337", "--interval", "5"],
				`13-enable-${worker.id}`,
				120_000,
			);
			assertStatus(enableWorker.status, 0, `failed to enable sync on ${worker.id}`);
			const joinRequestsResult = ctx.compose.exec(
				coordinatorService,
				[...CLI_PREFIX, "sync", "coordinator", "list-join-requests", swarm.coordinator_group, "--db-path", "/data/coordinator.sqlite", "--json"],
				`14-list-join-requests-${worker.id}`,
				120_000,
			);
			assertStatus(joinRequestsResult.status, 0, `failed to list join requests for ${worker.id}`);
			const joinRequests = parseJson<Array<{ request_id: string }>>(joinRequestsResult.stdout, `join-requests-${worker.id}`);
			const requestId = joinRequests[joinRequests.length - 1]?.request_id;
			assert(requestId, `missing join request id for ${worker.id}`);
			const approveResult = ctx.compose.exec(
				coordinatorService,
				[
					...CLI_PREFIX,
					"sync",
					"coordinator",
					"approve-join-request",
					"--db-path",
					"/data/coordinator.sqlite",
					"--json",
					"--",
					requestId,
				],
				`15-approve-${worker.id}`,
				120_000,
			);
			assertStatus(approveResult.status, 0, `failed to approve join request for ${worker.id}`);
			updateFleetNodeStatus(nodes, worker.id, "joined", `Joined coordinator group '${swarm.coordinator_group}'.`);
		}
	}

	const workerIdentities = new Map<string, { device_id: string; fingerprint: string }>();
	for (const swarm of spec.swarms) {
		for (const worker of swarm.workers) {
			const service = worker.runtime.service;
			assert(service, `worker '${worker.id}' missing compose service`);
			workerIdentities.set(worker.id, readPeerIdentity(ctx, service, `16-${worker.id}-identity`));
		}
	}

	await waitFor(
		async () => {
			const snapshot = fetchCoordinatorSnapshot<{
				discovered_devices?: Array<{ device_id?: string; fingerprint?: string }>;
			}>(ctx, seedService, "17-seed-discovery-snapshot");
			const discovered = Array.isArray(snapshot.discovered_devices) ? snapshot.discovered_devices : [];
			for (const swarm of spec.swarms) {
				for (const worker of swarm.workers) {
					const identity = workerIdentities.get(worker.id);
					assert(identity, `missing identity cache for ${worker.id}`);
					assert(
						discovered.some(
							(item) => item.device_id === identity.device_id && item.fingerprint === identity.fingerprint,
						),
						`seed peer has not discovered ${worker.id} yet`,
					);
				}
			}
		},
		{ description: "seed peer discovery for all workers", timeoutMs: 180_000, intervalMs: 3_000 },
	);

	for (const swarm of spec.swarms) {
		for (const worker of swarm.workers) {
			const service = worker.runtime.service;
			assert(service, `worker '${worker.id}' missing compose service`);
			const workerIdentity = workerIdentities.get(worker.id);
			assert(workerIdentity, `missing identity cache for ${worker.id}`);
			acceptDiscoveredPeer(ctx, seedService, workerIdentity.device_id, workerIdentity.fingerprint, `18-accept-${worker.id}-on-seed`);
			acceptDiscoveredPeer(ctx, service, seedIdentity.device_id, seedIdentity.fingerprint, `19-accept-seed-on-${worker.id}`);
		}
	}

	startSyncServer(ctx, seedService, "17-start-seed-sync-server");
	await waitForSyncServer(ctx, seedService, "20-seed-sync-ready");

	for (const swarm of spec.swarms) {
		for (const worker of swarm.workers) {
			const service = worker.runtime.service;
			assert(service, `worker '${worker.id}' missing compose service`);
			updateFleetNodeStatus(nodes, worker.id, "bootstrapping", `Bootstrapping from shared seed peer for swarm '${swarm.id}'.`);
			const bootstrapResult = bootstrapPeer(ctx, service, seedIdentity.device_id, `21-bootstrap-${worker.id}`);
			assert(bootstrapResult.ok === true, `${worker.id} bootstrap returned ok=false`);
			updateFleetNodeStatus(nodes, worker.id, "bootstrapped", `Bootstrap completed for swarm '${swarm.id}'.`);
			const syncResult = ctx.compose.exec(
				service,
				[...CLI_PREFIX, "sync", "once", "--db-path", "/data/mem.sqlite"],
				`22-sync-once-${worker.id}`,
				180_000,
				true,
			);
			assert(
				syncResult.stdout.includes(`${seedIdentity.device_id}: ok`),
				`${worker.id} did not complete a successful sync step against the shared seed peer`,
			);
			updateFleetNodeStatus(nodes, worker.id, "ready", `Join, bootstrap, and sync verification completed for swarm '${swarm.id}'.`);
		}
	}

	updateFleetNodeStatus(nodes, spec.seed_peer.id, "ready", "Seed peer reachable, coordinator-backed, and serving sync requests.");
	ctx.recordNote("fleet-status.json", JSON.stringify(createFleetStatusSnapshot(spec, nodes), null, 2));

	if (!ctx.keepStackOnFailure) {
		ctx.compose.down("23-compose-down-post");
	}
}
