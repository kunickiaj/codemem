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
import {
	mountRecipientPolicySharing,
	type RecipientPolicySharingOptions,
} from "./tabs/recipient-policy-sharing";

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
	loadTeamSetupSummary: typeof api.loadLegacyTeamSetupSummary;
	mountManagement: typeof mountRecipientPolicyManagement;
	mountSharing: typeof mountRecipientPolicySharing;
}

const defaultDependencies: RecipientPolicySharingLoaderDependencies = {
	loadDeviceInventory: api.loadDeviceIdentityInventory,
	loadIntent: api.loadRecipientPolicyIntent,
	loadProjects: loadRecipientPolicyProjects,
	loadSyncStatus: api.loadSyncStatus,
	loadTeamSetupSummary: api.loadLegacyTeamSetupSummary,
	mountManagement: mountRecipientPolicyManagement,
	mountSharing: mountRecipientPolicySharing,
};

export function createRecipientPolicySharingLoader(
	overrides: Partial<RecipientPolicySharingLoaderDependencies> = {},
	options: {
		onOpenTeamSetup?: (candidateRef: string) => void;
		onReviewDevices?: (deviceId?: string) => void;
	} = {},
): RecipientPolicySharingRefresh {
	const dependencies = { ...defaultDependencies, ...overrides };
	let loadRevision = 0;
	let latestLoad: Promise<boolean> | null = null;
	let coordinatorEnrollmentIssueCount = 0;
	let lastDeviceInventory: Awaited<ReturnType<typeof dependencies.loadDeviceInventory>> | undefined;
	let teamSetupSummary: api.LegacyTeamSetupSummaryResponseV1 | undefined;
	let teamSetupLoading = false;
	let teamSetupUnavailable = false;
	let lastRequiredRefreshError = false;
	let lastDeviceInventoryUnavailable = false;
	let lastSuccessfulData: {
		inventory: RecipientPolicyProjectInventory;
		intent: api.RecipientPolicyIntentGraphV1;
	} | null = null;

	const loadRecipientPolicySharingData = (
		refreshOptions: RecipientPolicySharingRefreshOptions = {},
	): Promise<boolean> => {
		const revision = ++loadRevision;
		const operation = load(revision, refreshOptions);
		latestLoad = operation;
		return operation;
	};

	async function load(
		revision: number,
		refreshOptions: RecipientPolicySharingRefreshOptions,
	): Promise<boolean> {
		const sharingMount = document.getElementById("recipientPolicySharingMount");
		if (!sharingMount) {
			if (!refreshOptions.requireTeamSetupSummary) return true;
			try {
				await dependencies.loadTeamSetupSummary();
				return true;
			} catch {
				return false;
			}
		}
		const managementMount = document.getElementById("recipientPolicyManagementMount");
		teamSetupLoading = true;
		teamSetupUnavailable = false;
		let renderTeamSetupUpdate = () => {
			const cached = lastSuccessfulData;
			dependencies.mountSharing(
				sharingMount,
				cached?.inventory.manageable ?? [],
				cached?.intent ?? EMPTY_RECIPIENT_POLICY_INTENT,
				cached
					? {
							coordinatorEnrollmentIssueCount,
							deviceInventory: lastDeviceInventory,
							deviceInventoryUnavailable: lastDeviceInventoryUnavailable,
							onOpenTeamSetup: options.onOpenTeamSetup,
							onReviewDevices: options.onReviewDevices,
							received: cached.inventory.received,
							...(lastRequiredRefreshError ? { refreshError: true } : {}),
							teamSetupSummary,
							teamSetupLoading,
							teamSetupUnavailable,
						}
					: {
							loading: true,
							teamSetupSummary,
							teamSetupLoading,
							teamSetupUnavailable,
						},
			);
		};
		renderTeamSetupUpdate();
		const teamSetupSummaryPromise = Promise.resolve()
			.then(() => dependencies.loadTeamSetupSummary())
			.then(
				(summary) => {
					if (revision !== loadRevision) return true;
					teamSetupSummary = summary;
					teamSetupLoading = false;
					teamSetupUnavailable = false;
					renderTeamSetupUpdate();
					return true;
				},
				() => {
					if (revision !== loadRevision) return false;
					teamSetupLoading = false;
					teamSetupUnavailable = true;
					renderTeamSetupUpdate();
					return false;
				},
			);
		const [inventoryResult, intentResult, deviceInventoryResult, syncStatusResult] =
			await Promise.allSettled([
				dependencies.loadProjects(),
				dependencies.loadIntent(),
				dependencies.loadDeviceInventory(),
				dependencies.loadSyncStatus(false, "", { includeJoinRequests: false }),
			]);
		if (revision !== loadRevision) {
			if (!refreshOptions.requireTeamSetupSummary) return latestLoad ?? false;
			await teamSetupSummaryPromise;
			return false;
		}
		const deviceInventoryUnavailable = deviceInventoryResult.status === "rejected";
		if (deviceInventoryResult.status === "fulfilled") {
			lastDeviceInventory = deviceInventoryResult.value;
		}
		if (syncStatusResult.status === "fulfilled") {
			coordinatorEnrollmentIssueCount = coordinatorEnrollmentOpenIssueCount(syncStatusResult.value);
		}
		let sharingProjects: RecipientPolicyManagementProject[];
		let sharingIntent: api.RecipientPolicyIntentGraphV1;
		let sharingOptions: RecipientPolicySharingOptions;
		const loadSucceeded =
			inventoryResult.status === "fulfilled" && intentResult.status === "fulfilled";
		lastRequiredRefreshError = !loadSucceeded;
		lastDeviceInventoryUnavailable = deviceInventoryUnavailable;
		if (loadSucceeded) {
			const inventory = inventoryResult.value;
			const intent = intentResult.value;
			lastSuccessfulData = {
				intent,
				inventory,
			};
			sharingProjects = inventory.manageable;
			sharingIntent = intent;
			sharingOptions = {
				coordinatorEnrollmentIssueCount,
				deviceInventory: lastDeviceInventory,
				deviceInventoryUnavailable,
				onOpenTeamSetup: options.onOpenTeamSetup,
				onReviewDevices: options.onReviewDevices,
				received: inventory.received,
			};
			if (managementMount) {
				dependencies.mountManagement(managementMount, inventory.manageable, intent, {
					onCommitted: async () => {
						await loadRecipientPolicySharingData();
					},
				});
			}
		} else if (lastSuccessfulData) {
			const cached = lastSuccessfulData;
			sharingProjects = cached.inventory.manageable;
			sharingIntent = cached.intent;
			sharingOptions = {
				coordinatorEnrollmentIssueCount,
				deviceInventory: lastDeviceInventory,
				deviceInventoryUnavailable,
				onOpenTeamSetup: options.onOpenTeamSetup,
				onReviewDevices: options.onReviewDevices,
				received: cached.inventory.received,
				refreshError: true,
			};
		} else {
			sharingProjects = [];
			sharingIntent = EMPTY_RECIPIENT_POLICY_INTENT;
			sharingOptions = {
				deviceInventoryUnavailable,
				loadError: true,
			};
		}

		const renderSharing = () => {
			dependencies.mountSharing(sharingMount, sharingProjects, sharingIntent, {
				...sharingOptions,
				teamSetupSummary,
				teamSetupLoading,
				teamSetupUnavailable,
			});
		};
		renderSharing();
		renderTeamSetupUpdate = renderSharing;

		if (!loadSucceeded && managementMount) {
			dependencies.mountManagement(managementMount, [], EMPTY_RECIPIENT_POLICY_INTENT, {
				loadError: true,
			});
		}
		if (!refreshOptions.requireTeamSetupSummary) return loadSucceeded;
		const teamSetupSucceeded = await teamSetupSummaryPromise;
		if (revision !== loadRevision) return false;
		return loadSucceeded && teamSetupSucceeded;
	}

	return loadRecipientPolicySharingData;
}

export interface RecipientPolicySharingRefreshOptions {
	requireTeamSetupSummary?: boolean;
}

export type RecipientPolicySharingRefresh = (
	options?: RecipientPolicySharingRefreshOptions,
) => Promise<boolean>;
