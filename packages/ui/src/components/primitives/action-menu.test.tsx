import { type ComponentChild, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeActionMenu, openActionMenu } from "../../menu-test-utils";
import { FeedItemMenu } from "../../tabs/feed/components/FeedItemMenu";
import { ActionMenu } from "./action-menu";

let mount: HTMLDivElement;

function mountMenu(content: ComponentChild) {
	mount = document.createElement("div");
	document.body.append(mount);
	act(() => render(content, mount));
	return mount;
}

function key(target: HTMLElement, value: string, shiftKey = false) {
	act(() => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }),
		);
	});
}

afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
});

describe("ActionMenu real Radix keyboard and portal behavior", () => {
	it.each(["Enter", " "])(
		"selects an enabled item with %j and returns focus to its trigger",
		async (selectionKey) => {
			// Arrange
			const onSelect = vi.fn();
			mountMenu(<ActionMenu label="Actions" actions={[{ label: "Select", onSelect }]} />);
			const trigger = mount.querySelector("button");
			const item = openActionMenu(mount).querySelector<HTMLElement>(
				'[role="menuitem"]',
			) as HTMLElement;
			item.focus();
			// Act
			key(item, selectionKey);
			// Assert
			expect(onSelect).toHaveBeenCalledTimes(1);
			await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
			await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
		},
	);

	it("preserves caller IDs, description links, and identity refs and clears item refs on close", () => {
		// Arrange: Devices uses these refs to recognize portalled controls during polling.
		const triggerRef = vi.fn();
		const actionRef = vi.fn();
		mountMenu(
			<>
				<div id="details-panel">Details</div>
				<ActionMenu
					triggerId="device-actions-test"
					triggerRef={triggerRef}
					label="Device actions"
					actions={[
						{
							label: "Details",
							ariaControls: "details-panel",
							ariaExpanded: true,
							ariaLabel: "Details for test device",
							ref: actionRef,
							onSelect: vi.fn(),
						},
					]}
				/>
			</>,
		);
		// Act
		const menu = openActionMenu(mount);
		const item = menu.querySelector<HTMLButtonElement>('[role="menuitem"]');
		// Assert
		expect(menu.getAttribute("aria-labelledby")).toBe("device-actions-test");
		expect(triggerRef).toHaveBeenCalledWith(document.getElementById("device-actions-test"));
		expect(actionRef).toHaveBeenCalledWith(item);
		expect(item?.getAttribute("aria-expanded")).toBe("true");
		expect(document.getElementById(item?.getAttribute("aria-controls") || "")?.textContent).toBe(
			"Details",
		);
		expect(item?.getAttribute("aria-label")).toBe("Details for test device");
		// Act
		closeActionMenu(menu);
		// Assert
		expect(actionRef).toHaveBeenLastCalledWith(null);
	});
});

describe("ActionMenu focus and tab order", () => {
	it("opens outside the row with focus on the first enabled item", async () => {
		// Arrange
		mountMenu(
			<ActionMenu
				label="Actions"
				actions={[
					{ label: "Blocked", disabled: true, onSelect: vi.fn() },
					{ label: "First", onSelect: vi.fn() },
				]}
			/>,
		);
		// Act
		const menu = openActionMenu(mount);
		// Assert
		expect(mount.contains(menu)).toBe(false);
		expect(menu.getAttribute("aria-label")).toBe("Actions");
		expect(mount.querySelector("button")?.getAttribute("aria-controls")).toBe(menu.id);
		await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("First"));
	});

	it("navigates enabled items with arrows, skips disabled items, loops, and returns focus on Escape", async () => {
		// Arrange
		mountMenu(
			<ActionMenu
				label="Actions"
				actions={[
					{ label: "First", onSelect: vi.fn() },
					{ label: "Blocked", disabled: true, onSelect: vi.fn() },
					{ label: "Last", onSelect: vi.fn() },
				]}
			/>,
		);
		const trigger = mount.querySelector("button");
		const menu = openActionMenu(mount);
		const items = menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
		items[0].focus();
		// Act
		key(items[0], "ArrowDown");
		// Assert
		await vi.waitFor(() => expect(document.activeElement).toBe(items[2]));
		key(items[2], "ArrowDown");
		await vi.waitFor(() => expect(document.activeElement).toBe(items[0]));
		key(items[0], "ArrowUp");
		await vi.waitFor(() => expect(document.activeElement).toBe(items[2]));
		closeActionMenu(menu);
		await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
		await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
	});

	it("opens with ArrowUp on the last enabled item rather than a disabled last item", async () => {
		// Arrange
		mountMenu(
			<ActionMenu
				label="Actions"
				actions={[
					{ label: "First", onSelect: vi.fn() },
					{ label: "Last enabled", onSelect: vi.fn() },
					{ label: "Blocked", disabled: true, onSelect: vi.fn() },
				]}
			/>,
		);
		const trigger = mount.querySelector("button") as HTMLButtonElement;
		// Act
		trigger.focus();
		key(trigger, "ArrowUp");
		// Assert
		await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Last enabled"));
	});

	it.each([
		{ position: "last", shiftKey: false },
		{ position: "first", shiftKey: true },
	])(
		"falls back to the trigger when it is the $position tabbable control and ShiftTab=$shiftKey",
		async ({ position, shiftKey }) => {
			// Arrange: keep a neighbor only in the opposite direction from the Tab exit.
			mountMenu(
				<>
					{position === "last" && <button type="button">Before</button>}
					<ActionMenu label="Actions" actions={[{ label: "Select", onSelect: vi.fn() }]} />
					{position === "first" && <button type="button">After</button>}
				</>,
			);
			const trigger = mount.querySelector<HTMLButtonElement>(
				".feed-menu-trigger",
			) as HTMLButtonElement;
			trigger.focus();
			key(trigger, "ArrowDown");
			await vi.waitFor(() => expect(document.querySelector('[role="menuitem"]')).not.toBeNull());
			const item = document.querySelector<HTMLElement>('[role="menuitem"]') as HTMLElement;
			act(() => item.focus());
			expect(document.activeElement).toBe(item);
			// Real Radix guards must be present to reproduce the temporary Tab destination bug.
			const guards = [...document.querySelectorAll<HTMLElement>("[data-radix-focus-guard]")];
			expect(guards.length).toBeGreaterThan(0);
			// Act
			key(item, "Tab", shiftKey);
			// Assert: closing must not leave focus on a temporary guard or lose it to the body.
			await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
			expect(guards).not.toContain(document.activeElement);
			expect(document.activeElement?.hasAttribute("data-radix-focus-guard")).toBe(false);
			await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
		},
	);

	it.each([false, true])(
		"exits the shared menu to the neighboring summary with ShiftTab=%s",
		async (shift) => {
			// Arrange: summaries participate in native tab order even inside closed details.
			mountMenu(
				<>
					<details>
						<summary id="before-menu">Before</summary>
						<button type="button">Hidden child</button>
					</details>
					<ActionMenu
						label="More actions for API"
						actions={[
							{ label: "Space assignment…", onSelect: vi.fn() },
							{ label: "Change project…", onSelect: vi.fn() },
							{ label: "Keep local-only", onSelect: vi.fn() },
							{ label: "Remove mapping", onSelect: vi.fn() },
							{ label: "Forget local memories…", danger: true, onSelect: vi.fn() },
						]}
					/>
					<details>
						<summary id="after-menu">After</summary>
					</details>
				</>,
			);
			const menu = openActionMenu(mount);
			const item = menu.querySelector<HTMLElement>('[role="menuitem"]') as HTMLElement;
			item.focus();
			// Act
			key(item, "Tab", shift);
			// Assert
			await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
			await vi.waitFor(() =>
				expect(document.activeElement).toBe(
					document.getElementById(shift ? "before-menu" : "after-menu"),
				),
			);
		},
	);
});

describe("ActionMenu close-focus lifecycle", () => {
	it("runs selection focus after the portal closes and does not repeat it on a later Escape", async () => {
		// Arrange: the callback must run after the modal focus trap releases the form.
		const onSelect = vi.fn();
		const focusAfterClose = vi.fn(() => {
			expect(document.querySelector('[role="menu"]')).toBeNull();
			expect(onSelect).toHaveBeenCalledTimes(1);
			mount.querySelector<HTMLInputElement>("input")?.focus();
		});
		mountMenu(
			<>
				<input aria-label="Identity to use" />
				<ActionMenu
					label="Actions"
					actions={[{ label: "Change identity", onSelect, focusAfterClose }]}
				/>
			</>,
		);
		const menu = openActionMenu(mount);
		const item = menu.querySelector<HTMLButtonElement>('[role="menuitem"]');
		expect(focusAfterClose).not.toHaveBeenCalled();
		// Act
		act(() => item?.click());
		// Assert
		await vi.waitFor(() => expect(focusAfterClose).toHaveBeenCalledTimes(1));
		expect(document.activeElement).toBe(mount.querySelector("input"));
		// Act: reopening and dismissing cannot reuse a prior selection callback.
		const reopened = openActionMenu(mount);
		closeActionMenu(reopened);
		// Assert
		await vi.waitFor(() => expect(document.activeElement).toBe(mount.querySelector("button")));
		expect(focusAfterClose).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it("does not call selection or close-focus callbacks for a disabled action or Escape", async () => {
		// Arrange
		const onSelect = vi.fn();
		const focusAfterClose = vi.fn();
		mountMenu(
			<ActionMenu
				label="Actions"
				actions={[{ label: "Blocked", disabled: true, onSelect, focusAfterClose }]}
			/>,
		);
		const menu = openActionMenu(mount);
		const item = menu.querySelector<HTMLButtonElement>('[role="menuitem"]');
		// Act
		act(() => item?.click());
		// Assert: blocked selection leaves the menu open.
		expect(menu.isConnected).toBe(true);
		expect(onSelect).not.toHaveBeenCalled();
		expect(focusAfterClose).not.toHaveBeenCalled();
		// Act
		closeActionMenu(menu);
		// Assert
		await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
		await vi.waitFor(() => expect(document.activeElement).toBe(mount.querySelector("button")));
		expect(focusAfterClose).not.toHaveBeenCalled();
	});

	it("preserves form focus set after the menu trap releases but before close autofocus", async () => {
		// Arrange: focusing synchronously while the trap is active cannot leave the menu.
		mountMenu(
			<>
				<form>
					<input aria-label="Device name" />
				</form>
				<ActionMenu
					label="Actions"
					actions={[
						{
							label: "Rename",
							onSelect: () =>
								queueMicrotask(() => mount.querySelector<HTMLInputElement>("input")?.focus()),
						},
					]}
				/>
			</>,
		);
		const item = openActionMenu(mount).querySelector<HTMLButtonElement>('[role="menuitem"]');
		// Act
		act(() => item?.click());
		// Assert
		await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
		await vi.waitFor(() => expect(document.activeElement).toBe(mount.querySelector("input")));
	});
});

describe("FeedItemMenu actions", () => {
	it.each(["Assign to project…", "Forget memory"])(
		"calls only the %s callback and closes",
		async (label) => {
			// Arrange
			const onAssignProject = vi.fn();
			const onForget = vi.fn();
			mountMenu(
				<FeedItemMenu
					title="Memory title"
					disabled={false}
					assignProjectDisabled={false}
					onAssignProject={onAssignProject}
					onForget={onForget}
				/>,
			);
			const menu = openActionMenu(mount);
			const item = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
				(node) => node.textContent === label,
			);
			// Act
			act(() => item?.click());
			// Assert
			expect(label === "Forget memory" ? onForget : onAssignProject).toHaveBeenCalledTimes(1);
			expect(label === "Forget memory" ? onAssignProject : onForget).not.toHaveBeenCalled();
			await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).toBeNull());
		},
	);

	it("blocks both busy actions and retains danger styling on the disabled forget item", () => {
		// Arrange
		const onAssignProject = vi.fn();
		const onForget = vi.fn();
		mountMenu(
			<FeedItemMenu
				title="Memory title"
				disabled
				assignProjectDisabled
				onAssignProject={onAssignProject}
				onForget={onForget}
			/>,
		);
		const menu = openActionMenu(mount);
		const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
		// Act
		act(() => {
			for (const item of items) item.click();
		});
		// Assert
		expect(items.map((item) => item.textContent)).toEqual(["Moving…", "Forgetting…"]);
		expect(items.every((item) => item.disabled && item.hasAttribute("data-disabled"))).toBe(true);
		expect(items[1].classList.contains("danger")).toBe(true);
		expect(onAssignProject).not.toHaveBeenCalled();
		expect(onForget).not.toHaveBeenCalled();
		expect(menu.isConnected).toBe(true);
	});
});
