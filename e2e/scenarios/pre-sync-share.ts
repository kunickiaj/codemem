import { assert, assertStatus } from "../lib/assert.js";
import { CLI_PREFIX, parseJson } from "../lib/coordinator.js";
import { shareFixtureProjectsWithPeerB } from "../lib/fixture-share.js";
import type { ScenarioContext } from "../lib/scenario-context.js";
import { waitFor } from "../lib/wait.js";

interface PeerState {
	origins: Array<{ origin: string; visibility: string; count: number }>;
	rejections: Array<{ reason: string; scope_id: string | null; count: number }>;
}

interface FixtureSummary {
	shared_count: number;
	private_count: number;
	shared_titles: string[];
}

function tsx(ctx: ScenarioContext, service: string, args: string[], artifact: string): string {
	const result = ctx.compose.exec(service, ["pnpm", "exec", "tsx", "--conditions", "source", ...args], artifact, 60_000);
	assertStatus(result.status, 0, `${service} ${args[0]} failed`);
	return result.stdout;
}

function peerState(ctx: ScenarioContext, service: string, artifact: string): PeerState {
	return parseJson<PeerState>(tsx(ctx, service, ["e2e/scripts/pre-sync-share-state.ts"], artifact), artifact);
}

function fixtureSummary(ctx: ScenarioContext, artifact: string): FixtureSummary {
	const stdout = tsx(ctx, "peer-b", ["e2e/scripts/fixture-summary.ts", "--db-path", "/data/mem.sqlite"], artifact);
	return parseJson<FixtureSummary>(stdout, artifact);
}

export async function runPreSyncShareScenario(ctx: ScenarioContext): Promise<void> {
	ctx.recordNote(
		"scenario.txt",
		"Pre-sync share: seed peer-a with fixture-small before it has a sync identity, so its memories keep origin 'local', share both fixture Projects with peer-b, and assert peer-b receives only the shared memories, peer-a records its own device as their origin, and peer-b's pulls from peer-a succeed without inbound rejections (codemem-yfla4).",
	);
	const { peerAIdentity } = await shareFixtureProjectsWithPeerB(ctx, { seedBeforeIdentity: true });
	const ownerId = peerAIdentity.device_id;

	// Assert: peer-b receives exactly the shared fixture memories.
	await waitFor(
		async () => {
			const summary = fixtureSummary(ctx, "24-peer-b-fixture-summary");
			assert(summary.shared_count === 16, `expected 16 shared fixture memories on peer-b, got ${summary.shared_count}`);
			assert(summary.private_count === 0, `expected 0 private fixture memories on peer-b, got ${summary.private_count}`);
			assert(summary.shared_titles.includes("fixture-small memory 0001"), "expected shared fixture memory 0001 on peer-b");
			assert(!summary.shared_titles.includes("fixture-small memory 0000"), "private fixture memory 0000 should not replicate as shared");
		},
		{ description: "peer-b replicated fixture data", timeoutMs: 120_000, intervalMs: 3_000 },
	);

	// Assert: peer-a recorded itself as origin of the shared memories it moved,
	// and left the private ones it didn't move as they were.
	const owner = peerState(ctx, "peer-a", "25-peer-a-origins");
	const ownerOrigins = Object.fromEntries(owner.origins.map((row) => [`${row.origin}|${row.visibility}`, row.count]));
	assert(ownerOrigins[`${ownerId}|shared`] === 16, `peer-a shared origins: ${JSON.stringify(owner.origins)}`);
	assert(ownerOrigins["local|private"] === 8, `peer-a private origins: ${JSON.stringify(owner.origins)}`);
	const recipient = peerState(ctx, "peer-b", "25-peer-b-origins");
	assert(
		recipient.origins.length === 1 && recipient.origins[0]?.origin === ownerId,
		`peer-b stored origins: ${JSON.stringify(recipient.origins)}`,
	);

	// Act + Assert: peer-b's own pull from peer-a succeeds and records no rejections.
	const pull = ctx.compose.exec(
		"peer-b",
		[...CLI_PREFIX, "sync", "once", "--db-path", "/data/mem.sqlite", "--peer", ownerId, "--json"],
		"26-peer-b-pull",
		180_000,
		true,
	);
	assertStatus(pull.status, 0, `peer-b pull from peer-a failed: ${pull.stdout}`);
	const rejections = peerState(ctx, "peer-b", "27-peer-b-rejections").rejections;
	assert(rejections.length === 0, `peer-b recorded inbound rejections: ${JSON.stringify(rejections)}`);

	if (!ctx.keepStackOnFailure) {
		ctx.compose.down("28-compose-down-post");
	}
}
