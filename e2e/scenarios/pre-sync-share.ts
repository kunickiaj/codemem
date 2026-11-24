import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertStatus } from "../lib/assert.js";
import { CLI_PREFIX, parseJson } from "../lib/coordinator.js";
import { shareFixtureProjectsWithPeerB } from "../lib/fixture-share.js";
import type { ScenarioContext } from "../lib/scenario-context.js";
import { waitFor } from "../lib/wait.js";

interface PeerState {
	origins: Array<{ origin: string; visibility: string; count: number }>;
	imported: Array<{ scope_id: string; origin: string }>;
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

/**
 * Another device's export of a memory it wrote before it had a sync identity,
 * in the first fixture Project. Nothing in it says which device wrote it.
 */
function importOtherDevicesPreSyncMemory(ctx: ScenarioContext): void {
	const exportPath = join(ctx.artifactsDir, "other-device-export.json");
	writeFileSync(
		exportPath,
		JSON.stringify({
			version: "1.0",
			exported_at: "2026-01-01T00:00:00Z",
			export_metadata: {
				tool_version: "codemem",
				projects: ["e2e-project-alpha"],
				total_memories: 1,
				total_sessions: 1,
				include_inactive: false,
				filters: {},
			},
			sessions: [
				{
					id: 1,
					project: "e2e-project-alpha",
					cwd: "/workspace/e2e-fixture-0",
					started_at: "2026-01-01T00:00:00Z",
					user: "other",
				},
			],
			memory_items: [
				{
					id: 1,
					session_id: 1,
					project: "e2e-project-alpha",
					kind: "discovery",
					title: "imported pre-sync memory",
					body_text: "Synthetic memory another device wrote before it had a sync identity.",
					visibility: "shared",
					workspace_kind: "shared",
					workspace_id: "shared:alpha",
					origin_device_id: "local",
					import_key: "e2e-other-device-pre-sync-0001",
				},
			],
			user_prompts: [],
			session_summaries: [],
		}),
	);
	ctx.compose.copyToContainer(exportPath, "peer-a:/tmp/other-device-export.json", "03-copy-other-device-export");
	const imported = ctx.compose.exec(
		"peer-a",
		[...CLI_PREFIX, "memory", "import", "/tmp/other-device-export.json", "--db-path", "/data/mem.sqlite"],
		"03-import-other-device-export",
		120_000,
	);
	assertStatus(imported.status, 0, "memory import of the other device's export failed on peer-a");
}

/**
 * One `sync once` from `service` with `peerId`. Both devices' sync services run
 * too, so a pass can meet the database lock. Only that is retried; any other
 * failure, a rejection included, fails at once.
 */
async function syncOnce(ctx: ScenarioContext, service: string, peerId: string, artifact: string): Promise<void> {
	for (let attempt = 1; ; attempt += 1) {
		const pass = ctx.compose.exec(
			service,
			[...CLI_PREFIX, "sync", "once", "--db-path", "/data/mem.sqlite", "--peer", peerId, "--json"],
			`${artifact}-${attempt}`,
			180_000,
			true,
		);
		if (pass.status === 0) return;
		const locked = pass.stdout.includes("database is locked") && !pass.stdout.includes("rejected");
		assert(locked && attempt < 6, `${service} sync with ${peerId} failed: ${pass.stdout}`);
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
}

export async function runPreSyncShareScenario(ctx: ScenarioContext): Promise<void> {
	ctx.recordNote(
		"scenario.txt",
		"Pre-sync share: seed peer-a with fixture-small before it has a sync identity, so its memories keep origin 'local', share both fixture Projects with peer-b, and assert peer-b receives only the shared memories, peer-a records its own device as their origin, peer-b's pulls from peer-a succeed without inbound rejections, another device's imported pre-sync memory is left out of the share and stays on peer-a unchanged, and once that memory is moved the way earlier shares did, peer-a withholds the cleanup peer-b would refuse so peer-b keeps pulling (codemem-yfla4).",
	);
	const { peerAIdentity, peerBIdentity } = await shareFixtureProjectsWithPeerB(ctx, {
		seedBeforeIdentity: true,
		afterSeed: () => importOtherDevicesPreSyncMemory(ctx),
		expectedUnattributedImports: 1,
	});
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

	// Assert: the imported memory without a known author stayed on peer-a as it
	// was, and never reached peer-b.
	assert(
		JSON.stringify(owner.imported) === JSON.stringify([{ scope_id: "local-default", origin: "local" }]),
		`peer-a imported memory: ${JSON.stringify(owner.imported)}`,
	);
	assert(recipient.imported.length === 0, `peer-b received the imported memory: ${JSON.stringify(recipient.imported)}`);

	// Act + Assert: peer-b's own pull from peer-a succeeds and records no rejections.
	await syncOnce(ctx, "peer-b", ownerId, "26-peer-b-pull");
	const rejections = peerState(ctx, "peer-b", "27-peer-b-rejections").rejections;
	assert(rejections.length === 0, `peer-b recorded inbound rejections: ${JSON.stringify(rejections)}`);

	// Arrange: the imported memory as a share made before shares claimed the
	// origin left it: moved into the shared Project, origin still "local", with
	// a cleanup peer-b refuses. peer-a's push delivers the move to peer-b first.
	tsx(ctx, "peer-a", ["e2e/scripts/pre-sync-share-legacy-move.ts"], "28-peer-a-legacy-move");
	await syncOnce(ctx, "peer-a", peerBIdentity.device_id, "29-peer-a-push");

	// Act + Assert: peer-a withholds that cleanup, so peer-b keeps pulling
	// without a rejection. peer-b's copy stays as it was received.
	await syncOnce(ctx, "peer-b", ownerId, "30-peer-b-pull-after-legacy-move");
	const after = peerState(ctx, "peer-b", "31-peer-b-after-legacy-move");
	assert(after.rejections.length === 0, `peer-b recorded inbound rejections: ${JSON.stringify(after.rejections)}`);
	assert(
		after.imported.length === 1 && after.imported[0]?.origin === "local",
		`peer-b imported copy: ${JSON.stringify(after.imported)}`,
	);
	const ownerAfter = peerState(ctx, "peer-a", "31-peer-a-after-legacy-move");
	assert(ownerAfter.imported[0]?.origin === "local", `peer-a imported memory: ${JSON.stringify(ownerAfter.imported)}`);

	if (!ctx.keepStackOnFailure) {
		ctx.compose.down("32-compose-down-post");
	}
}
