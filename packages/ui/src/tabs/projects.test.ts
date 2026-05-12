import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
	deleteSharingDomainProjectMapping: vi.fn(),
	loadProjects: vi.fn(),
	loadProjectScopeInventory: vi.fn(),
	loadSharingDomainSettings: vi.fn(),
	reassignProjectInventoryProject: vi.fn(),
	saveSharingDomainProjectMapping: vi.fn(),
	SharingDomainGuardrailConfirmationError: class SharingDomainGuardrailConfirmationError extends Error {
		requiredGuardrailTokens: string[];
		guardrailWarnings: Array<{ message: string }>;

		constructor(input: {
			required_guardrail_tokens?: string[];
			guardrail_warnings?: Array<{ message: string }>;
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
		<div id="projectsInventoryList"></div>
		<button id="projectsPrevPage"></button>
		<button id="projectsNextPage"></button>
	`;
}

describe("Projects tab", () => {
	beforeEach(() => {
		mountProjectsDom();
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
					kind: "team",
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
	});

	afterEach(() => {
		vi.clearAllMocks();
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

		expect(document.getElementById("projectsInventoryMeta")?.textContent).toBe("0 projects found");
		expect(document.body.textContent).not.toContain("showing 1-0");
		expect(api.loadProjectScopeInventory).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 25 }),
		);
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
});
