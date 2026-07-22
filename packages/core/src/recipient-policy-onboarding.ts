import { createHash } from "node:crypto";
import type { Database } from "./db.js";
import { normalizeIdentityDisplayName } from "./project-invite-identity.js";
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

function rowWhere(key: Record<string, string>): { clause: string; parameters: string[] } {
	return {
		clause: Object.keys(key)
			.map((column) => `${column} = ?`)
			.join(" AND "),
		parameters: Object.values(key),
	};
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
			if (
				keyMatch.identity_id !== expected.identity_id ||
				keyMatch.source_fingerprint !== expected.source_fingerprint
			) {
				throw new Error("device_binding_conflict");
			}
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
