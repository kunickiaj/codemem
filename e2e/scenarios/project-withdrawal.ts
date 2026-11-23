import { assert, assertStatus } from "../lib/assert.js";
import { CLI_PREFIX, GROUP_ID, parseJson } from "../lib/coordinator.js";
import { shareFixtureProjectsWithPeerB } from "../lib/fixture-share.js";
import type { ScenarioContext } from "../lib/scenario-context.js";
import { request } from "../lib/viewer.js";
import { waitFor } from "../lib/wait.js";

const ALPHA = { cwd: "/workspace/e2e-fixture-0", project: "e2e-project-alpha" };
const BETA = { cwd: "/workspace/e2e-fixture-1", project: "e2e-project-beta" };
type FixtureProject = typeof ALPHA;

interface PeerState {
	memories: Array<{ title: string; scope_id: string | null }>;
	memberships: Array<{ scope_id: string; device_id: string; status: string }>;
	withdrawals: Array<{ scope_id: string }>;
}

function runFixture(ctx: ScenarioContext, service: string, args: string[], artifact: string): string {
	const result = ctx.compose.exec(
		service,
		["pnpm", "exec", "tsx", "--conditions", "source", "e2e/scripts/project-withdrawal-fixture.ts", ...args],
		artifact,
		60_000,
	);
	assertStatus(result.status, 0, `${service} withdrawal fixture ${args[0]} failed`);
	return result.stdout;
}

function remember(ctx: ScenarioContext, service: string, project: FixtureProject, title: string, artifact: string) {
	const stdout = runFixture(
		ctx,
		service,
		["remember", "--cwd", project.cwd, "--project", project.project, "--title", title],
		artifact,
	);
	return parseJson<{ id: number; title: string; scope_id: string | null }>(stdout, artifact);
}

/** The Project boundary a memory was written to, or a failure naming the memory. */
function boundaryOf(memory: { title: string; scope_id: string | null }): string {
	const scopeId = memory.scope_id ?? "";
	assert(scopeId.startsWith("managed-project:"), `${memory.title} is not on a Project boundary: ${scopeId}`);
	return scopeId;
}

function peerState(ctx: ScenarioContext, service: string, artifact: string): PeerState {
	return parseJson<PeerState>(runFixture(ctx, service, ["state"], artifact), artifact);
}

function titlesIn(state: PeerState): Set<string> {
	return new Set(state.memories.map((memory) => memory.title));
}

async function waitForTitle(ctx: ScenarioContext, service: string, title: string, artifact: string): Promise<void> {
	await waitFor(
		async () => {
			assert(titlesIn(peerState(ctx, service, artifact)).has(title), `${title} has not reached ${service}`);
		},
		{ description: `${title} on ${service}`, timeoutMs: 120_000, intervalMs: 3_000 },
	);
}

async function setStopped(
	ctx: ScenarioContext,
	scopeId: string,
	action: "stop" | "resume",
	artifact: string,
): Promise<void> {
	const response = await request<{ workspace_identity?: string; stopped_at?: string | null; error?: string }>(
		ctx,
		"peer-b",
		`/api/sync/project-withdrawals/v1/${action}`,
		artifact,
		{ workspace_identity: `peer-received:scope:${scopeId}` },
	);
	assert(response.status === 200, `${action} failed: ${JSON.stringify(response.body)}`);
	assert(
		action === "stop" ? typeof response.body.stopped_at === "string" : response.body.stopped_at === null,
		`unexpected ${action} response: ${JSON.stringify(response.body)}`,
	);
}

/** Every memory peer-b held in a Project before it stopped receiving it. */
function heldTitles(state: PeerState, scopeId: string): string[] {
	return state.memories.filter((memory) => memory.scope_id === scopeId).map((memory) => memory.title);
}

function assertStillHeld(after: PeerState, titles: string[], label: string): void {
	const present = titlesIn(after);
	const missing = titles.filter((title) => !present.has(title));
	assert(missing.length === 0, `peer-b lost ${label} local copies: ${missing.join(", ")}`);
}

export async function runProjectWithdrawalScenario(ctx: ScenarioContext): Promise<void> {
	ctx.recordNote(
		"scenario.txt",
		"Project withdrawal: peer-b receives two shared fixture Projects, stops one so it receives nothing more for that Project while the other keeps syncing and its local copies stay, resumes it to get what was held back, then stops the other, loses access, and resumes it without receiving anything.",
	);
	const { peerAIdentity, peerBIdentity } = await shareFixtureProjectsWithPeerB(ctx);

	// Arrange: one memory per Project from the owner tells us each boundary.
	const alphaScope = boundaryOf(remember(ctx, "peer-a", ALPHA, "withdrawal alpha before stop", "20-owner-alpha-before"));
	const betaScope = boundaryOf(remember(ctx, "peer-a", BETA, "withdrawal beta before stop", "20-owner-beta-before"));
	assert(betaScope !== alphaScope, "alpha and beta share a boundary");
	await waitForTitle(ctx, "peer-b", "withdrawal alpha before stop", "21-peer-b-alpha-before");
	await waitForTitle(ctx, "peer-b", "withdrawal beta before stop", "21-peer-b-beta-before");
	const beforeStop = peerState(ctx, "peer-b", "22-peer-b-before-stop");
	const alphaHeld = heldTitles(beforeStop, alphaScope);
	assert(alphaHeld.length === 9, `expected 8 fixture memories plus 1 on alpha, got ${alphaHeld.length}`);

	// Act: peer-b stops alpha. Both devices then write to both Projects.
	await setStopped(ctx, alphaScope, "stop", "23-stop-alpha");
	remember(ctx, "peer-a", ALPHA, "withdrawal alpha from owner while stopped", "24-owner-alpha-stopped");
	remember(ctx, "peer-a", BETA, "withdrawal beta from owner while stopped", "24-owner-beta-stopped");
	// Assert: beta still arrives, which shows sync ran after the alpha write.
	// alpha receives nothing more, and peer-b keeps its alpha copies.
	await waitForTitle(ctx, "peer-b", "withdrawal beta from owner while stopped", "25-peer-b-beta-control");
	const recipientStopped = peerState(ctx, "peer-b", "26-peer-b-while-stopped");
	assert(
		!titlesIn(recipientStopped).has("withdrawal alpha from owner while stopped"),
		"peer-b received alpha data after stopping it",
	);
	assertStillHeld(recipientStopped, alphaHeld, "alpha");
	assert(
		recipientStopped.withdrawals.some((row) => row.scope_id === alphaScope),
		"peer-b has no withdrawal record for alpha",
	);

	// Act + Assert: resuming alpha delivers what was held back.
	await setStopped(ctx, alphaScope, "resume", "27-resume-alpha");
	await waitForTitle(ctx, "peer-b", "withdrawal alpha from owner while stopped", "28-peer-b-alpha-resumed");

	// Arrange: peer-b stops beta, the owner writes to it, then an admin
	// disables peer-b's enrollment and the owner's maintenance revokes its access.
	await setStopped(ctx, betaScope, "stop", "29-stop-beta");
	remember(ctx, "peer-a", BETA, "withdrawal beta from owner after access ends", "30-owner-beta-revoked");
	const beforeRevocation = peerState(ctx, "peer-b", "31-peer-b-before-revocation");
	const disabled = ctx.compose.exec(
		"coordinator",
		[
			...CLI_PREFIX,
			"coordinator",
			"device",
			"disable",
			GROUP_ID,
			peerBIdentity.device_id,
			"--db-path",
			"/data/coordinator.sqlite",
			"--json",
		],
		"32-disable-peer-b-enrollment",
	);
	assertStatus(disabled.status, 0, "peer-b coordinator enrollment disable failed");
	await waitFor(
		async () => {
			const owner = peerState(ctx, "peer-a", "33-owner-revokes-peer-b");
			assert(
				owner.memberships.some(
					(member) =>
						member.scope_id === betaScope &&
						member.device_id === peerBIdentity.device_id &&
						member.status === "revoked",
				),
				"owner maintenance has not revoked peer-b from beta",
			);
		},
		{ description: "owner revokes peer-b from beta", timeoutMs: 180_000, intervalMs: 3_000 },
	);

	// Act: peer-b resumes beta and tries to sync with the owner.
	await setStopped(ctx, betaScope, "resume", "34-resume-beta");
	const revokedSync = ctx.compose.exec(
		"peer-b",
		[...CLI_PREFIX, "sync", "once", "--db-path", "/data/mem.sqlite", "--peer", peerAIdentity.device_id, "--json"],
		"35-sync-peer-b-after-revocation",
		180_000,
		true,
	);

	// Assert: the pairing still syncs, but the owner no longer sends beta to
	// peer-b, so resuming delivers nothing held back. peer-b keeps every copy.
	assertStatus(revokedSync.status, 0, "peer-b sync with the owner failed after resuming beta");
	const revokedResult = parseJson<{ ok: boolean; results: Array<{ peer_device_id: string; ok: boolean }> }>(
		revokedSync.stdout,
		"35-sync-peer-b-after-revocation",
	);
	assert(
		revokedResult.results.some((result) => result.peer_device_id === peerAIdentity.device_id && result.ok),
		`peer-b did not complete a sync pass with the owner after resuming beta: ${revokedSync.stdout}`,
	);
	const recipientAfter = peerState(ctx, "peer-b", "36-peer-b-after-resume");
	assert(
		!titlesIn(recipientAfter).has("withdrawal beta from owner after access ends"),
		"peer-b received held-back beta data after its access ended",
	);
	assertStillHeld(recipientAfter, [...titlesIn(beforeRevocation)], "previously synced");

	if (!ctx.keepStackOnFailure) {
		ctx.compose.down("37-compose-down-post");
	}
}
