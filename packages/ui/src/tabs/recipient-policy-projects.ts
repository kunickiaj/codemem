import type { ProjectScopeInventoryProject } from "../lib/api/sync";
import type { RecipientPolicyManagementProject } from "./recipient-policy-management";

export function isRecipientPolicyManageableProject(project: ProjectScopeInventoryProject): boolean {
	return project.identity_source !== "unmapped" && project.read_only !== true;
}

export interface ReceivedProjectShare {
	canonicalProjectIdentity: string;
	displayName: string;
	existingMemoryCount: number;
	latestSessionAt: string | null;
}

/**
 * Projects this node receives from other people. Sourced from the local
 * inventory's peer_received markers so the recipient sees inbound access
 * without depending on the owner's policy graph.
 */
export function toReceivedProjectShares(
	projects: ProjectScopeInventoryProject[],
): ReceivedProjectShare[] {
	const byId = new Map<string, ReceivedProjectShare>();
	for (const project of projects) {
		if (project.read_only_reason !== "peer_received") continue;
		byId.set(project.workspace_identity, {
			canonicalProjectIdentity: project.workspace_identity,
			displayName: project.display_project,
			existingMemoryCount: project.memory_count ?? 0,
			latestSessionAt: project.latest_session_at ?? null,
		});
	}
	return [...byId.values()].sort(
		(left, right) =>
			left.displayName.localeCompare(right.displayName) ||
			left.canonicalProjectIdentity.localeCompare(right.canonicalProjectIdentity),
	);
}

export function toRecipientPolicyManagementProjects(
	projects: ProjectScopeInventoryProject[],
): RecipientPolicyManagementProject[] {
	const byId = new Map<string, RecipientPolicyManagementProject>();
	for (const project of projects) {
		if (!isRecipientPolicyManageableProject(project)) continue;
		byId.set(project.workspace_identity, {
			canonicalProjectIdentity: project.workspace_identity,
			displayName: project.display_project,
			existingMemoryCount: project.memory_count ?? 0,
		});
	}
	return [...byId.values()].sort(
		(left, right) =>
			left.displayName.localeCompare(right.displayName) ||
			left.canonicalProjectIdentity.localeCompare(right.canonicalProjectIdentity),
	);
}
