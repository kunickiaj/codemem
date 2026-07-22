import type { ProjectScopeInventoryProject } from "../lib/api/sync";
import type { RecipientPolicyManagementProject } from "./recipient-policy-management";

export function isRecipientPolicyManageableProject(project: ProjectScopeInventoryProject): boolean {
	return project.identity_source !== "unmapped" && project.read_only !== true;
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
