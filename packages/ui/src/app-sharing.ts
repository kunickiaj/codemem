import * as api from "./lib/api";
import type { ProjectScopeInventoryProject } from "./lib/api/sync";
import { coordinatorEnrollmentOpenIssueCount } from "./lib/coordinator-enrollment-attention";
import {
	mountRecipientPolicyManagement,
	type RecipientPolicyManagementProject,
} from "./tabs/recipient-policy-management";
import {
	type ReceivedProjectShare,
	toReceivedProjectShares,
	toRecipientPolicyManagementProjects,
} from "./tabs/recipient-policy-projects";
import { mountRecipientPolicySharing } from "./tabs/recipient-policy-sharing";

const EMPTY_RECIPIENT_POLICY_INTENT: api.RecipientPolicyIntentGraphV1 = {
	version: 1,
	identities: [],
	teams: [],
	teamMemberships: [],
	identityDevices: [],
	projectRecipients: [],
};

interface RecipientPolicyProjectInventory {
	manageable: RecipientPolicyManagementProject[];
	received: ReceivedProjectShare[];
}

async function loadRecipientPolicyProjects(): Promise<RecipientPolicyProjectInventory> {
	const projects: ProjectScopeInventoryProject[] = [];
	let offset = 0;
	while (true) {
		const page = await api.loadProjectScopeInventory({ limit: 250, offset });
		projects.push(...page.projects);
		if (!page.has_more) break;
		offset += page.limit;
	}
	return {
		manageable: toRecipientPolicyManagementProjects(projects),
		received: toReceivedProjectShares(projects),
	};
}

interface RecipientPolicySharingLoaderDependencies {
	loadDeviceInventory: typeof api.loadDeviceIdentityInventory;
	loadIntent: typeof api.loadRecipientPolicyIntent;
	loadProjects: () => Promise<RecipientPolicyProjectInventory>;
	loadSyncStatus: typeof api.loadSyncStatus;
	mountManagement: typeof mountRecipientPolicyManagement;
	mountSharing: typeof mountRecipientPolicySharing;
}

const defaultDependencies: RecipientPolicySharingLoaderDependencies = {
	loadDeviceInventory: api.loadDeviceIdentityInventory,
	loadIntent: api.loadRecipientPolicyIntent,
	loadProjects: loadRecipientPolicyProjects,
	loadSyncStatus: api.loadSyncStatus,
	mountManagement: mountRecipientPolicyManagement,
	mountSharing: mountRecipientPolicySharing,
};

export function createRecipientPolicySharingLoader(
	overrides: Partial<RecipientPolicySharingLoaderDependencies> = {},
	options: { onReviewDevices?: (deviceId?: string) => void } = {},
): () => Promise<boolean> {
	const dependencies = { ...defaultDependencies, ...overrides };
	let loaded = false;
	let loadRevision = 0;
	let latestLoad: Promise<boolean> | null = null;
	let coordinatorEnrollmentIssueCount = 0;

	const loadRecipientPolicySharingData = (): Promise<boolean> => {
		const revision = ++loadRevision;
		const operation = load(revision);
		latestLoad = operation;
		return operation;
	};

	async function load(revision: number): Promise<boolean> {
		const sharingMount = document.getElementById("recipientPolicySharingMount");
		if (!sharingMount) return true;
		const managementMount = document.getElementById("recipientPolicyManagementMount");
		if (!loaded) {
			dependencies.mountSharing(sharingMount, [], EMPTY_RECIPIENT_POLICY_INTENT, {
				loading: true,
			});
		}
		const [inventoryResult, intentResult, deviceInventoryResult, syncStatusResult] =
			await Promise.allSettled([
				dependencies.loadProjects(),
				dependencies.loadIntent(),
				dependencies.loadDeviceInventory(),
				dependencies.loadSyncStatus(false, "", { includeJoinRequests: false }),
			]);
		if (revision !== loadRevision) return latestLoad ?? false;
		const deviceInventoryUnavailable = deviceInventoryResult.status === "rejected";
		if (syncStatusResult.status === "fulfilled") {
			coordinatorEnrollmentIssueCount = coordinatorEnrollmentOpenIssueCount(syncStatusResult.value);
		}
		if (inventoryResult.status === "fulfilled" && intentResult.status === "fulfilled") {
			const inventory = inventoryResult.value;
			const intent = intentResult.value;
			const deviceInventory =
				deviceInventoryResult.status === "fulfilled" ? deviceInventoryResult.value : undefined;
			dependencies.mountSharing(sharingMount, inventory.manageable, intent, {
				coordinatorEnrollmentIssueCount,
				deviceInventory,
				deviceInventoryUnavailable,
				onReviewDevices: options.onReviewDevices,
				received: inventory.received,
			});
			loaded = true;
			if (managementMount) {
				dependencies.mountManagement(managementMount, inventory.manageable, intent, {
					onCommitted: async () => {
						await loadRecipientPolicySharingData();
					},
				});
			}
			return true;
		}
		dependencies.mountSharing(sharingMount, [], EMPTY_RECIPIENT_POLICY_INTENT, {
			deviceInventoryUnavailable,
			loadError: true,
		});
		if (managementMount) {
			dependencies.mountManagement(managementMount, [], EMPTY_RECIPIENT_POLICY_INTENT, {
				loadError: true,
			});
		}
		return false;
	}

	return loadRecipientPolicySharingData;
}
