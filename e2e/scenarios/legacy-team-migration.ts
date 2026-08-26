import { createHash } from "node:crypto";
import { recipientPolicyDigest } from "../../packages/core/src/recipient-policy-identifiers.js";
import { assert, assertStatus } from "../lib/assert.js";
import {
	ADMIN_SECRET,
	CLI_PREFIX,
	parseJson,
	writePeerConfig,
} from "../lib/coordinator.js";
import type { ScenarioContext } from "../lib/scenario-context.js";
import { seedPeer } from "../lib/seed.js";
import { waitFor } from "../lib/wait.js";

const GROUP_ALPHA = "legacy-team-alpha";
const GROUP_BETA = "legacy-team-beta";
const ALPHA_PROJECT = "https://example.invalid/e2e/alpha.git";
const BETA_PROJECT = "https://example.invalid/e2e/beta.git";
const WEB_PROJECT = "https://example.invalid/e2e/web.git";
const LEGACY_WEB_SOURCE_PROJECT = `unmapped:${createHash("sha256")
	.update("legacy-web", "utf8")
	.digest("hex")}`;
const API = "/api/sync/team-setup/v1";

interface FixtureSummary {
	roster: Record<
		"shared" | "optional" | "beta",
		{ deviceId: string; displayName: string; publicKey: string; fingerprint: string }
	>;
	offRosterDeviceId: string;
	legacyScopeMemberships: unknown[];
	policies: {
		teams: Array<{
			team_id: string;
			display_name: string;
			status: string;
			device_eligibility_mode: string;
		}>;
		memberships: Array<{ team_id: string; identity_id: string; status: string }>;
		devices: Array<{
			device_id: string;
			identity_id: string;
			status: string;
			assignment_version: number;
		}>;
		decisions: Array<{
			team_id: string;
			device_id: string;
			decision: string;
			assignment_version: number;
		}>;
		recipients: Array<{
			canonical_project_identity: string;
			recipient_kind: string;
			recipient_id: string;
			status: string;
		}>;
		reviewedMappings: Array<{
			workspace_identity: string;
			project_pattern: string;
			scope_id: string;
		}>;
	};
	effective: Array<{
		canonicalProjectIdentity: string;
		status: string;
		devices: Array<{ deviceId: string; identityId: string }>;
	}>;
	completions: Array<{
		candidate_ref: string;
		attempt_id: string;
		finish_digest: string;
		confirmed_access_delta_digest: string;
		response_json: string;
	}>;
}

interface CandidateSummary {
	candidateRef: string;
	displayName: string;
	status: string;
	deviceCount: number;
	projectCount: number;
	unresolvedDeviceCount: number;
	unresolvedProjectCount: number;
}

interface TeamDetail {
	version: 1;
	candidate: CandidateSummary;
	attemptId: string;
	draftState: string;
	unresolvedDeviceCount: number;
	unresolvedProjectCount: number;
	canFinish: boolean;
	conflictState: string | null;
	finishDigest?: string;
	accessDeltaDigest?: string;
	viewerAccessDeltaDigest?: string;
	devices: Array<{
		deviceRef: string;
		displayName: string;
		existingIdentityRef: string | null;
		suggestedIdentityRef: string | null;
		verifiedEvidenceKind: "active_assignment" | null;
		decision: string;
		targetIdentityRef: string | null;
		expectation:
			| { kind: "absent" }
			| { kind: "existing"; assignmentVersion: number; identityRef: string };
	}>;
	projects: Array<{
		projectRef: string;
		displayName: string;
		resolution: string;
		resolvedProjectRef: string | null;
		mappingChoices: Array<{ resolvedProjectRef: string; displayName: string }>;
	}>;
	identityChoices: Array<{ identityRef: string; displayName: string }>;
	accessDelta?: {
		teamChanges: unknown[];
		membershipChanges: unknown[];
		projectChanges: unknown[];
		recipientChanges: unknown[];
		deviceAccessChanges: unknown[];
	};
}

interface FinishResponse {
	version: 1;
	status: "completed";
	teamRef: string;
	attemptId: string;
	accessDeltaDigest: string;
	completedAt: string;
}

interface StoredCompletionResponse {
	status: "completed";
	teamId: string;
	attemptId: string;
	accessDeltaDigest: string;
	completedAt: string;
}

function fixture(ctx: ScenarioContext, action: string, artifact: string): FixtureSummary {
	const result = ctx.compose.exec(
		"peer-a",
		[
			"env",
			"CODEMEM_EMBEDDING_DISABLED=1",
			"pnpm",
			"exec",
			"tsx",
			"--conditions",
			"source",
			"e2e/scripts/legacy-team-migration-fixture.ts",
			"--action",
			action,
		],
		artifact,
		120_000,
	);
	assertStatus(result.status, 0, `legacy Team fixture action ${action} failed`);
	return parseJson<FixtureSummary>(result.stdout, artifact);
}

function coordinatorCommand(
	ctx: ScenarioContext,
	args: string[],
	artifact: string,
): void {
	const result = ctx.compose.exec(
		"coordinator",
		[
			...CLI_PREFIX,
			"sync",
			"coordinator",
			...args,
			"--db-path",
			"/data/coordinator.sqlite",
			"--json",
		],
		artifact,
		120_000,
	);
	assertStatus(result.status, 0, `coordinator command ${args[0] ?? "unknown"} failed`);
}

function createCoordinatorRoster(ctx: ScenarioContext, roster: FixtureSummary["roster"]): void {
	coordinatorCommand(ctx, ["group-create", GROUP_ALPHA, "--name", "Legacy Alpha"], "04-create-alpha");
	coordinatorCommand(ctx, ["group-create", GROUP_BETA, "--name", "Legacy Beta"], "05-create-beta");
	for (const [groupId, devices] of [
		[GROUP_ALPHA, [roster.shared, roster.optional]],
		[GROUP_BETA, [roster.shared, roster.optional, roster.beta]],
	] as const) {
		for (const device of devices) {
			coordinatorCommand(
				ctx,
				[
					"enroll-device",
					groupId,
					device.deviceId,
					"--fingerprint",
					device.fingerprint,
					"--public-key",
					device.publicKey,
					"--name",
					device.displayName,
				],
				`06-enroll-${groupId}-${device.deviceId}`,
			);
		}
	}
}

function startServer(ctx: ScenarioContext): void {
	const staticResult = ctx.compose.exec(
		"peer-a",
		[
			"node",
			"--input-type=module",
			"-e",
			"import { mkdirSync, writeFileSync } from 'node:fs'; mkdirSync('/tmp/viewer-static', { recursive: true }); writeFileSync('/tmp/viewer-static/index.html', '<!doctype html><title>e2e</title>');",
		],
		"07-viewer-static",
		30_000,
	);
	assertStatus(staticResult.status, 0, "viewer static preparation failed");
	const result = ctx.compose.execDetached(
		"peer-a",
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
		"08-start-viewer",
	);
	assertStatus(result.status, 0, "viewer server failed to start");
}

async function request<T>(
	ctx: ScenarioContext,
	method: "GET" | "POST" | "PUT",
	path: string,
	artifact: string,
	body?: Record<string, unknown>,
): Promise<{ status: number; body: T }> {
	const init =
		method === "GET"
			? {}
			: {
					method,
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body ?? {}),
				};
	const script = `const response = await fetch(${JSON.stringify(`http://127.0.0.1:38888${path}`)}, ${JSON.stringify(init)}); const text = await response.text(); console.log(JSON.stringify({ status: response.status, body: text ? JSON.parse(text) : null }));`;
	const result = ctx.compose.exec(
		"peer-a",
		["node", "--input-type=module", "-e", script],
		artifact,
		60_000,
	);
	assertStatus(result.status, 0, `viewer request ${method} ${path} failed`);
	return parseJson<{ status: number; body: T }>(result.stdout, artifact);
}

async function requestAndDropResponse(
	ctx: ScenarioContext,
	path: string,
	body: Record<string, unknown>,
	artifact: string,
): Promise<number> {
	const script = `const response = await fetch(${JSON.stringify(`http://127.0.0.1:38888${path}`)}, ${JSON.stringify({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })}); await response.body?.cancel(); console.log(JSON.stringify({ status: response.status }));`;
	const result = ctx.compose.exec(
		"peer-a",
		["node", "--input-type=module", "-e", script],
		artifact,
		60_000,
	);
	assertStatus(result.status, 0, "lost-response finish request failed");
	return parseJson<{ status: number }>(result.stdout, artifact).status;
}

function candidatePath(candidateRef: string): string {
	return `${API}/${encodeURIComponent(candidateRef)}`;
}

function finishBody(detail: TeamDetail): Record<string, unknown> {
	assert(detail.canFinish, `${detail.candidate.displayName} is not ready to finish`);
	assert(detail.finishDigest, "finish digest missing");
	assert(detail.accessDeltaDigest, "access delta digest missing");
	assert(detail.viewerAccessDeltaDigest, "viewer access delta digest missing");
	return {
		attemptId: detail.attemptId,
		finishDigest: detail.finishDigest,
		confirmedAccessDeltaDigest: detail.accessDeltaDigest,
		confirmedViewerAccessDeltaDigest: detail.viewerAccessDeltaDigest,
	};
}

function identityRef(detail: TeamDetail, displayName: string): string {
	const identity = detail.identityChoices.find((choice) => choice.displayName === displayName);
	assert(identity, `identity choice '${displayName}' missing`);
	return identity.identityRef;
}

async function assignDevice(
	ctx: ScenarioContext,
	detail: TeamDetail,
	displayName: string,
	identityDisplayName: string,
	decision: "included" | "excluded",
	artifact: string,
): Promise<void> {
	const device = detail.devices.find((item) => item.displayName === displayName);
	assert(device, `device '${displayName}' missing`);
	const targetIdentityRef = identityRef(detail, identityDisplayName);
	if (device.targetIdentityRef !== targetIdentityRef) {
		const assignment = await request<Record<string, unknown>>(
			ctx,
			"PUT",
			`${candidatePath(detail.candidate.candidateRef)}/devices/${encodeURIComponent(device.deviceRef)}/assignment`,
			`${artifact}-assignment`,
			{ attemptId: detail.attemptId, expectation: device.expectation, targetIdentityRef },
		);
		assert(assignment.status === 200, `assignment failed for ${displayName}`);
	}
	const decisionResult = await request<Record<string, unknown>>(
		ctx,
		"PUT",
		`${candidatePath(detail.candidate.candidateRef)}/devices/${encodeURIComponent(device.deviceRef)}/decision`,
		`${artifact}-decision`,
		{
			attemptId: detail.attemptId,
			decision,
			...(decision === "included" ? { expectedTargetIdentityRef: targetIdentityRef } : {}),
		},
	);
	assert(decisionResult.status === 200, `decision failed for ${displayName}`);
}

async function mapUnresolvedProjects(
	ctx: ScenarioContext,
	detail: TeamDetail,
	artifact: string,
): Promise<void> {
	for (const project of detail.projects.filter((item) => item.resolution === "unresolved")) {
		const target = project.mappingChoices.find((choice) =>
			choice.displayName.toLowerCase().includes("web-canonical"),
		);
		assert(target, `explicit mapping choice missing for ${project.displayName}`);
		const response = await request<Record<string, unknown>>(
			ctx,
			"PUT",
			`${candidatePath(detail.candidate.candidateRef)}/projects/${encodeURIComponent(project.projectRef)}/mapping`,
			`${artifact}-${project.displayName}`,
			{ attemptId: detail.attemptId, resolvedProjectRef: target.resolvedProjectRef },
		);
		assert(response.status === 200, `Project mapping failed for ${project.displayName}`);
	}
}

async function loadDetail(
	ctx: ScenarioContext,
	candidateRef: string,
	artifact: string,
): Promise<TeamDetail> {
	const response = await request<TeamDetail>(ctx, "GET", candidatePath(candidateRef), artifact);
	assert(response.status === 200, `candidate detail failed for ${candidateRef}`);
	return response.body;
}

function assertNoPolicyWrites(summary: FixtureSummary, message: string): void {
	assert(summary.policies.teams.length === 0, `${message}: Team was written`);
	assert(summary.policies.memberships.length === 0, `${message}: membership was written`);
	assert(summary.policies.decisions.length === 0, `${message}: device decision was written`);
	assert(summary.policies.recipients.length === 0, `${message}: Project recipient was written`);
	assert(summary.policies.reviewedMappings.length === 0, `${message}: Project repair was written`);
}

function assertExactRows<T>(actual: T[], expected: T[], message: string): void {
	const normalize = (rows: T[]) =>
		rows
			.map((row) => {
				if (row === null || typeof row !== "object") return JSON.stringify(row);
				const record = row as Record<string, unknown>;
				return JSON.stringify(
					Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]])),
				);
			})
			.sort();
	const normalizedActual = normalize(actual);
	const normalizedExpected = normalize(expected);
	assert(
		JSON.stringify(normalizedActual) === JSON.stringify(normalizedExpected),
		`${message}; actual=${JSON.stringify(normalizedActual)} expected=${JSON.stringify(normalizedExpected)}`,
	);
}

export async function runLegacyTeamMigrationScenario(ctx: ScenarioContext): Promise<void> {
	ctx.recordNote(
		"scenario.txt",
		"Legacy Team migration: review two overlapping coordinator groups through the real viewer API; prove explicit mapping, stale and conflicting evidence rejection, atomic activation, reviewed device eligibility, and immutable retry.",
	);
	ctx.compose.down("00-compose-down-pre", true);
	ctx.compose.up(["coordinator", "peer-a"], "01-compose-up");
	seedPeer(ctx.compose, ctx.artifactsDir, "peer-a", "empty", "02-seed-empty");
	const seeded = fixture(ctx, "seed", "03-seed-legacy-team-fixture");
	createCoordinatorRoster(ctx, seeded.roster);
	writePeerConfig(
		ctx,
		"peer-a",
		{
			sync_coordinator_url: "http://coordinator:7347",
			sync_coordinator_admin_secret: ADMIN_SECRET,
			sync_coordinator_groups: [GROUP_ALPHA, GROUP_BETA],
			sync_coordinator_timeout_s: 10,
		},
		"07-write-config",
	);
	startServer(ctx);
	await waitFor(
		async () => {
			const response = await request<Record<string, unknown>>(
				ctx,
				"GET",
				"/api/stats",
				"09-wait-viewer",
			);
			assert(response.status === 200, "viewer is not ready");
		},
		{ description: "legacy Team viewer readiness", timeoutMs: 120_000, intervalMs: 2_000 },
	);

	// Arrange: discovery persists two drafts, but setup has not changed access policy.
	const summaryResponse = await request<{ version: 1; candidates: CandidateSummary[] }>(
		ctx,
		"GET",
		API,
		"10-candidate-summary",
	);
	assert(summaryResponse.status === 200, "legacy Team summary failed");
	assert(summaryResponse.body.candidates.length === 2, "expected exactly two legacy Team candidates");
	const alphaCandidate = summaryResponse.body.candidates.find(
		(item) => item.displayName === "Legacy Alpha",
	);
	const betaCandidate = summaryResponse.body.candidates.find(
		(item) => item.displayName === "Legacy Beta",
	);
	assert(alphaCandidate && betaCandidate, "expected Legacy Alpha and Legacy Beta candidates");
	let alpha = await loadDetail(ctx, alphaCandidate.candidateRef, "11-alpha-unresolved-detail");
	const betaInitial = await loadDetail(ctx, betaCandidate.candidateRef, "12-beta-initial-detail");
	assert(
		alpha.unresolvedProjectCount === 1 && !alpha.canFinish,
		"explicit Project mapping did not block finish",
	);
	assert(
		alpha.devices.length === 2 && betaInitial.devices.length === 3,
		"overlapping rosters were not bounded as expected",
	);
	const before = fixture(ctx, "summary", "13-before-review-summary");
	assertNoPolicyWrites(before, "candidate discovery");
	assert(
		JSON.stringify(before.legacyScopeMemberships) === JSON.stringify(seeded.legacyScopeMemberships),
		"candidate discovery changed legacy scope access",
	);

	// Act: resolve Alpha through viewer mutations, excluding Optional Device only from Alpha.
	await assignDevice(ctx, alpha, "Shared Device", "Shared Person", "included", "14-alpha-shared");
	await assignDevice(ctx, alpha, "Optional Device", "Optional Person", "excluded", "15-alpha-optional");
	await mapUnresolvedProjects(ctx, alpha, "16-alpha-map");
	alpha = await loadDetail(ctx, alphaCandidate.candidateRef, "17-alpha-ready-detail");
	assert(alpha.canFinish && alpha.unresolvedProjectCount === 0, "Alpha did not become finishable");
	assert((alpha.accessDelta?.teamChanges.length ?? 0) === 1, "Alpha preview omitted the Team change");
	assert((alpha.accessDelta?.recipientChanges.length ?? 0) === 2, "Alpha preview omitted Project recipients");

	// Negative: mutate the reviewed decision and submit the old evidence. The stale finish writes nothing.
	await assignDevice(ctx, alpha, "Shared Device", "Shared Person", "excluded", "18-stale-alpha-shared");
	const staleFinish = await request<{ error: string }>(
		ctx,
		"POST",
		`${candidatePath(alphaCandidate.candidateRef)}/finish`,
		"19-reject-stale-alpha-finish",
		finishBody(alpha),
	);
	assert(
		staleFinish.status === 409 && staleFinish.body.error === "team_setup_confirmation_stale",
		"stale confirmation evidence did not fail closed",
	);
	const afterStale = fixture(ctx, "summary", "20-after-stale-summary");
	assertNoPolicyWrites(afterStale, "stale finish");
	assert(
		JSON.stringify(afterStale.policies.devices) === JSON.stringify(before.policies.devices),
		"stale finish wrote a canonical device assignment",
	);
	assert(
		JSON.stringify(afterStale.legacyScopeMemberships) === JSON.stringify(before.legacyScopeMemberships),
		"stale finish changed legacy access",
	);

	// Positive: reconfirm the current exact delta and atomically activate Alpha.
	alpha = await loadDetail(ctx, alphaCandidate.candidateRef, "21-alpha-current-detail");
	await assignDevice(ctx, alpha, "Shared Device", "Shared Person", "included", "22-alpha-reinclude-shared");
	alpha = await loadDetail(ctx, alphaCandidate.candidateRef, "23-alpha-reconfirmed-detail");
	const alphaFinish = await request<FinishResponse>(
		ctx,
		"POST",
		`${candidatePath(alphaCandidate.candidateRef)}/finish`,
		"24-finish-alpha",
		finishBody(alpha),
	);
	assert(
		alphaFinish.status === 200 && alphaFinish.body.status === "completed",
		"Alpha finish failed",
	);
	const afterAlpha = fixture(ctx, "summary", "25-after-alpha-summary");
	assert(afterAlpha.policies.teams.length === 1, "Alpha finish was not atomic");
	assert(afterAlpha.policies.memberships.length === 1, "Alpha memberships were incomplete");
	assert(afterAlpha.policies.recipients.length === 2, "Alpha Project recipients were incomplete");
	assertExactRows(
		afterAlpha.policies.devices,
		[
			{
				device_id: seeded.roster.shared.deviceId,
				identity_id: "identity-shared",
				status: "active",
				assignment_version: 0,
			},
		],
		"Alpha finish assigned a device outside its reviewed inclusion",
	);
	assert(
		afterAlpha.policies.reviewedMappings.length === 1,
		"explicit Project repair was not committed with Alpha",
	);

	// Arrange: refresh Beta after Alpha so the included shared assignment is verified and reusable.
	const refreshed = await request<Record<string, unknown>>(
		ctx,
		"POST",
		`${candidatePath(betaCandidate.candidateRef)}/refresh`,
		"26-refresh-beta-after-alpha",
		{},
	);
	assert(refreshed.status === 200, "Beta refresh failed");
	let beta = await loadDetail(ctx, betaCandidate.candidateRef, "27-beta-reused-assignments");
	const sharedDevice = beta.devices.find((item) => item.displayName === "Shared Device");
	assert(
		typeof sharedDevice?.existingIdentityRef === "string",
		"Shared Device did not report a reusable existing assignment",
	);
	assert(
		sharedDevice?.verifiedEvidenceKind === "active_assignment" &&
			sharedDevice.existingIdentityRef !== null &&
			sharedDevice.suggestedIdentityRef === sharedDevice.existingIdentityRef &&
			sharedDevice.expectation.kind === "existing",
		"Shared Device assignment was not reused across Team drafts",
	);
	await assignDevice(ctx, beta, "Shared Device", "Shared Person", "included", "28-beta-shared");
	await assignDevice(ctx, beta, "Optional Device", "Optional Person", "included", "29-beta-optional");
	await assignDevice(ctx, beta, "Beta Device", "Beta Person", "included", "30-beta-only");
	beta = await loadDetail(ctx, betaCandidate.candidateRef, "31-beta-ready-detail");
	assert(beta.canFinish, "Beta did not become finishable");

	// Negative: an external assignment appearing after review rejects the whole Beta transaction.
	fixture(ctx, "conflict-beta-assignment", "32-conflict-beta-assignment");
	const conflictFinish = await request<{ error: string }>(
		ctx,
		"POST",
		`${candidatePath(betaCandidate.candidateRef)}/finish`,
		"33-reject-beta-assignment-conflict",
		finishBody(beta),
	);
	assert(
		conflictFinish.status === 409 && conflictFinish.body.error === "team_setup_assignment_changed",
		"reassignment conflict did not fail closed",
	);
	const afterConflict = fixture(ctx, "summary", "34-after-conflict-summary");
	assertExactRows(
		afterConflict.policies.teams,
		afterAlpha.policies.teams,
		"conflicting Beta finish changed Teams",
	);
	assertExactRows(
		afterConflict.policies.memberships,
		afterAlpha.policies.memberships,
		"conflicting Beta finish changed memberships",
	);
	assertExactRows(
		afterConflict.policies.decisions,
		afterAlpha.policies.decisions,
		"conflicting Beta finish changed device decisions",
	);
	assertExactRows(
		afterConflict.policies.recipients,
		afterAlpha.policies.recipients,
		"conflicting Beta finish changed Project recipients",
	);
	assertExactRows(
		afterConflict.policies.reviewedMappings,
		afterAlpha.policies.reviewedMappings,
		"conflicting Beta finish changed reviewed mappings",
	);
	assertExactRows(
		afterConflict.policies.devices,
		[
			...afterAlpha.policies.devices,
			{
				device_id: afterConflict.roster.beta.deviceId,
				identity_id: "identity-conflict",
				status: "active",
				assignment_version: 1,
			},
		],
		"conflicting Beta finish changed canonical device assignments beyond the injected conflict",
	);
	assertExactRows(
		afterConflict.effective,
		afterAlpha.effective,
		"conflicting Beta finish changed effective Project access",
	);
	assertExactRows(
		afterConflict.completions,
		afterAlpha.completions,
		"conflicting Beta finish changed completion records",
	);
	assertExactRows(
		afterConflict.legacyScopeMemberships,
		afterAlpha.legacyScopeMemberships,
		"conflicting Beta finish changed legacy scope access",
	);

	// Positive: refresh, explicitly repair the changed assignment, then simulate a lost finish response.
	const refreshedAfterConflict = await request<Record<string, unknown>>(
		ctx,
		"POST",
		`${candidatePath(betaCandidate.candidateRef)}/refresh`,
		"35-refresh-beta-after-conflict",
		{},
	);
	assert(refreshedAfterConflict.status === 200, "Beta conflict refresh failed");
	beta = await loadDetail(ctx, betaCandidate.candidateRef, "36-beta-conflict-detail");
	await assignDevice(ctx, beta, "Shared Device", "Shared Person", "included", "37-beta-shared-current");
	await assignDevice(ctx, beta, "Optional Device", "Optional Person", "included", "38-beta-optional-current");
	await assignDevice(ctx, beta, "Beta Device", "Beta Person", "included", "39-beta-reassign");
	beta = await loadDetail(ctx, betaCandidate.candidateRef, "40-beta-final-detail");
	const betaFinishBody = finishBody(beta);
	const lostStatus = await requestAndDropResponse(
		ctx,
		`${candidatePath(betaCandidate.candidateRef)}/finish`,
		betaFinishBody,
		"41-finish-beta-drop-response",
	);
	assert(lostStatus === 200, "Beta finish did not complete before the response was dropped");
	const recoveredSummary = await request<{ version: 1; candidates: CandidateSummary[] }>(
		ctx,
		"GET",
		API,
		"42-summary-after-lost-beta-finish",
	);
	const recoveredBetaSummary = recoveredSummary.body.candidates.find(
		(candidate) => candidate.candidateRef === betaCandidate.candidateRef,
	);
	assert(
		recoveredSummary.status === 200 && recoveredBetaSummary?.status === "ready",
		"summary did not recover Beta as ready after the dropped finish response",
	);
	const recoveredBetaDetail = await loadDetail(
		ctx,
		betaCandidate.candidateRef,
		"43-detail-after-lost-beta-finish",
	);
	assert(
		recoveredBetaDetail.candidate.status === "ready" &&
			recoveredBetaDetail.draftState === "completed" &&
			!recoveredBetaDetail.canFinish,
		"detail did not recover Beta as completed after the dropped finish response",
	);
	const afterLostResponse = fixture(ctx, "summary", "44-after-lost-beta-finish");
	const storedBetaCompletion = afterLostResponse.completions.find(
		(completion) => completion.candidate_ref === betaCandidate.candidateRef,
	);
	assert(storedBetaCompletion, "lost Beta finish did not persist a completion");
	const storedBetaResponse = JSON.parse(
		storedBetaCompletion.response_json,
	) as StoredCompletionResponse;
	const expectedBetaResponse: FinishResponse = {
		version: 1,
		status: storedBetaResponse.status,
		teamRef: recipientPolicyDigest("legacy-team-viewer-team-ref-v1", [
			betaCandidate.candidateRef,
			storedBetaResponse.teamId,
		]),
		attemptId: storedBetaResponse.attemptId,
		accessDeltaDigest: storedBetaResponse.accessDeltaDigest,
		completedAt: storedBetaResponse.completedAt,
	};
	const retryOne = await request<FinishResponse>(
		ctx,
		"POST",
		`${candidatePath(betaCandidate.candidateRef)}/finish`,
		"45-retry-beta-finish-one",
		betaFinishBody,
	);
	const retryTwo = await request<FinishResponse>(
		ctx,
		"POST",
		`${candidatePath(betaCandidate.candidateRef)}/finish`,
		"46-retry-beta-finish-two",
		betaFinishBody,
	);
	assert(retryOne.status === 200 && retryTwo.status === 200, "completed Beta retry failed");
	assertExactRows(
		[retryOne.body, retryTwo.body],
		[expectedBetaResponse, expectedBetaResponse],
		"completed retry did not return the committed result",
	);
	assert(
		JSON.stringify(retryOne.body) === JSON.stringify(retryTwo.body),
		"completed retry result was mutable",
	);

	// Arrange: a later active device assigned to a reviewed person was never part of either roster.
	fixture(ctx, "add-off-roster-device", "47-add-off-roster-device");

	// Assert: both Teams are exact reviewed allowlists; Optional differs by Team; off-roster stays out.
	const final = fixture(ctx, "summary", "48-final-summary");
	assertExactRows(
		final.policies.devices.filter((device) => device.device_id === final.offRosterDeviceId),
		[
			{
				device_id: final.offRosterDeviceId,
				identity_id: "identity-shared",
				status: "active",
				assignment_version: 1,
			},
		],
		"off-roster device fixture was not inserted exactly",
	);
	const alphaTeam = final.policies.teams.find((team) => team.display_name === "Legacy Alpha");
	const betaTeam = final.policies.teams.find((team) => team.display_name === "Legacy Beta");
	assert(alphaTeam && betaTeam, "both canonical Teams were not activated");
	assertExactRows(
		final.policies.teams,
		[
			{
				team_id: alphaTeam.team_id,
				display_name: "Legacy Alpha",
				status: "active",
				device_eligibility_mode: "reviewed_allowlist",
			},
			{
				team_id: betaTeam.team_id,
				display_name: "Legacy Beta",
				status: "active",
				device_eligibility_mode: "reviewed_allowlist",
			},
		],
		"canonical Team policy rows were not exact",
	);
	assertExactRows(
		final.policies.memberships,
		[
			{ team_id: alphaTeam.team_id, identity_id: "identity-shared", status: "reviewed_active" },
			{ team_id: betaTeam.team_id, identity_id: "identity-beta", status: "reviewed_active" },
			{ team_id: betaTeam.team_id, identity_id: "identity-optional", status: "reviewed_active" },
			{ team_id: betaTeam.team_id, identity_id: "identity-shared", status: "reviewed_active" },
		],
		"canonical Team memberships were not exact",
	);
	assertExactRows(
		final.policies.decisions,
		[
			{
				team_id: alphaTeam.team_id,
				device_id: seeded.roster.optional.deviceId,
				decision: "excluded",
				assignment_version: 0,
			},
			{
				team_id: alphaTeam.team_id,
				device_id: seeded.roster.shared.deviceId,
				decision: "included",
				assignment_version: 0,
			},
			{
				team_id: betaTeam.team_id,
				device_id: seeded.roster.beta.deviceId,
				decision: "included",
				assignment_version: 2,
			},
			{
				team_id: betaTeam.team_id,
				device_id: seeded.roster.optional.deviceId,
				decision: "included",
				assignment_version: 0,
			},
			{
				team_id: betaTeam.team_id,
				device_id: seeded.roster.shared.deviceId,
				decision: "included",
				assignment_version: 0,
			},
		],
		"reviewed Team device decisions were not exact",
	);
	assertExactRows(
		final.policies.recipients,
		[
			{
				canonical_project_identity: ALPHA_PROJECT,
				recipient_kind: "team",
				recipient_id: alphaTeam.team_id,
				status: "active",
			},
			{
				canonical_project_identity: BETA_PROJECT,
				recipient_kind: "team",
				recipient_id: betaTeam.team_id,
				status: "active",
			},
			{
				canonical_project_identity: WEB_PROJECT,
				recipient_kind: "team",
				recipient_id: alphaTeam.team_id,
				status: "active",
			},
		],
		"canonical Project recipients were not exact",
	);
	assert(final.policies.reviewedMappings.length === 1, "reviewed Project mappings were not exact");
	const reviewedMapping = final.policies.reviewedMappings[0];
	assert(
		reviewedMapping?.workspace_identity === WEB_PROJECT &&
			reviewedMapping.scope_id === "scope-legacy-alpha" &&
			reviewedMapping.project_pattern === LEGACY_WEB_SOURCE_PROJECT,
		"the explicit legacy-web Project repair was not exact",
	);
	assertExactRows(
		final.effective.map((project) => project.canonicalProjectIdentity),
		[ALPHA_PROJECT, BETA_PROJECT, WEB_PROJECT],
		"effective policy was not derived for the exact canonical Projects",
	);
	const expectedEffectiveDevices = new Map<
		string,
		Array<{ deviceId: string; identityId: string }>
	>([
		[ALPHA_PROJECT, [{ deviceId: seeded.roster.shared.deviceId, identityId: "identity-shared" }]],
		[
			BETA_PROJECT,
			[
				{ deviceId: seeded.roster.beta.deviceId, identityId: "identity-beta" },
				{ deviceId: seeded.roster.optional.deviceId, identityId: "identity-optional" },
				{ deviceId: seeded.roster.shared.deviceId, identityId: "identity-shared" },
			],
		],
		[WEB_PROJECT, [{ deviceId: seeded.roster.shared.deviceId, identityId: "identity-shared" }]],
	]);
	for (const project of final.effective) {
		assert(project.status === "eligible", `${project.canonicalProjectIdentity} was not eligible`);
		assertExactRows(
			project.devices.map(({ deviceId, identityId }) => ({ deviceId, identityId })),
			expectedEffectiveDevices.get(project.canonicalProjectIdentity) ?? [],
			`${project.canonicalProjectIdentity} effective devices were not exact`,
		);
	}
	assert(
		final.effective.every(
			(project) =>
				!project.devices.some((device) => device.deviceId === final.offRosterDeviceId),
		),
		"off-roster active device became eligible",
	);
	assert(final.completions.length === 2, "expected one immutable completion per Team");
	assert(
		JSON.stringify(final.legacyScopeMemberships) === JSON.stringify(before.legacyScopeMemberships),
		"guided setup changed legacy scope access",
	);

	ctx.compose.copyFromContainer(
		"peer-a:/data/mem.sqlite",
		`${ctx.artifactsDir}/db/peer-a-legacy-team-migration.sqlite`,
		"49-copy-peer-db",
	);
	ctx.compose.copyFromContainer(
		"coordinator:/data/coordinator.sqlite",
		`${ctx.artifactsDir}/db/coordinator-legacy-team-migration.sqlite`,
		"50-copy-coordinator-db",
	);
	if (!ctx.keepStackOnFailure) ctx.compose.down("51-compose-down-post");
}
