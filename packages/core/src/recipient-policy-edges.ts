import type { Database } from "./db.js";
import {
	derivePolicyTeamDeviceEligibility,
	type PolicyTeamDeviceEligibilityBlock,
	type PolicyTeamDeviceEligibilityIdentity,
} from "./policy-team-device-eligibility.js";
import {
	isStrictRecipientPolicyId,
	isStrictRecipientPolicyProjectIdentity,
	legacyRecipientPolicyDigest,
} from "./recipient-policy-identifiers.js";
import { canonicalWorkspaceIdentity } from "./scope-resolution.js";
import { SYNC_BOOTSTRAP_CWD_PREFIX } from "./sync-bootstrap-constants.js";

export type RecipientPolicyEdgeRecipientRefV1 =
	| { recipientKind: "identity"; identityId: string }
	| { recipientKind: "team"; teamId: string };

export interface RecipientPolicyEdgeChangeV1 {
	canonicalProjectIdentity: string;
	recipient: RecipientPolicyEdgeRecipientRefV1;
	action: "add" | "remove";
}

export interface RecipientPolicyEdgePreviewRequestV1 {
	version: 1;
	changes: RecipientPolicyEdgeChangeV1[];
}

export interface RecipientPolicyEdgeCommitRequestV1 extends RecipientPolicyEdgePreviewRequestV1 {
	reviewedPolicyDigest: string;
}

export interface RecipientPolicyEdgePreviewProjectV1 {
	canonicalProjectIdentity: string;
	displayName: string;
	existingMemoryCount: number;
	futureMemoriesShared: true;
}

export interface RecipientPolicyEdgeIdentitySummaryV1 {
	identityId: string;
	displayName: string;
	verification: "local";
}

export type RecipientPolicyEdgeSelectedRecipientV1 =
	| ({ recipientKind: "identity" } & RecipientPolicyEdgeIdentitySummaryV1)
	| {
			recipientKind: "team";
			teamId: string;
			displayName: string;
			currentMembers: RecipientPolicyEdgeIdentitySummaryV1[];
			futureMembersInherit: true;
	  };

export interface RecipientPolicyEdgeEffectiveDeviceV1 {
	canonicalProjectIdentity: string;
	identityId: string;
	deviceId: string;
	displayName: string;
}

export interface RecipientPolicyEdgePreviewResponseV1 {
	version: 1;
	normalizedChanges: RecipientPolicyEdgeChangeV1[];
	outcomes: RecipientPolicyEdgeCommitOutcomeV1[];
	projects: RecipientPolicyEdgePreviewProjectV1[];
	selectedRecipients: RecipientPolicyEdgeSelectedRecipientV1[];
	effectiveDevices: RecipientPolicyEdgeEffectiveDeviceV1[];
	unchangedProjects: RecipientPolicyEdgePreviewProjectV1[];
	reviewedPolicyDigest: string;
	addCount: number;
	removeCount: number;
	netWriteCount: number;
}

export type RecipientPolicyEdgeOutcomeV1 =
	| "added"
	| "removed"
	| "already_present"
	| "already_absent";

export interface RecipientPolicyEdgeCommitOutcomeV1 {
	change: RecipientPolicyEdgeChangeV1;
	outcome: RecipientPolicyEdgeOutcomeV1;
}

export interface RecipientPolicyEdgeCommitResultV1 {
	version: 1;
	status: "applied" | "stale" | "invalid" | "not_found" | "conflict";
	reviewedPolicyDigest: string;
	errorCode: string | null;
	outcomes: RecipientPolicyEdgeCommitOutcomeV1[];
	writeCount: number;
	idempotent: boolean;
}

export class RecipientPolicyEdgeRequestError extends Error {
	readonly status: "invalid" | "not_found";
	readonly errorCode: string;

	constructor(status: "invalid" | "not_found", errorCode: string) {
		super(errorCode);
		this.name = "RecipientPolicyEdgeRequestError";
		this.status = status;
		this.errorCode = errorCode;
	}
}

type ProjectFact = RecipientPolicyEdgePreviewProjectV1;

interface IdentityFact extends RecipientPolicyEdgeIdentitySummaryV1 {
	status: "active" | "pending";
}

interface TeamFact {
	teamId: string;
	displayName: string;
	deviceEligibilityMode: string;
	currentMembers: IdentityFact[];
	eligibleDeviceIds: Set<string>;
	deviceDecisions: Array<{ deviceId: string; decision: string; assignmentVersion: number }>;
	eligibilityBlocks: PolicyTeamDeviceEligibilityBlock[];
}

interface DeviceFact {
	identityId: string;
	deviceId: string;
	displayName: string;
	status: string;
	assignmentVersion: number;
}

interface StoredEdge {
	canonicalProjectIdentity: string;
	recipientKind: "identity" | "team";
	recipientId: string;
	status: string;
}

interface PreviewState {
	response: RecipientPolicyEdgePreviewResponseV1;
	edgesByKey: Map<string, StoredEdge>;
}

const CONTROL_CHARACTER = /\p{Cc}/u;
const MAX_CHANGES = 500;
const MAX_PROJECTS = 500;
const MAX_RECIPIENTS = 200;
const KNOWN_DEVICE_STATUSES = new Set(["active", "revoked"]);

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

const digest = legacyRecipientPolicyDigest;

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const expected = new Set(keys);
	return (
		Object.keys(value).length === expected.size &&
		Object.keys(value).every((key) => expected.has(key))
	);
}

function strictId(value: unknown, maxLength = Number.POSITIVE_INFINITY): string | null {
	if (typeof value !== "string" || !value || value !== value.trim()) return null;
	if (value.length > maxLength || CONTROL_CHARACTER.test(value)) return null;
	return value;
}

function recipientKey(recipient: RecipientPolicyEdgeRecipientRefV1): string {
	return recipient.recipientKind === "identity"
		? `identity\u0000${recipient.identityId}`
		: `team\u0000${recipient.teamId}`;
}

function edgeKey(
	projectId: string,
	recipientKind: "identity" | "team",
	recipientId: string,
): string {
	return `${projectId}\u0000${recipientKind}\u0000${recipientId}`;
}

function recipientId(recipient: RecipientPolicyEdgeRecipientRefV1): string {
	return recipient.recipientKind === "identity" ? recipient.identityId : recipient.teamId;
}

function compareChanges(
	left: RecipientPolicyEdgeChangeV1,
	right: RecipientPolicyEdgeChangeV1,
): number {
	return (
		compareText(left.canonicalProjectIdentity, right.canonicalProjectIdentity) ||
		compareText(left.recipient.recipientKind, right.recipient.recipientKind) ||
		compareText(recipientId(left.recipient), recipientId(right.recipient)) ||
		compareText(left.action, right.action)
	);
}

function parseRecipient(value: unknown): RecipientPolicyEdgeRecipientRefV1 | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.recipientKind === "identity" && exactKeys(record, ["recipientKind", "identityId"])) {
		const identityId = isStrictRecipientPolicyId(record.identityId) ? record.identityId : null;
		return identityId ? { recipientKind: "identity", identityId } : null;
	}
	if (record.recipientKind === "team" && exactKeys(record, ["recipientKind", "teamId"])) {
		const teamId = isStrictRecipientPolicyId(record.teamId) ? record.teamId : null;
		return teamId ? { recipientKind: "team", teamId } : null;
	}
	return null;
}

function parseChanges(value: unknown): RecipientPolicyEdgeChangeV1[] | null {
	if (!Array.isArray(value) || value.length < 1 || value.length > MAX_CHANGES) return null;
	const changes: RecipientPolicyEdgeChangeV1[] = [];
	const edges = new Set<string>();
	const projects = new Set<string>();
	const recipients = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return null;
		const record = item as Record<string, unknown>;
		if (!exactKeys(record, ["canonicalProjectIdentity", "recipient", "action"])) return null;
		const canonicalProjectIdentity = isStrictRecipientPolicyProjectIdentity(
			record.canonicalProjectIdentity,
		)
			? record.canonicalProjectIdentity
			: null;
		const recipient = parseRecipient(record.recipient);
		if (
			!canonicalProjectIdentity ||
			!recipient ||
			(record.action !== "add" && record.action !== "remove")
		) {
			return null;
		}
		const key = edgeKey(canonicalProjectIdentity, recipient.recipientKind, recipientId(recipient));
		if (edges.has(key)) return null;
		edges.add(key);
		projects.add(canonicalProjectIdentity);
		recipients.add(recipientKey(recipient));
		if (projects.size > MAX_PROJECTS || recipients.size > MAX_RECIPIENTS) return null;
		changes.push({ canonicalProjectIdentity, recipient, action: record.action });
	}
	return changes.toSorted(compareChanges);
}

export function parseRecipientPolicyEdgePreviewRequest(
	value: unknown,
): RecipientPolicyEdgePreviewRequestV1 | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!exactKeys(record, ["version", "changes"]) || record.version !== 1) return null;
	const changes = parseChanges(record.changes);
	return changes ? { version: 1, changes } : null;
}

export function parseRecipientPolicyEdgeCommitRequest(
	value: unknown,
): RecipientPolicyEdgeCommitRequestV1 | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!exactKeys(record, ["version", "changes", "reviewedPolicyDigest"]) || record.version !== 1) {
		return null;
	}
	const changes = parseChanges(record.changes);
	const reviewedPolicyDigest = strictId(record.reviewedPolicyDigest, 256);
	return changes &&
		reviewedPolicyDigest &&
		/^edge-preview-v1:[a-f0-9]{64}$/u.test(reviewedPolicyDigest)
		? { version: 1, changes, reviewedPolicyDigest }
		: null;
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
		const current = projects.get(identity.value);
		projects.set(identity.value, {
			canonicalProjectIdentity: identity.value,
			displayName: current?.displayName ?? identity.displayProject ?? identity.value,
			existingMemoryCount: (current?.existingMemoryCount ?? 0) + Number(row.memory_count ?? 0),
			futureMemoriesShared: true,
		});
	}
	const addProjection = (projectId: unknown, displayName: unknown, memoryCount = 0): void => {
		if (typeof projectId !== "string" || !projectId || projectId.startsWith("unmapped:")) return;
		if (projects.has(projectId)) return;
		projects.set(projectId, {
			canonicalProjectIdentity: projectId,
			displayName:
				typeof displayName === "string" && displayName.trim() ? displayName.trim() : projectId,
			existingMemoryCount: memoryCount,
			futureMemoriesShared: true,
		});
	};
	for (const row of db
		.prepare(
			`SELECT workspace_identity, project_pattern FROM project_scope_mappings
			 WHERE workspace_identity IS NOT NULL AND TRIM(workspace_identity) <> '' ORDER BY id`,
		)
		.all() as Array<Record<string, unknown>>) {
		addProjection(row.workspace_identity, row.project_pattern);
	}
	for (const row of db
		.prepare(
			`SELECT canonical_project_identity, display_name
			 FROM share_operation_projects ORDER BY operation_id, ordinal`,
		)
		.all() as Array<Record<string, unknown>>) {
		addProjection(row.canonical_project_identity, row.display_name);
	}
	return projects;
}

function loadIdentityFacts(db: Database): Map<string, IdentityFact> {
	const result = new Map<string, IdentityFact>();
	for (const row of db
		.prepare(
			`SELECT actor_id, display_name, status FROM actors
			 WHERE status IN ('active', 'pending') ORDER BY actor_id`,
		)
		.all() as Array<Record<string, unknown>>) {
		const identityId = String(row.actor_id ?? "");
		result.set(identityId, {
			identityId,
			displayName: String(row.display_name ?? ""),
			verification: "local",
			status: row.status === "pending" ? "pending" : "active",
		});
	}
	return result;
}

function loadTeamIdentityFacts(db: Database): PolicyTeamDeviceEligibilityIdentity[] {
	return (
		db
			.prepare(
				`SELECT actor_id, status, merged_into_actor_id FROM actors
				 ORDER BY actor_id`,
			)
			.all() as Array<Record<string, unknown>>
	).map((row) => ({
		identityId: String(row.actor_id ?? ""),
		status: String(row.status ?? ""),
		mergedIntoIdentityId:
			typeof row.merged_into_actor_id === "string" && row.merged_into_actor_id
				? row.merged_into_actor_id
				: null,
	}));
}

function loadTeamFacts(
	db: Database,
	identities: Map<string, IdentityFact>,
	teamIdentities: PolicyTeamDeviceEligibilityIdentity[],
	devices: DeviceFact[],
): Map<string, TeamFact> {
	const teams = new Map<string, TeamFact>();
	for (const row of db
		.prepare(
			`SELECT team_id, display_name, device_eligibility_mode
			 FROM policy_teams WHERE status = 'active' ORDER BY team_id`,
		)
		.all() as Array<Record<string, unknown>>) {
		const teamId = String(row.team_id ?? "");
		teams.set(teamId, {
			teamId,
			displayName: String(row.display_name ?? ""),
			deviceEligibilityMode: String(row.device_eligibility_mode ?? ""),
			currentMembers: [],
			eligibleDeviceIds: new Set(),
			deviceDecisions: [],
			eligibilityBlocks: [],
		});
	}
	const memberships = db
		.prepare(
			`SELECT team_id, identity_id, status FROM policy_team_memberships
			 ORDER BY team_id, identity_id`,
		)
		.all() as Array<Record<string, unknown>>;
	const decisions = db
		.prepare(
			`SELECT team_id, device_id, decision, assignment_version FROM policy_team_device_decisions
			 ORDER BY team_id, device_id`,
		)
		.all() as Array<Record<string, unknown>>;
	const membershipsByTeam = new Map<string, Array<{ identityId: string; status: string }>>();
	for (const row of memberships) {
		const teamId = String(row.team_id ?? "");
		const current = membershipsByTeam.get(teamId) ?? [];
		current.push({
			identityId: String(row.identity_id ?? ""),
			status: String(row.status ?? ""),
		});
		membershipsByTeam.set(teamId, current);
	}
	const decisionsByTeam = new Map<
		string,
		Array<{ deviceId: string; decision: string; assignmentVersion: number }>
	>();
	for (const row of decisions) {
		const teamId = String(row.team_id ?? "");
		const current = decisionsByTeam.get(teamId) ?? [];
		current.push({
			deviceId: String(row.device_id ?? ""),
			decision: String(row.decision ?? ""),
			assignmentVersion: Number(row.assignment_version),
		});
		decisionsByTeam.set(teamId, current);
	}
	const teamIdentityById = new Map(
		teamIdentities.map((identity) => [identity.identityId, identity]),
	);
	const devicesByIdentity = new Map<string, DeviceFact[]>();
	for (const device of devices) {
		const current = devicesByIdentity.get(device.identityId) ?? [];
		current.push(device);
		devicesByIdentity.set(device.identityId, current);
	}
	for (const team of teams.values()) {
		team.deviceDecisions = decisionsByTeam.get(team.teamId) ?? [];
		const teamMemberships = membershipsByTeam.get(team.teamId) ?? [];
		const memberIdentityIds = new Set(teamMemberships.map((membership) => membership.identityId));
		const eligibilityIdentities = [...memberIdentityIds].flatMap((identityId) => {
			const identity = teamIdentityById.get(identityId);
			return identity ? [identity] : [];
		});
		const eligibilityDevices = [...memberIdentityIds].flatMap(
			(identityId) => devicesByIdentity.get(identityId) ?? [],
		);
		const eligibility = derivePolicyTeamDeviceEligibility({
			teamId: team.teamId,
			mode: team.deviceEligibilityMode,
			memberships: teamMemberships,
			identities: eligibilityIdentities,
			devices: eligibilityDevices,
			decisions: team.deviceDecisions,
		});
		team.eligibilityBlocks = eligibility.blocked;
		if (eligibility.status === "blocked") continue;
		team.eligibleDeviceIds = new Set(eligibility.eligibleDeviceIds);
		team.currentMembers = eligibility.activeMemberIdentityIds.flatMap((identityId) => {
			const identity = identities.get(identityId);
			return identity ? [identity] : [];
		});
	}
	return teams;
}

function loadDeviceFacts(db: Database, identities: Map<string, IdentityFact>): DeviceFact[] {
	return (
		db
			.prepare(
				`SELECT identity_id, device_id, display_name, status, assignment_version
				 FROM identity_devices
			 ORDER BY identity_id, device_id`,
			)
			.all() as Array<Record<string, unknown>>
	).flatMap((row): DeviceFact[] => {
		const identityId = String(row.identity_id ?? "");
		return identities.has(identityId)
			? [
					{
						identityId,
						deviceId: String(row.device_id ?? ""),
						displayName: String(row.display_name ?? ""),
						status: String(row.status ?? ""),
						assignmentVersion: Number(row.assignment_version),
					},
				]
			: [];
	});
}

function loadEdges(db: Database, projectIds: string[]): Map<string, StoredEdge> {
	const placeholders = projectIds.map(() => "?").join(",");
	const rows = db
		.prepare(
			`SELECT canonical_project_identity, recipient_kind, recipient_id, status
			 FROM project_recipients WHERE canonical_project_identity IN (${placeholders})
			 ORDER BY canonical_project_identity, recipient_kind, recipient_id`,
		)
		.all(...projectIds) as Array<Record<string, unknown>>;
	const result = new Map<string, StoredEdge>();
	for (const row of rows) {
		const recipientKind = row.recipient_kind === "team" ? "team" : "identity";
		const edge = {
			canonicalProjectIdentity: String(row.canonical_project_identity ?? ""),
			recipientKind,
			recipientId: String(row.recipient_id ?? ""),
			status: String(row.status ?? ""),
		} satisfies StoredEdge;
		result.set(edgeKey(edge.canonicalProjectIdentity, edge.recipientKind, edge.recipientId), edge);
	}
	return result;
}

function selectedRecipients(
	changes: RecipientPolicyEdgeChangeV1[],
	identities: Map<string, IdentityFact>,
	teams: Map<string, TeamFact>,
	edges: Map<string, StoredEdge>,
): RecipientPolicyEdgeSelectedRecipientV1[] {
	const recipients = new Map<string, RecipientPolicyEdgeSelectedRecipientV1>();
	for (const change of changes) {
		if (change.recipient.recipientKind === "identity") {
			const current = edges.get(
				edgeKey(
					change.canonicalProjectIdentity,
					change.recipient.recipientKind,
					change.recipient.identityId,
				),
			);
			const identity = identities.get(change.recipient.identityId);
			if (!identity) {
				// Removal uses the exact active edge after identity lifecycle changes.
				if (change.action === "remove" && current?.status === "active") continue;
				throw new RecipientPolicyEdgeRequestError("not_found", "recipient_not_found");
			}
			recipients.set(recipientKey(change.recipient), {
				recipientKind: "identity",
				identityId: identity.identityId,
				displayName: identity.displayName,
				verification: identity.verification,
			});
		} else {
			const current = edges.get(
				edgeKey(
					change.canonicalProjectIdentity,
					change.recipient.recipientKind,
					change.recipient.teamId,
				),
			);
			const team = teams.get(change.recipient.teamId);
			if (!team) {
				// Removal uses the exact active edge after Team lifecycle changes.
				if (change.action === "remove" && current?.status === "active") continue;
				throw new RecipientPolicyEdgeRequestError("not_found", "recipient_not_found");
			}
			const eligibilityBlock = team.eligibilityBlocks[0];
			if (eligibilityBlock) {
				// Removal is anchored to the exact persisted edge, not current Team
				// eligibility. This keeps malformed or future policy state removable.
				if (change.action === "remove" && current?.status === "active") continue;
				throw new RecipientPolicyEdgeRequestError("invalid", eligibilityBlock.code);
			}
			recipients.set(recipientKey(change.recipient), {
				recipientKind: "team",
				teamId: team.teamId,
				displayName: team.displayName,
				currentMembers: team.currentMembers.map(({ status: _status, ...identity }) => identity),
				futureMembersInherit: true,
			});
		}
	}
	return [...recipients.values()].toSorted((left, right) => {
		const leftId = left.recipientKind === "identity" ? left.identityId : left.teamId;
		const rightId = right.recipientKind === "identity" ? right.identityId : right.teamId;
		return compareText(left.recipientKind, right.recipientKind) || compareText(leftId, rightId);
	});
}

function assertDesiredTeamEligibility(edges: StoredEdge[], teams: Map<string, TeamFact>): void {
	for (const edge of edges) {
		if (edge.recipientKind !== "team") continue;
		const team = teams.get(edge.recipientId);
		if (!team) {
			throw new RecipientPolicyEdgeRequestError("not_found", "recipient_not_found");
		}
		const eligibilityBlock = team.eligibilityBlocks[0];
		if (eligibilityBlock) {
			throw new RecipientPolicyEdgeRequestError("invalid", eligibilityBlock.code);
		}
	}
}

function assertDesiredDirectIdentityEligibility(edges: StoredEdge[], devices: DeviceFact[]): void {
	const directIdentityIds = new Set(
		edges.filter((edge) => edge.recipientKind === "identity").map((edge) => edge.recipientId),
	);
	for (const device of devices) {
		if (!directIdentityIds.has(device.identityId)) continue;
		if (!KNOWN_DEVICE_STATUSES.has(device.status)) {
			throw new RecipientPolicyEdgeRequestError("invalid", "identity_device_invalid");
		}
		if (
			device.status === "active" &&
			(!isStrictRecipientPolicyId(device.identityId) || !isStrictRecipientPolicyId(device.deviceId))
		) {
			throw new RecipientPolicyEdgeRequestError("invalid", "identity_device_invalid");
		}
	}
}

function desiredActiveEdges(
	changes: RecipientPolicyEdgeChangeV1[],
	edges: Map<string, StoredEdge>,
): StoredEdge[] {
	const desired = new Map(
		[...edges.values()]
			.filter((edge) => edge.status === "active")
			.map((edge) => [
				edgeKey(edge.canonicalProjectIdentity, edge.recipientKind, edge.recipientId),
				edge,
			]),
	);
	for (const change of changes) {
		const id = recipientId(change.recipient);
		const key = edgeKey(change.canonicalProjectIdentity, change.recipient.recipientKind, id);
		if (change.action === "remove") desired.delete(key);
		else {
			desired.set(key, {
				canonicalProjectIdentity: change.canonicalProjectIdentity,
				recipientKind: change.recipient.recipientKind,
				recipientId: id,
				status: "active",
			});
		}
	}
	return [...desired.values()].toSorted(
		(left, right) =>
			compareText(left.canonicalProjectIdentity, right.canonicalProjectIdentity) ||
			compareText(left.recipientKind, right.recipientKind) ||
			compareText(left.recipientId, right.recipientId),
	);
}

function effectiveDevices(
	edges: StoredEdge[],
	identities: Map<string, IdentityFact>,
	teams: Map<string, TeamFact>,
	devices: DeviceFact[],
): RecipientPolicyEdgeEffectiveDeviceV1[] {
	const devicesByIdentity = new Map<string, DeviceFact[]>();
	for (const device of devices) {
		if (device.status !== "active") continue;
		const current = devicesByIdentity.get(device.identityId) ?? [];
		current.push(device);
		devicesByIdentity.set(device.identityId, current);
	}
	const effective = new Map<string, RecipientPolicyEdgeEffectiveDeviceV1>();
	for (const edge of edges) {
		const identityIds =
			edge.recipientKind === "identity"
				? identities.has(edge.recipientId)
					? [edge.recipientId]
					: []
				: (teams.get(edge.recipientId)?.currentMembers.map((member) => member.identityId) ?? []);
		for (const identityId of identityIds) {
			for (const device of devicesByIdentity.get(identityId) ?? []) {
				if (
					edge.recipientKind === "team" &&
					!teams.get(edge.recipientId)?.eligibleDeviceIds.has(device.deviceId)
				) {
					continue;
				}
				const key = `${edge.canonicalProjectIdentity}\u0000${device.deviceId}`;
				effective.set(key, {
					canonicalProjectIdentity: edge.canonicalProjectIdentity,
					identityId,
					deviceId: device.deviceId,
					displayName: device.displayName,
				});
			}
		}
	}
	return [...effective.values()].toSorted(
		(left, right) =>
			compareText(left.canonicalProjectIdentity, right.canonicalProjectIdentity) ||
			compareText(left.deviceId, right.deviceId) ||
			compareText(left.identityId, right.identityId),
	);
}

function selectedRecipientDigestFacts(
	changes: RecipientPolicyEdgeChangeV1[],
	desiredEdges: StoredEdge[],
	identities: Map<string, IdentityFact>,
	teams: Map<string, TeamFact>,
	devices: DeviceFact[],
): unknown[] {
	const devicesByIdentity = new Map<string, DeviceFact[]>();
	for (const device of devices) {
		if (device.status !== "active") continue;
		const current = devicesByIdentity.get(device.identityId) ?? [];
		current.push(device);
		devicesByIdentity.set(device.identityId, current);
	}
	// Assignment versions invalidate reviewed-Team previews, but person-wide
	// eligibility does not depend on them and must retain its legacy digest shape.
	const digestDevices = (
		identityId: string,
	): Array<Omit<DeviceFact, "status" | "assignmentVersion">> =>
		(devicesByIdentity.get(identityId) ?? []).map(
			({ status: _status, assignmentVersion: _assignmentVersion, ...device }) => device,
		);
	const reviewedDigestDevices = (identityId: string): Array<Omit<DeviceFact, "status">> =>
		(devicesByIdentity.get(identityId) ?? []).map(({ status: _status, ...device }) => device);
	const facts = new Map<string, unknown>();
	const addTeamFact = (team: TeamFact): void => {
		const key = recipientKey({ recipientKind: "team", teamId: team.teamId });
		if (facts.has(key)) return;
		const legacyFact = {
			recipientKind: "team",
			teamId: team.teamId,
			displayName: team.displayName,
			currentMembers: team.currentMembers.map((identity) => ({
				identity,
				devices: digestDevices(identity.identityId),
			})),
		};
		facts.set(
			key,
			team.deviceEligibilityMode !== "person_all_devices"
				? {
						...legacyFact,
						deviceEligibilityMode: team.deviceEligibilityMode,
						currentMembers: team.currentMembers.map((identity) => ({
							identity,
							devices: reviewedDigestDevices(identity.identityId),
						})),
						deviceDecisions: team.deviceDecisions,
					}
				: legacyFact,
		);
	};
	for (const change of changes) {
		if (change.recipient.recipientKind === "identity") {
			const identity = identities.get(change.recipient.identityId);
			if (!identity) continue;
			facts.set(recipientKey(change.recipient), {
				recipientKind: "identity",
				identity,
				devices: digestDevices(identity.identityId),
			});
			continue;
		}
		const team = teams.get(change.recipient.teamId);
		if (!team) continue;
		addTeamFact(team);
	}
	for (const edge of desiredEdges) {
		if (edge.recipientKind !== "team") continue;
		const team = teams.get(edge.recipientId);
		if (team) addTeamFact(team);
	}
	return [...facts.entries()]
		.toSorted(([left], [right]) => compareText(left, right))
		.map(([, fact]) => fact);
}

function buildPreview(db: Database, request: RecipientPolicyEdgePreviewRequestV1): PreviewState {
	const projectsById = projectFacts(db);
	const projectIds = [
		...new Set(request.changes.map((change) => change.canonicalProjectIdentity)),
	].toSorted();
	const edgesByKey = loadEdges(db, projectIds);
	const projects = projectIds.map((projectId) => {
		const project = projectsById.get(projectId);
		if (project) return project;
		const changes = request.changes.filter(
			(change) => change.canonicalProjectIdentity === projectId,
		);
		const removesExactActiveEdges = changes.every((change) => {
			const current = edgesByKey.get(
				edgeKey(projectId, change.recipient.recipientKind, recipientId(change.recipient)),
			);
			return change.action === "remove" && current?.status === "active";
		});
		if (!removesExactActiveEdges) {
			throw new RecipientPolicyEdgeRequestError("not_found", "project_not_found");
		}
		return {
			canonicalProjectIdentity: projectId,
			displayName: projectId,
			existingMemoryCount: 0,
			futureMemoriesShared: true as const,
		};
	});
	const identities = loadIdentityFacts(db);
	const teamIdentities = loadTeamIdentityFacts(db);
	const devices = loadDeviceFacts(db, identities);
	const teams = loadTeamFacts(db, identities, teamIdentities, devices);
	const recipients = selectedRecipients(request.changes, identities, teams, edgesByKey);
	const desiredEdges = desiredActiveEdges(request.changes, edgesByKey);
	assertDesiredTeamEligibility(desiredEdges, teams);
	assertDesiredDirectIdentityEligibility(desiredEdges, devices);
	const resultingDevices = effectiveDevices(desiredEdges, identities, teams, devices);
	let addCount = 0;
	let removeCount = 0;
	const changedProjects = new Set<string>();
	const outcomes: RecipientPolicyEdgeCommitOutcomeV1[] = [];
	for (const change of request.changes) {
		const current = edgesByKey.get(
			edgeKey(
				change.canonicalProjectIdentity,
				change.recipient.recipientKind,
				recipientId(change.recipient),
			),
		);
		if (change.action === "add" && current?.status !== "active") {
			addCount += 1;
			changedProjects.add(change.canonicalProjectIdentity);
			outcomes.push({ change, outcome: "added" });
		} else if (change.action === "add") {
			outcomes.push({ change, outcome: "already_present" });
		}
		if (change.action === "remove" && current?.status === "active") {
			removeCount += 1;
			changedProjects.add(change.canonicalProjectIdentity);
			outcomes.push({ change, outcome: "removed" });
		} else if (change.action === "remove") {
			outcomes.push({ change, outcome: "already_absent" });
		}
	}
	const reviewedPolicyDigest = digest("edge-preview-v1", {
		normalizedChanges: request.changes,
		outcomes,
		projects,
		selectedRecipientFacts: selectedRecipientDigestFacts(
			request.changes,
			desiredEdges,
			identities,
			teams,
			devices,
		),
		desiredActiveEdges: desiredEdges.map(({ status: _status, ...edge }) => edge),
		effectiveDevices: resultingDevices,
	});
	return {
		response: {
			version: 1,
			normalizedChanges: request.changes,
			outcomes,
			projects,
			selectedRecipients: recipients,
			effectiveDevices: resultingDevices,
			unchangedProjects: projects.filter(
				(project) => !changedProjects.has(project.canonicalProjectIdentity),
			),
			reviewedPolicyDigest,
			addCount,
			removeCount,
			netWriteCount: addCount + removeCount,
		},
		edgesByKey,
	};
}

export function previewRecipientPolicyEdges(
	db: Database,
	value: unknown,
): RecipientPolicyEdgePreviewResponseV1 {
	const request = parseRecipientPolicyEdgePreviewRequest(value);
	if (!request) throw new RecipientPolicyEdgeRequestError("invalid", "request_invalid");
	return buildPreview(db, request).response;
}

function emptyCommitResult(
	status: RecipientPolicyEdgeCommitResultV1["status"],
	errorCode: string,
	reviewedPolicyDigest = "",
): RecipientPolicyEdgeCommitResultV1 {
	return {
		version: 1,
		status,
		reviewedPolicyDigest,
		errorCode,
		outcomes: [],
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

export function commitRecipientPolicyEdges(
	db: Database,
	value: unknown,
	options: { now?: () => string } = {},
): RecipientPolicyEdgeCommitResultV1 {
	const request = parseRecipientPolicyEdgeCommitRequest(value);
	if (!request) return emptyCommitResult("invalid", "request_invalid");
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			const state = buildPreview(db, request);
			if (state.response.reviewedPolicyDigest !== request.reviewedPolicyDigest) {
				db.exec("ROLLBACK");
				return emptyCommitResult(
					"stale",
					"reviewed_policy_stale",
					state.response.reviewedPolicyDigest,
				);
			}
			const now = (options.now ?? (() => new Date().toISOString()))();
			const outcomes: RecipientPolicyEdgeCommitOutcomeV1[] = [];
			let writeCount = 0;
			for (const change of request.changes) {
				const id = recipientId(change.recipient);
				const key = edgeKey(change.canonicalProjectIdentity, change.recipient.recipientKind, id);
				const current = state.edgesByKey.get(key);
				if (change.action === "add") {
					if (current?.status === "active") {
						outcomes.push({ change, outcome: "already_present" });
						continue;
					}
					const revision = digest("edge-policy-revision-v1", [
						change.canonicalProjectIdentity,
						change.recipient.recipientKind,
						id,
						"active",
						request.reviewedPolicyDigest,
					]);
					if (current) {
						db.prepare(
							`UPDATE project_recipients SET status = 'active', provenance = 'user',
							 policy_revision = ?, migration_state = 'user_managed', source_fingerprint = NULL,
							 updated_at = ?
							 WHERE canonical_project_identity = ? AND recipient_kind = ? AND recipient_id = ?`,
						).run(
							revision,
							now,
							change.canonicalProjectIdentity,
							change.recipient.recipientKind,
							id,
						);
					} else {
						db.prepare(
							`INSERT INTO project_recipients(
							 canonical_project_identity, recipient_kind, recipient_id, status, provenance,
							 policy_revision, migration_state, source_fingerprint, idempotency_key,
							 created_at, updated_at
							 ) VALUES (?, ?, ?, 'active', 'user', ?, 'user_managed', NULL, ?, ?, ?)`,
						).run(
							change.canonicalProjectIdentity,
							change.recipient.recipientKind,
							id,
							revision,
							digest("edge-idempotency-v1", [
								change.canonicalProjectIdentity,
								change.recipient.recipientKind,
								id,
							]),
							now,
							now,
						);
					}
					writeCount += 1;
					outcomes.push({ change, outcome: "added" });
					continue;
				}
				if (current?.status !== "active") {
					outcomes.push({ change, outcome: "already_absent" });
					continue;
				}
				db.prepare(
					`UPDATE project_recipients SET status = 'revoked', provenance = 'user',
					 policy_revision = ?, migration_state = 'user_managed', source_fingerprint = NULL,
					 updated_at = ?
					 WHERE canonical_project_identity = ? AND recipient_kind = ? AND recipient_id = ?`,
				).run(
					digest("edge-policy-revision-v1", [
						change.canonicalProjectIdentity,
						change.recipient.recipientKind,
						id,
						"revoked",
						request.reviewedPolicyDigest,
					]),
					now,
					change.canonicalProjectIdentity,
					change.recipient.recipientKind,
					id,
				);
				writeCount += 1;
				outcomes.push({ change, outcome: "removed" });
			}
			db.exec("COMMIT");
			return {
				version: 1,
				status: "applied",
				reviewedPolicyDigest: state.response.reviewedPolicyDigest,
				errorCode: null,
				outcomes,
				writeCount,
				idempotent: writeCount === 0,
			};
		} catch (error) {
			if (db.inTransaction) db.exec("ROLLBACK");
			throw error;
		}
	} catch (error) {
		if (isSqliteBusy(error)) throw error;
		if (error instanceof RecipientPolicyEdgeRequestError) {
			return emptyCommitResult(error.status, error.errorCode, request.reviewedPolicyDigest);
		}
		return emptyCommitResult("conflict", "edge_commit_conflict", request.reviewedPolicyDigest);
	}
}
