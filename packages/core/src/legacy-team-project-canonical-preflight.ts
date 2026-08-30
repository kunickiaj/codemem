import { isMigratableLegacyTeamProjectIdentity } from "./legacy-team-project-policy.js";

export interface LegacyTeamProjectCanonicalPreflightInput {
	teamId: string;
	scopeIds: readonly string[];
	groupScopeIds: readonly string[];
	projects: ReadonlyArray<{
		sourceProjectIdentity: string;
		resolvedProjectIdentity: string | null;
		targetScopeId: string | null;
	}>;
	mappings: ReadonlyArray<{
		workspaceIdentity: string | null;
		projectPattern: string;
		scopeId: string;
		source: string | null;
	}>;
	recipients: ReadonlyArray<{
		canonicalProjectIdentity: string;
		recipientKind: string;
		recipientId: string;
		status: string;
	}>;
}

/**
 * Evaluates only the canonical Project facts shared by draft readiness and
 * activation. Callers remain responsible for loading fresh facts at their own
 * consistency boundary; activation repeats this check under its write lock.
 *
 * The input must include the complete active-scope set and complete historical
 * scope set for the coordinator group, every mapping whose Project pattern
 * matches a supplied source identity, and every recipient whose canonical
 * identity matches a supplied resolved identity. Unrelated mappings and
 * recipients may be omitted. Although normal callers invoke this only after
 * review completeness checks, unresolved or `unmapped:` identities are
 * rejected defensively so an incomplete caller fails closed.
 */
export function isLegacyTeamProjectCanonicalStateValid(
	input: LegacyTeamProjectCanonicalPreflightInput,
): boolean {
	for (const project of input.projects) {
		const resolvedIdentity = project.resolvedProjectIdentity;
		if (!resolvedIdentity || resolvedIdentity.startsWith("unmapped:")) return false;
		if (!isMigratableLegacyTeamProjectIdentity(resolvedIdentity)) return false;
		if (!project.targetScopeId || !input.scopeIds.includes(project.targetScopeId)) return false;

		const relatedMappings = input.mappings.filter(
			(mapping) => mapping.projectPattern === project.sourceProjectIdentity,
		);
		const hasConflictingMapping = relatedMappings.some((mapping) => {
			const ownSetupMapping =
				mapping.source === "reviewed_team_setup" && input.groupScopeIds.includes(mapping.scopeId);
			return (
				!ownSetupMapping &&
				(mapping.scopeId !== project.targetScopeId ||
					mapping.workspaceIdentity !== resolvedIdentity)
			);
		});
		if (hasConflictingMapping) return false;

		const hasConflictingRecipient = input.recipients.some(
			(recipient) =>
				recipient.canonicalProjectIdentity === resolvedIdentity &&
				recipient.status === "active" &&
				((recipient.recipientKind === "team" && recipient.recipientId !== input.teamId) ||
					(recipient.recipientKind !== "team" && recipient.recipientKind !== "identity")),
		);
		if (hasConflictingRecipient) return false;
	}
	const targetScopesByResolvedIdentity = new Map<string, Set<string>>();
	for (const project of input.projects) {
		const resolvedIdentity = project.resolvedProjectIdentity as string;
		const targetScopes = targetScopesByResolvedIdentity.get(resolvedIdentity) ?? new Set<string>();
		targetScopes.add(project.targetScopeId as string);
		targetScopesByResolvedIdentity.set(resolvedIdentity, targetScopes);
	}
	if ([...targetScopesByResolvedIdentity.values()].some((scopeIds) => scopeIds.size !== 1)) {
		return false;
	}

	return true;
}
