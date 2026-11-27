import type { ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./primitives/radix-dialog", () => {
	let previouslyOpen = false;
	return {
		RadixDialog: (props: {
			children?: ComponentChildren;
			contentId: string;
			onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
			onOpenAutoFocus?: (event: { preventDefault: () => void }) => void;
			onOpenChange: (open: boolean) => void;
			open: boolean;
		}) => {
			if (!props.open) {
				if (previouslyOpen) {
					queueMicrotask(() => props.onCloseAutoFocus?.({ preventDefault: () => undefined }));
				}
				previouslyOpen = false;
				return null;
			}
			if (!previouslyOpen) {
				queueMicrotask(() => props.onOpenAutoFocus?.({ preventDefault: () => undefined }));
			}
			previouslyOpen = true;
			return (
				<div
					id={props.contentId}
					onKeyDown={(event) => {
						if (event.key === "Escape") props.onOpenChange(false);
					}}
					role="dialog"
				>
					{props.children}
				</div>
			);
		},
		RadixDialogTitle: ({ children, id }: { children?: ComponentChildren; id?: string }) => (
			<h2 id={id}>{children}</h2>
		),
	};
});

import type { SyncLegacySharedReviewItem } from "../tabs/sync/components/sync-sharing-review";
import {
	hideLegacyUpgradeDialog,
	type LegacyUpgradeDialogActions,
	mountLegacyUpgradeDialog,
	showLegacyUpgradeDialog,
} from "./legacy-upgrade-dialog";

afterEach(() => {
	hideLegacyUpgradeDialog();
	document.body.replaceChildren();
});

function reviewGroup(name: string) {
	return {
		displayProject: name,
		identitySource: "git_remote",
		lastUpdatedAt: null,
		memoryCount: 3,
		memorySamples: [],
		peerOwnedMemoryCount: 0,
		reassignableMemoryCount: 3,
		suggestedScopeId: "scope-team",
		suggestionReason: null,
		workspaceIdentity: `workspace-${name}`,
	};
}

function legacyReview(groups: string[]): SyncLegacySharedReviewItem | null {
	if (groups.length === 0) return null;
	return {
		groups: groups.map(reviewGroup),
		memoryCount: groups.length * 3,
		scopeId: "legacy-shared-review",
		totalGroupCount: groups.length,
		targetScopes: [{ authorityType: "coordinator", label: "Team Space", scopeId: "scope-team" }],
	};
}

function mountDialog(overrides: Partial<LegacyUpgradeDialogActions> = {}) {
	const trigger = document.createElement("button");
	trigger.textContent = "Open";
	document.body.append(trigger);
	const mount = document.createElement("div");
	document.body.append(mount);
	const actions = {
		onDismiss: vi.fn(),
		onReassign: vi.fn(async () => null),
		onReviewProjects: vi.fn(),
		readReview: vi.fn(() => legacyReview(["alpha", "beta"])),
		...overrides,
	};
	mountLegacyUpgradeDialog(mount, actions);
	return { actions, mount, trigger };
}

describe("LegacyUpgradeDialog", () => {
	it("uses Radix modal focus and Escape cleanup while preserving dismissal", async () => {
		const { actions, trigger } = mountDialog();
		trigger.focus();

		act(() => showLegacyUpgradeDialog({ groupCount: 2, memoryCount: 12 }));
		await vi.waitFor(() => {
			expect(document.activeElement).toBe(document.getElementById("legacyUpgradeReviewGroups"));
		});
		expect(document.getElementById("legacyUpgradeSummary")?.textContent).toContain(
			"2 older projects need",
		);

		const checkbox = document.getElementById("legacyUpgradeDontShow") as HTMLInputElement;
		checkbox.checked = true;
		act(() => {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }),
			);
		});

		await vi.waitFor(() => {
			expect(document.getElementById("legacyUpgradeModal")).toBeNull();
			expect(document.activeElement).toBe(trigger);
		});
		expect(actions.onDismiss).toHaveBeenCalledOnce();
	});

	it("does not dismiss from the backdrop and keeps Start review in the dialog", async () => {
		const { actions } = mountDialog();
		act(() => showLegacyUpgradeDialog({ groupCount: 1, memoryCount: 4 }));
		await vi.waitFor(() => expect(document.getElementById("legacyUpgradeModal")).not.toBeNull());

		act(() => document.getElementById("legacyUpgradeModal")?.click());
		expect(document.getElementById("legacyUpgradeModal")).not.toBeNull();

		act(() => document.getElementById("legacyUpgradeReviewGroups")?.click());
		expect(actions.onDismiss).not.toHaveBeenCalled();
		expect(actions.onReviewProjects).not.toHaveBeenCalled();
		expect(document.getElementById("legacyUpgradeModal")).not.toBeNull();
	});

	it("shows the group review in the dialog and moves focus to it", async () => {
		mountDialog();
		act(() => showLegacyUpgradeDialog({ groupCount: 2, memoryCount: 6 }));
		await vi.waitFor(() => expect(document.getElementById("legacyUpgradeModal")).not.toBeNull());

		act(() => document.getElementById("legacyUpgradeReviewGroups")?.click());

		const review = document.getElementById("legacyUpgradeReview");
		await vi.waitFor(() => expect(document.activeElement).toBe(review));
		expect(document.getElementById("legacyUpgradeTitle")?.textContent).toBe(
			"Review older shared memories",
		);
		expect(review?.textContent).toContain("alpha");
		expect(review?.textContent).toContain("beta");
		expect(document.getElementById("legacyUpgradeReviewGroups")).toBeNull();
	});

	it("previews a group's move in place and drops the group once it is applied", async () => {
		const reviewed = ["alpha", "beta"];
		const { actions } = mountDialog({
			readReview: vi.fn(() => legacyReview(reviewed)),
			onReassign: vi.fn(async (_group, _scopeId, confirmed) => {
				if (!confirmed) {
					return {
						confirmation_token: "token-a",
						memory_count: 3,
						reassignable_memory_count: 3,
						skipped_memory_count: 0,
						warning: "Other devices may keep copies.",
					} as never;
				}
				reviewed.splice(0, 1);
				return null;
			}),
		});
		act(() => showLegacyUpgradeDialog({ groupCount: 2, memoryCount: 6 }));
		await vi.waitFor(() => expect(document.getElementById("legacyUpgradeModal")).not.toBeNull());
		act(() => document.getElementById("legacyUpgradeReviewGroups")?.click());
		const review = document.getElementById("legacyUpgradeReview");
		const buttonLabelled = (label: string) =>
			[...(review?.querySelectorAll("button") ?? [])].find(
				(button) => button.textContent === label,
			);

		await act(async () => buttonLabelled("Preview reassignment")?.click());
		expect(actions.onReassign).toHaveBeenCalledWith(
			expect.objectContaining({ workspaceIdentity: "workspace-alpha" }),
			"scope-team",
			false,
			undefined,
		);
		await vi.waitFor(() => expect(buttonLabelled("I understand, reassign memories")).toBeTruthy());
		await act(async () => buttonLabelled("I understand, reassign memories")?.click());

		await vi.waitFor(() => expect(review?.textContent).not.toContain("alpha"));
		expect(review?.textContent).toContain("beta");
		expect(actions.onDismiss).not.toHaveBeenCalled();
	});
});

describe("LegacyUpgradeDialog review stage", () => {
	it("says when nothing is left to review", async () => {
		mountDialog({ readReview: vi.fn(() => null) });
		act(() => showLegacyUpgradeDialog({ groupCount: 1, memoryCount: 3 }));
		await vi.waitFor(() => expect(document.getElementById("legacyUpgradeModal")).not.toBeNull());

		act(() => document.getElementById("legacyUpgradeReviewGroups")?.click());

		expect(document.getElementById("legacyUpgradeReview")?.textContent).toBe(
			"No older shared memories are waiting for review.",
		);
	});

	it("closes from the review and sends Manage all projects to Projects", async () => {
		const { actions } = mountDialog();
		act(() => showLegacyUpgradeDialog({ groupCount: 2, memoryCount: 6 }));
		await vi.waitFor(() => expect(document.getElementById("legacyUpgradeModal")).not.toBeNull());
		act(() => document.getElementById("legacyUpgradeReviewGroups")?.click());

		act(() => document.getElementById("legacyUpgradeClose")?.click());
		expect(actions.onDismiss).toHaveBeenCalledOnce();
		expect(document.getElementById("legacyUpgradeModal")).toBeNull();

		act(() => showLegacyUpgradeDialog({ groupCount: 2, memoryCount: 6 }));
		await vi.waitFor(() => expect(document.getElementById("legacyUpgradeModal")).not.toBeNull());
		expect(document.getElementById("legacyUpgradeReview")).toBeNull();
		act(() => document.getElementById("legacyUpgradeReviewGroups")?.click());
		const manageAll = [...document.querySelectorAll("button")].find(
			(button) => button.textContent === "Manage all projects",
		);
		act(() => manageAll?.click());
		expect(actions.onReviewProjects).toHaveBeenCalledOnce();
		expect(document.getElementById("legacyUpgradeModal")).toBeNull();
	});

	it("routes Manage all projects from the summary to Projects", async () => {
		const { actions } = mountDialog();
		act(() => showLegacyUpgradeDialog({ groupCount: 1, memoryCount: 4 }));
		await vi.waitFor(() => expect(document.getElementById("legacyUpgradeModal")).not.toBeNull());

		act(() => document.getElementById("legacyUpgradeReviewProjects")?.click());

		expect(actions.onDismiss).toHaveBeenCalledOnce();
		expect(actions.onReviewProjects).toHaveBeenCalledOnce();
	});
});
