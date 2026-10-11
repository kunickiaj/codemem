import { type ComponentChild, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

// The UI test config does not inline react-select's React runtime. Keep the
// wrapper real but replace that external dependency, as primitives.test.tsx does.
vi.mock("@radix-ui/react-select", async () => {
	const { h } = await import("preact");
	type Props = { children?: ComponentChild; [key: string]: unknown };
	const container = ({ children, ...props }: Props) => h("div", props, children);
	return {
		Root: ({ children }: Props) => h("div", null, children),
		Trigger: ({ children, ...props }: Props) => h("button", props, children),
		Value: ({ placeholder }: Props) => h("span", null, placeholder as string),
		Icon: container,
		Portal: container,
		Content: container,
		Viewport: container,
		Item: container,
		ItemText: container,
		ItemIndicator: container,
	};
});

import {
	PROJECT_FILTER_CHANGE,
	renderProjectFilter,
	requestProjectFilterChange,
} from "./project-filter";

afterEach(() => {
	const mount = document.getElementById("projectFilterMount");
	if (mount) act(() => render(null, mount));
	document.body.innerHTML = "";
});

describe("header project filter", () => {
	it.each(["", "long-project-name"])(
		"renders the controlled project value %j in the shared compact control",
		(value) => {
			// Objective: initial and refreshed values use the shared header control, including All Projects.
			// Arrange
			document.body.innerHTML = '<div id="projectFilterMount"></div>';

			// Act
			act(() => renderProjectFilter(["long-project-name"], value));
			const trigger = document.getElementById("projectFilter");

			// Assert
			expect(trigger?.tagName).toBe("BUTTON");
			expect(trigger?.classList.contains("radix-select-trigger")).toBe(true);
			expect(trigger?.dataset.size).toBe("compact");
			expect(trigger?.dataset.value).toBe(value);
			if (!value) expect(trigger?.textContent).toContain("All Projects");
		},
	);

	it.each(["", "long-project-name"])(
		"dispatches project changes with the original value %j",
		(value) => {
			// Arrange
			document.body.innerHTML = '<div id="projectFilterMount"></div>';
			const onChange = vi.fn();
			document
				.getElementById("projectFilterMount")
				?.addEventListener(PROJECT_FILTER_CHANGE, onChange);

			// Act
			const dispatched = requestProjectFilterChange(value);

			// Assert
			expect(dispatched).toBe(true);
			expect(onChange).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ detail: value }));
		},
	);

	it("does not dispatch or create a control when the header mount is absent", () => {
		// Arrange
		const onChange = vi.fn();
		document.addEventListener(PROJECT_FILTER_CHANGE, onChange);

		// Act
		act(() => renderProjectFilter(["project"], "project"));
		const dispatched = requestProjectFilterChange("project");
		document.removeEventListener(PROJECT_FILTER_CHANGE, onChange);

		// Assert
		expect(dispatched).toBe(false);
		expect(onChange).not.toHaveBeenCalled();
		expect(document.getElementById("projectFilter")).toBeNull();
	});
});
