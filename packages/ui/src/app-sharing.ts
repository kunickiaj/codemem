import * as api from "./lib/api";
import type { ProjectScopeInventoryProject } from "./lib/api/sync";
import { coordinatorEnrollmentOpenIssueCount } from "./lib/coordinator-enrollment-attention";
import type { ReadRequestOptions } from "./lib/read-request";
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

async function loadRecipientPolicyProjects(
	options: ReadRequestOptions = {},
): Promise<RecipientPolicyProjectInventory> {
	const projects: ProjectScopeInventoryProject[] = [];
	let offset = 0;
	while (true) {
		const page = await api.loadProjectScopeInventory({
			limit: 250,
			offset,
			signal: options.signal,
		});
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
	loadProjects: (options?: ReadRequestOptions) => Promise<RecipientPolicyProjectInventory>;
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

interface RecipientPolicySharingLoaderOptions {
	onNavigateAdvancedSync?: () => void;
	onOpenTeamSetup?: (candidateRef: string) => void;
	onReviewDevices?: (deviceId?: string) => void;
}

interface RecipientPolicySharingLoaderState {
	loadRevision: number;
	latestLoad: Promise<boolean> | null;
	coordinatorEnrollmentIssueCount: number;
	lastDeviceInventory: Awaited<ReturnType<typeof api.loadDeviceIdentityInventory>> | undefined;
	teamSetupSummary: api.LegacyTeamSetupSummaryResponseV1 | undefined;
	teamSetupLoading: boolean;
	teamSetupUnavailable: boolean;
	lastRequiredRefreshError: boolean;
	lastDeviceInventoryUnavailable: boolean;
	lastSuccessfulData: {
		inventory: RecipientPolicyProjectInventory;
		intent: api.RecipientPolicyIntentGraphV1;
	} | null;
}

interface RecipientPolicySharingLoaderContext {
	dependencies: RecipientPolicySharingLoaderDependencies;
	options: RecipientPolicySharingLoaderOptions;
	state: RecipientPolicySharingLoaderState;
}

interface SharingLoadData {
	projects: RecipientPolicyManagementProject[];
	intent: api.RecipientPolicyIntentGraphV1;
	options: RecipientPolicySharingOptions;
	loadSucceeded: boolean;
}

function createRecipientPolicySharingLoaderState(): RecipientPolicySharingLoaderState {
	return {
		loadRevision: 0,
		latestLoad: null,
		coordinatorEnrollmentIssueCount: 0,
		lastDeviceInventory: undefined,
		teamSetupSummary: undefined,
		teamSetupLoading: false,
		teamSetupUnavailable: false,
		lastRequiredRefreshError: false,
		lastDeviceInventoryUnavailable: false,
		lastSuccessfulData: null,
	};
}

function createInitialTeamSetupRenderer(
	context: RecipientPolicySharingLoaderContext,
	refresh: RecipientPolicySharingRefresh,
	sharingMount: HTMLElement,
): () => void {
	return () => {
		const { dependencies, options, state } = context;
		const cached = state.lastSuccessfulData;
		const sharingOptions: RecipientPolicySharingOptions = cached
			? {
					coordinatorEnrollmentIssueCount: state.coordinatorEnrollmentIssueCount,
					deviceInventory: state.lastDeviceInventory,
					deviceInventoryUnavailable: state.lastDeviceInventoryUnavailable,
					onNavigateAdvancedSync: options.onNavigateAdvancedSync,
					onOpenTeamSetup: options.onOpenTeamSetup,
					onReviewDevices: options.onReviewDevices,
					onTeamRenamed: () => refresh({ requireTeamSetupSummary: true }),
					received: cached.inventory.received,
					...(state.lastRequiredRefreshError ? { refreshError: true } : {}),
					teamSetupSummary: state.teamSetupSummary,
					teamSetupLoading: state.teamSetupLoading,
					teamSetupUnavailable: state.teamSetupUnavailable,
				}
			: {
					loading: true,
					onNavigateAdvancedSync: options.onNavigateAdvancedSync,
					teamSetupSummary: state.teamSetupSummary,
					teamSetupLoading: state.teamSetupLoading,
					teamSetupUnavailable: state.teamSetupUnavailable,
				};
		dependencies.mountSharing(
			sharingMount,
			cached?.inventory.manageable ?? [],
			cached?.intent ?? EMPTY_RECIPIENT_POLICY_INTENT,
			sharingOptions,
		);
	};
}

function beginTeamSetupLoad(
	context: RecipientPolicySharingLoaderContext,
	refresh: RecipientPolicySharingRefresh,
	sharingMount: HTMLElement,
	refreshOptions: RecipientPolicySharingRefreshOptions,
	isCurrent: () => boolean,
): {
	setRenderer: (renderer: () => void) => void;
	summaryPromise: Promise<boolean>;
} {
	const { dependencies, state } = context;
	state.teamSetupLoading = true;
	state.teamSetupUnavailable = false;
	let renderTeamSetupUpdate = createInitialTeamSetupRenderer(context, refresh, sharingMount);
	renderTeamSetupUpdate();
	const summaryPromise = Promise.resolve()
		.then(() => dependencies.loadTeamSetupSummary({ signal: refreshOptions.signal }))
		.then(
			(summary) => {
				if (!isCurrent()) return true;
				state.teamSetupSummary = summary;
				state.teamSetupLoading = false;
				state.teamSetupUnavailable = false;
				renderTeamSetupUpdate();
				return true;
			},
			() => {
				if (!isCurrent()) return false;
				state.teamSetupLoading = false;
				state.teamSetupUnavailable = true;
				renderTeamSetupUpdate();
				return false;
			},
		);
	return {
		setRenderer: (renderer) => {
			renderTeamSetupUpdate = renderer;
		},
		summaryPromise,
	};
}

function updateSharingLoaderAvailability(
	context: RecipientPolicySharingLoaderContext,
	deviceInventoryResult: PromiseSettledResult<
		Awaited<ReturnType<typeof api.loadDeviceIdentityInventory>>
	>,
	syncStatusResult: PromiseSettledResult<Awaited<ReturnType<typeof api.loadSyncStatus>>>,
): void {
	const { state } = context;
	state.lastDeviceInventoryUnavailable = deviceInventoryResult.status === "rejected";
	if (deviceInventoryResult.status === "fulfilled") {
		state.lastDeviceInventory = deviceInventoryResult.value;
	}
	if (syncStatusResult.status === "fulfilled") {
		state.coordinatorEnrollmentIssueCount = coordinatorEnrollmentOpenIssueCount(
			syncStatusResult.value,
		);
	}
}

function buildSharingLoadData(
	context: RecipientPolicySharingLoaderContext,
	refresh: RecipientPolicySharingRefresh,
	inventoryResult: PromiseSettledResult<RecipientPolicyProjectInventory>,
	intentResult: PromiseSettledResult<api.RecipientPolicyIntentGraphV1>,
): SharingLoadData {
	const { options, state } = context;
	const loadSucceeded =
		inventoryResult.status === "fulfilled" && intentResult.status === "fulfilled";
	state.lastRequiredRefreshError = !loadSucceeded;
	if (loadSucceeded) {
		const inventory = inventoryResult.value;
		const intent = intentResult.value;
		state.lastSuccessfulData = { intent, inventory };
		return {
			projects: inventory.manageable,
			intent,
			options: {
				coordinatorEnrollmentIssueCount: state.coordinatorEnrollmentIssueCount,
				deviceInventory: state.lastDeviceInventory,
				deviceInventoryUnavailable: state.lastDeviceInventoryUnavailable,
				onOpenTeamSetup: options.onOpenTeamSetup,
				onReviewDevices: options.onReviewDevices,
				onTeamRenamed: () => refresh({ requireTeamSetupSummary: true }),
				received: inventory.received,
			},
			loadSucceeded: true,
		};
	}
	if (state.lastSuccessfulData) {
		const cached = state.lastSuccessfulData;
		return {
			projects: cached.inventory.manageable,
			intent: cached.intent,
			options: {
				coordinatorEnrollmentIssueCount: state.coordinatorEnrollmentIssueCount,
				deviceInventory: state.lastDeviceInventory,
				deviceInventoryUnavailable: state.lastDeviceInventoryUnavailable,
				onOpenTeamSetup: options.onOpenTeamSetup,
				onReviewDevices: options.onReviewDevices,
				onTeamRenamed: () => refresh({ requireTeamSetupSummary: true }),
				received: cached.inventory.received,
				refreshError: true,
			},
			loadSucceeded: false,
		};
	}
	return {
		projects: [],
		intent: EMPTY_RECIPIENT_POLICY_INTENT,
		options: {
			deviceInventoryUnavailable: state.lastDeviceInventoryUnavailable,
			loadError: true,
		},
		loadSucceeded: false,
	};
}

function renderSharingLoad(
	context: RecipientPolicySharingLoaderContext,
	refresh: RecipientPolicySharingRefresh,
	sharingMount: HTMLElement,
	managementMount: HTMLElement | null,
	data: SharingLoadData,
): () => void {
	const { dependencies, options, state } = context;
	if (data.loadSucceeded && managementMount) {
		dependencies.mountManagement(managementMount, data.projects, data.intent, {
			onCommitted: async () => {
				await refresh();
			},
		});
	}
	const renderSharing = () => {
		dependencies.mountSharing(sharingMount, data.projects, data.intent, {
			...data.options,
			onNavigateAdvancedSync: options.onNavigateAdvancedSync,
			teamSetupSummary: state.teamSetupSummary,
			teamSetupLoading: state.teamSetupLoading,
			teamSetupUnavailable: state.teamSetupUnavailable,
		});
	};
	renderSharing();
	if (!data.loadSucceeded && managementMount) {
		dependencies.mountManagement(managementMount, [], EMPTY_RECIPIENT_POLICY_INTENT, {
			loadError: true,
		});
	}
	return renderSharing;
}

async function loadRecipientPolicySharingData(
	context: RecipientPolicySharingLoaderContext,
	refresh: RecipientPolicySharingRefresh,
	revision: number,
	refreshOptions: RecipientPolicySharingRefreshOptions,
): Promise<boolean> {
	const sharingMount = document.getElementById("recipientPolicySharingMount");
	if (!sharingMount) return loadRecipientPolicyWithoutMount(context.dependencies, refreshOptions);
	const { dependencies, state } = context;
	const isCurrent = () => !refreshOptions.signal?.aborted && revision === state.loadRevision;
	const managementMount = document.getElementById("recipientPolicyManagementMount");
	const teamSetup = beginTeamSetupLoad(context, refresh, sharingMount, refreshOptions, isCurrent);
	const [inventoryResult, intentResult, deviceInventoryResult, syncStatusResult] =
		await Promise.allSettled([
			dependencies.loadProjects({ signal: refreshOptions.signal }),
			dependencies.loadIntent({ signal: refreshOptions.signal }),
			dependencies.loadDeviceInventory({ signal: refreshOptions.signal }),
			dependencies.loadSyncStatus(false, "", {
				includeJoinRequests: false,
				signal: refreshOptions.signal,
			}),
		]);
	if (!isCurrent()) {
		if (refreshOptions.signal?.aborted) return false;
		if (!waitsForTeamSetupSummary(refreshOptions)) return state.latestLoad ?? false;
		await teamSetup.summaryPromise;
		return false;
	}
	updateSharingLoaderAvailability(context, deviceInventoryResult, syncStatusResult);
	const data = buildSharingLoadData(context, refresh, inventoryResult, intentResult);
	const renderSharing = renderSharingLoad(context, refresh, sharingMount, managementMount, data);
	teamSetup.setRenderer(renderSharing);
	return finishRecipientPolicySharingLoad({
		isCurrent,
		loadSucceeded: data.loadSucceeded,
		options: refreshOptions,
		teamSetupSummaryPromise: teamSetup.summaryPromise,
	});
}

async function loadRecipientPolicyWithoutMount(
	dependencies: RecipientPolicySharingLoaderDependencies,
	options: RecipientPolicySharingRefreshOptions,
): Promise<boolean> {
	if (!options.awaitTeamSetupSummary && !options.requireTeamSetupSummary) return true;
	try {
		await dependencies.loadTeamSetupSummary({ signal: options.signal });
		return !options.signal?.aborted;
	} catch {
		return !options.requireTeamSetupSummary && !options.signal?.aborted;
	}
}

function finishRecipientPolicySharingLoad(input: {
	isCurrent: () => boolean;
	loadSucceeded: boolean;
	options: RecipientPolicySharingRefreshOptions;
	teamSetupSummaryPromise: Promise<boolean>;
}): boolean | Promise<boolean> {
	if (!input.options.awaitTeamSetupSummary && !input.options.requireTeamSetupSummary)
		return input.loadSucceeded;
	return input.teamSetupSummaryPromise.then((teamSetupSucceeded) => {
		if (!input.isCurrent()) return false;
		return input.loadSucceeded && (!input.options.requireTeamSetupSummary || teamSetupSucceeded);
	});
}

function waitsForTeamSetupSummary(options: RecipientPolicySharingRefreshOptions): boolean {
	return options.awaitTeamSetupSummary === true || options.requireTeamSetupSummary === true;
}

export function createRecipientPolicySharingLoader(
	overrides: Partial<RecipientPolicySharingLoaderDependencies> = {},
	options: RecipientPolicySharingLoaderOptions = {},
): RecipientPolicySharingRefresh {
	const context: RecipientPolicySharingLoaderContext = {
		dependencies: { ...defaultDependencies, ...overrides },
		options,
		state: createRecipientPolicySharingLoaderState(),
	};
	const refresh: RecipientPolicySharingRefresh = (refreshOptions = {}) => {
		const revision = ++context.state.loadRevision;
		const operation = loadRecipientPolicySharingData(context, refresh, revision, refreshOptions);
		context.state.latestLoad = operation;
		return operation;
	};
	return refresh;
}

export interface RecipientPolicySharingRefreshOptions {
	awaitTeamSetupSummary?: boolean;
	requireTeamSetupSummary?: boolean;
	signal?: AbortSignal;
}

export type RecipientPolicySharingRefresh = (
	options?: RecipientPolicySharingRefreshOptions,
) => Promise<boolean>;
