import { assert, assertStatus } from "../lib/assert.js";
import { CLI_PREFIX, parseJson } from "../lib/coordinator.js";
import { shareFixtureProjectsWithPeerB } from "../lib/fixture-share.js";
import type { ScenarioContext } from "../lib/scenario-context.js";
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

export async function runDirectSyncScenario(ctx: ScenarioContext): Promise<void> {
	ctx.recordNote(
		"scenario.txt",
		"Direct sync scenario: seed peer-a with fixture-small, share both fixture Projects with peer-b through a Project invite so each gets its own boundary, run direct sync, and assert only shared fixture data replicates.",
	);

	await shareFixtureProjectsWithPeerB(ctx);

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
