import { createRef, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeSelect } from "./native-select";

let mount: HTMLDivElement;

beforeEach(() => {
	mount = document.createElement("div");
	document.body.appendChild(mount);
});

afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
});

describe("NativeSelect attributes", () => {
	it.each([
		{ disabled: false, multiple: false, size: 1, hidden: false },
		{ disabled: true, multiple: true, size: 4, hidden: true },
	])("passes through native attributes: %j", (attributes) => {
		// Arrange
		const props = { ...attributes, id: "project-picker", name: "project", "aria-label": "Project" };
		// Act
		act(() =>
			render(
				<NativeSelect {...props}>
					<option value="one">One</option>
				</NativeSelect>,
				mount,
			),
		);
		const select = mount.querySelector("select");
		// Assert: styling must not replace the native element or override caller semantics.
		expect(select).toBeInstanceOf(HTMLSelectElement);
		expect(mount.children).toHaveLength(1);
		expect(select?.className).toBe("native-select");
		expect(select?.id).toBe("project-picker");
		expect(select?.name).toBe("project");
		expect(select?.getAttribute("aria-label")).toBe("Project");
		for (const attribute of ["disabled", "multiple", "size", "hidden"] as const) {
			expect(select?.[attribute]).toBe(attributes[attribute]);
		}
		expect(select?.options[0]?.value).toBe("one");
	});

	it.each([
		{ className: "caller-class", class: undefined, expected: "native-select caller-class" },
		{ className: undefined, class: "html-class", expected: "native-select html-class" },
		{
			className: "caller-class",
			class: "html-class",
			expected: "native-select html-class caller-class",
		},
		{ className: "", class: "", expected: "native-select" },
	])(
		"adds caller classes without replacing the shared class: $expected",
		({ expected, ...props }) => {
			// Arrange
			const content = <NativeSelect {...props} />;
			// Act
			act(() => render(content, mount));
			// Assert: empty classes must not leave extra spaces or remove the opt-in hook.
			expect(mount.querySelector("select")?.className).toBe(expected);
		},
	);
});

describe("NativeSelect value and events", () => {
	it.each(["two", ""])("preserves controlled value and native event targets for %j", (value) => {
		// Arrange: empty values are intentional options, not encoded sentinel values.
		const onChange = vi.fn();
		const onInput = vi.fn();
		const content = (selected: string) => (
			<NativeSelect
				value={selected}
				onChange={(event) => onChange(event.currentTarget, event.currentTarget.value)}
				onInput={(event) => onInput(event.currentTarget, event.currentTarget.value)}
			>
				<option value="">All projects</option>
				<option value="one">One</option>
				<option value="two">Two</option>
			</NativeSelect>
		);
		act(() => render(content("one"), mount));
		const select = mount.querySelector("select");
		if (!select) throw new Error("native select missing");
		// Act: controlled rerenders update select.value without notifying the caller.
		act(() => render(content(value), mount));
		// Assert
		expect(select.value).toBe(value);
		expect(onChange).not.toHaveBeenCalled();
		expect(onInput).not.toHaveBeenCalled();
		// Act: both event families still target the actual native select.
		act(() => {
			select.dispatchEvent(new Event("change", { bubbles: true }));
		});
		// Assert: change must not masquerade as an input event.
		expect(onChange).toHaveBeenCalledExactlyOnceWith(select, value);
		expect(onInput).not.toHaveBeenCalled();
		// Act
		act(() => {
			select.dispatchEvent(new Event("input", { bubbles: true }));
		});
		// Assert
		expect(onInput).toHaveBeenCalledExactlyOnceWith(select, value);
		expect(onChange).toHaveBeenCalledTimes(1);
	});
});

describe("NativeSelect refs", () => {
	it("forwards an object ref for imperative select.value access and clears it on unmount", () => {
		// Arrange
		const ref = createRef<HTMLSelectElement>();
		const onChange = vi.fn();
		// Act
		act(() =>
			render(
				<NativeSelect ref={ref} onChange={onChange}>
					<option value="one">One</option>
					<option value="two">Two</option>
				</NativeSelect>,
				mount,
			),
		);
		const select = ref.current;
		if (!select) throw new Error("native select ref missing");
		select.value = "two";
		// Assert: native refs require no wrapper lookup or synthetic value setter.
		expect(select).toBeInstanceOf(HTMLSelectElement);
		expect(select).toBe(mount.querySelector("select"));
		expect(select.value).toBe("two");
		expect(onChange).not.toHaveBeenCalled();
		// Act
		act(() => render(null, mount));
		// Assert
		expect(ref.current).toBeNull();
	});

	it("forwards callback refs to the native select and releases them on unmount", () => {
		// Arrange
		const ref = vi.fn();
		// Act
		act(() => render(<NativeSelect ref={ref} />, mount));
		const select = mount.querySelector("select");
		// Assert
		expect(select).toBeInstanceOf(HTMLSelectElement);
		expect(ref).toHaveBeenLastCalledWith(select);
		// Act
		act(() => render(null, mount));
		// Assert
		expect(ref).toHaveBeenLastCalledWith(null);
	});
});
