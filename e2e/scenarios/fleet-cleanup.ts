import { assert, assertStatus } from "../lib/assert.js";
import {
	ADMIN_SECRET,
	CLI_PREFIX,
	parseJson,
	readPeerIdentity,
	writePeerConfig,
} from "../lib/coordinator.js";
import { collectComposeServices, loadFleetSpec } from "../fleet/spec.js";
import type { ScenarioContext } from "../lib/scenario-context.js";
import { seedPeer } from "../lib/seed.js";

const DEFAULT_SPEC_PATH = "e2e/fleet/examples/compose-shared-seed.json";
const processRef = globalThis as typeof globalThis & {
	process: { env: Record<string, string | undefined> };
};

function removeCoordinatorDevice(
	ctx: ScenarioContext,
	service: string,
	groupId: string,
	deviceId: string,
	artifactName: string,
) {
	const result = ctx.compose.exec(
		service,
		[
			"node",
			"--input-type=module",
			"-e",
			`const res = await fetch('http://127.0.0.1:7347/v1/admin/devices/remove', { method: 'POST', headers: { 'content-type': 'application/json', 'X-Codemem-Coordinator-Admin': '${ADMIN_SECRET}' }, body: JSON.stringify({ group_id: '${groupId}', device_id: '${deviceId}' }) }); const body = await res.text(); console.log(body); if (res.status !== 200) throw new Error('coordinator remove failed');`,
		],
		artifactName,
		60_000,
	);
	assertStatus(result.status, 0, `failed to remove device ${deviceId} from coordinator group ${groupId}`);
	return parseJson<{ ok: boolean }>(result.stdout, artifactName);
}

function removeLocalPeer(ctx: ScenarioContext, service: string, peerDeviceId: string, artifactName: string) {
	const result = ctx.compose.exec(
		service,
		[
			"pnpm",
			"exec",
			"tsx",
			"--conditions",
			"source",
			"e2e/scripts/remove-local-peer.ts",
			"--peer-device-id",
			peerDeviceId,
			"--db-path",
			"/data/mem.sqlite",
		],
		artifactName,
		60_000,
	);
	assertStatus(result.status, 0, `failed to remove local peer ${peerDeviceId} on ${service}`);
	return parseJson<{ ok: boolean; peer_device_id: string }>(result.stdout, artifactName);
}

function pinPeer(
	ctx: ScenarioContext,
	service: string,
	peerDeviceId: string,
	fingerprint: string,
	publicKey: string,
	address: string,
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
			"e2e/scripts/pin-peer.ts",
			"--peer-device-id",
			peerDeviceId,
			"--fingerprint",
			fingerprint,
			"--public-key",
			publicKey,
			"--address",
			address,
			"--db-path",
			"/data/mem.sqlite",
		],
		artifactName,
		120_000,
	);
	assertStatus(result.status, 0, `failed to pin peer ${peerDeviceId} on ${service}`);
}

export async function runFleetCleanupScenario(ctx: ScenarioContext): Promise<void> {
	const specPath = processRef.process.env.CODEMEM_E2E_FLEET_SPEC?.trim() || DEFAULT_SPEC_PATH;
	const spec = loadFleetSpec(specPath);
	const coordinatorService = spec.coordinator.runtime.service ?? "coordinator";
	const seedService = spec.seed_peer.runtime.service;
	assert(seedService, "seed peer compose service missing");

	ctx.recordNote(
		"scenario.txt",
		"Fleet cleanup scenario: materialize workers from the fleet spec, then remove ephemeral workers from coordinator and local peer state while protecting the shared seed peer.",
	);
	ctx.recordNote("fleet-spec.json", JSON.stringify(spec, null, 2));

	ctx.compose.down("00-compose-down-pre", true);
	ctx.compose.up(collectComposeServices(spec), "01-compose-up");
	ctx.compose.ps("02-compose-ps");

	seedPeer(ctx.compose, ctx.artifactsDir, seedService, "empty", "03-seed-shared-seed");
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
		"04-write-seed-config",
	);
	const enableSeed = ctx.compose.exec(
		seedService,
		[...CLI_PREFIX, "sync", "enable", "--db-path", "/data/mem.sqlite", "--host", "0.0.0.0", "--port", "7337", "--interval", "5"],
		"05-enable-seed",
		120_000,
	);
	assertStatus(enableSeed.status, 0, "failed to enable sync on seed peer");

	const seedIdentity = readPeerIdentity(ctx, seedService, "06-seed-identity");
	const cleanupResults: Array<Record<string, unknown>> = [];

	for (const swarm of spec.swarms) {
		const groupCreate = ctx.compose.exec(
			coordinatorService,
			[...CLI_PREFIX, "sync", "coordinator", "group-create", swarm.coordinator_group, "--db-path", "/data/coordinator.sqlite"],
			`07-group-create-${swarm.id}`,
			120_000,
		);
		assertStatus(groupCreate.status, 0, `failed to create group ${swarm.id}`);
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
			`08-enroll-seed-${swarm.id}`,
			120_000,
		);
		assertStatus(enrollSeed.status, 0, `failed to enroll seed for ${swarm.id}`);

		const inviteResult = ctx.compose.exec(
			seedService,
			[...CLI_PREFIX, "sync", "coordinator", "create-invite", swarm.coordinator_group, "--policy", "approval_required", "--json"],
			`09-create-invite-${swarm.id}`,
			120_000,
		);
		assertStatus(inviteResult.status, 0, `failed to create invite for ${swarm.id}`);
		const invitePayload = parseJson<{ encoded: string }>(inviteResult.stdout, `invite-${swarm.id}`);

		for (const worker of swarm.workers) {
			const service = worker.runtime.service;
			assert(service, `worker '${worker.id}' missing compose service`);
			seedPeer(ctx.compose, ctx.artifactsDir, service, "empty", `10-seed-${worker.id}-empty`);
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
			assertStatus(enableWorker.status, 0, `failed to enable worker ${worker.id}`);
			const joinRequestsResult = ctx.compose.exec(
				coordinatorService,
				[...CLI_PREFIX, "sync", "coordinator", "list-join-requests", swarm.coordinator_group, "--db-path", "/data/coordinator.sqlite", "--json"],
				`14-list-join-requests-${worker.id}`,
				120_000,
			);
			assertStatus(joinRequestsResult.status, 0, `failed to list join requests for ${worker.id}`);
			const joinRequests = parseJson<Array<{ request_id: string }>>(joinRequestsResult.stdout, `join-requests-${worker.id}`);
			const requestId = joinRequests[joinRequests.length - 1]?.request_id;
			assert(requestId, `missing join request for ${worker.id}`);
			const approveResult = ctx.compose.exec(
				coordinatorService,
				[
					...CLI_PREFIX,
					"sync",
					"coordinator",
					"approve-join-request",
					requestId,
					"--db-path",
					"/data/coordinator.sqlite",
					"--json",
				],
				`15-approve-${worker.id}`,
				120_000,
			);
			assertStatus(approveResult.status, 0, `failed to approve ${worker.id}`);

			const workerIdentity = readPeerIdentity(ctx, service, `16-identity-${worker.id}`);
			pinPeer(
				ctx,
				seedService,
				workerIdentity.device_id,
				workerIdentity.fingerprint,
				workerIdentity.public_key,
				`${service}:7337`,
				`17-pin-${worker.id}-on-seed`,
			);
			const coordinatorRemoval = removeCoordinatorDevice(
				ctx,
				coordinatorService,
				swarm.coordinator_group,
				workerIdentity.device_id,
				`18-remove-coordinator-${worker.id}`,
			);
			const localSeedRemoval = removeLocalPeer(ctx, seedService, workerIdentity.device_id, `19-remove-seed-peer-${worker.id}`);
			cleanupResults.push({
				worker_id: worker.id,
				worker_device_id: workerIdentity.device_id,
				swarm_id: swarm.id,
				group_id: swarm.coordinator_group,
				coordinator_removed: coordinatorRemoval.ok,
				seed_removed: localSeedRemoval.ok,
			});
		}
	}

	const devicesResult = ctx.compose.exec(
		seedService,
		[
			"node",
			"--input-type=module",
			"-e",
			`const groups = ${JSON.stringify(spec.swarms.map((swarm) => swarm.coordinator_group))}; const out = []; for (const groupId of groups) { const res = await fetch('http://coordinator:7347/v1/admin/devices?group_id=' + encodeURIComponent(groupId), { headers: { 'X-Codemem-Coordinator-Admin': '${ADMIN_SECRET}' } }); const body = await res.json(); out.push({ group_id: groupId, items: body.items ?? [] }); } console.log(JSON.stringify(out, null, 2));`,
		],
		"20-list-devices-post-cleanup",
		60_000,
	);
	assertStatus(devicesResult.status, 0, "failed to inspect coordinator devices after cleanup");
	const groups = parseJson<Array<{ group_id: string; items: Array<{ device_id?: string }> }>>(devicesResult.stdout, "post-cleanup-devices");
	for (const group of groups) {
		assert(group.items.length === 1, `expected only seed peer to remain in ${group.group_id}, got ${group.items.length}`);
		assert(group.items[0]?.device_id === seedIdentity.device_id, `expected seed peer to remain in ${group.group_id}`);
	}

	ctx.recordNote("fleet-cleanup.json", JSON.stringify({ ok: true, workers_removed: cleanupResults }, null, 2));

	if (!ctx.keepStackOnFailure) {
		ctx.compose.down("21-compose-down-post");
	}
}
