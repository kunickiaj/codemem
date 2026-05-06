import { join } from "node:path";
import { assertStatus } from "../lib/assert.js";
import type { ScenarioContext } from "../lib/scenario-context.js";

export async function runSharingDomainsScenario(ctx: ScenarioContext): Promise<void> {
	ctx.recordNote(
		"scenario.txt",
		"Sharing-domain smoke: seed Mixed Adam with personal/work/OSS memories, exercise sync filters, retrieval/MCP/viewer boundaries, legacy-peer default deny, revocation, and hostile peer rejection fixtures.",
	);

	ctx.compose.down("00-compose-down-pre", true);
	ctx.compose.up(["coordinator", "peer-a"], "01-compose-up");
	ctx.compose.ps("02-compose-ps");

	const result = ctx.compose.exec(
		"peer-a",
		[
			"pnpm",
			"exec",
			"tsx",
			"--conditions",
			"source",
			"e2e/scripts/sharing-domain-smoke.ts",
			"--db-path",
			"/data/mixed-adam-sharing-domains.sqlite",
		],
		"03-sharing-domain-smoke",
		300_000,
	);
	assertStatus(result.status, 0, "sharing-domain smoke script failed");

	const coordinatorDataPathCheck = ctx.compose.exec(
		"coordinator",
		[
			"pnpm",
			"exec",
			"tsx",
			"--conditions",
			"source",
			"-e",
			`import { connect } from './packages/core/src/db.ts';
const db = connect('/data/coordinator.sqlite');
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => String(row.name));
  const forbidden = tables.filter((name) => /^(memory_items|replication_ops|raw_events|sessions|artifacts)$/.test(name));
  if (forbidden.length > 0) {
    console.error(JSON.stringify({ ok: false, forbidden }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, checked_tables: tables.length }));
} finally {
  db.close();
}`,
		],
		"04-coordinator-no-memory-data-path",
		60_000,
	);
	assertStatus(coordinatorDataPathCheck.status, 0, "coordinator DB exposed memory data-path tables");

	ctx.compose.copyFromContainer(
		"peer-a:/data/mixed-adam-sharing-domains.sqlite",
		join(ctx.artifactsDir, "db", "mixed-adam-sharing-domains.sqlite"),
		"05-copy-mixed-adam-db",
	);
	ctx.compose.copyFromContainer(
		"coordinator:/data/coordinator.sqlite",
		join(ctx.artifactsDir, "db", "coordinator-sharing-domains.sqlite"),
		"06-copy-coordinator-db",
	);

	if (!ctx.keepStackOnFailure) {
		ctx.compose.down("07-compose-down-post");
	}
}
