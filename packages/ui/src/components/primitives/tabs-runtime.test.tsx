import { type ComponentChild, render } from "preact";
import { useState } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RadixTabs, RadixTabsContent } from "./radix-tabs";

let mount: HTMLDivElement;

function TabsFixture({
	name,
	customId,
	children,
	onKey,
}: {
	name: string;
	customId?: string;
	children?: ComponentChild;
	onKey?: (value: string) => void;
}) {
	const [value, setValue] = useState("first");
	return (
		<RadixTabs
			ariaLabel={name}
			value={value}
			onValueChange={setValue}
			onTriggerKeyDown={onKey}
			tabs={[
				{ value: "first", label: "First", id: customId },
				{ value: "blocked", label: "Unavailable", disabled: true },
				{ value: "second", label: "Second" },
			]}
		>
			<RadixTabsContent value="first" forceMount>
				{children || "First panel"}
			</RadixTabsContent>
			<RadixTabsContent value="blocked" forceMount>
				Unavailable panel
			</RadixTabsContent>
			<RadixTabsContent value="second" forceMount>
				Second panel
			</RadixTabsContent>
		</RadixTabs>
	);
}

function triggers(name: string): HTMLButtonElement[] {
	const list = mount.querySelector(`[role="tablist"][aria-label="${name}"]`);
	if (!list) throw new Error(`Missing tablist ${name}`);
	return [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
}

function panel(trigger: HTMLElement): HTMLElement {
	const result = document.getElementById(trigger.getAttribute("aria-controls") || "");
	if (!result) throw new Error("Tab does not control a mounted panel");
	return result;
}

function expectLinkedPanels(name: string) {
	for (const trigger of triggers(name)) {
		expect(trigger.id).not.toBe("");
		expect(panel(trigger).getAttribute("role")).toBe("tabpanel");
		expect(panel(trigger).getAttribute("aria-labelledby")).toBe(trigger.id);
		expect(document.getElementById(panel(trigger).getAttribute("aria-labelledby") || "")).toBe(
			trigger,
		);
	}
}

function key(target: HTMLElement, value: string) {
	act(() => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }),
		);
		vi.advanceTimersByTime(0);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	mount = document.createElement("div");
	document.body.append(mount);
});

afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
	vi.useRealTimers();
});

describe("RadixTabs real SDK labels and keyboard behavior", () => {
	it("keeps default generated IDs linked in both directions, including inactive panels", () => {
		// Arrange
		act(() => render(<TabsFixture name="Default" />, mount));
		// Act
		const tabs = triggers("Default");
		// Assert: passing an undefined ID previously erased the SDK trigger ID.
		expectLinkedPanels("Default");
		expect(new Set(tabs.map((tab) => tab.id)).size).toBe(3);
		expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
			"true",
			"false",
			"false",
		]);
		expect(panel(tabs[2]).getAttribute("data-state")).toBe("inactive");
	});

	it("labels custom-ID panels without overriding generated siblings and preserves keyboard hooks", () => {
		// Arrange
		const onKey = vi.fn();
		act(() => render(<TabsFixture name="Custom" customId="custom-first" onKey={onKey} />, mount));
		const tabs = triggers("Custom");
		key(tabs[2], "Enter");
		// Act
		key(tabs[0], "Enter");
		// Assert
		expect(tabs[0].id).toBe("custom-first");
		expectLinkedPanels("Custom");
		expect(tabs[2].id).not.toBe("custom-first");
		expect(onKey.mock.calls).toEqual([["second"], ["first"]]);
		expect(tabs[0].getAttribute("aria-selected")).toBe("true");
		expect(panel(tabs[0]).getAttribute("data-state")).toBe("active");
	});

	it("skips disabled tabs with arrows and cannot activate them with Enter", () => {
		// Arrange
		act(() => render(<TabsFixture name="Keyboard" />, mount));
		const tabs = triggers("Keyboard");
		act(() => tabs[0].focus());
		// Act
		key(tabs[0], "ArrowRight");
		key(tabs[1], "Enter");
		// Assert
		expect(document.activeElement).toBe(tabs[2]);
		expect(tabs[1].disabled).toBe(true);
		expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
			"false",
			"false",
			"true",
		]);
		expect(panel(tabs[1]).getAttribute("data-state")).toBe("inactive");
		// Act
		key(tabs[2], "ArrowLeft");
		// Assert
		expect(document.activeElement).toBe(tabs[0]);
		expect(tabs[0].getAttribute("aria-selected")).toBe("true");
	});

	it("keeps separate roots with identical values from sharing custom or generated IDs", () => {
		// Arrange
		act(() =>
			render(
				<>
					<TabsFixture name="Custom" customId="separate-first" />
					<TabsFixture name="Default" />
				</>,
				mount,
			),
		);
		// Act
		key(triggers("Custom")[2], "Enter");
		// Assert
		expectLinkedPanels("Custom");
		expectLinkedPanels("Default");
		expect(triggers("Default")[0].id).not.toBe("separate-first");
		expect(triggers("Default")[0].getAttribute("aria-selected")).toBe("true");
		const ids = [...mount.querySelectorAll<HTMLElement>("[id]")].map((element) => element.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("isolates nested custom-ID maps and restores the outer map for sibling panels", () => {
		// Arrange
		act(() =>
			render(
				<TabsFixture name="Outer" customId="outer-first">
					<TabsFixture name="Inner" customId="inner-first" />
				</TabsFixture>,
				mount,
			),
		);
		// Act
		key(triggers("Inner")[2], "Enter");
		// Assert
		expectLinkedPanels("Outer");
		expectLinkedPanels("Inner");
		expect(panel(triggers("Outer")[0]).getAttribute("aria-labelledby")).toBe("outer-first");
		expect(panel(triggers("Inner")[0]).getAttribute("aria-labelledby")).toBe("inner-first");
		expect(triggers("Outer")[0].getAttribute("aria-selected")).toBe("true");
		expect(triggers("Inner")[2].getAttribute("aria-selected")).toBe("true");
	});
});
