import { assert, assertStatus } from "../lib/assert.js";
import { createFleetStatusSnapshot, type FleetNodeStatus } from "../fleet/readiness.js";
import { collectComposeServices, loadFleetSpec } from "../fleet/spec.js";
import type { ScenarioContext } from "../lib/scenario-context.js";
import { waitFor } from "../lib/wait.js";

const CLI_PREFIX = ["pnpm", "exec", "tsx", "--conditions", "source", "packages/cli/src/index.ts"];
const ADMIN_SECRET = "e2e-admin-secret";
const DEFAULT_SPEC_PATH = "e2e/fleet/examples/compose-shared-seed.json";
const processRef = globalThis as typeof globalThis & {
	process: { env: Record<string, string | undefined> };
};

export async function runFleetSmokeScenario(ctx: ScenarioContext): Promise<void> {
	const specPath = processRef.process.env.CODEMEM_E2E_FLEET_SPEC?.trim() || DEFAULT_SPEC_PATH;
	const spec = loadFleetSpec(specPath);
	const composeServices = collectComposeServices(spec);
	assert(composeServices.length > 0, "fleet spec did not resolve any compose services");
	const coordinatorService = spec.coordinator.runtime.service ?? "coordinator";

	ctx.recordNote(
		"scenario.txt",
		"Fleet smoke scenario: load fleet spec, start declared compose services, verify codemem CLI reachability on the seed and workers, and materialize coordinator groups for each swarm.",
	);
	ctx.recordNote("fleet-spec.json", JSON.stringify(spec, null, 2));
	ctx.recordNote(
		"resolved-topology.json",
		JSON.stringify(
			{
				specPath,
				composeServices,
				seed_peer: spec.seed_peer,
				coordinator: spec.coordinator,
				swarms: spec.swarms,
			},
			null,
			2,
		),
	);
	const nodeStatuses: FleetNodeStatus[] = [
		{
			id: spec.coordinator.runtime.service ?? "coordinator",
			role: "coordinator",
			swarm_id: null,
			coordinator_group: null,
			runtime_type: spec.coordinator.runtime.type,
			runtime_target: spec.coordinator.runtime.service ?? spec.coordinator.runtime.selector ?? null,
			identity: null,
			state: "pending",
			detail: "Coordinator service declared in fleet spec.",
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

	ctx.compose.down("00-compose-down-pre", true);
	ctx.compose.up(composeServices, "01-compose-up");
	ctx.compose.ps("02-compose-ps");
	nodeStatuses[0]!.state = "reachable";
	nodeStatuses[0]!.detail = "Compose services started successfully.";

	const seedService = spec.seed_peer.runtime.service;
	assert(seedService, "seed peer compose service missing");

	await waitFor(
		async () => {
			const result = ctx.compose.exec(seedService, [...CLI_PREFIX, "version"], "03-seed-version-check", 30_000);
			assertStatus(result.status, 0, "seed peer codemem version check failed");
		},
		{ description: "seed peer CLI readiness", timeoutMs: 120_000, intervalMs: 2_000 },
	);
	const seedStatus = nodeStatuses.find((node) => node.id === spec.seed_peer.id);
	if (seedStatus) {
		seedStatus.state = "reachable";
		seedStatus.detail = "Seed peer CLI is reachable.";
	}

	for (const swarm of spec.swarms) {
		const groupCreate = ctx.compose.exec(
			coordinatorService,
			[
				...CLI_PREFIX,
				"sync",
				"coordinator",
				"group-create",
				swarm.coordinator_group,
				"--db-path",
				"/data/coordinator.sqlite",
			],
			`04-group-create-${swarm.id}`,
		);
		assertStatus(groupCreate.status, 0, `failed to create coordinator group for ${swarm.id}`);
		for (const worker of swarm.workers) {
			const status = nodeStatuses.find((node) => node.id === worker.id);
			if (status) {
				status.state = "group_ready";
				status.detail = `Coordinator group '${swarm.coordinator_group}' materialized for swarm '${swarm.id}'.`;
			}
		}

		for (const worker of swarm.workers) {
			const service = worker.runtime.service;
			assert(service, `worker '${worker.id}' is missing compose service`);
			await waitFor(
				async () => {
					const result = ctx.compose.exec(service, [...CLI_PREFIX, "version"], `05-${worker.id}-version-check`, 30_000);
					assertStatus(result.status, 0, `worker ${worker.id} codemem version check failed`);
				},
				{ description: `${worker.id} CLI readiness`, timeoutMs: 120_000, intervalMs: 2_000 },
			);

			const adminCheck = ctx.compose.exec(
				service,
				[
					"node",
					"--input-type=module",
					"-e",
					`const res = await fetch('http://${coordinatorService}:7347/v1/admin/devices?group_id=${swarm.coordinator_group}', { headers: { 'X-Codemem-Coordinator-Admin': '${ADMIN_SECRET}' } }); const body = await res.text(); console.log(body); process.exit(res.status === 200 ? 0 : 1);`,
				],
				`06-${worker.id}-admin-check`,
				30_000,
			);
			assertStatus(adminCheck.status, 0, `failed admin reachability check for ${worker.id}`);
			assert(adminCheck.stdout.includes('"items"'), `${worker.id} admin response missing items payload`);
			const status = nodeStatuses.find((node) => node.id === worker.id);
			if (status) {
				status.state = "reachable";
				status.detail = `Worker CLI is reachable and coordinator admin endpoint responded for group '${swarm.coordinator_group}'.`;
			}
		}
	}

	ctx.recordNote(
		"fleet-status.json",
		JSON.stringify(createFleetStatusSnapshot(spec, nodeStatuses), null, 2),
	);

	ctx.compose.copyFromContainer(
		`${coordinatorService}:/data/coordinator.sqlite`,
		`${ctx.artifactsDir}/db/coordinator-fleet-smoke.sqlite`,
		"07-copy-coordinator-db",
		false,
	);

	if (!ctx.keepStackOnFailure) {
		ctx.compose.down("08-compose-down-post");
	}
}
