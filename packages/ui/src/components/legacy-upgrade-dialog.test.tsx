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

import {
	hideLegacyUpgradeDialog,
	mountLegacyUpgradeDialog,
	showLegacyUpgradeDialog,
} from "./legacy-upgrade-dialog";

afterEach(() => {
	hideLegacyUpgradeDialog();
	document.body.replaceChildren();
});

function mountDialog() {
	const trigger = document.createElement("button");
	trigger.textContent = "Open";
	document.body.append(trigger);
	const mount = document.createElement("div");
	document.body.append(mount);
	const actions = {
		onDismiss: vi.fn(),
		onReviewGroups: vi.fn(),
		onReviewProjects: vi.fn(),
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

	it("does not dismiss from the backdrop and routes the primary action", async () => {
		const { actions } = mountDialog();
		act(() => showLegacyUpgradeDialog({ groupCount: 1, memoryCount: 4 }));
		await vi.waitFor(() => expect(document.getElementById("legacyUpgradeModal")).not.toBeNull());

		act(() => document.getElementById("legacyUpgradeModal")?.click());
		expect(document.getElementById("legacyUpgradeModal")).not.toBeNull();

		act(() => document.getElementById("legacyUpgradeReviewGroups")?.click());
		expect(actions.onDismiss).toHaveBeenCalledOnce();
		expect(actions.onReviewGroups).toHaveBeenCalledOnce();
		expect(document.getElementById("legacyUpgradeModal")).toBeNull();
	});
});
