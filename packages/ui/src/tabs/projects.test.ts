import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
	deleteSharingDomainProjectMapping: vi.fn(),
	forgetProjectInventoryMemories: vi.fn(),
	loadProjects: vi.fn(),
	loadCoordinatorAdminGroupsFiltered: vi.fn(),
	loadCoordinatorAdminStatus: vi.fn(),
	loadLegacyTeamSetupSummary: vi.fn(),
	loadProjectScopeInventory: vi.fn(),
	loadRecipientPolicyIntent: vi.fn(),
	loadRecipientPolicyReview: vi.fn(),
	loadSharingDomainSettings: vi.fn(),
	reassignProjectInventoryProject: vi.fn(),
	saveSharingDomainProjectMapping: vi.fn(),
	ProjectForgetConfirmationError: class ProjectForgetConfirmationError extends Error {
		preview: {
			confirmation_token: string;
			local_owned_memory_count: number;
			peer_owned_memory_count: number;
			workspace_identity: string;
		};

		constructor(preview: {
			confirmation_token: string;
			local_owned_memory_count: number;
			peer_owned_memory_count: number;
			workspace_identity: string;
		}) {
			super("Project forget confirmation required");
			this.preview = preview;
		}
	},
	RecipientPolicyReviewStaleError: class RecipientPolicyReviewStaleError extends Error {
		result: unknown;

		constructor(result: unknown) {
			super("Recipient policy review source state changed");
			this.result = result;
		}
	},
	resolveRecipientPolicyReview: vi.fn(),
	resolveRecipientPolicyReviewBulk: vi.fn(),
	saveSharingDomainProjectMappings: vi.fn(),
	SharingDomainGuardrailConfirmationError: class SharingDomainGuardrailConfirmationError extends Error {
		requiredGuardrailTokens: string[];
		guardrailWarnings: Array<{ code?: string; message: string }>;

		constructor(input: {
			required_guardrail_tokens?: string[];
			guardrail_warnings?: Array<{ code?: string; message: string }>;
		}) {
			super("Sharing domain guardrail confirmation required");
			this.requiredGuardrailTokens = input.required_guardrail_tokens ?? [];
			this.guardrailWarnings = input.guardrail_warnings ?? [];
		}
	},
}));

vi.mock("../lib/notice", () => ({ showGlobalNotice: vi.fn() }));
vi.mock("./project-sharing", () => ({
	openProjectShareFlow: vi.fn(),
	renderProjectShareFlow: vi.fn(),
}));
vi.mock("./recipient-policy-management", () => ({
	mountRecipientPolicyManagement: vi.fn(),
	openRecipientPolicyManagement: vi.fn(),
}));
vi.mock("./sync/sync-dialogs", () => ({ openSyncInputDialog: vi.fn() }));

import * as api from "../lib/api";
import type {
	LegacyTeamSetupSummaryResponseV1,
	ProjectScopeInventoryProject,
	ProjectScopeInventoryResult,
	RecipientPolicyIntentGraphV1,
	RecipientPolicyReviewItemV1,
	RecipientPolicyReviewListV1,
} from "../lib/api/sync";
import { showGlobalNotice } from "../lib/notice";
import { state } from "../lib/state";
import * as projectSharing from "./project-sharing";
import {
	getProjectsInventoryController,
	initProjectsTab,
	loadProjectsData,
	type ProjectsInventoryViewModel,
} from "./projects";
import * as recipientPolicyManagement from "./recipient-policy-management";
import { openSyncInputDialog } from "./sync/sync-dialogs";

function project(
	overrides: Partial<ProjectScopeInventoryProject> = {},
): ProjectScopeInventoryProject {
	return {
		cwd: "/workspace/work/exampleco/api",
		display_project: "api",
		git_branch: "main",
		git_remote: "https://git.example.invalid/exampleco/api.git",
		guardrail_warnings: [],
		identity_source: "git_remote",
		latest_session_at: "2026-05-06T00:00:00Z",
		mapping_id: null,
		matched_pattern: null,
		memory_count: 1,
		project: "api",
		resolution_reason: "local_default",
		resolved_scope_id: "local-default",
		session_count: 1,
		statuses: ["local_only"],
		suggested_scope_id: null,
		suggestion_reason: null,
		suggestion_signal: null,
		workspace_identity: "https://git.example.invalid/exampleco/api.git",
		...overrides,
	};
}

function reviewItem(
	overrides: Partial<RecipientPolicyReviewItemV1> = {},
): RecipientPolicyReviewItemV1 {
	const preview = {
		affectedDeviceCount: 2,
		affectedMemoryCount: 12,
		affectedProjectCount: 1,
		effect: "none" as const,
		effectiveDevices: [
			{
				assignment: "assigned" as const,
				deviceId: "private-device-id",
				displayName: "Adam’s Mac",
				identityId: "private-identity-id",
			},
			{
				assignment: "unassigned" as const,
				deviceId: "private-build-device-id",
				displayName: "Build host",
				identityId: null,
			},
		],
		projects: [{ canonicalIdentity: "private-project-id", displayName: "Codemem" }],
		requiresDecisionInput: false,
	};
	return {
		conditionCode: "suggest_local_identity",
		finding: "Older project sharing needs a decision.",
		options: [
			{
				affectedDeviceCount: 2,
				affectedMemoryCount: 12,
				affectedProjectCount: 1,
				decision: "keep_current_setup",
				effect: "none",
				label: "Keep current setup unchanged",
				preview,
			},
			{
				affectedDeviceCount: 2,
				affectedMemoryCount: 12,
				affectedProjectCount: 1,
				decision: "reject_suggestion",
				effect: "none",
				label: "Reject suggestion",
				preview,
			},
			{
				affectedDeviceCount: 2,
				affectedMemoryCount: 12,
				affectedProjectCount: 1,
				decision: "choose_recipients",
				effect: "metadata_only",
				label: "Choose recipients",
				preview: { ...preview, effect: "metadata_only", requiresDecisionInput: true },
			},
		],
		reason: "Review current recipient evidence for Codemem.",
		projectGroup: { displayName: "Codemem", identity: "private-project-id" },
		recommendedDecision: "keep_current_setup",
		resolution: null,
		reviewItemId: "review-1",
		sourceFingerprint: "fingerprint-1",
		state: "open",
		version: 1,
		...overrides,
	};
}

function recipientReview(
	overrides: Partial<RecipientPolicyReviewListV1> = {},
): RecipientPolicyReviewListV1 {
	const reviewItems = overrides.reviewItems ?? [reviewItem()];
	const blockedItems = overrides.blockedItems ?? [];
	const continuity =
		overrides.continuity === undefined
			? { findingCount: 1 as const, state: "legacy_access_preserved" as const }
			: overrides.continuity;
	const categoryCounts = overrides.categoryCounts ?? {
		actionableReview: reviewItems.length,
		preservedContinuity: Math.max(0, (continuity?.findingCount ?? 0) - reviewItems.length),
		blockedRepair: blockedItems.length,
	};
	return {
		blockedItems,
		categoryCounts,
		continuity,
		reviewItems,
		version: overrides.version ?? 1,
	};
}

function recipientIntent(
	overrides: Partial<RecipientPolicyIntentGraphV1> = {},
): RecipientPolicyIntentGraphV1 {
	return {
		version: 1,
		identities: [
			{
				version: 1,
				identityId: "identity-adam",
				displayName: "Adam",
				kind: "personal",
				verification: "local",
				status: "active",
				mergedIntoIdentityId: null,
			},
		],
		teams: [{ version: 1, teamId: "team-example", displayName: "ExampleCo", status: "active" }],
		teamMemberships: [],
		identityDevices: [],
		projectRecipients: [],
		...overrides,
	};
}

function mountProjectsDom() {
	document.body.innerHTML = `
		<input id="projectsSearch" />
		<select id="projectsStatusFilter"></select>
		<div id="projectsInventoryMeta"></div>
		<div id="projectsInventorySkeleton"></div>
		<div id="projectsInventoryList"></div>
		<div id="projectShareFlowMount"></div>
		<div id="recipientPolicyReviewMount"></div>
		<div id="recipientPolicyManagementMount"></div>
		<button id="projectsShareSelected"></button>
		<div id="projectsSelectionStatus"></div>
		<button id="projectsPrevPage"></button>
		<button id="projectsNextPage"></button>
	`;
}

async function flushAsyncWork() {
	for (let i = 0; i < 5; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function buttonNamed(name: string, root: ParentNode = document): HTMLButtonElement | undefined {
	return [...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.textContent?.trim() === name,
	);
}

function setupProjectsTest() {
	mountProjectsDom();
	state.lastProjectCoordinatorAdminGroups = [
		{ archived_at: null, display_name: "ExampleCo Team", group_id: "exampleco" },
	];
	vi.mocked(api.loadCoordinatorAdminStatus).mockResolvedValue({
		has_admin_secret: true,
		readiness: "ready",
	});
	vi.mocked(api.loadCoordinatorAdminGroupsFiltered).mockResolvedValue({
		items: [{ archived_at: null, display_name: "ExampleCo Team", group_id: "exampleco" }],
	});
	vi.mocked(api.loadSharingDomainSettings).mockResolvedValue({
		local_default_scope_id: "local-default",
		mappings: [],
		projects: [],
		scopes: [
			{
				authority_type: "local",
				kind: "system",
				label: "Local only",
				scope_id: "local-default",
				status: "active",
			},
			{
				authority_type: "local",
				kind: "system",
				label: "Legacy shared review",
				scope_id: "legacy-shared-review",
				status: "active",
			},
			{
				authority_type: "coordinator",
				group_id: "exampleco",
				kind: "team_default",
				label: "ExampleCo Work",
				scope_id: "exampleco-work",
				status: "active",
			},
		],
	});
	vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue({
		blockedItems: [],
		categoryCounts: {
			actionableReview: 0,
			preservedContinuity: 0,
			blockedRepair: 0,
		},
		continuity: null,
		reviewItems: [],
		version: 1,
	});
	vi.mocked(api.loadRecipientPolicyIntent).mockResolvedValue(recipientIntent());
	vi.mocked(api.loadLegacyTeamSetupSummary).mockResolvedValue({ version: 1, candidates: [] });
	vi.mocked(api.resolveRecipientPolicyReview).mockResolvedValue({
		errorCode: null,
		idempotent: false,
		reviewItemId: "review-1",
		sourceFingerprint: "fingerprint-1",
		status: "applied",
	});
	vi.mocked(api.resolveRecipientPolicyReviewBulk).mockResolvedValue({ version: 1, results: [] });
	vi.mocked(api.loadProjects).mockResolvedValue(["api", "codemem"]);
	vi.mocked(api.reassignProjectInventoryProject).mockResolvedValue({
		moved_memory_count: 1,
		moved_session_count: 1,
		previous_projects: ["api"],
		project: "codemem",
		workspace_identity: "https://git.example.invalid/exampleco/api.git",
	});
	vi.mocked(api.forgetProjectInventoryMemories).mockResolvedValue({
		confirmation_token: "token",
		confirmed: true,
		forgotten_memory_count: 1,
		local_owned_memory_count: 1,
		peer_owned_memory_count: 0,
		workspace_identity: "https://git.example.invalid/exampleco/api.git",
	});
}

function cleanupProjectsTest(): void {
	vi.clearAllMocks();
	state.lastProjectCoordinatorAdminGroups = [];
	state.lastCoordinatorAdminStatus = null;
	state.lastCoordinatorAdminGroups = [];
	document.body.innerHTML = "";
}

beforeEach(setupProjectsTest);
afterEach(cleanupProjectsTest);

describe("Projects tab", () => {
	it("shows empty inventory without bogus pagination range", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 25,
			offset: 0,
			projects: [],
			total: 0,
		});

		initProjectsTab(() => {});
		await loadProjectsData();

		expect(document.getElementById("projectsInventoryMeta")?.textContent).toBe("0 projects");
		expect(document.body.textContent).not.toContain("showing 1-0");
		expect(api.loadProjectScopeInventory).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 250 }),
		);
		expect(document.getElementById("projectsInventorySkeleton")).toBeNull();
	});

	it("keeps Advanced recovery snapshots untouched when Project Team-name refresh fails", async () => {
		state.lastCoordinatorAdminStatus = {
			active_group: "retained-group",
			readiness: "ready",
		};
		state.lastCoordinatorAdminGroups = [
			{ archived_at: null, display_name: "Retained Team", group_id: "retained-group" },
		];
		vi.mocked(api.loadCoordinatorAdminStatus).mockRejectedValue(
			new Error("project refresh failed"),
		);
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 25,
			offset: 0,
			projects: [],
			total: 0,
		});

		initProjectsTab(() => {});
		await loadProjectsData();
		await flushAsyncWork();

		expect(state.lastCoordinatorAdminStatus?.active_group).toBe("retained-group");
		expect(state.lastCoordinatorAdminGroups).toEqual([
			{ archived_at: null, display_name: "Retained Team", group_id: "retained-group" },
		]);
		expect(state.lastProjectCoordinatorAdminGroups).toEqual([]);
	});
});

function projectsRecipientPolicyReviewSurfaceTests(): void {
	it("omits preserved continuity from mixed review and repair state", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue({
			...recipientReview(),
			blockedItems: [
				{
					blockedItemId: "blocked-1",
					finding: "Project identity is unstable.",
					ownerLabel: "Project owner",
					reason: "Codemem requires source-state repair.",
					repairAction: "Assign a stable canonical Project identity.",
					repair: {
						kind: "reassign_project",
						projectIdentity: "/workspace/unstable",
						label: "Repair Project identity…",
					},
					version: 1,
				},
			],
			categoryCounts: {
				actionableReview: 1,
				preservedContinuity: 36,
				blockedRepair: 1,
			},
			continuity: { findingCount: 37, state: "legacy_access_preserved" },
		});

		await loadProjectsData();

		const surface = document.querySelector(".recipient-policy-review");
		expect(surface?.textContent).toContain("Sharing decisions 1");
		expect(surface?.textContent).toContain("Unapplied");
		expect(surface?.textContent).toContain("Blocked repairs 1");
		expect(surface?.textContent).not.toContain("Preserved legacy continuity");
		expect(surface?.textContent).not.toContain("preserved legacy findings");
		const reviewCopy = surface?.querySelector(".recipient-policy-review-decisions")?.textContent;
		expect(reviewCopy).toContain("Suggested: Keep current setup unchanged");
		expect(surface?.querySelector<HTMLDivElement>(".recipient-policy-review-details")?.hidden).toBe(
			true,
		);
		expect(reviewCopy).not.toContain("Action is required");
		expect(surface?.textContent).toContain("Owner: Project owner");
		expect(surface?.querySelectorAll("button")).toHaveLength(4);
		expect(surface?.textContent).toContain("Repair Project identity…");
		expect(
			document.querySelectorAll(
				".recipient-policy-review-decisions > .recipient-policy-review-item",
			),
		).toHaveLength(1);
		expect(buttonNamed("Apply")).toBeDefined();
		expect(document.querySelector(".recipient-policy-review-continuity")).toBeNull();
	});

	it("renders sharing-decision load errors", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		vi.mocked(api.loadRecipientPolicyReview).mockRejectedValue(new Error("Review unavailable"));

		await loadProjectsData();

		const surface = document.querySelector(".recipient-policy-review");
		expect(surface?.querySelector("h2")?.textContent).toBe("Sharing decisions");
		expect(surface?.querySelector('[role="status"]')?.textContent).toContain("Review unavailable");
	});
}

describe("Projects recipient policy review surface", projectsRecipientPolicyReviewSurfaceTests);

function projectsRecipientPolicyGroupedResolutionTests(): void {
	it("groups repository worktrees and applies one decision with every item fingerprint", async () => {
		const first = reviewItem({
			projectGroup: { displayName: "Codemem", identity: "https://example.test/codemem.git" },
		});
		const second = reviewItem({
			projectGroup: { displayName: "Codemem", identity: "https://example.test/codemem.git" },
			reviewItemId: "review-2",
			sourceFingerprint: "fingerprint-2",
			options: first.options.map((option) => ({
				...option,
				preview: {
					...option.preview,
					affectedMemoryCount: 3,
					projects: [{ canonicalIdentity: "/worktrees/second", displayName: "Codemem" }],
				},
			})),
		});
		first.options = first.options.map((option) => ({
			...option,
			preview: {
				...option.preview,
				projects: [{ canonicalIdentity: "/worktrees/first", displayName: "Codemem" }],
			},
		}));
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		vi.mocked(api.loadRecipientPolicyReview)
			.mockResolvedValueOnce(recipientReview({ reviewItems: [first, second] }))
			.mockResolvedValue(recipientReview({ reviewItems: [] }));
		vi.mocked(api.resolveRecipientPolicyReviewBulk).mockResolvedValue({
			version: 1,
			results: [
				{
					errorCode: null,
					idempotent: false,
					reviewItemId: "review-1",
					sourceFingerprint: "fingerprint-1",
					status: "applied",
				},
				{
					errorCode: null,
					idempotent: false,
					reviewItemId: "review-2",
					sourceFingerprint: "fingerprint-2",
					status: "applied",
				},
			],
		});

		await loadProjectsData();

		expect(document.querySelectorAll(".recipient-policy-review-item")).toHaveLength(1);
		expect(document.body.textContent).toContain("2 worktrees");
		expect(document.querySelector<HTMLDivElement>(".recipient-policy-review-details")?.hidden).toBe(
			true,
		);
		const decisions = document.querySelector(".recipient-policy-review-decisions");
		if (!decisions) throw new Error("review decisions missing");
		buttonNamed("Details", decisions)?.click();
		expect(document.body.textContent).toContain("/worktrees/first");
		expect(document.body.textContent).toContain("/worktrees/second");
		expect(document.body.textContent).toContain("Affected: 2 Projects · 15 memories · 2 devices");
		buttonNamed("Apply")?.click();
		await flushAsyncWork();

		expect(api.resolveRecipientPolicyReviewBulk).toHaveBeenCalledWith([
			{
				decision: "keep_current_setup",
				reviewItemId: "review-1",
				sourceFingerprint: "fingerprint-1",
			},
			{
				decision: "keep_current_setup",
				reviewItemId: "review-2",
				sourceFingerprint: "fingerprint-2",
			},
		]);
		expect(document.querySelector(".recipient-policy-review-item")).toBeNull();
	});
}

describe(
	"Projects recipient policy grouped resolution",
	projectsRecipientPolicyGroupedResolutionTests,
);

function projectsRecipientPolicyBulkTests(): void {
	it("chunks repository decisions to the bulk endpoint limit", async () => {
		const reviewItems = Array.from({ length: 101 }, (_, index) =>
			reviewItem({
				projectGroup: {
					displayName: "Codemem",
					identity: "https://example.test/codemem.git",
				},
				reviewItemId: `review-${index}`,
				sourceFingerprint: `fingerprint-${index}`,
			}),
		);
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		vi.mocked(api.loadRecipientPolicyReview)
			.mockResolvedValueOnce(recipientReview({ reviewItems }))
			.mockResolvedValue(recipientReview({ reviewItems: [] }));
		vi.mocked(api.resolveRecipientPolicyReviewBulk).mockImplementation(async (requests) => ({
			version: 1,
			results: requests.map((request) => ({
				errorCode: null,
				idempotent: false,
				reviewItemId: request.reviewItemId,
				sourceFingerprint: request.sourceFingerprint,
				status: "applied" as const,
			})),
		}));

		await loadProjectsData();
		buttonNamed("Apply")?.click();
		await flushAsyncWork();

		expect(api.resolveRecipientPolicyReviewBulk).toHaveBeenCalledTimes(2);
		expect(vi.mocked(api.resolveRecipientPolicyReviewBulk).mock.calls[0]?.[0]).toHaveLength(100);
		expect(vi.mocked(api.resolveRecipientPolicyReviewBulk).mock.calls[1]?.[0]).toHaveLength(1);
	});

	it("refreshes after a later repository decision batch fails", async () => {
		const reviewItems = Array.from({ length: 101 }, (_, index) =>
			reviewItem({
				projectGroup: {
					displayName: "Codemem",
					identity: "https://example.test/codemem.git",
				},
				reviewItemId: `review-${index}`,
				sourceFingerprint: `fingerprint-${index}`,
			}),
		);
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		vi.mocked(api.loadRecipientPolicyReview)
			.mockResolvedValueOnce(recipientReview({ reviewItems }))
			.mockResolvedValue(
				recipientReview({ reviewItems: [reviewItems[100] as RecipientPolicyReviewItemV1] }),
			);
		vi.mocked(api.resolveRecipientPolicyReviewBulk)
			.mockImplementationOnce(async (requests) => ({
				version: 1,
				results: requests.map((request) => ({
					errorCode: null,
					idempotent: false,
					reviewItemId: request.reviewItemId,
					sourceFingerprint: request.sourceFingerprint,
					status: "applied" as const,
				})),
			}))
			.mockRejectedValueOnce(new Error("Second batch failed"));

		await loadProjectsData();
		buttonNamed("Apply")?.click();
		await flushAsyncWork();

		expect(api.loadRecipientPolicyReview).toHaveBeenCalledTimes(2);
		expect(document.querySelectorAll(".recipient-policy-review-item")).toHaveLength(1);
		expect(document.body.textContent).toContain("Second batch failed");
	});
}

describe("Projects recipient policy bulk resolution", projectsRecipientPolicyBulkTests);

function projectsRecipientPolicySafetyTests(): void {
	it("explains required recipient input without submitting an incomplete decision", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(recipientReview());

		await loadProjectsData();
		const select = document.querySelector<HTMLSelectElement>(".recipient-policy-review-select");
		const submit = buttonNamed("Apply");
		if (!select || !submit) throw new Error("review decision controls missing");
		select.value = "choose_recipients";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		buttonNamed("Details")?.click();

		expect(submit.disabled).toBe(true);
		expect(document.body.textContent).toContain("Choose recipients first (Update sharing, below)");
		submit.click();
		expect(api.resolveRecipientPolicyReview).not.toHaveBeenCalled();
	});

	it("keeps stale findings open and refreshes their fingerprints", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		vi.mocked(api.loadRecipientPolicyReview)
			.mockResolvedValueOnce(recipientReview())
			.mockResolvedValue(
				recipientReview({
					reviewItems: [reviewItem({ sourceFingerprint: "fingerprint-refreshed" })],
				}),
			);
		vi.mocked(api.resolveRecipientPolicyReview).mockRejectedValueOnce(
			new api.RecipientPolicyReviewStaleError({
				errorCode: "source_fingerprint_stale",
				idempotent: false,
				reviewItemId: "review-1",
				sourceFingerprint: "fingerprint-1",
				status: "stale",
			}),
		);

		await loadProjectsData();
		buttonNamed("Apply")?.click();
		await flushAsyncWork();

		expect(document.querySelector(".recipient-policy-review-item")).not.toBeNull();
		expect(document.body.textContent).toContain("Changed since loaded");
		expect(api.loadRecipientPolicyReview).toHaveBeenCalledTimes(2);
	});

	it("restores review-control focus after source data refreshes", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		vi.mocked(api.loadRecipientPolicyReview)
			.mockResolvedValueOnce(recipientReview())
			.mockResolvedValueOnce(
				recipientReview({
					reviewItems: [reviewItem({ sourceFingerprint: "fingerprint-refreshed" })],
				}),
			);

		await loadProjectsData();
		const original = document.querySelector<HTMLSelectElement>(".recipient-policy-review-select");
		if (original) {
			original.value = "reject_suggestion";
			original.dispatchEvent(new Event("change"));
		}
		original?.focus();
		await loadProjectsData();

		const refreshed = document.querySelector<HTMLSelectElement>(".recipient-policy-review-select");
		expect(refreshed).toBe(original);
		expect(refreshed?.value).toBe("reject_suggestion");
		expect(document.activeElement).toBe(refreshed);
	});
}

describe("Projects recipient policy safety", projectsRecipientPolicySafetyTests);

function projectsRecipientPolicyResultEdgeCaseTests(): void {
	it("re-enables unchanged grouped controls after a non-applied bulk result", async () => {
		const second = reviewItem({ reviewItemId: "review-2", sourceFingerprint: "fingerprint-2" });
		const review = recipientReview({ reviewItems: [reviewItem(), second] });
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(review);
		vi.mocked(api.resolveRecipientPolicyReviewBulk).mockResolvedValue({
			version: 1,
			results: [
				{
					errorCode: "resolution_conflict",
					idempotent: false,
					reviewItemId: "review-1",
					sourceFingerprint: "fingerprint-1",
					status: "conflict",
				},
			],
		});

		await loadProjectsData();
		buttonNamed("Apply")?.click();
		await flushAsyncWork();

		expect(
			document.querySelector<HTMLSelectElement>(".recipient-policy-review-select")?.disabled,
		).toBe(false);
		expect(buttonNamed("Apply")?.disabled).toBe(false);
		expect(document.body.textContent).not.toContain("Applying…");
	});

	it("counts a project's memories once across device-scoped review items", async () => {
		const first = reviewItem({ conditionCode: "unassigned_effective_device" });
		const second = reviewItem({
			conditionCode: "unassigned_effective_device",
			reviewItemId: "review-2",
			sourceFingerprint: "fingerprint-2",
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(
			recipientReview({ reviewItems: [first, second] }),
		);

		await loadProjectsData();

		expect(document.body.textContent).toContain("Affected: 1 Project · 12 memories · 2 devices");
		expect(document.body.textContent).not.toContain("24 memories");
	});
}

describe("Projects recipient policy result edge cases", projectsRecipientPolicyResultEdgeCaseTests);

function projectsInventoryTablePresentationTests(): void {
	beforeEach(setupProjectsTest);
	afterEach(cleanupProjectsTest);

	it("renders active Team and Identity recipients with only recipient management primary", async () => {
		const selected = project({
			display_project: "codemem",
			workspace_identity: "project-codemem",
			git_remote: "https://git.example.invalid/exampleco/codemem.git",
		});
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [selected],
			total: 1,
		});
		vi.mocked(api.loadRecipientPolicyIntent).mockResolvedValue(
			recipientIntent({
				projectRecipients: [
					{
						version: 1,
						canonicalProjectIdentity: "project-codemem",
						recipientKind: "team",
						teamId: "team-example",
						intentSource: "user",
						policyRevision: "one",
						status: "active",
					},
					{
						version: 1,
						canonicalProjectIdentity: "project-codemem",
						recipientKind: "identity",
						identityId: "identity-adam",
						intentSource: "user",
						policyRevision: "two",
						status: "active",
					},
				],
			}),
		);

		await loadProjectsData();

		const row = document.querySelector<HTMLElement>(".project-inventory-row");
		if (!row) throw new Error("project row missing");
		expect(row.querySelector(".project-recipient-status")).toBeNull();
		expect(
			[...row.querySelectorAll(".project-recipient-chip")].map((chip) => chip.textContent),
		).toEqual(["Identity: Adam", "Team: ExampleCo"]);
		const updateSharing = row.querySelector<HTMLButtonElement>(
			'button[aria-label="Update sharing for codemem"]',
		);
		expect(updateSharing?.textContent).toBe("Update sharing");
		expect(row.querySelector('button[aria-label="More actions for codemem"]')).not.toBeNull();
		expect(row.querySelector("details")?.textContent).toContain("Share");
		const normalCopy = row.cloneNode(true) as HTMLElement;
		normalCopy.querySelector("details")?.remove();
		expect(normalCopy.textContent).not.toContain(selected.workspace_identity);
		expect(normalCopy.textContent).not.toContain("Space");

		row.querySelector<HTMLButtonElement>(".project-recipient-action")?.click();
		expect(recipientPolicyManagement.openRecipientPolicyManagement).toHaveBeenCalledWith({
			mode: "project-manage",
			projectId: "project-codemem",
		});
	});
}

describe("Projects inventory table presentation", projectsInventoryTablePresentationTests);

{
	function blockedRepairButton(): HTMLButtonElement | null {
		return document.querySelector<HTMLButtonElement>(
			".recipient-policy-blocked-item button[aria-describedby]",
		);
	}

	it("preserves a focused repair when only hidden continuity data changes", async () => {
		const initialReviewItem = reviewItem();
		const blockedItem = {
			blockedItemId: "blocked-1",
			finding: "Project identity is unstable.",
			ownerLabel: "Project owner",
			reason: "Codemem requires source-state repair.",
			repairAction: "Assign a stable canonical Project identity.",
			repair: {
				kind: "reassign_project" as const,
				projectIdentity: "/workspace/unstable",
				label: "Repair Project identity…",
			},
			version: 1 as const,
		};
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		vi.mocked(api.loadRecipientPolicyReview)
			.mockResolvedValueOnce(
				recipientReview({
					blockedItems: [blockedItem],
					categoryCounts: {
						actionableReview: 1,
						blockedRepair: 1,
						preservedContinuity: 1,
					},
					continuity: { findingCount: 1, state: "legacy_access_preserved" },
					reviewItems: [initialReviewItem],
				}),
			)
			.mockResolvedValueOnce(
				recipientReview({
					blockedItems: [blockedItem],
					categoryCounts: {
						actionableReview: 1,
						blockedRepair: 1,
						preservedContinuity: 2,
					},
					continuity: { findingCount: 2, state: "legacy_access_preserved" },
					reviewItems: [initialReviewItem],
				}),
			);

		await loadProjectsData();
		const surface = document.querySelector<HTMLElement>(".recipient-policy-review");
		const repair = surface?.querySelector<HTMLButtonElement>("button[aria-describedby]");
		repair?.focus();

		await loadProjectsData();

		expect(document.querySelector(".recipient-policy-review")).toBe(surface);
		expect(repair?.isConnected).toBe(true);
		expect(document.activeElement).toBe(repair);
	});

	it("routes an unfinished server Team candidate into guided setup without resolving recipient review", async () => {
		const onOpenTeamSetup = vi.fn();
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(recipientReview());
		vi.mocked(api.loadLegacyTeamSetupSummary).mockResolvedValue({
			version: 1,
			candidates: [
				{
					candidateRef: "opaque-candidate-ref",
					displayName: "Example Team",
					status: "in_progress",
					deviceCount: 2,
					projectCount: 1,
					unresolvedDeviceCount: 1,
					unresolvedProjectCount: 0,
				},
			],
		});

		initProjectsTab(() => {}, { onOpenTeamSetup });
		await loadProjectsData();
		const entry = document.querySelector<HTMLElement>(".project-team-setup-entry");
		expect(entry?.textContent).toContain("Finish setting up this Team");
		expect(entry?.textContent).toContain("Example Team");
		expect(entry?.querySelector("button")?.getAttribute("aria-label")).toBe(
			"Finish setting up Example Team",
		);
		entry?.querySelector<HTMLButtonElement>("button")?.click();

		expect(onOpenTeamSetup).toHaveBeenCalledWith("opaque-candidate-ref");
		expect(api.resolveRecipientPolicyReview).not.toHaveBeenCalled();
		expect(recipientPolicyManagement.openRecipientPolicyManagement).not.toHaveBeenCalled();
	});

	it("preserves the focused Team setup action while a refresh discovery is pending", async () => {
		const summary = {
			version: 1 as const,
			candidates: [
				{
					candidateRef: "opaque-candidate-ref",
					displayName: "Example Team",
					status: "in_progress" as const,
					deviceCount: 2,
					projectCount: 1,
					unresolvedDeviceCount: 1,
					unresolvedProjectCount: 0,
				},
			],
		};
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(recipientReview());
		vi.mocked(api.loadLegacyTeamSetupSummary).mockResolvedValueOnce(summary);
		initProjectsTab(() => {}, { onOpenTeamSetup: vi.fn() });

		await loadProjectsData();
		const entry = document.querySelector<HTMLElement>(".project-team-setup-entry");
		const button = entry?.querySelector<HTMLButtonElement>("button");
		button?.focus();
		let resolveSummary!: (value: typeof summary) => void;
		vi.mocked(api.loadLegacyTeamSetupSummary).mockImplementationOnce(
			() => new Promise((resolve) => (resolveSummary = resolve)),
		);

		await loadProjectsData();

		expect(document.querySelector(".project-team-setup-entry")).toBe(entry);
		expect(button?.isConnected).toBe(true);
		expect(document.activeElement).toBe(button);

		resolveSummary(summary);
		await vi.waitFor(() => expect(api.loadLegacyTeamSetupSummary).toHaveBeenCalledTimes(2));
		await flushAsyncWork();
		expect(document.querySelector(".project-team-setup-entry")).toBe(entry);
		expect(document.activeElement).toBe(button);

		vi.mocked(api.loadLegacyTeamSetupSummary).mockRejectedValueOnce(
			new Error("temporary discovery failure"),
		);
		await loadProjectsData();
		await vi.waitFor(() => expect(api.loadLegacyTeamSetupSummary).toHaveBeenCalledTimes(3));
		await flushAsyncWork();
		expect(document.querySelector(".project-team-setup-entry")).toBe(entry);
		expect(entry?.querySelector('[role="status"]')?.textContent).toBe(
			"Team setup status is temporarily unavailable. The previous Team setup status is being shown.",
		);
		expect(document.activeElement).toBe(button);

		vi.mocked(api.loadLegacyTeamSetupSummary).mockResolvedValueOnce({
			version: 1,
			candidates: [],
		});
		await loadProjectsData();
		await vi.waitFor(() => expect(document.querySelector(".project-team-setup-entry")).toBeNull());
		expect(document.activeElement).toBe(document.getElementById("projectsSearch"));
	});

	it("keeps Projects usable when guided Team setup discovery is unavailable", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project()],
			total: 1,
		});
		vi.mocked(api.loadLegacyTeamSetupSummary).mockRejectedValue(new Error("setup unavailable"));

		await loadProjectsData();

		expect(document.body.textContent).toContain("api");
		expect(document.querySelector(".project-team-setup-entry")).toBeNull();
		expect(document.getElementById("projectsInventoryMeta")?.textContent).toContain(
			"1 projects · 1–1",
		);
	});

	it("renders Projects before optional Team setup discovery finishes", async () => {
		let resolveTeamSetup!: (value: { version: 1; candidates: [] }) => void;
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project()],
			total: 1,
		});
		vi.mocked(api.loadLegacyTeamSetupSummary).mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveTeamSetup = resolve;
				}),
		);

		const loading = loadProjectsData();
		await vi.waitFor(() =>
			expect(document.getElementById("projectsInventoryMeta")?.textContent).toContain(
				"1 projects · 1–1",
			),
		);
		await loading;
		expect(document.querySelector(".project-team-setup-entry")).toBeNull();

		resolveTeamSetup({ version: 1, candidates: [] });
	});

	it("renders Projects but reports strict refresh failure after Team setup discovery fails", async () => {
		let rejectTeamSetup!: (reason?: unknown) => void;
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project()],
			total: 1,
		});
		vi.mocked(api.loadLegacyTeamSetupSummary).mockImplementation(
			() =>
				new Promise<LegacyTeamSetupSummaryResponseV1>((_, reject) => {
					rejectTeamSetup = reject;
				}),
		);

		const loading = loadProjectsData({ requireTeamSetupSummary: true });
		await vi.waitFor(() =>
			expect(document.getElementById("projectsInventoryMeta")?.textContent).toContain(
				"1 projects · 1–1",
			),
		);
		let settled = false;
		void loading.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		rejectTeamSetup(new Error("setup unavailable"));
		await expect(loading).resolves.toBe(false);
	});

	it("requires a fresh Team setup summary for a strict refresh", async () => {
		let resolveFirst!: (value: LegacyTeamSetupSummaryResponseV1) => void;
		let resolveSecond!: (value: LegacyTeamSetupSummaryResponseV1) => void;
		vi.mocked(api.loadLegacyTeamSetupSummary)
			.mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
			.mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));

		await expect(loadProjectsData()).resolves.toBe(true);
		const strictRefresh = loadProjectsData({ requireTeamSetupSummary: true });
		await vi.waitFor(() => expect(api.loadLegacyTeamSetupSummary).toHaveBeenCalledTimes(2));

		resolveSecond({ version: 1, candidates: [] });
		await expect(strictRefresh).resolves.toBe(true);
		resolveFirst({ version: 1, candidates: [] });
	});

	it("removes completed setup cards without disturbing an active Project domain selection", async () => {
		const select = document.createElement("select");
		select.className = "project-domain-select";
		document.body.appendChild(select);
		select.focus();
		const mount = document.getElementById("recipientPolicyReviewMount");
		if (!mount) throw new Error("review mount missing");
		const card = document.createElement("section");
		card.className = "project-team-setup-entry";
		mount.appendChild(card);
		vi.mocked(api.loadLegacyTeamSetupSummary).mockResolvedValueOnce({
			version: 1,
			candidates: [],
		});

		await expect(loadProjectsData({ requireTeamSetupSummary: true })).resolves.toBe(true);
		expect(api.loadLegacyTeamSetupSummary).toHaveBeenCalledOnce();
		expect(document.querySelector(".project-team-setup-entry")).toBeNull();
		expect(document.activeElement).toBe(select);
	});

	it("ignores an older focused-select Team setup summary", async () => {
		let resolveOlder!: (value: LegacyTeamSetupSummaryResponseV1) => void;
		let resolveNewer!: (value: LegacyTeamSetupSummaryResponseV1) => void;
		vi.mocked(api.loadLegacyTeamSetupSummary)
			.mockImplementationOnce(() => new Promise((resolve) => (resolveOlder = resolve)))
			.mockImplementationOnce(() => new Promise((resolve) => (resolveNewer = resolve)));
		const select = document.createElement("select");
		select.className = "project-domain-select";
		document.body.appendChild(select);
		select.focus();

		const olderRefresh = loadProjectsData({ requireTeamSetupSummary: true });
		await vi.waitFor(() => expect(api.loadLegacyTeamSetupSummary).toHaveBeenCalledOnce());
		select.remove();
		const newerRefresh = loadProjectsData({ requireTeamSetupSummary: true });
		await vi.waitFor(() => expect(api.loadLegacyTeamSetupSummary).toHaveBeenCalledTimes(2));

		resolveNewer({ version: 1, candidates: [] });
		await expect(newerRefresh).resolves.toBe(true);
		resolveOlder({
			version: 1,
			candidates: [
				{
					candidateRef: "opaque-candidate-ref",
					deviceCount: 1,
					displayName: "Stale Team",
					projectCount: 1,
					status: "needs_setup",
					unresolvedDeviceCount: 1,
					unresolvedProjectCount: 0,
				},
			],
		});
		await expect(olderRefresh).resolves.toBe(false);
		expect(document.querySelector(".project-team-setup-entry")).toBeNull();
	});

	it("does not cancel an inventory load when a focused-select summary starts", async () => {
		let resolveInventory!: (
			value: Awaited<ReturnType<typeof api.loadProjectScopeInventory>>,
		) => void;
		let resolveBackgroundSummary!: (value: LegacyTeamSetupSummaryResponseV1) => void;
		vi.mocked(api.loadProjectScopeInventory).mockImplementationOnce(
			() => new Promise((resolve) => (resolveInventory = resolve)),
		);
		vi.mocked(api.loadLegacyTeamSetupSummary)
			.mockImplementationOnce(() => new Promise((resolve) => (resolveBackgroundSummary = resolve)))
			.mockResolvedValueOnce({ version: 1, candidates: [] });

		const inventoryLoad = loadProjectsData();
		await vi.waitFor(() =>
			expect(document.getElementById("projectsInventoryMeta")?.textContent).toBe(
				"Loading project inventory…",
			),
		);
		const select = document.createElement("select");
		select.className = "project-domain-select";
		document.body.appendChild(select);
		select.focus();

		await expect(loadProjectsData({ requireTeamSetupSummary: true })).resolves.toBe(true);
		resolveInventory({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project()],
			total: 1,
		});
		await expect(inventoryLoad).resolves.toBe(true);
		expect(document.getElementById("projectsInventoryMeta")?.textContent).toContain(
			"1 projects · 1–1",
		);
		resolveBackgroundSummary({ version: 1, candidates: [] });
	});

	it("reuses slow Team setup discovery across polling generations", async () => {
		let resolveTeamSetup!: (value: LegacyTeamSetupSummaryResponseV1) => void;
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project()],
			total: 1,
		});
		vi.mocked(api.loadLegacyTeamSetupSummary).mockImplementation(
			() => new Promise((resolve) => (resolveTeamSetup = resolve)),
		);

		await loadProjectsData();
		await loadProjectsData();
		await loadProjectsData();
		expect(api.loadLegacyTeamSetupSummary).toHaveBeenCalledTimes(1);

		resolveTeamSetup({
			version: 1,
			candidates: [
				{
					candidateRef: "opaque-candidate-ref",
					displayName: "Slow Team",
					status: "needs_setup",
					deviceCount: 1,
					projectCount: 1,
					unresolvedDeviceCount: 1,
					unresolvedProjectCount: 0,
				},
			],
		});
		await vi.waitFor(() =>
			expect(document.querySelector(".project-team-setup-entry")?.textContent).toContain(
				"Slow Team",
			),
		);
	});

	it("preserves the review surface across an unchanged refresh", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(recipientReview());

		await loadProjectsData();
		const firstSurface = document.querySelector(".recipient-policy-review");
		expect(firstSurface?.textContent).toContain("Sharing decisions 1");
		expect(firstSurface?.textContent).toContain("Suggested: Keep current setup unchanged");

		await loadProjectsData();

		expect(document.querySelector(".recipient-policy-review")).toBe(firstSurface);
	});

	it("hides preserved-only review results without a replacement notice", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		vi.mocked(api.loadRecipientPolicyReview)
			.mockResolvedValueOnce(
				recipientReview({
					categoryCounts: {
						actionableReview: 0,
						preservedContinuity: 1,
						blockedRepair: 0,
					},
					reviewItems: [],
				}),
			)
			.mockResolvedValueOnce(
				recipientReview({
					categoryCounts: {
						actionableReview: 0,
						preservedContinuity: 2,
						blockedRepair: 0,
					},
					continuity: { findingCount: 2, state: "legacy_access_preserved" },
					reviewItems: [],
				}),
			);

		await loadProjectsData();
		await flushAsyncWork();
		const mount = document.getElementById("recipientPolicyReviewMount");
		expect(mount?.hidden).toBe(true);
		expect(mount?.textContent).toBe("");

		await loadProjectsData();
		await flushAsyncWork();

		expect(mount?.hidden).toBe(true);
		expect(mount?.textContent).toBe("");
		expect(document.querySelector(".recipient-policy-review")).toBeNull();
		expect(document.body.textContent).not.toContain("Preserved legacy continuity");
		expect(mount?.querySelector('[aria-live="polite"]')).toBeNull();
	});

	it("does not offer an unusable repair action for an unmapped Project", async () => {
		const repairProject = project({
			identity_source: "unmapped",
			workspace_identity: "unmapped:unstable",
		});
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [repairProject],
			total: 1,
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(
			recipientReview({
				blockedItems: [
					{
						blockedItemId: "blocked-1",
						finding: "Project identity is unstable.",
						ownerLabel: "Project owner",
						reason: "Codemem requires source-state repair.",
						repairAction: "Assign a stable canonical Project identity.",
						repair: {
							kind: "open_project_administration",
							projectIdentity: "unmapped:unstable",
							label: "Open Project administration",
						},
						version: 1,
					},
				],
				continuity: null,
				reviewItems: [],
			}),
		);

		await loadProjectsData();

		const blocked = document.querySelector(".recipient-policy-blocked-item");
		expect(blocked?.textContent).toContain("Blocked");
		expect(blocked?.textContent).toContain("Repair in Projects");
		expect(blocked?.textContent).toContain("Owner: Project owner");
		expect(blocked?.querySelector("button[aria-describedby]")).toBeNull();
		const details = blocked?.querySelector<HTMLButtonElement>('button[aria-expanded="false"]');
		details?.click();
		expect(blocked?.textContent).toContain("Assign a stable canonical Project identity.");
	});

	it("clears an active status filter before opening a filtered repair target", async () => {
		const repairProject = project({
			cwd: "/workspace/filtered-project",
			display_project: "filtered-project",
			identity_source: "cwd",
			project: "filtered-project",
			workspace_identity: "cwd:/workspace/filtered-project",
		});
		const status = document.getElementById("projectsStatusFilter") as HTMLSelectElement;
		status.append(new Option("Needs attention", "needs_attention"));
		status.value = "needs_attention";
		vi.mocked(api.loadProjectScopeInventory).mockImplementation(async (input = {}) => ({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: input.status || input.q !== repairProject.workspace_identity ? [] : [repairProject],
			total: input.status || input.q !== repairProject.workspace_identity ? 0 : 1,
		}));
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(
			recipientReview({
				blockedItems: [
					{
						blockedItemId: "blocked-filtered",
						finding: "Project identity is unstable.",
						ownerLabel: "Project owner",
						reason: "Codemem requires source-state repair.",
						repairAction: "Assign a stable canonical Project identity.",
						repair: {
							kind: "open_project_administration",
							projectIdentity: repairProject.workspace_identity,
							label: "Open Project administration",
						},
						version: 1,
					},
				],
				continuity: null,
				reviewItems: [],
			}),
		);

		await loadProjectsData();
		blockedRepairButton()?.click();

		await vi.waitFor(() => expect(status.value).toBe(""));
		expect(document.getElementById("projectsSearch")).toHaveProperty(
			"value",
			repairProject.workspace_identity,
		);
		expect(
			document
				.querySelector<HTMLElement>(
					`[data-project-workspace-identity="${repairProject.workspace_identity}"]`,
				)
				?.querySelector<HTMLDetailsElement>(".project-inventory-details")?.open,
		).toBe(true);
	});

	it("queues a second blocked-item repair while navigation is active", async () => {
		let resolveFirstLookup!: (value: ProjectScopeInventoryResult) => void;
		const firstLookup = new Promise<ProjectScopeInventoryResult>((resolve) => {
			resolveFirstLookup = resolve;
		});
		vi.mocked(api.loadProjectScopeInventory).mockImplementation((input = {}) => {
			if (!input.q) {
				return Promise.resolve({
					has_more: false,
					limit: 250,
					offset: 0,
					projects: [],
					total: 0,
				});
			}
			if (input.q === "/workspace/first") return firstLookup;
			return Promise.resolve({
				has_more: false,
				limit: 250,
				offset: 0,
				projects: [],
				total: 0,
			});
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(
			recipientReview({
				blockedItems: ["first", "second"].map((name) => ({
					blockedItemId: `blocked-${name}`,
					finding: `Project ${name} identity is unstable.`,
					ownerLabel: "Project owner",
					reason: "Codemem requires source-state repair.",
					repairAction: "Open Project administration.",
					repair: {
						kind: "open_project_administration" as const,
						projectIdentity: `/workspace/${name}`,
						label: "Open Project administration",
					},
					version: 1 as const,
				})),
				continuity: null,
				reviewItems: [],
			}),
		);

		await loadProjectsData();
		const repairs = [
			...document.querySelectorAll<HTMLButtonElement>(
				".recipient-policy-blocked-item button[aria-describedby]",
			),
		];
		repairs[0]?.click();
		repairs[1]?.click();
		await Promise.resolve();

		expect(
			vi
				.mocked(api.loadProjectScopeInventory)
				.mock.calls.flatMap(([input]) => (input?.q ? [input.q] : [])),
		).toEqual(["/workspace/first"]);

		resolveFirstLookup({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		await vi.waitFor(() =>
			expect(
				vi
					.mocked(api.loadProjectScopeInventory)
					.mock.calls.flatMap(([input]) => (input?.q ? [input.q] : [])),
			).toEqual(["/workspace/first", "/workspace/second"]),
		);
		await flushAsyncWork();
	});

	it("drops queued repairs superseded by later user navigation", async () => {
		let resolveFirstLookup!: (value: ProjectScopeInventoryResult) => void;
		const firstLookup = new Promise<ProjectScopeInventoryResult>((resolve) => {
			resolveFirstLookup = resolve;
		});
		const repairQueries: string[] = [];
		vi.mocked(api.loadProjectScopeInventory).mockImplementation((input = {}) => {
			if (input.q?.startsWith("/workspace/")) repairQueries.push(input.q);
			if (input.q === "/workspace/first") return firstLookup;
			return Promise.resolve({
				has_more: false,
				limit: 250,
				offset: 0,
				projects: [],
				total: 0,
			});
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(
			recipientReview({
				blockedItems: ["first", "second"].map((name) => ({
					blockedItemId: `blocked-${name}`,
					finding: `Project ${name} identity is unstable.`,
					ownerLabel: "Project owner",
					reason: "Codemem requires source-state repair.",
					repairAction: "Open Project administration.",
					repair: {
						kind: "open_project_administration" as const,
						projectIdentity: `/workspace/${name}`,
						label: "Open Project administration",
					},
					version: 1 as const,
				})),
				continuity: null,
				reviewItems: [],
			}),
		);

		await loadProjectsData();
		initProjectsTab(() => {
			void loadProjectsData();
		});
		const repairs = [
			...document.querySelectorAll<HTMLButtonElement>(
				".recipient-policy-blocked-item button[aria-describedby]",
			),
		];
		repairs[0]?.click();
		repairs[1]?.click();
		await vi.waitFor(() => expect(repairQueries).toEqual(["/workspace/first"]));

		const search = document.getElementById("projectsSearch") as HTMLInputElement;
		search.value = "user-query";
		search.dispatchEvent(new Event("input"));
		resolveFirstLookup({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		await flushAsyncWork();

		expect(repairQueries).toEqual(["/workspace/first"]);
		expect(search.value).toBe("user-query");
	});

	it("defers repair while a Space assignment control is active", async () => {
		const repairProject = project({ workspace_identity: "/workspace/repair-target" });
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [repairProject],
			total: 1,
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(
			recipientReview({
				blockedItems: [
					{
						blockedItemId: "blocked-active-space",
						finding: "Project identity is unstable.",
						ownerLabel: "Project owner",
						reason: "Codemem requires source-state repair.",
						repairAction: "Open Project administration.",
						repair: {
							kind: "open_project_administration",
							projectIdentity: repairProject.workspace_identity,
							label: "Open Project administration",
						},
						version: 1,
					},
				],
				continuity: null,
				reviewItems: [],
			}),
		);

		await loadProjectsData();
		const activeSelect = document.createElement("select");
		activeSelect.className = "project-domain-select";
		document.body.appendChild(activeSelect);
		activeSelect.focus();
		blockedRepairButton()?.click();

		await vi.waitFor(() =>
			expect(showGlobalNotice).toHaveBeenCalledWith(
				"Finish the open Space assignment, then try Repair again.",
				"warning",
			),
		);
	});

	it("preserves newer filter edits when repair navigation is superseded", async () => {
		const projectIdentity = "/workspace/repair-target";
		const repairProject = project({ workspace_identity: projectIdentity });
		let resolveRepairLoad!: (value: ProjectScopeInventoryResult) => void;
		const repairLoad = new Promise<ProjectScopeInventoryResult>((resolve) => {
			resolveRepairLoad = resolve;
		});
		let repairQueryCount = 0;
		vi.mocked(api.loadProjectScopeInventory).mockImplementation((input = {}) => {
			if (input.q === projectIdentity) {
				repairQueryCount += 1;
				if (repairQueryCount === 1) {
					return Promise.resolve({
						has_more: false,
						limit: 250,
						offset: 0,
						projects: [repairProject],
						total: 1,
					});
				}
				return repairLoad;
			}
			return Promise.resolve({
				has_more: false,
				limit: 250,
				offset: 0,
				projects: [],
				total: 0,
			});
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(
			recipientReview({
				blockedItems: [
					{
						blockedItemId: "blocked-superseded-navigation",
						finding: "Project identity is unstable.",
						ownerLabel: "Project owner",
						reason: "Codemem requires source-state repair.",
						repairAction: "Open Project administration.",
						repair: {
							kind: "open_project_administration",
							projectIdentity,
							label: "Open Project administration",
						},
						version: 1,
					},
				],
				continuity: null,
				reviewItems: [],
			}),
		);

		await loadProjectsData();
		blockedRepairButton()?.click();
		await vi.waitFor(() => expect(repairQueryCount).toBe(2));

		const search = document.getElementById("projectsSearch") as HTMLInputElement;
		search.value = "user-query";
		await loadProjectsData();
		resolveRepairLoad({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [repairProject],
			total: 1,
		});
		await flushAsyncWork();

		expect(search.value).toBe("user-query");
	});

	it("preserves newer filter edits made during repair target lookup", async () => {
		const projectIdentity = "/workspace/slow-repair-target";
		const repairProject = project({ workspace_identity: projectIdentity });
		let resolveLookup!: (value: ProjectScopeInventoryResult) => void;
		const lookup = new Promise<ProjectScopeInventoryResult>((resolve) => {
			resolveLookup = resolve;
		});
		let repairQueryCount = 0;
		vi.mocked(api.loadProjectScopeInventory).mockImplementation((input = {}) => {
			if (input.q === projectIdentity) {
				repairQueryCount += 1;
				if (repairQueryCount === 1) return lookup;
			}
			return Promise.resolve({
				has_more: false,
				limit: 250,
				offset: 0,
				projects: input.q === projectIdentity ? [repairProject] : [],
				total: input.q === projectIdentity ? 1 : 0,
			});
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(
			recipientReview({
				blockedItems: [
					{
						blockedItemId: "blocked-slow-lookup",
						finding: "Project identity is unstable.",
						ownerLabel: "Project owner",
						reason: "Codemem requires source-state repair.",
						repairAction: "Open Project administration.",
						repair: {
							kind: "open_project_administration",
							projectIdentity,
							label: "Open Project administration",
						},
						version: 1,
					},
				],
				continuity: null,
				reviewItems: [],
			}),
		);

		await loadProjectsData();
		blockedRepairButton()?.click();
		await vi.waitFor(() => expect(repairQueryCount).toBe(1));

		const search = document.getElementById("projectsSearch") as HTMLInputElement;
		search.value = "user-query";
		await loadProjectsData();
		resolveLookup({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [repairProject],
			total: 1,
		});
		await flushAsyncWork();

		expect(search.value).toBe("user-query");
		expect(repairQueryCount).toBe(1);
	});

	it("continues repair target lookup across a background inventory refresh", async () => {
		const projectIdentity = "/workspace/background-refresh-target";
		const repairProject = project({ workspace_identity: projectIdentity });
		let resolveLookup!: (value: ProjectScopeInventoryResult) => void;
		const lookup = new Promise<ProjectScopeInventoryResult>((resolve) => {
			resolveLookup = resolve;
		});
		let repairQueryCount = 0;
		vi.mocked(api.loadProjectScopeInventory).mockImplementation((input = {}) => {
			if (input.q === projectIdentity) {
				repairQueryCount += 1;
				if (repairQueryCount === 1) return lookup;
				return Promise.resolve({
					has_more: false,
					limit: 250,
					offset: 0,
					projects: [repairProject],
					total: 1,
				});
			}
			return Promise.resolve({
				has_more: false,
				limit: 250,
				offset: 0,
				projects: [],
				total: 0,
			});
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(
			recipientReview({
				blockedItems: [
					{
						blockedItemId: "blocked-background-refresh",
						finding: "Project identity is unstable.",
						ownerLabel: "Project owner",
						reason: "Codemem requires source-state repair.",
						repairAction: "Open Project administration.",
						repair: {
							kind: "open_project_administration",
							projectIdentity,
							label: "Open Project administration",
						},
						version: 1,
					},
				],
				continuity: null,
				reviewItems: [],
			}),
		);

		await loadProjectsData();
		blockedRepairButton()?.click();
		await vi.waitFor(() => expect(repairQueryCount).toBe(1));
		await loadProjectsData();
		resolveLookup({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [repairProject],
			total: 1,
		});

		await vi.waitFor(() => expect(repairQueryCount).toBe(2));
		await vi.waitFor(() =>
			expect(
				document
					.querySelector<HTMLElement>(`[data-project-workspace-identity="${projectIdentity}"]`)
					?.querySelector<HTMLDetailsElement>(".project-inventory-details")?.open,
			).toBe(true),
		);
	});

	it("pages identity search until it renders the exact repair target", async () => {
		const repairProject = project({
			display_project: "app",
			project: "app",
			workspace_identity: "/workspace/app",
		});
		const prefixMatch = project({
			display_project: "nested-app",
			project: "nested-app",
			workspace_identity: "/workspace/app/nested",
		});
		const peerExactMatch = project({
			read_only: true,
			read_only_reason: "peer_received",
			session_count: 0,
			workspace_identity: repairProject.workspace_identity,
		});
		vi.mocked(api.loadProjectScopeInventory).mockImplementation(async (input = {}) => {
			if (!input.q) {
				return {
					has_more: false,
					limit: 250,
					offset: 0,
					projects: [peerExactMatch],
					total: 1,
				};
			}
			if ((input.offset ?? 0) === 0) {
				return {
					has_more: true,
					limit: 250,
					offset: 0,
					projects: [prefixMatch, peerExactMatch],
					total: 250,
				};
			}
			return {
				has_more: false,
				limit: 250,
				offset: 250,
				projects: [repairProject],
				total: 250,
			};
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(
			recipientReview({
				blockedItems: [
					{
						blockedItemId: "blocked-paginated",
						finding: "Project identity is unstable.",
						ownerLabel: "Project owner",
						reason: "Codemem requires source-state repair.",
						repairAction: "Assign a stable canonical Project identity.",
						repair: {
							kind: "open_project_administration",
							projectIdentity: repairProject.workspace_identity,
							label: "Open Project administration",
						},
						version: 1,
					},
				],
				continuity: null,
				reviewItems: [],
			}),
		);

		await loadProjectsData();
		blockedRepairButton()?.click();

		await vi.waitFor(() =>
			expect(
				document
					.querySelector<HTMLElement>(
						`[data-project-workspace-identity="${repairProject.workspace_identity}"]`,
					)
					?.querySelector<HTMLDetailsElement>(".project-inventory-details")?.open,
			).toBe(true),
		);
		expect(api.loadProjectScopeInventory).toHaveBeenCalledWith({
			limit: 250,
			offset: 0,
			q: repairProject.workspace_identity,
		});
		expect(api.loadProjectScopeInventory).toHaveBeenCalledWith(
			expect.objectContaining({ offset: 250, q: repairProject.workspace_identity }),
		);
	});

	it("stops repair lookup when paginated search does not advance", async () => {
		const projectIdentity = "/workspace/app";
		vi.mocked(api.loadProjectScopeInventory).mockImplementation(async (input = {}) => {
			if (!input.q) {
				return { has_more: false, limit: 250, offset: 0, projects: [], total: 0 };
			}
			return {
				has_more: true,
				limit: 250,
				offset: 0,
				projects:
					(input.offset ?? 0) === 0
						? [project({ workspace_identity: `${projectIdentity}/nested` })]
						: [],
				total: 500,
			};
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(
			recipientReview({
				blockedItems: [
					{
						blockedItemId: "blocked-stalled-pagination",
						finding: "Project identity is unstable.",
						ownerLabel: "Project owner",
						reason: "Codemem requires source-state repair.",
						repairAction: "Assign a stable canonical Project identity.",
						repair: {
							kind: "open_project_administration",
							projectIdentity,
							label: "Open Project administration",
						},
						version: 1,
					},
				],
				continuity: null,
				reviewItems: [],
			}),
		);

		await loadProjectsData();
		blockedRepairButton()?.click();

		await vi.waitFor(() =>
			expect(showGlobalNotice).toHaveBeenCalledWith(
				"This Project is not visible in the current inventory. Refresh Projects, then try Repair again.",
				"warning",
			),
		);
		expect(
			vi
				.mocked(api.loadProjectScopeInventory)
				.mock.calls.map(([input]) => input)
				.filter((input) => input?.q === projectIdentity),
		).toEqual([
			{ limit: 250, offset: 0, q: projectIdentity },
			{ limit: 250, offset: 250, q: projectIdentity },
		]);
	});

	it("opens the local repairable row when a peer row shares its reserved identity", async () => {
		const workspaceIdentity = "peer-received:collision";
		const localProject = project({ workspace_identity: workspaceIdentity });
		const peerProject = project({
			read_only: true,
			read_only_reason: "peer_received",
			session_count: 0,
			workspace_identity: workspaceIdentity,
		});
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [localProject, peerProject],
			total: 2,
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(
			recipientReview({
				blockedItems: [
					{
						blockedItemId: "blocked-collision",
						finding: "Project administration needs attention.",
						ownerLabel: "Project owner",
						reason: "Codemem requires source-state repair.",
						repairAction: "Open the local Project administration controls.",
						repair: {
							kind: "open_project_administration",
							projectIdentity: workspaceIdentity,
							label: "Open Project administration",
						},
						version: 1,
					},
				],
				continuity: null,
				reviewItems: [],
			}),
		);

		await loadProjectsData();
		blockedRepairButton()?.click();

		const currentRows = () => [
			...document.querySelectorAll<HTMLElement>(
				`[data-project-workspace-identity="${workspaceIdentity}"]`,
			),
		];
		expect(currentRows()).toHaveLength(2);
		await vi.waitFor(() => {
			const rows = currentRows();
			expect(
				rows.find((row) => row.dataset.projectRepairable === "true")?.querySelector("details")
					?.open,
			).toBe(true);
			expect(
				rows
					.find((row) => row.dataset.projectRepairable === "true")
					?.contains(document.activeElement),
			).toBe(true);
		});
		expect(
			currentRows()
				.find((row) => row.dataset.projectRepairable === "false")
				?.querySelector("details")?.open,
		).toBe(false);

		await loadProjectsData();

		expect(
			currentRows()
				.find((row) => row.dataset.projectRepairable === "true")
				?.contains(document.activeElement),
		).toBe(true);
	});

	it("opens the containing cluster before focusing a duplicate-name repair target", async () => {
		const repairProject = project({
			cwd: "/workspace/repair-target",
			display_project: "duplicate-repair",
			git_remote: "https://git.example.invalid/exampleco/duplicate-repair.git",
			project: "duplicate-repair",
			workspace_identity: "cwd:/workspace/repair-target",
		});
		const duplicateNameProject = project({
			cwd: "/workspace/duplicate-name",
			display_project: "duplicate-repair",
			git_remote: "https://git.example.invalid/exampleco/duplicate-repair.git",
			project: "duplicate-repair",
			workspace_identity: "git:https://git.example.invalid/exampleco/duplicate-name.git",
		});
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [repairProject, duplicateNameProject],
			total: 2,
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(
			recipientReview({
				blockedItems: [
					{
						blockedItemId: "blocked-clustered",
						finding: "Project identity is unstable.",
						ownerLabel: "Project owner",
						reason: "Codemem requires source-state repair.",
						repairAction: "Assign a stable canonical Project identity.",
						repair: {
							kind: "open_project_administration",
							projectIdentity: repairProject.workspace_identity,
							label: "Open Project administration",
						},
						version: 1,
					},
				],
				continuity: null,
				reviewItems: [],
			}),
		);

		await loadProjectsData();
		const clusterDetails = document.querySelector<HTMLDetailsElement>(
			".project-inventory-cluster > .project-inventory-details",
		);
		expect(clusterDetails?.open).toBe(false);

		blockedRepairButton()?.click();

		await vi.waitFor(() =>
			expect(
				document.querySelector<HTMLDetailsElement>(
					".project-inventory-cluster > .project-inventory-details",
				)?.open,
			).toBe(true),
		);
		const repairRow = document.querySelector<HTMLElement>(
			`[data-project-workspace-identity="${repairProject.workspace_identity}"]`,
		);
		expect(repairRow?.querySelector<HTMLDetailsElement>(".project-inventory-details")?.open).toBe(
			true,
		);
		expect(repairRow?.contains(document.activeElement)).toBe(true);
		expect(
			document
				.querySelector<HTMLElement>(
					`[data-project-workspace-identity="${duplicateNameProject.workspace_identity}"]`,
				)
				?.querySelector<HTMLDetailsElement>(".project-inventory-details")?.open,
		).toBe(false);

		await loadProjectsData();

		const rerenderedRepairRow = document.querySelector<HTMLElement>(
			`[data-project-workspace-identity="${repairProject.workspace_identity}"]`,
		);
		expect(
			document.querySelector<HTMLDetailsElement>(
				".project-inventory-cluster > .project-inventory-details",
			)?.open,
		).toBe(true);
		expect(
			rerenderedRepairRow?.querySelector<HTMLDetailsElement>(".project-inventory-details")?.open,
		).toBe(true);
		expect(rerenderedRepairRow?.contains(document.activeElement)).toBe(true);
	});

	it("opens row sharing with exactly the selected canonical project", async () => {
		const selected = project({
			cwd: "/workspace/work/exampleco/codemem",
			display_project: "codemem",
			git_remote: "https://git.example.invalid/exampleco/codemem.git",
			project: "codemem",
			workspace_identity: "git:https://git.example.invalid/exampleco/codemem.git",
		});
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project(), selected],
			total: 2,
		});

		initProjectsTab(() => {});
		await loadProjectsData();
		const selectedRow = [...document.querySelectorAll<HTMLElement>(".project-inventory-row")].find(
			(row) => row.textContent?.includes("codemem"),
		);
		if (!selectedRow) throw new Error("selected project row missing");
		const share = [...selectedRow.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Share",
		);
		if (!share) throw new Error("Share button missing");
		share.click();

		expect(projectSharing.renderProjectShareFlow).toHaveBeenCalledWith(
			document.getElementById("projectShareFlowMount"),
			[project(), selected],
			{ inventoryError: false },
		);
		expect(projectSharing.openProjectShareFlow).toHaveBeenCalledWith([selected.workspace_identity]);
	});

	it("loads the sharing selector independently from the filtered inventory page", async () => {
		const filtered = project({ display_project: "filtered", workspace_identity: "git:filtered" });
		const later = project({ display_project: "later", workspace_identity: "git:later" });
		vi.mocked(api.loadProjectScopeInventory)
			.mockResolvedValueOnce({
				has_more: false,
				limit: 250,
				offset: 0,
				projects: [filtered],
				total: 1,
			})
			.mockResolvedValueOnce({
				has_more: true,
				limit: 250,
				offset: 0,
				projects: [project()],
				total: 251,
			})
			.mockResolvedValueOnce({
				has_more: false,
				limit: 250,
				offset: 250,
				projects: [later],
				total: 251,
			});

		initProjectsTab(() => {});
		await loadProjectsData();

		expect(projectSharing.renderProjectShareFlow).toHaveBeenCalledWith(
			document.getElementById("projectShareFlowMount"),
			[project(), later],
			{ inventoryError: false },
		);
		expect(recipientPolicyManagement.mountRecipientPolicyManagement).toHaveBeenCalledWith(
			document.getElementById("recipientPolicyManagementMount"),
			[
				{
					canonicalProjectIdentity: project().workspace_identity,
					displayName: "api",
					existingMemoryCount: 1,
				},
				{
					canonicalProjectIdentity: "git:later",
					displayName: "later",
					existingMemoryCount: 1,
				},
			],
			recipientIntent(),
			expect.objectContaining({ loadError: false }),
		);
		expect(api.loadProjectScopeInventory).toHaveBeenNthCalledWith(2, { limit: 250, offset: 0 });
		expect(api.loadProjectScopeInventory).toHaveBeenNthCalledWith(3, {
			limit: 250,
			offset: 250,
		});
	});

	it("does not let an older project load overwrite a newer selector snapshot", async () => {
		let resolveOldFiltered: (value: ProjectScopeInventoryResult) => void = () => {};
		let resolveOldSharing: (value: ProjectScopeInventoryResult) => void = () => {};
		const oldFiltered = new Promise<ProjectScopeInventoryResult>((resolve) => {
			resolveOldFiltered = resolve;
		});
		const oldSharing = new Promise<ProjectScopeInventoryResult>((resolve) => {
			resolveOldSharing = resolve;
		});
		const newerFiltered = project({
			display_project: "new filtered",
			workspace_identity: "new-filtered",
		});
		const newerSharing = project({
			display_project: "new sharing",
			workspace_identity: "new-sharing",
		});
		let call = 0;
		vi.mocked(api.loadProjectScopeInventory).mockImplementation(async () => {
			call += 1;
			if (call === 1) return oldFiltered;
			if (call === 2) return oldSharing;
			return {
				has_more: false,
				limit: 250,
				offset: 0,
				projects: [call === 3 ? newerFiltered : newerSharing],
				total: 1,
			};
		});

		initProjectsTab(() => {});
		const olderLoad = loadProjectsData();
		await loadProjectsData();
		resolveOldFiltered({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project({ display_project: "old filtered", workspace_identity: "old-filtered" })],
			total: 1,
		});
		resolveOldSharing({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project({ display_project: "old sharing", workspace_identity: "old-sharing" })],
			total: 1,
		});
		await olderLoad;

		expect(projectSharing.renderProjectShareFlow).toHaveBeenLastCalledWith(
			document.getElementById("projectShareFlowMount"),
			[newerSharing],
			{ inventoryError: false },
		);
		expect(recipientPolicyManagement.mountRecipientPolicyManagement).toHaveBeenLastCalledWith(
			document.getElementById("recipientPolicyManagementMount"),
			[
				{
					canonicalProjectIdentity: "new-sharing",
					displayName: "new sharing",
					existingMemoryCount: 1,
				},
			],
			recipientIntent(),
			expect.objectContaining({ loadError: false }),
		);
		expect(document.body.textContent).toContain("new filtered");
		expect(document.body.textContent).not.toContain("old filtered");
	});

	it("does not let an older coordinator refresh redraw stale project rows", async () => {
		let resolveOldStatus: (value: { has_admin_secret: boolean; readiness: "ready" }) => void =
			() => {};
		const oldStatus = new Promise<{ has_admin_secret: boolean; readiness: "ready" }>((resolve) => {
			resolveOldStatus = resolve;
		});
		vi.mocked(api.loadCoordinatorAdminStatus)
			.mockImplementationOnce(async () => oldStatus)
			.mockResolvedValueOnce({ has_admin_secret: true, readiness: "ready" });
		const old = project({ display_project: "old filtered", workspace_identity: "old-filtered" });
		const newer = project({ display_project: "new filtered", workspace_identity: "new-filtered" });
		vi.mocked(api.loadProjectScopeInventory)
			.mockResolvedValueOnce({
				has_more: false,
				limit: 250,
				offset: 0,
				projects: [old],
				total: 1,
			})
			.mockResolvedValueOnce({
				has_more: false,
				limit: 250,
				offset: 0,
				projects: [old],
				total: 1,
			})
			.mockResolvedValueOnce({
				has_more: false,
				limit: 250,
				offset: 0,
				projects: [newer],
				total: 1,
			})
			.mockResolvedValueOnce({
				has_more: false,
				limit: 250,
				offset: 0,
				projects: [newer],
				total: 1,
			});

		initProjectsTab(() => {});
		await loadProjectsData();
		await loadProjectsData();
		await flushAsyncWork();
		resolveOldStatus({ has_admin_secret: true, readiness: "ready" });
		await flushAsyncWork();

		expect(document.body.textContent).toContain("new filtered");
		expect(document.body.textContent).not.toContain("old filtered");
	});

	it("disables stale sharing choices when a later primary inventory load fails", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project()],
			total: 1,
		});
		initProjectsTab(() => {});
		await loadProjectsData();
		vi.mocked(api.loadProjectScopeInventory).mockRejectedValueOnce(
			new Error("inventory unavailable"),
		);

		await loadProjectsData();

		expect(projectSharing.renderProjectShareFlow).toHaveBeenLastCalledWith(
			document.getElementById("projectShareFlowMount"),
			[],
			{ inventoryError: true },
		);
	});

	it("reports the newer successful result when an older overlapping load fails", async () => {
		let rejectOlder!: (reason?: unknown) => void;
		const inventory = {
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project()],
			total: 1,
		};
		vi.mocked(api.loadProjectScopeInventory)
			.mockImplementationOnce(
				() => new Promise<ProjectScopeInventoryResult>((_, reject) => (rejectOlder = reject)),
			)
			.mockResolvedValue(inventory);

		const olderLoad = loadProjectsData();
		await vi.waitFor(() => expect(api.loadProjectScopeInventory).toHaveBeenCalledTimes(2));
		const newerLoad = loadProjectsData();

		await expect(newerLoad).resolves.toBe(true);
		rejectOlder(new Error("older load failed"));
		await expect(olderLoad).resolves.toBe(true);
	});

	it("reports the newer failed result when an older overlapping load succeeds", async () => {
		let resolveOlder!: (value: ProjectScopeInventoryResult) => void;
		const inventory = {
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project()],
			total: 1,
		};
		vi.mocked(api.loadProjectScopeInventory)
			.mockImplementationOnce(
				() => new Promise<ProjectScopeInventoryResult>((resolve) => (resolveOlder = resolve)),
			)
			.mockResolvedValueOnce(inventory)
			.mockRejectedValueOnce(new Error("newer load failed"))
			.mockResolvedValue(inventory);

		const olderLoad = loadProjectsData();
		await vi.waitFor(() => expect(api.loadProjectScopeInventory).toHaveBeenCalledTimes(2));
		const newerLoad = loadProjectsData();

		await expect(newerLoad).resolves.toBe(false);
		resolveOlder(inventory);
		await expect(olderLoad).resolves.toBe(false);
	});

	it("does not reuse cached repair targets after an inventory load fails", async () => {
		const repairProject = project({ workspace_identity: "/workspace/stale-repair-target" });
		let failNextPrimaryLoad = false;
		vi.mocked(api.loadProjectScopeInventory).mockImplementation(async (input = {}) => {
			if (failNextPrimaryLoad && !input.q) {
				failNextPrimaryLoad = false;
				throw new Error("inventory unavailable");
			}
			return {
				has_more: false,
				limit: 250,
				offset: 0,
				projects: input.q ? [] : [repairProject],
				total: input.q ? 0 : 1,
			};
		});
		vi.mocked(api.loadRecipientPolicyReview).mockResolvedValue(
			recipientReview({
				blockedItems: [
					{
						blockedItemId: "blocked-stale-cache",
						finding: "Project identity is unstable.",
						ownerLabel: "Project owner",
						reason: "Codemem requires source-state repair.",
						repairAction: "Open Project administration.",
						repair: {
							kind: "open_project_administration",
							projectIdentity: repairProject.workspace_identity,
							label: "Open Project administration",
						},
						version: 1,
					},
				],
				continuity: null,
				reviewItems: [],
			}),
		);

		await loadProjectsData();
		failNextPrimaryLoad = true;
		await loadProjectsData();
		blockedRepairButton()?.click();

		await vi.waitFor(() =>
			expect(showGlobalNotice).toHaveBeenCalledWith(
				"This Project is not visible in the current inventory. Refresh Projects, then try Repair again.",
				"warning",
			),
		);
		expect(showGlobalNotice).not.toHaveBeenCalledWith(
			"Project administration could not be opened. Refresh Projects and try again.",
			"warning",
		);
	});

	it("shows exact project sharing People without leaking the summary to a sibling identity", async () => {
		const selected = project({
			display_project: "codemem",
			project: "codemem",
			workspace_identity: "git:https://git.example.invalid/exampleco/codemem.git",
			sharing: [
				{
					person: { actor_id: "actor-brian", display_name: "Brian" },
					lifecycle: {
						state: "active",
						label: "Up to date",
						explanation: "Existing memories and future activity are shared.",
					},
				},
				{
					person: { actor_id: "actor-alex", display_name: "Alex" },
					lifecycle: {
						state: "waiting_for_device",
						label: "Checking device compatibility",
						explanation:
							"Waiting for a participating device to report the required sharing capability.",
					},
				},
			],
		});
		const sibling = project({
			display_project: "codemem-docs",
			project: "codemem-docs",
			workspace_identity: "git:https://git.example.invalid/exampleco/codemem-docs.git",
			sharing: [],
		});
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [selected, sibling],
			total: 2,
		});

		await loadProjectsData();

		const rows = [...document.querySelectorAll<HTMLElement>(".project-inventory-row")];
		const selectedRow = rows.find(
			(row) => row.querySelector(".project-inventory-title")?.textContent === "codemem",
		);
		const siblingRow = rows.find(
			(row) => row.querySelector(".project-inventory-title")?.textContent === "codemem-docs",
		);
		expect(selectedRow?.querySelector(".project-sharing-summary")?.textContent).toContain("Brian");
		expect(selectedRow?.querySelector(".project-sharing-summary")?.textContent).toContain("Alex");
		expect(selectedRow?.textContent).toContain("Up to date");
		expect(selectedRow?.textContent).toContain("Checking device compatibility");
		expect(selectedRow?.textContent.match(/Checking device compatibility/g)).toHaveLength(1);
		expect(siblingRow?.querySelector(".project-sharing-summary")).toBeNull();
	});

	it("describes revoked and cancelled project shares as history", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project({
					sharing: [
						{
							person: { actor_id: "actor-brian", display_name: "Brian" },
							lifecycle: {
								state: "revoked",
								label: "Access removed",
								explanation: "Previously copied memories may remain.",
							},
						},
						{
							person: { actor_id: "actor-alex", display_name: "Alex" },
							lifecycle: {
								state: "cancelled",
								label: "Invitation cancelled",
								explanation: "No project access was added.",
							},
						},
					],
				}),
			],
			total: 1,
		});

		await loadProjectsData();

		const summary = document.querySelector(".project-sharing-summary");
		expect(summary?.textContent).toContain("Previously shared with Brian");
		expect(summary?.textContent).toContain("Invitation to Alex cancelled");
		expect(summary?.querySelector("strong")?.textContent).toBe("Project sharing");
	});

	it("removes the project inventory skeleton when loading fails", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockRejectedValue(new Error("inventory unavailable"));

		initProjectsTab(() => {});
		await loadProjectsData();

		expect(document.getElementById("projectsInventorySkeleton")).toBeNull();
		expect(document.getElementById("projectsInventoryMeta")?.textContent).toBe(
			"Project inventory failed to load.",
		);
		expect(document.body.textContent).toContain("inventory unavailable");
	});

	it("renders peer-received project identities read-only", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project({
					cwd: null,
					display_project: "codemem",
					git_branch: null,
					git_remote: null,
					identity_source: "workspace_id",
					memory_count: 18111,
					project: "codemem",
					read_only: true,
					read_only_reason: "peer_received",
					session_count: 0,
					statuses: ["received"],
					workspace_identity: "peer-received:peer-a:project:codemem",
				}),
			],
			total: 1,
		});

		initProjectsTab(() => {});
		await loadProjectsData();

		expect(document.body.textContent).toContain("From other devices");
		expect(document.body.textContent).toContain("Read-only here. Change it on the source device.");
		expect(document.querySelector(".project-domain-select")).toBeNull();
		expect(document.body.textContent).not.toContain("Change project…");
	});

	it("does not reload inventory while a Space select is active", async () => {
		const refresh = vi.fn();
		initProjectsTab(refresh);
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project()],
			total: 1,
		});
		await loadProjectsData();
		await flushAsyncWork();
		const select = document.querySelector(".project-domain-select") as HTMLSelectElement | null;
		if (!select) throw new Error("project Space select missing");
		select.focus();
		vi.clearAllMocks();

		await loadProjectsData();

		expect(api.loadProjectScopeInventory).not.toHaveBeenCalled();
		expect(api.loadSharingDomainSettings).not.toHaveBeenCalled();
		expect(api.loadCoordinatorAdminGroupsFiltered).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(select);

		select.blur();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("replays skipped refresh when a focused cluster Space select blurs", async () => {
		const refresh = vi.fn();
		initProjectsTab(refresh);
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project({ cwd: "/workspace/a", memory_count: 2, session_count: 1 }),
				project({
					cwd: "/tmp/worktree-a",
					memory_count: 3,
					session_count: 2,
					workspace_identity: "https://git.example.invalid/exampleco/api.git:worktree",
				}),
			],
			total: 2,
		});
		await loadProjectsData();
		await flushAsyncWork();
		const select = document.querySelector(
			".project-inventory-cluster > details > .project-inventory-details-body .project-domain-select",
		) as HTMLSelectElement | null;
		if (!select) throw new Error("cluster Space select missing");
		select.focus();
		vi.clearAllMocks();

		await loadProjectsData();
		expect(document.body.textContent).not.toContain("Team: ExampleCo Team");
		await flushAsyncWork();
		expect(api.loadProjectScopeInventory).not.toHaveBeenCalled();

		select.blur();
		expect(refresh).toHaveBeenCalledTimes(1);
	});

	it("preserves a cluster Space draft across inventory re-renders until save succeeds", async () => {
		const refresh = vi.fn();
		initProjectsTab(refresh);
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project({ cwd: "/workspace/a", memory_count: 2, session_count: 1 }),
				project({
					cwd: "/tmp/worktree-a",
					memory_count: 3,
					session_count: 2,
					workspace_identity: "https://git.example.invalid/exampleco/api.git:worktree",
				}),
			],
			total: 2,
		});
		await loadProjectsData();
		const select = document.querySelector(
			".project-inventory-cluster > details > .project-inventory-details-body .project-domain-select",
		) as HTMLSelectElement | null;
		if (!select) throw new Error("cluster Space select missing");
		select.value = "exampleco-work";
		select.dispatchEvent(new Event("change", { bubbles: true }));

		await loadProjectsData();

		const rerenderedSelect = document.querySelector(
			".project-inventory-cluster > details > .project-inventory-details-body .project-domain-select",
		) as HTMLSelectElement | null;
		if (!rerenderedSelect) throw new Error("cluster Space select missing after refresh");
		expect(rerenderedSelect.value).toBe("exampleco-work");
		const save = Array.from(document.querySelectorAll("button")).find((button) =>
			button.textContent?.startsWith("Save Space for 2 identities"),
		) as HTMLButtonElement | undefined;
		expect(save).toBeDefined();
		save?.click();
		await flushAsyncWork();

		expect(api.saveSharingDomainProjectMappings).toHaveBeenCalledWith({
			mappings: expect.arrayContaining([
				expect.objectContaining({
					scope_id: "exampleco-work",
					workspace_identity: "https://git.example.invalid/exampleco/api.git",
				}),
			]),
		});
		expect(refresh).toHaveBeenCalled();
		await loadProjectsData();
		const clearedSelect = document.querySelector(
			".project-inventory-cluster > details > .project-inventory-details-body .project-domain-select",
		) as HTMLSelectElement | null;
		expect(clearedSelect?.value).toBe("");
	});

	it("refreshes active Team names and ignores archived Teams for Space labels", async () => {
		state.lastProjectCoordinatorAdminGroups = [
			{ archived_at: "2026-05-01T00:00:00Z", display_name: "Old Team", group_id: "old" },
		];
		vi.mocked(api.loadCoordinatorAdminGroupsFiltered).mockResolvedValue({
			items: [
				{ archived_at: null, display_name: "ExampleCo Team", group_id: "exampleco" },
				{ archived_at: "2026-05-01T00:00:00Z", display_name: "Old Team", group_id: "old" },
			],
		});
		vi.mocked(api.loadSharingDomainSettings).mockResolvedValue({
			local_default_scope_id: "local-default",
			mappings: [],
			projects: [],
			scopes: [
				{
					authority_type: "coordinator",
					group_id: "exampleco",
					kind: "team",
					label: "ExampleCo Work",
					scope_id: "exampleco-work",
					status: "active",
				},
				{
					authority_type: "coordinator",
					group_id: "old",
					kind: "team",
					label: "Old Work",
					scope_id: "old-work",
					status: "active",
				},
			],
		});
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project({ resolved_scope_id: "exampleco-work" }),
				project({
					display_project: "old-api",
					git_remote: "https://git.example.invalid/old/api.git",
					project: "old-api",
					resolved_scope_id: "old-work",
					workspace_identity: "https://git.example.invalid/old/api.git",
				}),
			],
			total: 2,
		});

		await loadProjectsData();
		expect(document.body.textContent).not.toContain("Team: ExampleCo Team");
		await flushAsyncWork();

		expect(api.loadCoordinatorAdminGroupsFiltered).toHaveBeenCalledWith(false);
		expect(document.body.textContent).toContain("Team: ExampleCo Team");
		expect(document.body.textContent).not.toContain("Team: Old Team");
		expect(document.body.textContent).toContain("Team details unavailable");
		const enabledOptionLabels = Array.from(document.querySelectorAll("option:not(:disabled)")).map(
			(option) => option.textContent,
		);
		expect(enabledOptionLabels).toContain("ExampleCo Work");
		expect(enabledOptionLabels).not.toContain("Old Work");
	});

	it("renders inventory before coordinator Team name refresh finishes", async () => {
		let resolveStatus: (value: unknown) => void = () => {};
		vi.mocked(api.loadCoordinatorAdminStatus).mockReturnValue(
			new Promise((resolve) => {
				resolveStatus = resolve;
			}),
		);
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project({ resolved_scope_id: "exampleco-work" })],
			total: 1,
		});

		await loadProjectsData();

		expect(document.getElementById("projectsInventoryMeta")?.textContent).toContain(
			"1 projects · 1–1",
		);
		expect(api.loadCoordinatorAdminGroupsFiltered).not.toHaveBeenCalled();

		resolveStatus({ has_admin_secret: true, readiness: "ready" });
		await flushAsyncWork();

		expect(api.loadCoordinatorAdminGroupsFiltered).toHaveBeenCalledWith(false);
	});

	it("clusters related project identities and bulk assigns the group", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project({ cwd: "/workspace/a", memory_count: 2, session_count: 1 }),
				project({
					cwd: "/tmp/worktree-a",
					memory_count: 3,
					session_count: 2,
					workspace_identity: "https://git.example.invalid/exampleco/api.git:worktree",
				}),
			],
			total: 2,
		});

		await loadProjectsData();

		const cluster = document.querySelector<HTMLElement>(".project-inventory-cluster");
		expect(cluster?.textContent).toContain("2 worktrees");
		expect(cluster?.querySelector('[data-label="Memories"]')?.textContent).toBe("5");
		expect(cluster?.querySelector('[data-label="Sessions"]')?.textContent).toBe("3");
		expect(document.body.textContent).toContain("Save Space for 2 identities");
		const select = document.querySelector(
			".project-inventory-cluster select",
		) as HTMLSelectElement | null;
		if (!select) throw new Error("cluster select missing");
		expect(select.value).toBe("");
		select.value = "exampleco-work";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		const save = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "Save Space for 2 identities",
		) as HTMLButtonElement | undefined;
		await vi.waitFor(() => expect(save?.disabled).toBe(false));
		save?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(api.saveSharingDomainProjectMappings).toHaveBeenCalledWith({
			mappings: expect.arrayContaining([
				expect.objectContaining({
					scope_id: "exampleco-work",
					workspace_identity: "https://git.example.invalid/exampleco/api.git",
				}),
				expect.objectContaining({
					scope_id: "exampleco-work",
					workspace_identity: "https://git.example.invalid/exampleco/api.git:worktree",
				}),
			]),
		});
	});

	it("excludes peer-received identities from cluster bulk assignment", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project({
					cwd: "/workspace/a",
					git_remote: null,
					identity_source: "cwd",
					memory_count: 2,
					session_count: 1,
					workspace_identity: "/workspace/a",
				}),
				project({
					cwd: null,
					git_branch: null,
					git_remote: null,
					guardrail_warnings: [
						{
							code: "basename_collision_review",
							message: "Peer-received rows should not block local bulk assignment.",
							requires_confirmation: true,
							severity: "warning",
						},
					],
					identity_source: "workspace_id",
					memory_count: 4,
					read_only: true,
					read_only_reason: "peer_received",
					session_count: 0,
					statuses: ["received"],
					workspace_identity: "peer-received:peer-a:project:api",
				}),
			],
			total: 2,
		});

		await loadProjectsData();

		const cluster = document.querySelector<HTMLElement>(".project-inventory-cluster");
		expect(cluster?.textContent).toContain("2 worktrees");
		expect(cluster?.querySelector('[data-label="Memories"]')?.textContent).toBe("6");
		expect(cluster?.querySelector('[data-label="Sessions"]')?.textContent).toBe("1");
		expect(document.body.textContent).toContain("Save Space for 1 identity");
		const select = document.querySelector(
			".project-inventory-cluster select",
		) as HTMLSelectElement | null;
		if (!select) throw new Error("cluster select missing");
		select.value = "exampleco-work";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		const save = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "Save Space for 1 identity",
		) as HTMLButtonElement | undefined;
		await vi.waitFor(() => expect(save?.disabled).toBe(false));
		save?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(api.saveSharingDomainProjectMappings).toHaveBeenCalledWith({
			mappings: [
				expect.objectContaining({
					scope_id: "exampleco-work",
					workspace_identity: "/workspace/a",
				}),
			],
		});
	});

	it("does not show bulk Space controls for unmapped-only clusters", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project({
					cwd: null,
					git_remote: null,
					identity_source: "unmapped",
					workspace_identity: "unmapped:one",
				}),
				project({
					cwd: null,
					git_remote: null,
					identity_source: "unmapped",
					workspace_identity: "unmapped:two",
				}),
			],
			total: 2,
		});

		await loadProjectsData();

		expect(document.body.textContent).not.toContain("Save Space for");
		expect(document.querySelector(".project-inventory-cluster select")).toBeNull();
	});

	it("blocks cluster bulk assignment when an identity needs guardrail review", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project(),
				project({
					guardrail_warnings: [
						{
							code: "basename_collision_review",
							message: "Another project is also named api.",
							requires_confirmation: true,
							severity: "warning",
						},
					],
					workspace_identity: "https://git.example.invalid/exampleco/api.git:worktree",
				}),
			],
			total: 2,
		});

		await loadProjectsData();
		const save = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "Save Space for 2 identities",
		) as HTMLButtonElement | undefined;
		save?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(save?.disabled).toBe(true);
		expect(api.saveSharingDomainProjectMappings).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("need individual review");
		expect(document.body.textContent).toContain(
			"Blocked identity: https://git.example.invalid/exampleco/api.git:worktree",
		);
		expect(document.body.textContent).toContain("Another project is also named api.");
		expect(document.body.textContent).toContain("Space assignment");
	});

	it("does not block cluster bulk assignment for informational guardrail warnings", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project(),
				project({
					guardrail_warnings: [
						{
							code: "unknown_project_local_only",
							message: "This identity currently stays Local only.",
							requires_confirmation: false,
							severity: "warning",
						},
					],
					workspace_identity: "https://git.example.invalid/exampleco/api.git:worktree",
				}),
			],
			total: 2,
		});

		await loadProjectsData();
		const select = document.querySelector(
			".project-inventory-cluster select",
		) as HTMLSelectElement | null;
		if (!select) throw new Error("cluster select missing");
		select.value = "exampleco-work";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		const save = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "Save Space for 2 identities",
		) as HTMLButtonElement | undefined;
		await vi.waitFor(() => expect(save?.disabled).toBe(false));
		expect(document.body.textContent).not.toContain("Blocked identity:");

		save?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(api.saveSharingDomainProjectMappings).toHaveBeenCalledWith({
			mappings: expect.arrayContaining([
				expect.objectContaining({
					scope_id: "exampleco-work",
					workspace_identity: "https://git.example.invalid/exampleco/api.git:worktree",
				}),
			]),
		});
	});

	it("requires explicit cluster domain choice for mixed suggestions", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project({ suggested_scope_id: "exampleco-work" }),
				project({
					resolved_scope_id: "personal",
					suggested_scope_id: "personal",
					workspace_identity: "https://git.example.invalid/exampleco/api.git:worktree",
				}),
			],
			total: 2,
		});

		await loadProjectsData();
		const select = document.querySelector(
			".project-inventory-cluster select",
		) as HTMLSelectElement | null;
		const save = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "Save Space for 2 identities",
		) as HTMLButtonElement | undefined;

		expect(select?.value).toBe("");
		expect(save?.disabled).toBe(true);
		expect(document.body.textContent).toContain("mixed suggestions or current Spaces");
	});

	it("does not partially update cluster identities when bulk assignment fails", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project({ cwd: "/workspace/a" }),
				project({
					cwd: "/tmp/worktree-a",
					workspace_identity: "https://git.example.invalid/exampleco/api.git:worktree",
				}),
			],
			total: 2,
		});
		vi.mocked(api.saveSharingDomainProjectMappings).mockRejectedValueOnce(
			new api.SharingDomainGuardrailConfirmationError({
				guardrail_warnings: [],
				required_guardrail_tokens: ["token-1"],
			}),
		);

		await loadProjectsData();
		const select = document.querySelector(
			".project-inventory-cluster select",
		) as HTMLSelectElement | null;
		if (!select) throw new Error("cluster select missing");
		select.value = "exampleco-work";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		const save = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "Save Space for 2 identities",
		) as HTMLButtonElement | undefined;
		await vi.waitFor(() => expect(save?.disabled).toBe(false));
		save?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(api.saveSharingDomainProjectMappings).toHaveBeenCalledTimes(1);
		expect(api.saveSharingDomainProjectMapping).not.toHaveBeenCalled();
	});

	it("does not render assignment controls for unmapped projects", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 50,
			offset: 0,
			projects: [
				project({
					identity_source: "unmapped",
					statuses: ["local_only", "unmapped"],
					workspace_identity: "unmapped:abc123",
				}),
			],
			total: 1,
		});

		await loadProjectsData();

		expect(document.body.textContent).toContain(
			"Stays on this device until it has a path, git remote, or workspace id.",
		);
		expect(document.querySelector(".project-domain-select")).toBeNull();
	});

	it("excludes legacy review from assignment options", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 50,
			offset: 0,
			projects: [project()],
			total: 1,
		});

		await loadProjectsData();

		const values = Array.from(document.querySelectorAll("option")).map(
			(option) => (option as HTMLOptionElement).value,
		);
		expect(values).toContain("local-default");
		expect(values).toContain("exampleco-work");
		expect(values).not.toContain("legacy-shared-review");
	});

	it("groups assignable Spaces by Team", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 50,
			offset: 0,
			projects: [project({ resolved_scope_id: "exampleco-work" })],
			total: 1,
		});

		await loadProjectsData();

		const groups = Array.from(document.querySelectorAll("optgroup")).map((group) => ({
			label: group.label,
			options: Array.from(group.querySelectorAll("option")).map((option) => option.textContent),
		}));
		expect(groups).toEqual([
			{ label: "Local device", options: ["Local only"] },
			{ label: "Team: ExampleCo Team", options: ["ExampleCo Work (default)"] },
		]);
		expect(document.body.textContent).toContain("ExampleCo Work (default) · Team: ExampleCo Team");
	});

	it("disambiguates duplicate Space names in assignment options", async () => {
		vi.mocked(api.loadSharingDomainSettings).mockResolvedValue({
			local_default_scope_id: "local-default",
			mappings: [],
			projects: [],
			scopes: [
				{
					authority_type: "local",
					kind: "system",
					label: "Local only",
					scope_id: "local-default",
					status: "active",
				},
				{
					authority_type: "coordinator",
					group_id: "exampleco",
					kind: "team",
					label: "Client Work",
					scope_id: "client-work-a",
					status: "active",
				},
				{
					authority_type: "coordinator",
					group_id: "exampleco",
					kind: "team",
					label: "Client Work",
					scope_id: "client-work-b",
					status: "active",
				},
			],
		});
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 50,
			offset: 0,
			projects: [project()],
			total: 1,
		});

		await loadProjectsData();

		const teamGroupOptions = Array.from(
			document
				.querySelector('optgroup[label="Team: ExampleCo Team"]')
				?.querySelectorAll("option") ?? [],
		).map((option) => option.textContent);
		expect(teamGroupOptions).toEqual([
			"Client Work · Space ID client-work-a",
			"Client Work · Space ID client-work-b",
		]);
	});

	it("ignores stale suggested Spaces that are not assignable", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 50,
			offset: 0,
			projects: [project({ suggested_scope_id: "legacy-shared-review" })],
			total: 1,
		});

		await loadProjectsData();

		const select = document.querySelector(".project-domain-select") as HTMLSelectElement | null;
		const save = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "Save Space",
		) as HTMLButtonElement | undefined;
		expect(select?.value).toBe("local-default");
		await vi.waitFor(() => expect(save?.disabled).toBe(false));
		save?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(api.saveSharingDomainProjectMapping).toHaveBeenCalledWith(
			expect.objectContaining({ scope_id: "local-default" }),
		);
	});

	it("keeps expanded project details open after refresh", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 50,
			offset: 0,
			projects: [project()],
			total: 1,
		});

		await loadProjectsData();
		const details = document.querySelector("details");
		expect(details).not.toBeNull();
		details?.setAttribute("open", "");
		details?.dispatchEvent(new Event("toggle"));

		await loadProjectsData();

		expect(document.querySelector("details")?.open).toBe(true);
	});

	it("keeps draft domain selection after refresh", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 25,
			offset: 0,
			projects: [project()],
			total: 1,
		});

		await loadProjectsData();
		const select = document.querySelector(".project-domain-select") as HTMLSelectElement | null;
		expect(select).not.toBeNull();
		if (!select) throw new Error("select missing");
		select.value = "exampleco-work";
		select.dispatchEvent(new Event("change", { bubbles: true }));

		await loadProjectsData();

		expect(
			(document.querySelector(".project-domain-select") as HTMLSelectElement | null)?.value,
		).toBe("exampleco-work");
	});

	it("explains backend guardrail confirmation as a required acknowledgement", async () => {
		const refresh = vi.fn();
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 25,
			offset: 0,
			projects: [project()],
			total: 1,
		});
		vi.mocked(api.saveSharingDomainProjectMapping).mockRejectedValueOnce(
			new api.SharingDomainGuardrailConfirmationError({
				guardrail_warnings: [
					{
						code: "unknown_project_local_only",
						message:
							"No Space assignment matches this project, so future memories stay Local only until you assign one.",
						requires_confirmation: true,
						severity: "warning",
					},
					{
						code: "basename_collision_review",
						message:
							"Another workspace is also named api. Review the git remote or path before assigning a non-local Space.",
						requires_confirmation: true,
						severity: "warning",
					},
				],
				required_guardrail_tokens: ["token-1", "token-2"],
			}),
		);

		initProjectsTab(refresh);
		await loadProjectsData();
		const select = document.querySelector(".project-domain-select") as HTMLSelectElement | null;
		if (!select) throw new Error("select missing");
		select.value = "exampleco-work";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		const save = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "Save Space",
		) as HTMLButtonElement | undefined;
		save?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await loadProjectsData();

		expect(document.body.textContent).toContain("Confirmation required before saving this Space.");
		expect(document.body.textContent).toContain(
			"Codemem can save this change after you acknowledge the checks below.",
		);
		expect(document.body.textContent).toContain("Current behavior:");
		expect(document.body.textContent).toContain("Name collision:");
		expect(document.body.textContent).toContain("I understand, save Space");
		expect(document.body.textContent).not.toContain("Confirm and save");
	});

	it("clears stale guardrail confirmation when the draft domain changes", async () => {
		const refresh = vi.fn();
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 25,
			offset: 0,
			projects: [project()],
			total: 1,
		});
		vi.mocked(api.saveSharingDomainProjectMapping).mockRejectedValueOnce(
			new api.SharingDomainGuardrailConfirmationError({
				guardrail_warnings: [
					{
						code: "basename_collision_review",
						message:
							"Another workspace is also named api. Review the git remote or path before assigning a non-local Space.",
						requires_confirmation: true,
						severity: "warning",
					},
				],
				required_guardrail_tokens: ["token-1"],
			}),
		);

		initProjectsTab(refresh);
		await loadProjectsData();
		const select = document.querySelector(".project-domain-select") as HTMLSelectElement | null;
		if (!select) throw new Error("select missing");
		select.value = "exampleco-work";
		select.dispatchEvent(new Event("change", { bubbles: true }));
		const save = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "Save Space",
		) as HTMLButtonElement | undefined;
		save?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await loadProjectsData();
		expect(document.body.textContent).toContain("I understand, save Space");
		const staleConfirm = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "I understand, save Space",
		) as HTMLButtonElement | undefined;
		expect(api.saveSharingDomainProjectMapping).toHaveBeenCalledTimes(1);

		const nextSelect = document.querySelector(".project-domain-select") as HTMLSelectElement | null;
		if (!nextSelect) throw new Error("select missing after refresh");
		nextSelect.focus();
		nextSelect.value = "local-default";
		nextSelect.dispatchEvent(new Event("change", { bubbles: true }));
		await vi.waitFor(() =>
			expect(document.body.textContent).not.toContain("I understand, save Space"),
		);
		staleConfirm?.click();
		expect(api.saveSharingDomainProjectMapping).toHaveBeenCalledTimes(1);
		await loadProjectsData();

		expect(document.body.textContent).not.toContain("I understand, save Space");
		expect(document.body.textContent).not.toContain(
			"Confirmation required before saving this Space.",
		);
		expect(refresh).toHaveBeenCalled();
	});

	it("surfaces suggestions and attention warnings on the collapsed card", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 50,
			offset: 0,
			projects: [
				project({
					guardrail_warnings: [
						{
							code: "basename_collision_review",
							message: "Another project is also named api.",
							requires_confirmation: true,
							severity: "warning",
						},
					],
					statuses: ["suggested", "needs_attention"],
					suggested_scope_id: "exampleco-work",
					suggestion_reason:
						"ExampleCo Work is suggested because the git remote contains exampleco.",
				}),
			],
			total: 1,
		});

		await loadProjectsData();

		expect(document.body.textContent).toContain("Suggestion: ExampleCo Work is suggested");
		expect(document.body.textContent).toContain(
			"Needs attention: Another project is also named api.",
		);
	});

	it("lets project rows reassign their stored project", async () => {
		const refresh = vi.fn();
		vi.mocked(openSyncInputDialog).mockResolvedValue("codemem");
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 25,
			offset: 0,
			projects: [project({ memory_count: 11, project: "injection", session_count: 1 })],
			total: 1,
		});

		initProjectsTab(refresh);
		await loadProjectsData();
		const changeProject = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "Change project…",
		) as HTMLButtonElement | undefined;
		expect(changeProject).not.toBeUndefined();

		changeProject?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(openSyncInputDialog).toHaveBeenCalledWith(
			expect.objectContaining({
				description: expect.stringContaining("1 session and 11 memories"),
				initialValue: "injection",
				title: "Change project",
			}),
		);
		expect(api.reassignProjectInventoryProject).toHaveBeenCalledWith({
			project: "codemem",
			workspace_identity: "https://git.example.invalid/exampleco/api.git",
		});
		expect(refresh).toHaveBeenCalled();
	});

	it("disables project reassignment for saved mappings with no sessions", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 25,
			offset: 0,
			projects: [
				project({
					memory_count: 0,
					resolution_reason: "exact_mapping",
					session_count: 0,
				}),
			],
			total: 1,
		});

		await loadProjectsData();

		const changeProject = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "Change project…",
		) as HTMLButtonElement | undefined;
		expect(changeProject?.disabled).toBe(true);
		expect(changeProject?.title).toContain("No sessions");
	});

	it("confirms cleanup before forgetting local project memories", async () => {
		const refresh = vi.fn();
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project({ memory_count: 7 })],
			total: 1,
		});
		vi.mocked(api.forgetProjectInventoryMemories).mockRejectedValueOnce(
			new api.ProjectForgetConfirmationError({
				confirmation_token: "confirm-token",
				local_owned_memory_count: 5,
				peer_owned_memory_count: 2,
				workspace_identity: "https://git.example.invalid/exampleco/api.git",
			}),
		);

		initProjectsTab(refresh);
		await loadProjectsData();
		const forget = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "Forget local memories…",
		) as HTMLButtonElement | undefined;
		forget?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await loadProjectsData();

		expect(document.body.textContent).toContain("Confirm project memory cleanup");
		expect(document.body.textContent).toContain("5 locally owned memories will be forgotten");
		expect(document.body.textContent).toContain("2 peer-owned memories will be left unchanged");
		const confirm = Array.from(document.querySelectorAll("button")).find(
			(button) => button.textContent === "I understand, forget local memories",
		) as HTMLButtonElement | undefined;
		confirm?.click();
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(api.forgetProjectInventoryMemories).toHaveBeenLastCalledWith({
			confirmation_token: "confirm-token",
			confirmed: true,
			workspace_identity: "https://git.example.invalid/exampleco/api.git",
		});
	});

	it("bulk-selects exact canonical Projects and opens sorted recipient sharing", async () => {
		const alpha = project({
			display_project: "alpha",
			git_remote: "git:alpha",
			project: "alpha",
			workspace_identity: "project-zeta",
		});
		const beta = project({
			display_project: "beta",
			git_remote: "git:beta",
			project: "beta",
			workspace_identity: "project-alpha",
		});
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [alpha, beta],
			total: 2,
		});

		initProjectsTab(() => {});
		await loadProjectsData();
		document
			.querySelector<HTMLInputElement>('input[aria-label="Select alpha for recipient sharing"]')
			?.click();
		document
			.querySelector<HTMLInputElement>('input[aria-label="Select beta for recipient sharing"]')
			?.click();

		const shareSelected = document.getElementById("projectsShareSelected") as HTMLButtonElement;
		expect(shareSelected.textContent).toBe("Add Teams or Identities (2)");
		expect(shareSelected.disabled).toBe(false);
		expect(document.getElementById("projectsSelectionStatus")?.textContent).toBe(
			"2 Projects selected.",
		);
		shareSelected.click();

		expect(recipientPolicyManagement.openRecipientPolicyManagement).toHaveBeenCalledWith({
			mode: "project-add",
			projectIds: ["project-alpha", "project-zeta"],
		});
	});

	it("keeps selection across renders and prunes Projects absent from complete inventory", async () => {
		initProjectsTab(() => {});
		const alpha = project({
			display_project: "alpha",
			git_remote: "git:alpha",
			project: "alpha",
			workspace_identity: "project-alpha",
		});
		const beta = project({
			display_project: "beta",
			git_remote: "git:beta",
			project: "beta",
			workspace_identity: "project-beta",
		});
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [alpha, beta],
			total: 2,
		});

		await loadProjectsData();
		document
			.querySelector<HTMLInputElement>('input[aria-label="Select alpha for recipient sharing"]')
			?.click();
		document
			.querySelector<HTMLInputElement>('input[aria-label="Select beta for recipient sharing"]')
			?.click();
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [alpha],
			total: 1,
		});

		await loadProjectsData();

		expect(document.getElementById("projectsSelectionStatus")?.textContent).toBe(
			"1 Project selected.",
		);
		expect(
			document.querySelector<HTMLInputElement>(
				'input[aria-label="Select alpha for recipient sharing"]',
			)?.checked,
		).toBe(true);
	});

	it("keeps inventory usable and disables recipient actions when intent loading fails", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project()],
			total: 1,
		});
		vi.mocked(api.loadRecipientPolicyIntent).mockRejectedValueOnce(new Error("intent unavailable"));

		initProjectsTab(() => {});
		await loadProjectsData();

		expect(document.body.textContent).toContain("Unavailable");
		expect(document.querySelector<HTMLButtonElement>(".project-recipient-action")?.disabled).toBe(
			true,
		);
		expect(
			document.getElementById("projectsShareSelected")?.getAttribute("disabled"),
		).not.toBeNull();
		expect(recipientPolicyManagement.mountRecipientPolicyManagement).toHaveBeenCalledWith(
			document.getElementById("recipientPolicyManagementMount"),
			[
				{
					canonicalProjectIdentity: project().workspace_identity,
					displayName: "api",
					existingMemoryCount: 1,
				},
			],
			expect.objectContaining({ projectRecipients: [] }),
			expect.objectContaining({ loadError: true }),
		);
	});

	it("mounts complete inventory and clears selection after a successful management commit", async () => {
		const refresh = vi.fn();
		const selected = project({
			display_project: "selected",
			workspace_identity: "project-selected",
		});
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [selected],
			total: 1,
		});

		initProjectsTab(refresh);
		await loadProjectsData();
		document.querySelector<HTMLInputElement>(".project-selection-checkbox")?.click();
		const calls = vi.mocked(recipientPolicyManagement.mountRecipientPolicyManagement).mock.calls;
		const options = calls[calls.length - 1]?.[3];
		expect(calls[calls.length - 1]?.[1]).toEqual([
			{
				canonicalProjectIdentity: "project-selected",
				displayName: "selected",
				existingMemoryCount: 1,
			},
		]);
		await options?.onCommitted?.({
			version: 1,
			status: "applied",
			reviewedPolicyDigest: "digest",
			errorCode: null,
			outcomes: [],
			writeCount: 1,
			idempotent: false,
		});

		expect(refresh).toHaveBeenCalled();
		expect(document.getElementById("projectsSelectionStatus")?.textContent).toBe(
			"0 Projects selected.",
		);
	});

	it("aggregates clustered recipients and shares all exact canonical identities", async () => {
		const first = project({ cwd: "/workspace/a", workspace_identity: "project-zeta" });
		const second = project({ cwd: "/workspace/b", workspace_identity: "project-alpha" });
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [first, second],
			total: 2,
		});
		vi.mocked(api.loadRecipientPolicyIntent).mockResolvedValue(
			recipientIntent({
				projectRecipients: [
					{
						version: 1,
						canonicalProjectIdentity: "project-zeta",
						recipientKind: "team",
						teamId: "team-example",
						intentSource: "user",
						policyRevision: "one",
						status: "active",
					},
					{
						version: 1,
						canonicalProjectIdentity: "project-alpha",
						recipientKind: "identity",
						identityId: "identity-adam",
						intentSource: "user",
						policyRevision: "two",
						status: "active",
					},
				],
			}),
		);

		await loadProjectsData();

		const cluster = document.querySelector<HTMLElement>(".project-inventory-cluster");
		if (!cluster) throw new Error("project cluster missing");
		expect(
			[
				...cluster.querySelectorAll(
					":scope > .project-inventory-row-header .project-recipient-chip",
				),
			].map((chip) => chip.textContent),
		).toEqual(["Identity: Adam", "Team: ExampleCo"]);
		const action = cluster.querySelector<HTMLButtonElement>(
			":scope > .project-inventory-row-header .project-recipient-action",
		);
		expect(action?.textContent).toBe("Add Teams or Identities");
		expect(action?.getAttribute("aria-label")).toBe("Add Teams or Identities for api");
		const clusterSelection = cluster.querySelector<HTMLInputElement>(
			':scope > .project-inventory-row-header input[aria-label="Select all identities for api"]',
		);
		clusterSelection?.click();
		expect(document.getElementById("projectsSelectionStatus")?.textContent).toBe(
			"2 Projects selected.",
		);
		action?.click();
		expect(recipientPolicyManagement.openRecipientPolicyManagement).toHaveBeenCalledWith({
			mode: "project-add",
			projectIds: ["project-alpha", "project-zeta"],
		});
	});
}

describe("Projects cluster suggestions", () => {
	beforeEach(setupProjectsTest);
	afterEach(cleanupProjectsTest);

	it("does not classify a missing suggestion as a mixed cluster suggestion", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project({ suggested_scope_id: "exampleco-work" }),
				project({
					suggested_scope_id: null,
					workspace_identity: "https://git.example.invalid/exampleco/api.git:worktree",
				}),
			],
			total: 2,
		});

		await loadProjectsData();

		expect(document.body.textContent).not.toContain("mixed suggestions or current Spaces");
	});
});

describe("Projects inventory controller", () => {
	beforeEach(setupProjectsTest);
	afterEach(cleanupProjectsTest);

	it("exposes a serializable inventory view model for component renderers", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project()],
			total: 1,
		});

		initProjectsTab(() => {});
		await loadProjectsData();
		const controller = getProjectsInventoryController();
		const viewModel = controller.getViewModel();

		expect(viewModel.rows).toHaveLength(1);
		expect(viewModel.rows[0]).toMatchObject({
			kind: "project",
			key: `local:${project().workspace_identity}`,
			shareEligible: true,
			shareReady: true,
		});
		expect(viewModel.pagination).toEqual({ hasMore: false, limit: 250, offset: 0, total: 1 });
		expect(viewModel.selection).toMatchObject({ count: 0, projectIds: [] });
		expect(() => JSON.stringify(viewModel)).not.toThrow();
		expect(controller.callbacks.toggleSelection).toEqual(expect.any(Function));
		controller.callbacks.shareProject(project().workspace_identity);
		expect(projectSharing.openProjectShareFlow).toHaveBeenCalledWith([
			project().workspace_identity,
		]);
	});
});

describe("Projects inventory controller collision keys", () => {
	beforeEach(setupProjectsTest);
	afterEach(cleanupProjectsTest);

	it("keys colliding local and peer rows independently", async () => {
		const workspaceIdentity = "peer-received:controller-collision";
		vi.mocked(api.loadRecipientPolicyIntent).mockResolvedValue(
			recipientIntent({
				projectRecipients: [
					{
						version: 1,
						canonicalProjectIdentity: workspaceIdentity,
						intentSource: "user",
						policyRevision: "revision-1",
						recipientKind: "team",
						teamId: "team-example",
						status: "active",
					},
				],
			}),
		);
		vi.mocked(api.saveSharingDomainProjectMapping).mockRejectedValueOnce(
			new api.SharingDomainGuardrailConfirmationError({
				required_guardrail_tokens: ["confirm-scope"],
				guardrail_warnings: [
					{
						code: "scope_change",
						message: "Confirm this Space.",
						requires_confirmation: true,
						severity: "warning",
					},
				],
			}),
		);
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project({ workspace_identity: workspaceIdentity }),
				project({
					read_only: true,
					read_only_reason: "peer_received",
					workspace_identity: workspaceIdentity,
				}),
			],
			total: 2,
		});
		initProjectsTab(() => {});
		await loadProjectsData();
		const controller = getProjectsInventoryController();
		const row = controller.getViewModel().rows[0];
		if (row?.kind !== "cluster") throw new Error("colliding project cluster missing");
		expect(new Set(row.projects.map((entry) => entry.key)).size).toBe(2);
		const peerRow = row.projects.find((entry) => entry.project.read_only === true);
		if (!peerRow) throw new Error("peer project row missing");

		controller.callbacks.setProjectDetailsOpen(peerRow.key, true);

		const refreshedRow = controller.getViewModel().rows[0];
		if (refreshedRow?.kind !== "cluster") {
			throw new Error("refreshed colliding project cluster missing");
		}
		expect(refreshedRow.projects.find((entry) => entry.key === peerRow.key)?.detailsOpen).toBe(
			true,
		);
		expect(
			refreshedRow.projects.find((entry) => entry.project.read_only !== true)?.detailsOpen,
		).toBe(false);

		await controller.callbacks.saveProjectScope(workspaceIdentity, "exampleco-work");
		const confirmationRow = controller.getViewModel().rows[0];
		if (confirmationRow?.kind !== "cluster") {
			throw new Error("confirmation project cluster missing");
		}
		expect(
			confirmationRow.projects.find((entry) => entry.project.read_only !== true)
				?.pendingConfirmation,
		).not.toBeNull();
		expect(
			confirmationRow.projects.find((entry) => entry.project.read_only === true)
				?.pendingConfirmation,
		).toBeNull();
		controller.callbacks.setProjectScopeDraft(workspaceIdentity, "exampleco-work");
		const draftRow = controller.getViewModel().rows[0];
		if (draftRow?.kind !== "cluster") throw new Error("draft project cluster missing");
		const localProject = draftRow.projects.find((entry) => entry.project.read_only !== true);
		const peerProject = draftRow.projects.find((entry) => entry.project.read_only === true);
		expect(localProject?.draftScopeId).toBe("exampleco-work");
		expect(localProject?.recipients).toHaveLength(1);
		expect(peerProject?.draftScopeId).toBeNull();
		expect(peerProject?.recipients).toEqual([]);
	});
});

describe("Projects inventory controller subscriptions", () => {
	beforeEach(setupProjectsTest);
	afterEach(cleanupProjectsTest);

	it("notifies component subscribers and stops after unsubscribe", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project()],
			total: 1,
		});
		initProjectsTab(() => {});
		await loadProjectsData();
		const controller = getProjectsInventoryController();
		const notifications: ProjectsInventoryViewModel[] = [];
		const listener = vi.fn((viewModel: ProjectsInventoryViewModel) => {
			notifications.push(viewModel);
		});
		const unsubscribe = controller.subscribe(listener);
		const legacyDetails = document.querySelector<HTMLDetailsElement>(".project-inventory-details");
		if (!legacyDetails) throw new Error("legacy project details missing");
		legacyDetails.open = true;
		legacyDetails.dispatchEvent(new Event("toggle"));
		expect(listener).toHaveBeenLastCalledWith(
			expect.objectContaining({ rows: [expect.objectContaining({ detailsOpen: true })] }),
		);
		listener.mockClear();

		controller.callbacks.toggleSelection([project().workspace_identity]);
		const projectRow = controller.getViewModel().rows[0];
		if (projectRow?.kind !== "project") throw new Error("project row missing");
		controller.callbacks.setProjectDetailsOpen(projectRow.key, true);
		controller.callbacks.setProjectScopeDraft(project().workspace_identity, "exampleco-work");

		expect(listener).toHaveBeenCalledTimes(3);
		expect(listener).toHaveBeenLastCalledWith(
			expect.objectContaining({
				selection: expect.objectContaining({ count: 1 }),
			}),
		);
		const row = notifications.at(-1)?.rows[0];
		expect(row).toMatchObject({
			detailsOpen: true,
			draftScopeId: "exampleco-work",
		});

		unsubscribe();
		controller.callbacks.toggleSelection([project().workspace_identity]);
		controller.callbacks.setProjectDetailsOpen(projectRow.key, false);
		await controller.callbacks.saveProjectScope(project().workspace_identity, "local-default");
		expect(listener).toHaveBeenCalledTimes(3);
	});

	it("notifies subscribers for legacy cluster and project controls", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [
				project({ cwd: "/workspace/a", workspace_identity: "project-a" }),
				project({ cwd: "/workspace/b", workspace_identity: "project-b" }),
			],
			total: 2,
		});
		initProjectsTab(() => {});
		await loadProjectsData();
		const listener = vi.fn();
		getProjectsInventoryController().subscribe(listener);

		const cluster = document.querySelector<HTMLElement>(".project-inventory-cluster");
		const details = cluster?.querySelector<HTMLDetailsElement>(":scope > details");
		const selects = cluster?.querySelectorAll<HTMLSelectElement>(".project-domain-select");
		const share = cluster?.querySelector<HTMLButtonElement>(
			":scope > .project-inventory-row-header .project-recipient-action",
		);
		if (!details || !selects || selects.length < 2 || !share) {
			throw new Error("legacy cluster controls missing");
		}

		details.open = true;
		details.dispatchEvent(new Event("toggle"));
		expect(listener).toHaveBeenCalledTimes(1);
		selects[0].value = "exampleco-work";
		selects[0].dispatchEvent(new Event("change"));
		expect(listener).toHaveBeenCalledTimes(2);
		selects[1].value = "exampleco-work";
		selects[1].dispatchEvent(new Event("change"));
		expect(listener).toHaveBeenCalledTimes(3);
		share.click();
		expect(listener).toHaveBeenCalledTimes(4);
	});
});

describe("Projects inventory controller async state", () => {
	beforeEach(setupProjectsTest);
	afterEach(cleanupProjectsTest);

	it("notifies subscribers when an async save requires confirmation", async () => {
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project()],
			total: 1,
		});
		vi.mocked(api.saveSharingDomainProjectMapping).mockRejectedValueOnce(
			new api.SharingDomainGuardrailConfirmationError({
				required_guardrail_tokens: ["confirm-scope"],
				guardrail_warnings: [
					{
						code: "scope_reassignment_old_copies",
						message: "Confirm this Space.",
						requires_confirmation: true,
						severity: "warning",
					},
				],
			}),
		);
		initProjectsTab(() => {});
		await loadProjectsData();
		const controller = getProjectsInventoryController();
		const notifications: ProjectsInventoryViewModel[] = [];
		const listener = vi.fn((viewModel: ProjectsInventoryViewModel) => {
			notifications.push(viewModel);
		});
		const unsubscribe = controller.subscribe(listener);

		await controller.callbacks.saveProjectScope(project().workspace_identity, "exampleco-work");

		expect(listener).toHaveBeenCalled();
		expect(notifications.at(-1)?.rows[0]).toMatchObject({
			pendingConfirmation: {
				requiredGuardrailTokens: ["confirm-scope"],
				scopeId: "exampleco-work",
			},
		});
		unsubscribe();
		controller.callbacks.cancelProjectScopeConfirmation(project().workspace_identity);
	});
});

describe("Projects inventory controller page snapshots", () => {
	beforeEach(setupProjectsTest);
	afterEach(cleanupProjectsTest);

	it("does not render a previous page after the requested offset changes", async () => {
		let resolvePreviousPage: (value: ProjectScopeInventoryResult) => void = () => {};
		const previousPage = new Promise<ProjectScopeInventoryResult>((resolve) => {
			resolvePreviousPage = resolve;
		});
		let callCount = 0;
		vi.mocked(api.loadProjectScopeInventory).mockImplementation(async () => {
			callCount += 1;
			if (callCount === 1) return previousPage;
			return { has_more: false, limit: 250, offset: 0, projects: [], total: 0 };
		});
		initProjectsTab(() => {});
		const status = document.getElementById("projectsStatusFilter") as HTMLSelectElement;
		status.dispatchEvent(new Event("change"));
		const previousLoad = loadProjectsData();
		document.getElementById("projectsNextPage")?.click();
		resolvePreviousPage({
			has_more: true,
			limit: 250,
			offset: 0,
			projects: [project({ display_project: "previous page" })],
			total: 251,
		});

		expect(await previousLoad).toBe(false);
		expect(document.body.textContent).not.toContain("previous page");
	});
});

describe("Projects inventory controller coordinator refresh", () => {
	beforeEach(setupProjectsTest);
	afterEach(cleanupProjectsTest);

	it("does not redraw a previous page after coordinator names load", async () => {
		let resolveCoordinatorStatus: (value: {
			has_admin_secret: boolean;
			readiness: "ready";
		}) => void = () => {};
		vi.mocked(api.loadCoordinatorAdminStatus).mockImplementationOnce(
			async () =>
				new Promise<{ has_admin_secret: boolean; readiness: "ready" }>((resolve) => {
					resolveCoordinatorStatus = resolve;
				}),
		);
		vi.mocked(api.loadProjectScopeInventory)
			.mockResolvedValueOnce({
				has_more: true,
				limit: 250,
				offset: 0,
				projects: [project({ display_project: "previous page" })],
				total: 251,
			})
			.mockResolvedValue({
				has_more: false,
				limit: 250,
				offset: 0,
				projects: [project({ display_project: "previous page" })],
				total: 1,
			});
		initProjectsTab(() => {});
		const status = document.getElementById("projectsStatusFilter") as HTMLSelectElement;
		status.dispatchEvent(new Event("change"));
		await loadProjectsData();
		const previousRow = document.querySelector(".project-inventory-row");

		document.getElementById("projectsNextPage")?.click();
		resolveCoordinatorStatus({ has_admin_secret: true, readiness: "ready" });
		await flushAsyncWork();

		expect(document.querySelector(".project-inventory-row")).toBe(previousRow);
	});
});

describe("Projects inventory controller filter snapshots", () => {
	beforeEach(setupProjectsTest);
	afterEach(cleanupProjectsTest);

	it("does not render a completed load after the user changes filters", async () => {
		let resolveOldFiltered: (value: ProjectScopeInventoryResult) => void = () => {};
		const oldFiltered = new Promise<ProjectScopeInventoryResult>((resolve) => {
			resolveOldFiltered = resolve;
		});
		let unfilteredCallCount = 0;
		vi.mocked(api.loadProjectScopeInventory).mockImplementation(async (input) => {
			if (input.q === "new") {
				return {
					has_more: false,
					limit: 250,
					offset: 0,
					projects: [project({ display_project: "new result", workspace_identity: "new-result" })],
					total: 1,
				};
			}
			unfilteredCallCount += 1;
			if (unfilteredCallCount === 1) return oldFiltered;
			return { has_more: false, limit: 250, offset: 0, projects: [], total: 0 };
		});

		initProjectsTab(() => {
			void loadProjectsData();
		});
		const olderLoad = loadProjectsData();
		const search = document.getElementById("projectsSearch") as HTMLInputElement;
		search.value = "new";
		search.dispatchEvent(new Event("input"));
		await vi.waitFor(() => expect(document.body.textContent).toContain("new result"));

		resolveOldFiltered({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [project({ display_project: "old result", workspace_identity: "old-result" })],
			total: 1,
		});
		await olderLoad;

		expect(document.body.textContent).toContain("new result");
		expect(document.body.textContent).not.toContain("old result");
	});
});

describe("Projects refresh cancellation", () => {
	it("does not mark retained Team setup status unavailable after cancellation", async () => {
		const summary = {
			version: 1 as const,
			candidates: [
				{
					candidateRef: "opaque-candidate-ref",
					displayName: "Example Team",
					status: "in_progress" as const,
					deviceCount: 2,
					projectCount: 1,
					unresolvedDeviceCount: 1,
					unresolvedProjectCount: 0,
				},
			],
		};
		vi.mocked(api.loadProjectScopeInventory).mockResolvedValue({
			has_more: false,
			limit: 250,
			offset: 0,
			projects: [],
			total: 0,
		});
		vi.mocked(api.loadLegacyTeamSetupSummary).mockResolvedValueOnce(summary);

		await loadProjectsData();
		await flushAsyncWork();
		const entry = document.querySelector<HTMLElement>(".project-team-setup-entry");
		expect(entry?.textContent).toContain("Example Team");

		vi.mocked(api.loadLegacyTeamSetupSummary).mockImplementationOnce(
			(options: { signal?: AbortSignal } = {}) =>
				new Promise((_, reject) => {
					options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
						once: true,
					});
				}),
		);
		const controller = new AbortController();
		const operation = loadProjectsData({
			awaitTeamSetupSummary: true,
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(api.loadLegacyTeamSetupSummary).toHaveBeenCalledTimes(2));
		let settled = false;
		void operation.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		controller.abort(new DOMException("Refresh canceled", "AbortError"));
		await expect(operation).resolves.toBe(false);

		expect(document.querySelector(".project-team-setup-entry")).toBe(entry);
		expect(entry?.querySelector('[role="status"]')).toBeNull();
	});

	it("does not reuse an unowned Team summary for an aggregate refresh", async () => {
		let resolveUnowned!: (value: LegacyTeamSetupSummaryResponseV1) => void;
		vi.mocked(api.loadLegacyTeamSetupSummary)
			.mockImplementationOnce(() => new Promise((resolve) => (resolveUnowned = resolve)))
			.mockImplementationOnce(
				(options: { signal?: AbortSignal } = {}) =>
					new Promise((_, reject) => {
						options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
							once: true,
						});
					}),
			);
		await loadProjectsData();

		const controller = new AbortController();
		const operation = loadProjectsData({
			awaitTeamSetupSummary: true,
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(api.loadLegacyTeamSetupSummary).toHaveBeenCalledTimes(2));
		controller.abort(new DOMException("Refresh canceled", "AbortError"));

		await expect(operation).resolves.toBe(false);
		resolveUnowned({ version: 1, candidates: [] });
	});

	it("keeps deadline ownership after a required Projects read fails", async () => {
		let resolveTeamSetup!: (value: LegacyTeamSetupSummaryResponseV1) => void;
		vi.mocked(api.loadLegacyTeamSetupSummary).mockImplementationOnce(
			() => new Promise((resolve) => (resolveTeamSetup = resolve)),
		);
		vi.mocked(api.loadProjectScopeInventory).mockRejectedValueOnce(
			new Error("Project inventory unavailable"),
		);

		const operation = loadProjectsData({ awaitTeamSetupSummary: true });
		let settled = false;
		void operation.then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(document.getElementById("projectsInventoryMeta")?.textContent).toBe(
			"Project inventory failed to load.",
		);
		expect(settled).toBe(false);

		resolveTeamSetup({ version: 1, candidates: [] });
		await expect(operation).resolves.toBe(false);
	});
});
