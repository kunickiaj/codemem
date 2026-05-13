import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncSharingReview } from "./sync-sharing-review";

let mount: HTMLDivElement | null = null;

function renderReview(element: Parameters<typeof render>[0]) {
	mount = document.createElement("div");
	document.body.appendChild(mount);
	act(() => {
		render(element, mount as HTMLDivElement);
	});
	return mount;
}

afterEach(() => {
	if (mount) {
		act(() => {
			render(null, mount as HTMLDivElement);
		});
		mount.remove();
		mount = null;
	}
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

describe("SyncSharingReview", () => {
	it("renders grouped legacy shared review without automatic promotion", () => {
		const onLegacyReview = vi.fn();
		const root = renderReview(
			<SyncSharingReview
				items={[]}
				legacyReview={{
					groups: [
						{
							displayProject: "oss-dev",
							identitySource: "git_remote",
							lastUpdatedAt: "2026-05-12T00:00:00Z",
							memoryCount: 3,
							suggestedScopeId: "oss",
							suggestionReason:
								"Existing project mapping can be reviewed as a destination, but legacy data is not promoted automatically.",
							workspaceIdentity: "https://git.example.invalid/oss/dev.git",
						},
					],
					memoryCount: 3,
					scopeId: "legacy-shared-review",
					targetScopes: [
						{ authorityType: "local", label: "Personal", scopeId: "personal" },
						{ authorityType: "coordinator", label: "OSS", scopeId: "oss" },
					],
				}}
				onLegacyReassign={vi.fn()}
				onLegacyReview={onLegacyReview}
				onReview={() => {}}
			/>,
		);

		expect(root.textContent).toContain("Legacy shared review");
		expect(root.textContent).toContain("1 older project needs a Sharing domain");
		expect(root.textContent).toContain("3 older shared memories total");
		expect(root.textContent).toContain("oss-dev");
		expect(root.textContent).toContain("Matched by git remote · suggested oss");
		expect(root.textContent).toContain("Destination Sharing domain");
		expect(root.textContent).toContain("OSS · coordinator · suggested");
		expect(root.textContent).toContain("legacy data is not promoted automatically");
		expect(root.textContent).toContain("Nothing moves automatically");

		const buttons = [...root.querySelectorAll("button")];
		const button = buttons.find((item) => item.textContent === "Manage all projects");
		expect(button).toBeTruthy();
		button?.click();
		expect(onLegacyReview).toHaveBeenCalledTimes(1);
	});

	it("requires explicit confirmation before applying a suggested legacy domain", async () => {
		const onLegacyReassign = vi
			.fn()
			.mockResolvedValueOnce({
				affected_peer_device_count: 1,
				affected_peer_device_ids: ["peer-a"],
				memory_count: 3,
				reassignable_memory_count: 2,
				scope_id: "oss",
				skipped_memory_count: 1,
				target_scope_label: "OSS",
				warning:
					"This changes future sync authorization but does not erase data already copied to peers.",
				workspace_identity: "https://git.example.invalid/oss/dev.git",
			})
			.mockResolvedValueOnce(null);
		const root = renderReview(
			<SyncSharingReview
				items={[]}
				legacyReview={{
					groups: [
						{
							displayProject: "oss-dev",
							identitySource: "git_remote",
							lastUpdatedAt: null,
							memoryCount: 3,
							suggestedScopeId: "oss",
							suggestionReason: "Existing project mapping can be reviewed.",
							workspaceIdentity: "https://git.example.invalid/oss/dev.git",
						},
					],
					memoryCount: 3,
					scopeId: "legacy-shared-review",
					targetScopes: [
						{ authorityType: "local", label: "Personal", scopeId: "personal" },
						{ authorityType: "coordinator", label: "OSS", scopeId: "oss" },
					],
				}}
				onLegacyReassign={onLegacyReassign}
				onReview={() => {}}
			/>,
		);

		const applyButton = [...root.querySelectorAll("button")].find(
			(button) => button.textContent === "Preview reassignment",
		);
		expect(applyButton).toBeTruthy();
		await act(async () => {
			applyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(onLegacyReassign).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceIdentity: "https://git.example.invalid/oss/dev.git" }),
			"oss",
			false,
		);
		expect(root.textContent).toContain("2 of 3 memories");
		expect(root.textContent).toContain("1 peer-owned copies will be left unchanged");

		const confirmButton = [...root.querySelectorAll("button")].find(
			(button) => button.textContent === "I understand, reassign memories",
		);
		expect(confirmButton).toBeTruthy();
		await act(async () => {
			confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(onLegacyReassign).toHaveBeenLastCalledWith(
			expect.objectContaining({ workspaceIdentity: "https://git.example.invalid/oss/dev.git" }),
			"oss",
			true,
		);
	});

	it("lets users choose a non-suggested legacy destination before preview", async () => {
		const onLegacyReassign = vi.fn().mockResolvedValueOnce({
			affected_peer_device_count: 0,
			affected_peer_device_ids: [],
			memory_count: 960,
			reassignable_memory_count: 960,
			scope_id: "oss",
			skipped_memory_count: 0,
			target_scope_label: "OSS",
			warning: "This changes future sync authorization.",
			workspace_identity: "workspace-id:codemem",
		});
		const root = renderReview(
			<SyncSharingReview
				items={[]}
				legacyReview={{
					groups: [
						{
							displayProject: "codemem",
							identitySource: "workspace_id",
							lastUpdatedAt: null,
							memoryCount: 960,
							suggestedScopeId: "personal",
							suggestionReason: "Existing project mapping can be reviewed.",
							workspaceIdentity: "workspace-id:codemem",
						},
					],
					memoryCount: 960,
					scopeId: "legacy-shared-review",
					targetScopes: [
						{ authorityType: "local", label: "Personal", scopeId: "personal" },
						{ authorityType: "coordinator", label: "OSS", scopeId: "oss" },
					],
				}}
				onLegacyReassign={onLegacyReassign}
				onReview={() => {}}
			/>,
		);

		const select = root.querySelector("select");
		expect(select?.value).toBe("personal");
		act(() => {
			if (!select) throw new Error("select missing");
			select.value = "oss";
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});

		const applyButton = [...root.querySelectorAll("button")].find(
			(button) => button.textContent === "Preview reassignment",
		);
		await act(async () => {
			applyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(onLegacyReassign).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceIdentity: "workspace-id:codemem" }),
			"oss",
			false,
		);
	});

	it("filters cleanup groups and previews selected suggested groups in bulk", async () => {
		const onLegacyReassign = vi.fn().mockResolvedValue({
			affected_peer_device_count: 0,
			affected_peer_device_ids: [],
			memory_count: 10,
			reassignable_memory_count: 10,
			scope_id: "oss",
			skipped_memory_count: 0,
			target_scope_label: "OSS",
			warning: "This changes future sync authorization.",
			workspace_identity: "workspace-id:codemem",
		});
		const root = renderReview(
			<SyncSharingReview
				items={[]}
				legacyReview={{
					groups: [
						{
							displayProject: "codemem",
							identitySource: "git_remote",
							lastUpdatedAt: null,
							memoryCount: 10,
							suggestedScopeId: "oss",
							suggestionReason: "Existing project mapping can be reviewed.",
							workspaceIdentity: "workspace-id:codemem",
						},
						{
							displayProject: "fatal: not a git repository (or any parent): .git",
							identitySource: "cwd",
							lastUpdatedAt: null,
							memoryCount: 122,
							suggestedScopeId: "personal",
							suggestionReason: "Existing project mapping can be reviewed.",
							workspaceIdentity: "cwd:fatal",
						},
					],
					memoryCount: 132,
					scopeId: "legacy-shared-review",
					targetScopes: [
						{ authorityType: "local", label: "Personal", scopeId: "personal" },
						{ authorityType: "coordinator", label: "OSS", scopeId: "oss" },
					],
				}}
				onLegacyReassign={onLegacyReassign}
				onReview={() => {}}
			/>,
		);

		expect(root.textContent).toContain("Needs cleanup 1");
		expect(root.textContent).toContain("Unclear project identity");

		const selectSuggested = [...root.querySelectorAll("button")].find(
			(button) => button.textContent === "Select suggested",
		);
		act(() => {
			selectSuggested?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		const bulkPreview = [...root.querySelectorAll("button")].find(
			(button) => button.textContent === "Preview 1 selected",
		);
		await act(async () => {
			bulkPreview?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(onLegacyReassign).toHaveBeenCalledTimes(1);
		expect(onLegacyReassign).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceIdentity: "workspace-id:codemem" }),
			"oss",
			false,
		);
	});

	it("does not show bulk preview controls without a reassignment target", () => {
		const root = renderReview(
			<SyncSharingReview
				items={[]}
				legacyReview={{
					groups: [
						{
							displayProject: "codemem",
							identitySource: "git_remote",
							lastUpdatedAt: null,
							memoryCount: 10,
							suggestedScopeId: null,
							suggestionReason: null,
							workspaceIdentity: "workspace-id:codemem",
						},
					],
					memoryCount: 10,
					scopeId: "legacy-shared-review",
					targetScopes: [],
				}}
				onLegacyReassign={vi.fn()}
				onReview={() => {}}
			/>,
		);

		const checkbox = root.querySelector<HTMLInputElement>('input[type="checkbox"]');
		act(() => {
			checkbox?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(root.textContent).not.toContain("Preview 1 selected");
		expect(root.textContent).toContain("Add or join a Sharing domain before bulk reassignment");
	});
});
