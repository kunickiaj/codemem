import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import { normalizeIdentityDisplayName } from "./project-invite-identity.js";
import {
	normalizeRecipientReviewedIntent,
	type RecipientReviewedIntentV1,
} from "./recipient-reviewed-intent.js";
import { canonicalWorkspaceIdentity } from "./scope-resolution.js";
import { SYNC_BOOTSTRAP_CWD_PREFIX } from "./sync-bootstrap.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

export type RecipientPolicyOnboardingJourneyV1 = "team" | "direct_project" | "add_device";

export interface RecipientPolicyOnboardingBindingV1 {
	invitationId: string;
	identityId: string;
	deviceId: string;
	deviceKeyFingerprint: string;
	deviceDisplayName: string;
}

interface RecipientPolicyOnboardingRequestBaseV1 {
	version: 1;
	invitationId: string;
	identityId: string;
	deviceId: string;
	devicePublicKey: string;
	deviceDisplayName: string;
}

export interface RecipientPolicyTeamOnboardingRequestV1
	extends RecipientPolicyOnboardingRequestBaseV1 {
	journey: "team";
	teamId: string;
}

export interface RecipientPolicyDirectProjectOnboardingRequestV1
	extends RecipientPolicyOnboardingRequestBaseV1 {
	journey: "direct_project";
	canonicalProjectIdentities: string[];
}

export interface RecipientPolicyAddDeviceOnboardingRequestV1
	extends RecipientPolicyOnboardingRequestBaseV1 {
	journey: "add_device";
}

export type RecipientPolicyOnboardingPreviewRequestV1 =
	| RecipientPolicyTeamOnboardingRequestV1
	| RecipientPolicyDirectProjectOnboardingRequestV1
	| RecipientPolicyAddDeviceOnboardingRequestV1;

export type RecipientPolicyOnboardingCommitRequestV1 = RecipientPolicyOnboardingPreviewRequestV1 & {
	reviewedOnboardingDigest: string;
};

export type RecipientPolicyReviewedIntentPreviewRequestV1 =
	| RecipientPolicyTeamOnboardingRequestV1
	| RecipientPolicyAddDeviceOnboardingRequestV1;

export type RecipientPolicyReviewedIntentCommitRequestV1 =
	RecipientPolicyReviewedIntentPreviewRequestV1 & {
		identityDisplayName: string;
		reviewedIntent: RecipientReviewedIntentV1;
		reviewedOnboardingDigest: string;
	};

export type RecipientPolicyOnboardingProjectSourceV1 =
	| { kind: "direct" }
	| { kind: "team"; teamId: string; displayName: string };

export interface RecipientPolicyOnboardingProjectV1 {
	canonicalProjectIdentity: string;
	displayName: string;
	existingMemoryCount: number;
	futureMemoriesShared: true;
	sources: RecipientPolicyOnboardingProjectSourceV1[];
}

export interface RecipientPolicyOnboardingExcludedProjectV1 {
	canonicalProjectIdentity: string;
	displayName: string;
	existingMemoryCount: number;
}

export interface RecipientPolicyOnboardingPreviewV1 {
	version: 1;
	journey: RecipientPolicyOnboardingJourneyV1;
	binding: RecipientPolicyOnboardingBindingV1;
	team: { teamId: string; displayName: string; futureProjectsInherit: true } | null;
	projects: RecipientPolicyOnboardingProjectV1[];
	excludedProjects: RecipientPolicyOnboardingExcludedProjectV1[];
	reviewedOnboardingDigest: string;
}

export interface RecipientPolicyOnboardingCommitResultV1 {
	version: 1;
	status: "applied" | "stale" | "invalid" | "not_found" | "conflict";
	journey: RecipientPolicyOnboardingJourneyV1 | null;
	reviewedOnboardingDigest: string;
	errorCode: string | null;
	writeCount: number;
	idempotent: boolean;
}

export interface DirectProjectSharePolicyCommitInput {
	operationId: string;
	inviterIdentityId: string;
	inviterDevices: Array<{ deviceId: string; displayName: string }>;
	recipientIdentityId: string;
	recipientDeviceId: string;
	recipientDevicePublicKey: string;
	recipientDeviceDisplayName: string;
	canonicalProjectIdentities: string[];
	now: string;
}

export class RecipientPolicyOnboardingRequestError extends Error {
	readonly status: "invalid" | "not_found";
	readonly errorCode: string;

	constructor(status: "invalid" | "not_found", errorCode: string) {
		super(errorCode);
		this.name = "RecipientPolicyOnboardingRequestError";
		this.status = status;
		this.errorCode = errorCode;
	}
}

interface NormalizedRequestBase {
	version: 1;
	journey: RecipientPolicyOnboardingJourneyV1;
	binding: RecipientPolicyOnboardingBindingV1;
}

type NormalizedRequest =
	| (NormalizedRequestBase & { journey: "team"; teamId: string })
	| (NormalizedRequestBase & {
			journey: "direct_project";
			canonicalProjectIdentities: string[];
	  })
	| (NormalizedRequestBase & { journey: "add_device" });

interface ProjectFact {
	canonicalProjectIdentity: string;
	displayName: string;
	existingMemoryCount: number;
}

interface IntentRow {
	table: "policy_team_memberships" | "identity_devices" | "project_recipients";
	key: Record<string, string>;
	values: Record<string, string | null>;
}

const CONTROL_CHARACTER = /\p{Cc}/u;

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.toSorted(([left], [right]) => compareText(left, right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function digest(prefix: string, value: unknown): string {
	return `${prefix}:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function strictId(value: unknown, field: string, maxLength = 512): string {
	if (
		typeof value !== "string" ||
		!value ||
		value !== value.trim() ||
		value.length > maxLength ||
		CONTROL_CHARACTER.test(value)
	) {
		throw new RecipientPolicyOnboardingRequestError("invalid", `${field}_invalid`);
	}
	return value;
}

function normalizeRequest(request: RecipientPolicyOnboardingPreviewRequestV1): NormalizedRequest {
	if (request?.version !== 1) {
		throw new RecipientPolicyOnboardingRequestError("invalid", "request_invalid");
	}
	const invitationId = strictId(request.invitationId, "invitation_id", 256);
	const identityId = strictId(request.identityId, "identity_id", 256);
	const deviceId = strictId(request.deviceId, "device_id", 256);
	const publicKey = String(request.devicePublicKey ?? "").trim();
	if (!publicKey || publicKey.length > 16_384) {
		throw new RecipientPolicyOnboardingRequestError("invalid", "device_public_key_invalid");
	}
	let deviceDisplayName: string;
	try {
		deviceDisplayName = normalizeIdentityDisplayName(
			String(request.deviceDisplayName ?? ""),
			"device_display_name",
		);
	} catch (error) {
		throw new RecipientPolicyOnboardingRequestError(
			"invalid",
			error instanceof Error ? error.message : "device_display_name_invalid",
		);
	}
	const binding = {
		invitationId,
		identityId,
		deviceId,
		deviceKeyFingerprint: fingerprintPublicKey(publicKey),
		deviceDisplayName,
	};
	if (request.journey === "team") {
		return {
			version: 1,
			journey: "team",
			binding,
			teamId: strictId(request.teamId, "team_id", 256),
		};
	}
	if (request.journey === "direct_project") {
		if (
			!Array.isArray(request.canonicalProjectIdentities) ||
			request.canonicalProjectIdentities.length < 1 ||
			request.canonicalProjectIdentities.length > 100
		) {
			throw new RecipientPolicyOnboardingRequestError("invalid", "project_set_invalid");
		}
		const projects = request.canonicalProjectIdentities.map((projectId) =>
			strictId(projectId, "canonical_project_identity"),
		);
		if (new Set(projects).size !== projects.length) {
			throw new RecipientPolicyOnboardingRequestError("invalid", "project_set_invalid");
		}
		return {
			version: 1,
			journey: "direct_project",
			binding,
			canonicalProjectIdentities: projects.toSorted(compareText),
		};
	}
	if (request.journey === "add_device") return { version: 1, journey: "add_device", binding };
	throw new RecipientPolicyOnboardingRequestError("invalid", "journey_invalid");
}

function projectFacts(db: Database): Map<string, ProjectFact> {
	const rows = db
		.prepare(
			`SELECT s.id, s.cwd, s.project, s.git_remote, s.git_branch,
			 (SELECT mi.workspace_id FROM memory_items mi
			  WHERE mi.session_id = s.id AND mi.workspace_id IS NOT NULL AND TRIM(mi.workspace_id) <> ''
			  ORDER BY mi.id DESC LIMIT 1) AS workspace_id,
			 COUNT(mi_count.id) AS memory_count
			 FROM sessions s
			 LEFT JOIN memory_items mi_count ON mi_count.session_id = s.id
			  AND mi_count.active = 1 AND mi_count.deleted_at IS NULL
			 WHERE (COALESCE(TRIM(s.git_remote), TRIM(s.cwd), TRIM(s.project), '') <> '' OR mi_count.id IS NOT NULL)
			  AND (s.cwd IS NULL OR substr(s.cwd, 1, length(?)) <> ?)
			 GROUP BY s.id ORDER BY s.id`,
		)
		.all(SYNC_BOOTSTRAP_CWD_PREFIX, SYNC_BOOTSTRAP_CWD_PREFIX) as Array<{
		cwd: string | null;
		project: string | null;
		git_remote: string | null;
		git_branch: string | null;
		workspace_id: string | null;
		memory_count: number;
	}>;
	const projects = new Map<string, ProjectFact>();
	for (const row of rows) {
		const identity = canonicalWorkspaceIdentity({
			cwd: row.cwd,
			project: row.project,
			gitRemote: row.git_remote,
			gitBranch: row.git_branch,
			workspaceId: row.workspace_id,
		});
		if (identity.value.startsWith("unmapped:")) continue;
		const existing = projects.get(identity.value);
		projects.set(identity.value, {
			canonicalProjectIdentity: identity.value,
			displayName: existing?.displayName ?? identity.displayProject ?? identity.value,
			existingMemoryCount: (existing?.existingMemoryCount ?? 0) + Number(row.memory_count ?? 0),
		});
	}
	const add = (projectId: unknown, displayName: unknown): void => {
		if (typeof projectId !== "string" || !projectId || projectId.startsWith("unmapped:")) return;
		if (projects.has(projectId)) return;
		projects.set(projectId, {
			canonicalProjectIdentity: projectId,
			displayName:
				typeof displayName === "string" && displayName.trim() ? displayName.trim() : projectId,
			existingMemoryCount: 0,
		});
	};
	for (const row of db
		.prepare(
			`SELECT canonical_project_identity, display_name
			 FROM share_operation_projects ORDER BY operation_id, ordinal`,
		)
		.all() as Array<Record<string, unknown>>) {
		add(row.canonical_project_identity, row.display_name);
	}
	for (const row of db
		.prepare(
			`SELECT canonical_project_identity FROM project_recipients
			 ORDER BY canonical_project_identity`,
		)
		.all() as Array<Record<string, unknown>>) {
		add(row.canonical_project_identity, row.canonical_project_identity);
	}
	return projects;
}

function assertActiveIdentity(db: Database, identityId: string): void {
	const row = db.prepare("SELECT status FROM actors WHERE actor_id = ?").get(identityId) as
		| { status: string }
		| undefined;
	if (row?.status !== "active") {
		throw new RecipientPolicyOnboardingRequestError("not_found", "identity_not_found");
	}
}

function assertActiveLocalIdentity(db: Database, identityId: string): void {
	const row = db
		.prepare("SELECT is_local, status FROM actors WHERE actor_id = ?")
		.get(identityId) as { is_local: number; status: string } | undefined;
	if (row?.status !== "active" || row.is_local !== 1) {
		throw new Error("inviter_identity_conflict");
	}
}

function sourceKey(source: RecipientPolicyOnboardingProjectSourceV1): string {
	return source.kind === "direct" ? "direct" : `team\u0000${source.teamId}`;
}

function addSource(
	sources: Map<string, RecipientPolicyOnboardingProjectSourceV1[]>,
	projectId: string,
	source: RecipientPolicyOnboardingProjectSourceV1,
): void {
	const current = sources.get(projectId) ?? [];
	if (!current.some((candidate) => sourceKey(candidate) === sourceKey(source)))
		current.push(source);
	sources.set(projectId, current);
}

function teamFact(db: Database, teamId: string): { teamId: string; displayName: string } {
	const row = db
		.prepare(
			"SELECT team_id, display_name FROM policy_teams WHERE team_id = ? AND status = 'active'",
		)
		.get(teamId) as { team_id: string; display_name: string } | undefined;
	if (!row) throw new RecipientPolicyOnboardingRequestError("not_found", "team_not_found");
	return { teamId: row.team_id, displayName: row.display_name };
}

function teamSources(
	db: Database,
	team: { teamId: string; displayName: string },
): Map<string, RecipientPolicyOnboardingProjectSourceV1[]> {
	const result = new Map<string, RecipientPolicyOnboardingProjectSourceV1[]>();
	for (const row of db
		.prepare(
			`SELECT canonical_project_identity FROM project_recipients
			 WHERE recipient_kind = 'team' AND recipient_id = ? AND status = 'active'
			 ORDER BY canonical_project_identity`,
		)
		.all(team.teamId) as Array<{ canonical_project_identity: string }>) {
		addSource(result, row.canonical_project_identity, {
			kind: "team",
			teamId: team.teamId,
			displayName: team.displayName,
		});
	}
	return result;
}

function inheritedSources(
	db: Database,
	identityId: string,
): Map<string, RecipientPolicyOnboardingProjectSourceV1[]> {
	const result = new Map<string, RecipientPolicyOnboardingProjectSourceV1[]>();
	for (const row of db
		.prepare(
			`SELECT canonical_project_identity FROM project_recipients
			 WHERE recipient_kind = 'identity' AND recipient_id = ? AND status = 'active'
			 ORDER BY canonical_project_identity`,
		)
		.all(identityId) as Array<{ canonical_project_identity: string }>) {
		addSource(result, row.canonical_project_identity, { kind: "direct" });
	}
	for (const row of db
		.prepare(
			`SELECT pr.canonical_project_identity, pt.team_id, pt.display_name
			 FROM policy_team_memberships tm
			 JOIN policy_teams pt ON pt.team_id = tm.team_id AND pt.status = 'active'
			 JOIN project_recipients pr ON pr.recipient_kind = 'team'
			  AND pr.recipient_id = tm.team_id AND pr.status = 'active'
			 WHERE tm.identity_id = ? AND tm.status = 'active'
			 ORDER BY pr.canonical_project_identity, pt.team_id`,
		)
		.all(identityId) as Array<{
		canonical_project_identity: string;
		team_id: string;
		display_name: string;
	}>) {
		addSource(result, row.canonical_project_identity, {
			kind: "team",
			teamId: row.team_id,
			displayName: row.display_name,
		});
	}
	return result;
}

function buildPreview(
	db: Database,
	request: NormalizedRequest,
): RecipientPolicyOnboardingPreviewV1 {
	assertActiveIdentity(db, request.binding.identityId);
	const facts = projectFacts(db);
	let team: RecipientPolicyOnboardingPreviewV1["team"] = null;
	let sources = new Map<string, RecipientPolicyOnboardingProjectSourceV1[]>();
	if (request.journey === "team") {
		const selectedTeam = teamFact(db, request.teamId);
		team = { ...selectedTeam, futureProjectsInherit: true };
		sources = teamSources(db, selectedTeam);
	}
	if (request.journey === "direct_project") {
		for (const projectId of request.canonicalProjectIdentities) {
			if (!facts.has(projectId)) {
				throw new RecipientPolicyOnboardingRequestError("not_found", "project_not_found");
			}
			addSource(sources, projectId, { kind: "direct" });
		}
	}
	if (request.journey === "add_device") {
		sources = inheritedSources(db, request.binding.identityId);
	}
	const projects = [...sources.entries()]
		.map(([projectId, projectSources]): RecipientPolicyOnboardingProjectV1 => {
			const fact = facts.get(projectId) ?? {
				canonicalProjectIdentity: projectId,
				displayName: projectId,
				existingMemoryCount: 0,
			};
			return {
				...fact,
				futureMemoriesShared: true,
				sources: projectSources.toSorted((left, right) =>
					compareText(sourceKey(left), sourceKey(right)),
				),
			};
		})
		.toSorted((left, right) =>
			compareText(left.canonicalProjectIdentity, right.canonicalProjectIdentity),
		);
	const excludedProjects = [...facts.values()]
		.filter((project) => !sources.has(project.canonicalProjectIdentity))
		.toSorted((left, right) =>
			compareText(left.canonicalProjectIdentity, right.canonicalProjectIdentity),
		);
	const reviewedOnboardingDigest = digest("recipient-onboarding-preview-v1", {
		journey: request.journey,
		binding: request.binding,
		team,
		projects,
		excludedProjectIdentities: excludedProjects.map((project) => project.canonicalProjectIdentity),
	});
	return {
		version: 1,
		journey: request.journey,
		binding: request.binding,
		team,
		projects,
		excludedProjects,
		reviewedOnboardingDigest,
	};
}

export function previewRecipientPolicyOnboarding(
	db: Database,
	request: RecipientPolicyOnboardingPreviewRequestV1,
): RecipientPolicyOnboardingPreviewV1 {
	return buildPreview(db, normalizeRequest(request));
}

function reviewedIntentTarget(request: NormalizedRequest) {
	if (request.journey === "team") {
		return { kind: "team_member" as const, policyTeamId: request.teamId };
	}
	if (request.journey === "add_device") {
		return { kind: "add_device" as const, targetIdentityId: request.binding.identityId };
	}
	throw new RecipientPolicyOnboardingRequestError("invalid", "journey_invalid");
}

function buildReviewedIntentPreview(
	request: NormalizedRequest,
	reviewedIntentValue: RecipientReviewedIntentV1,
): RecipientPolicyOnboardingPreviewV1 {
	const reviewedIntent = normalizeRecipientReviewedIntent(
		reviewedIntentValue,
		reviewedIntentTarget(request),
	);
	const team = reviewedIntent.journey === "team" ? reviewedIntent.team : null;
	const reviewedOnboardingDigest = digest("recipient-onboarding-preview-v1", {
		journey: request.journey,
		binding: request.binding,
		team,
		projects: reviewedIntent.projects,
		excludedProjectIdentities: reviewedIntent.excludedProjects.map(
			(project) => project.canonicalProjectIdentity,
		),
	});
	return {
		version: 1,
		journey: request.journey,
		binding: request.binding,
		team,
		projects: reviewedIntent.projects,
		excludedProjects: reviewedIntent.excludedProjects,
		reviewedOnboardingDigest,
	};
}

export function previewRecipientPolicyOnboardingFromReviewedIntent(
	reviewedIntent: RecipientReviewedIntentV1,
	request: RecipientPolicyReviewedIntentPreviewRequestV1,
): RecipientPolicyOnboardingPreviewV1 {
	return buildReviewedIntentPreview(normalizeRequest(request), reviewedIntent);
}

function relationshipMetadata(
	kind: string,
	revisionIdentity: unknown,
	idempotencyIdentity: unknown,
): { revision: string; idempotencyKey: string } {
	return {
		revision: digest(`recipient-policy-${kind}-revision-v1`, revisionIdentity),
		idempotencyKey: digest(`recipient-policy-${kind}-idempotency-v1`, idempotencyIdentity),
	};
}

function baseValues(input: {
	provenance: string;
	revision: string;
	idempotencyKey: string;
	sourceFingerprint: string;
	now: string;
}): Record<string, string> & { revision: string } {
	return {
		status: "active",
		provenance: input.provenance,
		migration_state: "user_managed",
		source_fingerprint: input.sourceFingerprint,
		idempotency_key: input.idempotencyKey,
		created_at: input.now,
		updated_at: input.now,
		revision: input.revision,
	};
}

function deviceRow(request: NormalizedRequest, now: string): IntentRow {
	const stableBinding = {
		identityId: request.binding.identityId,
		deviceId: request.binding.deviceId,
		deviceKeyFingerprint: request.binding.deviceKeyFingerprint,
	};
	const sourceFingerprint = digest("recipient-onboarding-binding-v1", stableBinding);
	const metadata = relationshipMetadata("identity-device", stableBinding, [
		request.binding.invitationId,
		"device",
	]);
	return {
		table: "identity_devices",
		key: { device_id: request.binding.deviceId },
		values: {
			identity_id: request.binding.identityId,
			display_name: request.binding.deviceDisplayName,
			...baseValues({
				provenance: "recipient_invite",
				revision: metadata.revision,
				idempotencyKey: metadata.idempotencyKey,
				sourceFingerprint,
				now,
			}),
		},
	};
}

function membershipRow(request: NormalizedRequest & { journey: "team" }, now: string): IntentRow {
	const identity = [request.journey, request.binding, request.teamId];
	const metadata = relationshipMetadata("team-membership", identity, [
		request.journey,
		request.binding.invitationId,
		"membership",
	]);
	return {
		table: "policy_team_memberships",
		key: { team_id: request.teamId, identity_id: request.binding.identityId },
		values: {
			role: "member",
			...baseValues({
				provenance: "team_invite",
				revision: metadata.revision,
				idempotencyKey: metadata.idempotencyKey,
				sourceFingerprint: digest("recipient-onboarding-binding-v1", identity),
				now,
			}),
		},
	};
}

function projectRow(
	request: NormalizedRequest & { journey: "direct_project" },
	projectId: string,
	now: string,
): IntentRow {
	const identity = [request.journey, request.binding, projectId];
	const metadata = relationshipMetadata("project-recipient", identity, [
		request.journey,
		request.binding.invitationId,
		"project",
		projectId,
	]);
	const values = baseValues({
		provenance: "exact_project_invite",
		revision: metadata.revision,
		idempotencyKey: metadata.idempotencyKey,
		sourceFingerprint: digest("recipient-onboarding-binding-v1", identity),
		now,
	});
	const { revision, ...rest } = values;
	return {
		table: "project_recipients",
		key: {
			canonical_project_identity: projectId,
			recipient_kind: "identity",
			recipient_id: request.binding.identityId,
		},
		values: { ...rest, policy_revision: revision },
	};
}

function inviterDeviceRow(input: {
	identityId: string;
	deviceId: string;
	displayName: string;
	now: string;
}): IntentRow {
	const stableBinding = { identityId: input.identityId, deviceId: input.deviceId };
	const metadata = relationshipMetadata(
		"identity-device",
		["direct_project_inviter", stableBinding],
		["direct_project_inviter", stableBinding],
	);
	return {
		table: "identity_devices",
		key: { device_id: input.deviceId },
		values: {
			identity_id: input.identityId,
			display_name: input.displayName,
			...baseValues({
				provenance: "exact_project_invite",
				revision: metadata.revision,
				idempotencyKey: metadata.idempotencyKey,
				sourceFingerprint: digest("recipient-onboarding-inviter-device-v1", stableBinding),
				now: input.now,
			}),
		},
	};
}

function inviterProjectRow(input: {
	identityId: string;
	projectId: string;
	now: string;
}): IntentRow {
	const stableBinding = {
		canonicalProjectIdentity: input.projectId,
		recipientKind: "identity",
		recipientId: input.identityId,
	};
	const metadata = relationshipMetadata(
		"project-recipient",
		["direct_project_inviter", stableBinding],
		["direct_project_inviter", stableBinding],
	);
	const values = baseValues({
		provenance: "exact_project_invite",
		revision: metadata.revision,
		idempotencyKey: metadata.idempotencyKey,
		sourceFingerprint: digest("recipient-onboarding-inviter-project-v1", stableBinding),
		now: input.now,
	});
	const { revision, ...rest } = values;
	return {
		table: "project_recipients",
		key: {
			canonical_project_identity: input.projectId,
			recipient_kind: "identity",
			recipient_id: input.identityId,
		},
		values: { ...rest, policy_revision: revision },
	};
}

function planRows(request: NormalizedRequest, now: string): IntentRow[] {
	const rows = [deviceRow(request, now)];
	if (request.journey === "team") rows.push(membershipRow(request, now));
	if (request.journey === "direct_project") {
		rows.push(
			...request.canonicalProjectIdentities.map((projectId) => projectRow(request, projectId, now)),
		);
	}
	return rows;
}

function isPristineBootstrapIdentity(db: Database, identityId: string, deviceId: string): boolean {
	if (identityId !== `local:${deviceId}`) return false;
	const actor = db
		.prepare(
			`SELECT is_local, status, merged_into_actor_id
			 FROM actors WHERE actor_id = ?`,
		)
		.get(identityId) as
		| {
				is_local: number;
				status: string;
				merged_into_actor_id: string | null;
		  }
		| undefined;
	if (actor?.is_local !== 1 || actor.status !== "active" || actor.merged_into_actor_id !== null) {
		return false;
	}
	const references = [
		Number(
			db.prepare("SELECT COUNT(*) FROM memory_items WHERE actor_id = ?").pluck().get(identityId),
		),
		Number(
			db
				.prepare("SELECT COUNT(*) FROM identity_devices WHERE identity_id = ?")
				.pluck()
				.get(identityId),
		),
		Number(
			db
				.prepare("SELECT COUNT(*) FROM policy_team_memberships WHERE identity_id = ?")
				.pluck()
				.get(identityId),
		),
		Number(
			db
				.prepare(
					`SELECT COUNT(*) FROM project_recipients
					 WHERE recipient_kind = 'identity' AND recipient_id = ?`,
				)
				.pluck()
				.get(identityId),
		),
		Number(
			db
				.prepare(
					"SELECT COUNT(*) FROM recipient_policy_review_resolutions WHERE decided_by_identity_id = ?",
				)
				.pluck()
				.get(identityId),
		),
		Number(
			db
				.prepare("SELECT COUNT(*) FROM sync_peers WHERE actor_id = ? OR claimed_local_actor = 1")
				.pluck()
				.get(identityId),
		),
	];
	return references.every((count) => count === 0);
}

export function assertAddDeviceIdentityAdoptionAllowed(
	db: Database,
	targetIdentityId: string,
	deviceId: string,
): void {
	const targetId = strictId(targetIdentityId, "identity_id", 256);
	const localDeviceId = strictId(deviceId, "device_id", 256);
	const localIdentities = db
		.prepare(
			`SELECT actor_id FROM actors
			 WHERE is_local = 1 AND status = 'active' AND merged_into_actor_id IS NULL
			 ORDER BY actor_id`,
		)
		.pluck()
		.all() as string[];
	const target = db
		.prepare("SELECT is_local, status, merged_into_actor_id FROM actors WHERE actor_id = ?")
		.get(targetId) as
		| { is_local: number; status: string; merged_into_actor_id: string | null }
		| undefined;
	if (
		target &&
		(target.is_local !== 1 || target.status !== "active" || target.merged_into_actor_id)
	) {
		throw new Error("invite_identity_conflict");
	}
	for (const identityId of localIdentities) {
		if (identityId === targetId) continue;
		if (!isPristineBootstrapIdentity(db, identityId, localDeviceId)) {
			throw new Error("invite_identity_conflict");
		}
	}
}

function materializeLocalIdentity(
	db: Database,
	input: {
		identityId: string;
		displayName: string;
		deviceId: string;
		allowBootstrapAdoption: boolean;
	},
	now: string,
): boolean {
	if (input.allowBootstrapAdoption) {
		assertAddDeviceIdentityAdoptionAllowed(db, input.identityId, input.deviceId);
		db.prepare(
			`UPDATE actors SET is_local = 0, status = 'merged', merged_into_actor_id = ?, updated_at = ?
			 WHERE actor_id <> ? AND is_local = 1 AND status = 'active'`,
		).run(input.identityId, now, input.identityId);
	}
	const existing = db
		.prepare("SELECT is_local, status, merged_into_actor_id FROM actors WHERE actor_id = ?")
		.get(input.identityId) as
		| { is_local: number; status: string; merged_into_actor_id: string | null }
		| undefined;
	if (existing) {
		if (existing.is_local !== 1 || existing.status !== "active" || existing.merged_into_actor_id) {
			throw new Error("invite_identity_conflict");
		}
		return false;
	}
	db.prepare(
		`INSERT INTO actors(
		 actor_id, display_name, is_local, status, merged_into_actor_id, created_at, updated_at
		 ) VALUES (?, ?, 1, 'active', NULL, ?, ?)`,
	).run(input.identityId, input.displayName, now, now);
	return true;
}

function materializeReviewedTeam(
	db: Database,
	team: { teamId: string; displayName: string; futureProjectsInherit: true },
	now: string,
): boolean {
	const existing = db
		.prepare("SELECT display_name, status FROM policy_teams WHERE team_id = ?")
		.get(team.teamId) as { display_name: string; status: string } | undefined;
	if (existing) {
		if (existing.display_name !== team.displayName || existing.status !== "active") {
			throw new Error("intent_conflict");
		}
		return false;
	}
	const stableTeam = { teamId: team.teamId, displayName: team.displayName };
	const metadata = relationshipMetadata("team", stableTeam, stableTeam);
	db.prepare(
		`INSERT INTO policy_teams(
		 team_id, display_name, status, provenance, revision, migration_state,
		 source_fingerprint, idempotency_key, created_at, updated_at
		 ) VALUES (?, ?, 'active', 'team_invite', ?, 'user_managed', ?, ?, ?, ?)`,
	).run(
		team.teamId,
		team.displayName,
		metadata.revision,
		digest("recipient-onboarding-team-v1", stableTeam),
		metadata.idempotencyKey,
		now,
		now,
	);
	return true;
}

function rowWhere(key: Record<string, string>): { clause: string; parameters: string[] } {
	return {
		clause: Object.keys(key)
			.map((column) => `${column} = ?`)
			.join(" AND "),
		parameters: Object.values(key),
	};
}

function hasMatchingLocalDeviceKey(db: Database, expected: Record<string, string | null>): boolean {
	const publicKey = db
		.prepare("SELECT public_key FROM sync_device WHERE device_id = ?")
		.pluck()
		.get(expected.device_id);
	if (typeof publicKey !== "string" || !publicKey.trim()) return false;
	return (
		expected.source_fingerprint ===
		digest("recipient-onboarding-binding-v1", {
			identityId: expected.identity_id,
			deviceId: expected.device_id,
			deviceKeyFingerprint: fingerprintPublicKey(publicKey),
		})
	);
}

function transitionExactProjectDevice(
	db: Database,
	row: IntentRow,
	where: { clause: string; parameters: string[] },
): void {
	const entries = Object.entries(row.values).filter(([column]) => column !== "created_at");
	const result = db
		.prepare(
			`UPDATE identity_devices SET ${entries.map(([column]) => `${column} = ?`).join(", ")}
			 WHERE ${where.clause}`,
		)
		.run(...entries.map(([, value]) => value), ...where.parameters);
	if (result.changes !== 1) throw new Error("device_binding_conflict");
}

function validateOrWriteRow(db: Database, row: IntentRow): boolean {
	const idempotencyMatch = db
		.prepare(`SELECT * FROM ${row.table} WHERE idempotency_key = ?`)
		.get(row.values.idempotency_key) as Record<string, unknown> | undefined;
	const where = rowWhere(row.key);
	const keyMatch = db
		.prepare(`SELECT * FROM ${row.table} WHERE ${where.clause}`)
		.get(...where.parameters) as Record<string, unknown> | undefined;
	const existing = idempotencyMatch ?? keyMatch;
	if (existing) {
		const expected = { ...row.key, ...row.values };
		if (row.table === "identity_devices" && keyMatch && !idempotencyMatch) {
			const hasRecipientKeyBinding =
				keyMatch.provenance === "recipient_invite" && expected.provenance === "recipient_invite";
			const hasConflictingFingerprint =
				hasRecipientKeyBinding && keyMatch.source_fingerprint !== expected.source_fingerprint;
			if (
				keyMatch.identity_id !== expected.identity_id ||
				keyMatch.status !== "active" ||
				hasConflictingFingerprint
			) {
				throw new Error("device_binding_conflict");
			}
			if (
				keyMatch.provenance === "exact_project_invite" &&
				expected.provenance === "recipient_invite"
			) {
				if (!hasMatchingLocalDeviceKey(db, expected)) {
					throw new Error("device_binding_conflict");
				}
				transitionExactProjectDevice(db, row, where);
				return true;
			}
			return false;
		}
		if (row.table === "project_recipients" && keyMatch && !idempotencyMatch) {
			if (keyMatch.status !== "active") throw new Error("intent_conflict");
			return false;
		}
		const comparableColumns = Object.keys(expected).filter(
			(column) => column !== "created_at" && column !== "updated_at",
		);
		if (comparableColumns.some((column) => existing[column] !== expected[column])) {
			throw new Error(
				row.table === "identity_devices" ? "device_binding_conflict" : "intent_conflict",
			);
		}
		return false;
	}
	const columns = [...Object.keys(row.key), ...Object.keys(row.values)];
	db.prepare(
		`INSERT INTO ${row.table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
	).run(...Object.values(row.key), ...Object.values(row.values));
	return true;
}

export function commitDirectProjectSharePolicyInTransaction(
	db: Database,
	input: DirectProjectSharePolicyCommitInput,
): number {
	if (!db.inTransaction) throw new Error("direct_share_policy_transaction_required");
	const normalized = normalizeRequest({
		version: 1,
		journey: "direct_project",
		invitationId: input.operationId,
		identityId: input.recipientIdentityId,
		deviceId: input.recipientDeviceId,
		devicePublicKey: input.recipientDevicePublicKey,
		deviceDisplayName: input.recipientDeviceDisplayName,
		canonicalProjectIdentities: input.canonicalProjectIdentities,
	});
	if (normalized.journey !== "direct_project") throw new Error("journey_invalid");
	assertActiveIdentity(db, normalized.binding.identityId);
	assertActiveLocalIdentity(db, input.inviterIdentityId);
	if (input.inviterDevices.length === 0) throw new Error("inviter_device_binding_missing");
	const inviterDevices = input.inviterDevices
		.map((device) => ({
			deviceId: strictId(device.deviceId, "inviter_device_id", 256),
			displayName: normalizeIdentityDisplayName(device.displayName, "device_display_name"),
		}))
		.toSorted((left, right) => compareText(left.deviceId, right.deviceId));
	if (new Set(inviterDevices.map((device) => device.deviceId)).size !== inviterDevices.length) {
		throw new Error("inviter_device_binding_invalid");
	}
	const rows = [
		...inviterDevices.map((device) =>
			inviterDeviceRow({
				identityId: input.inviterIdentityId,
				deviceId: device.deviceId,
				displayName: device.displayName,
				now: input.now,
			}),
		),
		...normalized.canonicalProjectIdentities.map((projectId) =>
			inviterProjectRow({ identityId: input.inviterIdentityId, projectId, now: input.now }),
		),
		...planRows(normalized, input.now),
	];
	let writeCount = 0;
	for (const row of rows) {
		if (validateOrWriteRow(db, row)) writeCount += 1;
	}
	return writeCount;
}

function emptyResult(
	status: RecipientPolicyOnboardingCommitResultV1["status"],
	errorCode: string,
	journey: RecipientPolicyOnboardingJourneyV1 | null,
	reviewedOnboardingDigest: string,
): RecipientPolicyOnboardingCommitResultV1 {
	return {
		version: 1,
		status,
		journey,
		reviewedOnboardingDigest,
		errorCode,
		writeCount: 0,
		idempotent: false,
	};
}

function isSqliteBusy(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
	return (
		code === "SQLITE_BUSY" ||
		(error instanceof Error && error.message.includes("database is locked"))
	);
}

export function commitRecipientPolicyOnboarding(
	db: Database,
	request: RecipientPolicyOnboardingCommitRequestV1,
	options: { now?: () => string } = {},
): RecipientPolicyOnboardingCommitResultV1 {
	let normalized: NormalizedRequest;
	try {
		normalized = normalizeRequest(request);
	} catch (error) {
		if (error instanceof RecipientPolicyOnboardingRequestError) {
			return emptyResult(error.status, error.errorCode, null, "");
		}
		return emptyResult("invalid", "request_invalid", null, "");
	}
	if (!/^recipient-onboarding-preview-v1:[a-f0-9]{64}$/u.test(request.reviewedOnboardingDigest)) {
		return emptyResult("invalid", "reviewed_onboarding_digest_invalid", normalized.journey, "");
	}
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			const preview = buildPreview(db, normalized);
			if (preview.reviewedOnboardingDigest !== request.reviewedOnboardingDigest) {
				db.exec("ROLLBACK");
				return emptyResult(
					"stale",
					"reviewed_onboarding_stale",
					normalized.journey,
					preview.reviewedOnboardingDigest,
				);
			}
			const now = (options.now ?? (() => new Date().toISOString()))();
			let writeCount = 0;
			for (const row of planRows(normalized, now)) {
				if (validateOrWriteRow(db, row)) writeCount += 1;
			}
			db.exec("COMMIT");
			return {
				version: 1,
				status: "applied",
				journey: normalized.journey,
				reviewedOnboardingDigest: preview.reviewedOnboardingDigest,
				errorCode: null,
				writeCount,
				idempotent: writeCount === 0,
			};
		} catch (error) {
			if (db.inTransaction) db.exec("ROLLBACK");
			throw error;
		}
	} catch (error) {
		if (isSqliteBusy(error)) throw error;
		if (error instanceof RecipientPolicyOnboardingRequestError) {
			return emptyResult(
				error.status,
				error.errorCode,
				normalized.journey,
				request.reviewedOnboardingDigest,
			);
		}
		const errorCode =
			error instanceof Error && error.message === "device_binding_conflict"
				? "device_binding_conflict"
				: "onboarding_intent_conflict";
		return emptyResult("conflict", errorCode, normalized.journey, request.reviewedOnboardingDigest);
	}
}

export function commitRecipientPolicyOnboardingFromReviewedIntent(
	db: Database,
	request: RecipientPolicyReviewedIntentCommitRequestV1,
	options: { now?: () => string } = {},
): RecipientPolicyOnboardingCommitResultV1 {
	let normalized: NormalizedRequest;
	try {
		normalized = normalizeRequest(request);
		if (normalized.journey === "direct_project") {
			return emptyResult("invalid", "journey_invalid", normalized.journey, "");
		}
	} catch (error) {
		if (error instanceof RecipientPolicyOnboardingRequestError) {
			return emptyResult(error.status, error.errorCode, null, "");
		}
		return emptyResult("invalid", "request_invalid", null, "");
	}
	if (!/^recipient-onboarding-preview-v1:[a-f0-9]{64}$/u.test(request.reviewedOnboardingDigest)) {
		return emptyResult("invalid", "reviewed_onboarding_digest_invalid", normalized.journey, "");
	}
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			const reviewedIntent = normalizeRecipientReviewedIntent(
				request.reviewedIntent,
				reviewedIntentTarget(normalized),
			);
			const preview = buildReviewedIntentPreview(normalized, reviewedIntent);
			if (preview.reviewedOnboardingDigest !== request.reviewedOnboardingDigest) {
				db.exec("ROLLBACK");
				return emptyResult(
					"stale",
					"reviewed_onboarding_stale",
					normalized.journey,
					preview.reviewedOnboardingDigest,
				);
			}
			const now = (options.now ?? (() => new Date().toISOString()))();
			const identityDisplayName =
				normalized.journey === "add_device" && reviewedIntent.journey === "add_device"
					? reviewedIntent.targetIdentity.displayName
					: normalizeIdentityDisplayName(request.identityDisplayName, "identity_display_name");
			let writeCount = materializeLocalIdentity(
				db,
				{
					identityId: normalized.binding.identityId,
					displayName: identityDisplayName,
					deviceId: normalized.binding.deviceId,
					allowBootstrapAdoption: normalized.journey === "add_device",
				},
				now,
			)
				? 1
				: 0;
			if (normalized.journey === "team") {
				if (reviewedIntent.journey !== "team") throw new Error("intent_conflict");
				if (materializeReviewedTeam(db, reviewedIntent.team, now)) writeCount += 1;
			}
			for (const row of planRows(normalized, now)) {
				if (validateOrWriteRow(db, row)) writeCount += 1;
			}
			db.exec("COMMIT");
			return {
				version: 1,
				status: "applied",
				journey: normalized.journey,
				reviewedOnboardingDigest: preview.reviewedOnboardingDigest,
				errorCode: null,
				writeCount,
				idempotent: writeCount === 0,
			};
		} catch (error) {
			if (db.inTransaction) db.exec("ROLLBACK");
			throw error;
		}
	} catch (error) {
		if (isSqliteBusy(error)) throw error;
		if (error instanceof RecipientPolicyOnboardingRequestError) {
			return emptyResult(
				error.status,
				error.errorCode,
				normalized.journey,
				request.reviewedOnboardingDigest,
			);
		}
		const message = error instanceof Error ? error.message : "";
		const errorCode =
			message === "device_binding_conflict"
				? "device_binding_conflict"
				: message === "invite_identity_conflict"
					? "invite_identity_conflict"
					: "onboarding_intent_conflict";
		return emptyResult("conflict", errorCode, normalized.journey, request.reviewedOnboardingDigest);
	}
}
