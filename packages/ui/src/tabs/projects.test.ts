import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
	deleteSharingDomainProjectMapping: vi.fn(),
	forgetProjectInventoryMemories: vi.fn(),
	loadProjects: vi.fn(),
	loadCoordinatorAdminGroupsFiltered: vi.fn(),
	loadCoordinatorAdminStatus: vi.fn(),
	loadProjectScopeInventory: vi.fn(),
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
vi.mock("./sync/sync-dialogs", () => ({ openSyncInputDialog: vi.fn() }));

import * as api from "../lib/api";
import type { ProjectScopeInventoryProject } from "../lib/api/sync";
import { state } from "../lib/state";
import { initProjectsTab, loadProjectsData } from "./projects";
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

function mountProjectsDom() {
	document.body.innerHTML = `
		<input id="projectsSearch" />
		<select id="projectsStatusFilter"></select>
		<div id="projectsInventoryMeta"></div>
		<div id="projectsInventorySkeleton"></div>
		<div id="projectsInventoryList"></div>
		<button id="projectsPrevPage"></button>
		<button id="projectsNextPage"></button>
	`;
}

async function flushAsyncWork() {
	for (let i = 0; i < 5; i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe("Projects tab", () => {
	beforeEach(() => {
		mountProjectsDom();
		state.lastCoordinatorAdminGroups = [
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
	});

	afterEach(() => {
		vi.clearAllMocks();
		state.lastCoordinatorAdminGroups = [];
		document.body.innerHTML = "";
	});

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

		expect(document.getElementById("projectsInventoryMeta")?.textContent).toBe(
			"0 project identities found",
		);
		expect(document.body.textContent).not.toContain("showing 1-0");
		expect(api.loadProjectScopeInventory).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 250 }),
		);
		expect(document.getElementById("projectsInventorySkeleton")).toBeNull();
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

		expect(document.body.textContent).toContain("Received from peers");
		expect(document.body.textContent).toContain("Change its project or Space on the source device");
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
			".project-inventory-cluster > .project-inventory-actions .project-domain-select",
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
			".project-inventory-cluster > .project-inventory-actions .project-domain-select",
		) as HTMLSelectElement | null;
		if (!select) throw new Error("cluster Space select missing");
		select.value = "exampleco-work";
		select.dispatchEvent(new Event("change"));

		await loadProjectsData();

		const rerenderedSelect = document.querySelector(
			".project-inventory-cluster > .project-inventory-actions .project-domain-select",
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
			".project-inventory-cluster > .project-inventory-actions .project-domain-select",
		) as HTMLSelectElement | null;
		expect(clearedSelect?.value).toBe("");
	});

	it("refreshes active Team names and ignores archived Teams for Space labels", async () => {
		state.lastCoordinatorAdminGroups = [
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
			"1 project identity found",
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

		expect(document.body.textContent).toContain("2 identities · 3 sessions · 5 memories");
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
		expect(save?.disabled).toBe(false);
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

		expect(document.body.textContent).toContain("2 identities · 1 sessions · 6 memories");
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
		expect(save?.disabled).toBe(false);
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
		expect(document.body.textContent).toContain("Show identities in this project");
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
		expect(save?.disabled).toBe(false);
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

		expect(document.body.textContent).toContain("missing a stable path");
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
		expect(save?.disabled).toBe(false);
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
		select.dispatchEvent(new Event("change"));

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
		select.dispatchEvent(new Event("change"));
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
		select.dispatchEvent(new Event("change"));
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
		nextSelect.dispatchEvent(new Event("change"));
		expect(document.body.textContent).not.toContain("I understand, save Space");
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
});
