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

		const button = root.querySelector("button");
		expect(button?.textContent).toBe("Review projects");
		button?.click();
		expect(onLegacyReview).toHaveBeenCalledTimes(1);
	});
});
