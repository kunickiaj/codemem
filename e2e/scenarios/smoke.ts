import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assert, assertStatus } from "../lib/assert.js";
import type { ScenarioContext } from "../lib/scenario-context.js";
import { waitFor } from "../lib/wait.js";

const GROUP_ID = "e2e-smoke";
const ADMIN_SECRET = "e2e-admin-secret";

const CLI_PREFIX = ["pnpm", "exec", "tsx", "--conditions", "source", "packages/cli/src/index.ts"];

export async function runSmokeScenario(ctx: ScenarioContext): Promise<void> {
	ctx.recordNote(
		"scenario.txt",
		"Smoke scenario: start coordinator and peer containers, verify CLI execution, create a coordinator group, and verify coordinator HTTP admin reachability.",
	);

	ctx.compose.down("00-compose-down-pre", true);
	ctx.compose.up(["coordinator", "peer-a"], "01-compose-up");
	ctx.compose.ps("02-compose-ps");

	await waitFor(
		async () => {
			const result = ctx.compose.exec(
				"peer-a",
				[...CLI_PREFIX, "version"],
				"03-peer-a-version-check",
				30_000,
			);
			assertStatus(result.status, 0, "peer-a codemem version check failed");
		},
		{ description: "peer-a CLI readiness", timeoutMs: 120_000, intervalMs: 2_000 },
	);

	const groupCreate = ctx.compose.exec(
		"coordinator",
		[
			...CLI_PREFIX,
			"sync",
			"coordinator",
			"group-create",
			GROUP_ID,
			"--db-path",
			"/data/coordinator.sqlite",
		],
		"04-group-create",
	);
	assertStatus(groupCreate.status, 0, "coordinator group creation failed");

	const dbCopyDir = join(ctx.artifactsDir, "db");
	mkdirSync(dbCopyDir, { recursive: true });

	await waitFor(
		async () => {
			const result = ctx.compose.exec(
				"peer-a",
				[
					"node",
					"--input-type=module",
					"-e",
					`const res = await fetch('http://coordinator:7347/v1/admin/devices?group_id=${GROUP_ID}', { headers: { 'X-Codemem-Coordinator-Admin': '${ADMIN_SECRET}' } }); const body = await res.text(); console.log(body); process.exit(res.status === 200 ? 0 : 1);`,
				],
				"05-coordinator-http-check",
				30_000,
			);
			assertStatus(result.status, 0, "coordinator admin HTTP check failed");
			assert(result.stdout.includes('"items"'), "coordinator admin response did not include items payload");
		},
		{ description: "coordinator admin HTTP reachability", timeoutMs: 60_000, intervalMs: 2_000 },
	);

	ctx.compose.copyFromContainer(
		"coordinator:/data/coordinator.sqlite",
		join(dbCopyDir, "coordinator.sqlite"),
		"06-copy-coordinator-db",
	);

	if (!ctx.keepStackOnFailure) {
		ctx.compose.down("07-compose-down-post");
	}
}
