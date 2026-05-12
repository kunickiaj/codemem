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
				}}
				onLegacyReview={onLegacyReview}
				onReview={() => {}}
			/>,
		);

		expect(root.textContent).toContain("Legacy shared review");
		expect(root.textContent).toContain("3 historical shared memories");
		expect(root.textContent).toContain("oss-dev · git_remote · suggested oss");
		expect(root.textContent).toContain("legacy data is not promoted automatically");
		expect(root.textContent).toContain(
			"Remapping or revocation does not erase data already copied",
		);

		const buttons = [...root.querySelectorAll("button")];
		const button = buttons.find((item) => item.textContent === "Review projects");
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
				}}
				onLegacyReassign={onLegacyReassign}
				onReview={() => {}}
			/>,
		);

		const applyButton = [...root.querySelectorAll("button")].find(
			(button) => button.textContent === "Review suggested reassignment",
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
});
