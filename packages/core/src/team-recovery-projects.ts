import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import type { Database } from "./db.js";
import { selectedProjectScopeMappings } from "./legacy-recipient-policy-projection.js";
import { compareCodepoints } from "./recipient-policy-identifiers.js";
import { normalizeRepositoryWorkspaceIdentity } from "./repository-mapping-aliases.js";
import { resolveSessionScope } from "./scope-stamping.js";

/*
 * The Project half of the Team recovery preview: which Projects the Team's
 * devices would receive again.
 *
 * Quarantine revoked the Team recipients its setup created and deleted the
 * setup's Project mappings. Recovery puts back only what is still exactly as
 * quarantine left it: a recipient still revoked by quarantine, for a Project
 * that nobody has routed anywhere else since. A Project whose sharing or
 * mapping someone changed after the Team was disabled is skipped, and its
 * owner shares it again by hand. A Project shared with the Team outside the
 * setup was never revoked, so it resumes as soon as the Team is active.
 *
 * Where a Project is routed is read from the rules that stamp new memories, for
 * the Project's identity and for every checkout of it this machine has seen. A
 * mapping can name a checkout path or match one with a pattern, and such a
 * mapping moves the Project's memories without ever naming the Project. That
 * includes a mapping to local-only storage: only the fallback that applies when
 * no mapping matches counts as no route.
 */

export type TeamRecoveryProjectReason = "sharing_changed" | "mapping_changed" | "scope_unavailable";

export interface TeamRecoveryProject {
	projectIdentity: string;
	displayName: string | null;
	/**
	 * `restored`: recovery makes the setup's recipient active again.
	 * `resumes`: an active recipient nobody revoked takes effect again.
	 * `skipped`: the Project stays unshared with the Team.
	 */
	outcome: "restored" | "resumes" | "skipped";
	reason?: TeamRecoveryProjectReason;
	/**
	 * The scopes the Project's memories are routed to now. The Team's devices
	 * receive a restored or resumed Project through these scopes, or through the
	 * re-created setup mappings when there are none. The local default scope
	 * appears when a mapping keeps the Project on this machine.
	 */
	routedScopeIds: string[];
	/** Setup mappings recovery re-creates for a restored Project. */
	restoredMappings: Array<{ sourceProjectIdentity: string; scopeId: string }>;
}

export interface TeamRecoveryProjectsInput {
	teamId: string;
	attemptId: string;
	coordinatorId: string;
	groupId: string;
	/** The manifest the completed draft yields: each Project's reviewed scope. */
	localManifest: CoordinatorLegacyTeamCompletionManifestV1;
}

interface SetupProject {
	displayName: string;
	sources: Array<{ sourceProjectIdentity: string; scopeId: string }>;
}

interface RecipientRow {
	canonical_project_identity: string;
	status: string;
	provenance: string;
	migration_state: string;
}

/** The setup's Projects by resolved identity, each with its sources and their reviewed scopes. */
function setupProjects(db: Database, input: TeamRecoveryProjectsInput): Map<string, SetupProject> {
	const scopeByRef = new Map(
		input.localManifest.project_mappings.map((mapping) => [mapping.project_ref, mapping.scope_id]),
	);
	const rows = db
		.prepare(
			`SELECT project_ref, source_project_identity, resolved_project_identity, display_name
			 FROM legacy_team_setup_draft_projects WHERE attempt_id = ? ORDER BY project_ref`,
		)
		.all(input.attemptId) as Array<{
		project_ref: string;
		source_project_identity: string;
		resolved_project_identity: string;
		display_name: string;
	}>;
	const projects = new Map<string, SetupProject>();
	for (const row of rows) {
		const scopeId = scopeByRef.get(row.project_ref);
		if (scopeId === undefined) continue;
		const project = projects.get(row.resolved_project_identity) ?? {
			displayName: row.display_name,
			sources: [],
		};
		project.sources.push({ sourceProjectIdentity: row.source_project_identity, scopeId });
		projects.set(row.resolved_project_identity, project);
	}
	return projects;
}

function activeGroupScopeIds(db: Database, input: TeamRecoveryProjectsInput): Set<string> {
	return new Set(
		db
			.prepare(
				`SELECT scope_id FROM replication_scopes
				 WHERE coordinator_id = ? AND group_id = ?
				   AND authority_type = 'coordinator' AND status = 'active'`,
			)
			.pluck()
			.all(input.coordinatorId, input.groupId) as string[],
	);
}

/** Exactly the state quarantine leaves a setup recipient in. */
function revokedByQuarantine(recipient: RecipientRow | undefined): boolean {
	return (
		recipient?.status === "revoked" &&
		recipient.provenance === "reviewed_team_setup" &&
		recipient.migration_state === "needs_setup"
	);
}

type Selected =
	ReturnType<typeof selectedProjectScopeMappings> extends Map<string, infer Value> ? Value : never;

// One session for each checkout that recorded one of the identities as its
// remote, its path or its repository. Memories received from peers are not checkouts.
const CHECKOUT_SESSIONS_SQL = `SELECT MAX(id) FROM sessions
	WHERE cwd IS NOT NULL AND TRIM(cwd) <> ''
	  AND COALESCE(tool_version, '') <> 'sync_replication'
	  AND (
	    RTRIM(REPLACE(TRIM(git_remote), char(92), '/'), '/') IN (SELECT value FROM json_each(@identities))
	    OR RTRIM(REPLACE(TRIM(cwd), char(92), '/'), '/') IN (SELECT value FROM json_each(@identities))
	    OR (json_valid(metadata_json)
	        AND json_type(metadata_json, '$.codemem_repository_identity') = 'text'
	        AND RTRIM(REPLACE(TRIM(json_extract(metadata_json, '$.codemem_repository_identity')),
	            char(92), '/'), '/') IN (SELECT value FROM json_each(@identities)))
	  )
	GROUP BY cwd, git_remote ORDER BY MAX(id)`;

/**
 * The scopes a new memory of the Project would be stamped with now: from each
 * checkout of it this machine has seen, under the live stamping rules, and by
 * its identity alone, which covers a Project with no checkout here.
 */
function routedScopeIds(
	db: Database,
	identities: readonly string[],
	selected: ReadonlyMap<string, Selected>,
): string[] {
	const normalized = identities.flatMap((identity) => {
		const value = normalizeRepositoryWorkspaceIdentity(identity);
		return value ? [value] : [];
	});
	const sessionIds = db
		.prepare(CHECKOUT_SESSIONS_SQL)
		.pluck()
		.all({ identities: JSON.stringify(normalized) }) as number[];
	const scopeIds = new Set<string>();
	for (const sessionId of sessionIds) {
		const route = resolveSessionScope(db, { sessionId, readOnly: true });
		// Only the fallback is no route. A mapping that names the local default
		// scope keeps the Project on this machine on purpose, and that is a route.
		if (route.reason !== "local_default") scopeIds.add(route.scopeId);
	}
	for (const identity of identities) {
		const mapping = selected.get(identity);
		if (mapping) scopeIds.add(mapping.scopeId);
	}
	return [...scopeIds].toSorted(compareCodepoints);
}

type ProjectPlan = Pick<TeamRecoveryProject, "outcome" | "reason" | "restoredMappings">;

function planSetupProject(
	project: SetupProject,
	recipient: RecipientRow | undefined,
	route: { scopeIds: readonly string[]; selected: Selected | undefined },
	activeScopeIds: ReadonlySet<string>,
): ProjectPlan {
	// Someone shared it with the Team again, or outside the setup: nothing to restore.
	if (recipient?.status === "active") return { outcome: "resumes", restoredMappings: [] };
	const skipped = (reason: TeamRecoveryProjectReason): ProjectPlan => ({
		outcome: "skipped",
		reason,
		restoredMappings: [],
	});
	if (!revokedByQuarantine(recipient)) return skipped("sharing_changed");
	if (project.sources.some((source) => !activeScopeIds.has(source.scopeId)))
		return skipped("scope_unavailable");
	// Nothing routes the Project now: the setup's own mappings come back.
	if (route.scopeIds.length === 0)
		return { outcome: "restored", restoredMappings: project.sources };
	const reviewed = new Set(project.sources.map((source) => source.scopeId));
	// A route to any other scope, or one no mapping names the Project for, is someone's change.
	const changed =
		route.scopeIds.some((scopeId) => !reviewed.has(scopeId)) ||
		route.selected?.workspaceIdentity === null;
	return changed ? skipped("mapping_changed") : { outcome: "restored", restoredMappings: [] };
}

/** Plans every Project the Team would or would not receive once recovered. Reads only. */
export function planTeamRecoveryProjects(
	db: Database,
	input: TeamRecoveryProjectsInput,
): TeamRecoveryProject[] {
	const setup = setupProjects(db, input);
	const recipients = db
		.prepare(
			`SELECT canonical_project_identity, status, provenance, migration_state
			 FROM project_recipients WHERE recipient_kind = 'team' AND recipient_id = ?`,
		)
		.all(input.teamId) as RecipientRow[];
	const recipientByProject = new Map(
		recipients.map((row) => [row.canonical_project_identity, row]),
	);
	// Shared with the Team outside the setup: quarantine never revoked these.
	const outside = recipients
		.filter((row) => row.status === "active" && !setup.has(row.canonical_project_identity))
		.map((row) => row.canonical_project_identity);
	const sourcesOf = (projectIdentity: string) =>
		(setup.get(projectIdentity)?.sources ?? []).map((source) => source.sourceProjectIdentity);
	const identitiesOf = (projectIdentity: string) => [
		...new Set([projectIdentity, ...sourcesOf(projectIdentity)]),
	];
	const projectIdentities = [...setup.keys(), ...outside];
	const selected = selectedProjectScopeMappings(db, projectIdentities.flatMap(identitiesOf));
	const activeScopeIds = activeGroupScopeIds(db, input);
	return projectIdentities
		.toSorted(compareCodepoints)
		.map((projectIdentity): TeamRecoveryProject => {
			const project = setup.get(projectIdentity);
			const scopeIds = routedScopeIds(db, identitiesOf(projectIdentity), selected);
			const route = { scopeIds, selected: selected.get(projectIdentity) };
			const plan: ProjectPlan = project
				? planSetupProject(project, recipientByProject.get(projectIdentity), route, activeScopeIds)
				: { outcome: "resumes", restoredMappings: [] };
			return {
				projectIdentity,
				displayName: project?.displayName ?? null,
				...plan,
				routedScopeIds: scopeIds,
			};
		});
}
