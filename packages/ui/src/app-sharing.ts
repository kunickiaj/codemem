import * as api from "./lib/api";
import type { ProjectScopeInventoryProject } from "./lib/api/sync";
import {
	mountRecipientPolicyManagement,
	type RecipientPolicyManagementProject,
} from "./tabs/recipient-policy-management";
import { toRecipientPolicyManagementProjects } from "./tabs/recipient-policy-projects";
import { mountRecipientPolicySharing } from "./tabs/recipient-policy-sharing";

const EMPTY_RECIPIENT_POLICY_INTENT: api.RecipientPolicyIntentGraphV1 = {
	version: 1,
	identities: [],
	teams: [],
	teamMemberships: [],
	identityDevices: [],
	projectRecipients: [],
};

async function loadRecipientPolicyProjects(): Promise<RecipientPolicyManagementProject[]> {
	const projects: ProjectScopeInventoryProject[] = [];
	let offset = 0;
	while (true) {
		const page = await api.loadProjectScopeInventory({ limit: 250, offset });
		projects.push(...page.projects);
		if (!page.has_more) break;
		offset += page.limit;
	}
	return toRecipientPolicyManagementProjects(projects);
}

interface RecipientPolicySharingLoaderDependencies {
	loadIntent: typeof api.loadRecipientPolicyIntent;
	loadProjects: () => Promise<RecipientPolicyManagementProject[]>;
	mountManagement: typeof mountRecipientPolicyManagement;
	mountSharing: typeof mountRecipientPolicySharing;
}

const defaultDependencies: RecipientPolicySharingLoaderDependencies = {
	loadIntent: api.loadRecipientPolicyIntent,
	loadProjects: loadRecipientPolicyProjects,
	mountManagement: mountRecipientPolicyManagement,
	mountSharing: mountRecipientPolicySharing,
};

export function createRecipientPolicySharingLoader(
	overrides: Partial<RecipientPolicySharingLoaderDependencies> = {},
): () => Promise<void> {
	const dependencies = { ...defaultDependencies, ...overrides };
	let loaded = false;

	return async function loadRecipientPolicySharingData(): Promise<void> {
		const sharingMount = document.getElementById("recipientPolicySharingMount");
		if (!sharingMount) return;
		const managementMount = document.getElementById("recipientPolicyManagementMount");
		if (!loaded) {
			dependencies.mountSharing(sharingMount, [], EMPTY_RECIPIENT_POLICY_INTENT, {
				loading: true,
			});
		}
		try {
			const [projects, intent] = await Promise.all([
				dependencies.loadProjects(),
				dependencies.loadIntent(),
			]);
			dependencies.mountSharing(sharingMount, projects, intent);
			loaded = true;
			if (managementMount) {
				dependencies.mountManagement(managementMount, projects, intent, {
					onCommitted: loadRecipientPolicySharingData,
				});
			}
		} catch {
			dependencies.mountSharing(sharingMount, [], EMPTY_RECIPIENT_POLICY_INTENT, {
				loadError: true,
			});
			if (managementMount) {
				dependencies.mountManagement(managementMount, [], EMPTY_RECIPIENT_POLICY_INTENT, {
					loadError: true,
				});
			}
		}
	};
}
