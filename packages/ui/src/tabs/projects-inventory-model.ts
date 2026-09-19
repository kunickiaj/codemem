import type {
	ProjectScopeGuardrailWarning,
	ProjectScopeInventoryProject,
	SharingDomainScope,
} from "../lib/api/sync";

export interface ProjectInventoryRecipientViewModel {
	key: string;
	kind: "Team" | "Identity";
	displayName: string;
}

export interface ProjectInventoryProjectViewModel {
	kind: "project";
	key: string;
	detailKey: string;
	project: ProjectScopeInventoryProject;
	manageable: boolean;
	selected: boolean;
	shareEligible: boolean;
	shareReady: boolean;
	detailsOpen: boolean;
	draftScopeId: string | null;
	pendingConfirmation: {
		requiredGuardrailTokens: string[];
		scopeId: string;
		warnings: ProjectScopeGuardrailWarning[];
	} | null;
	pendingForgetConfirmation: {
		confirmationToken: string;
		localOwnedMemoryCount: number;
		peerOwnedMemoryCount: number;
	} | null;
	recipients: ProjectInventoryRecipientViewModel[];
}

export interface ProjectInventoryClusterViewModel {
	kind: "cluster";
	key: string;
	label: string;
	projects: ProjectInventoryProjectViewModel[];
	projectIds: string[];
	selectedProjectIds: string[];
	detailsOpen: boolean;
	draftScopeId: string | null;
	recipients: ProjectInventoryRecipientViewModel[];
}

export interface ProjectsInventoryViewModel {
	rows: Array<ProjectInventoryProjectViewModel | ProjectInventoryClusterViewModel>;
	recipientPolicyReady: boolean;
	shareInventoryReady: boolean;
	scopeLabels: Record<string, string>;
	selection: {
		projectIds: string[];
		count: number;
		ready: boolean;
	};
	pagination: {
		offset: number;
		limit: number;
		total: number;
		hasMore: boolean;
	};
	scopeGroups: Array<{ label: string; scopes: SharingDomainScope[] }>;
	statusOptions: Array<{ label: string; value: string }>;
}

export interface ProjectInventoryCallbacks {
	toggleSelection(projectIds: string[]): void;
	shareProject(projectIdentity: string): void;
	manageRecipients(projectIds: string[]): void;
	setProjectDetailsOpen(key: string, open: boolean): void;
	setClusterDetailsOpen(key: string, open: boolean): void;
	setProjectScopeDraft(projectIdentity: string, scopeId: string): void;
	setClusterScopeDraft(clusterKey: string, scopeId: string): void;
	saveProjectScope(projectIdentity: string, scopeId: string): Promise<void>;
	saveClusterScope(clusterKey: string, scopeId: string): Promise<void>;
	removeProjectScope(projectIdentity: string): Promise<void>;
	keepProjectLocal(projectIdentity: string): Promise<void>;
	reassignProject(projectIdentity: string): Promise<void>;
	forgetProject(projectIdentity: string, confirmed?: boolean): Promise<void>;
	confirmProjectScope(projectIdentity: string): Promise<void>;
	cancelProjectScopeConfirmation(projectIdentity: string): void;
	cancelProjectForgetConfirmation(projectIdentity: string): void;
	onSpaceSelectBlur(): void;
}

export interface ProjectsInventoryController {
	getViewModel(): ProjectsInventoryViewModel;
	subscribe(listener: (viewModel: ProjectsInventoryViewModel) => void): () => void;
	callbacks: ProjectInventoryCallbacks;
}
