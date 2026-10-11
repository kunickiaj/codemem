import { type ComponentChild, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openActionMenu } from "../../menu-test-utils";
import { ProjectRowMenu } from "./ProjectRowMenu";

let mount: HTMLDivElement;

function mountMenu(content: ComponentChild) {
	mount = document.createElement("div");
	document.body.append(mount);
	act(() => render(content, mount));
	return mount;
}

function projectProps() {
	return {
		label: "API",
		canAssign: true,
		canChangeProject: true,
		canForget: true,
		canRemoveMapping: true,
		onChangeProject: vi.fn(),
		onForget: vi.fn(),
		onKeepLocal: vi.fn(),
		onOpenSpaceAssignment: vi.fn(),
		onRemoveMapping: vi.fn(),
	};
}

afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
});

describe("ProjectRowMenu gates", () => {
	it.each([
		["Space assignment…", "onOpenSpaceAssignment"],
		["Change project…", "onChangeProject"],
		["Keep local-only", "onKeepLocal"],
		["Remove mapping", "onRemoveMapping"],
		["Forget local memories…", "onForget"],
	] as const)("routes %s to its own callback", (label, callback) => {
		// Arrange
		const props = projectProps();
		mountMenu(<ProjectRowMenu {...props} />);
		const menu = openActionMenu(mount);
		const item = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
			(node) => node.textContent === label,
		);
		// Act
		act(() => item?.click());
		// Assert
		expect(props[callback]).toHaveBeenCalledTimes(1);
		for (const name of [
			"onChangeProject",
			"onForget",
			"onKeepLocal",
			"onOpenSpaceAssignment",
			"onRemoveMapping",
		] as const) {
			if (name !== callback) expect(props[name]).not.toHaveBeenCalled();
		}
	});

	it("omits unavailable mapping removal and blocks all gated actions", () => {
		// Arrange
		const props = {
			...projectProps(),
			canAssign: false,
			canChangeProject: false,
			canForget: false,
			canRemoveMapping: false,
		};
		mountMenu(<ProjectRowMenu {...props} />);
		const menu = openActionMenu(mount);
		const items = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
		// Act
		act(() => {
			for (const item of items) item.click();
		});
		// Assert
		expect(items).toHaveLength(4);
		expect(menu.textContent).not.toContain("Remove mapping");
		expect(items.every((item) => item.disabled)).toBe(true);
		expect(items.at(-1)?.classList.contains("danger")).toBe(true);
		for (const name of [
			"onChangeProject",
			"onForget",
			"onKeepLocal",
			"onOpenSpaceAssignment",
			"onRemoveMapping",
		] as const)
			expect(props[name]).not.toHaveBeenCalled();
	});
});
