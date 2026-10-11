import { type ComponentChild, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

let radioOnValueChange: ((value: string) => void) | undefined;
const mocks = vi.hoisted(() => ({
	resolveCurrentDialog: vi.fn(),
}));

type MockChildrenProps = {
	children?: ComponentChild;
	[key: string]: unknown;
};

// Keep shared wrappers real so their accessible relationships are exercised.
vi.mock("@radix-ui/react-radio-group", () => ({
	Root: ({ children, onValueChange, value, ...props }: MockChildrenProps) => {
		radioOnValueChange = onValueChange as (value: string) => void;
		return (
			<div {...props} role="radiogroup" data-value={value}>
				{children}
			</div>
		);
	},
	Item: ({ children, value, ...props }: MockChildrenProps) => (
		<input
			{...props}
			type="radio"
			value={String(value)}
			onChange={() => radioOnValueChange?.(String(value))}
		/>
	),
	Indicator: () => null,
}));

vi.mock("@radix-ui/react-select", () => ({
	Root: ({ children }: MockChildrenProps) => <>{children}</>,
	Trigger: ({ children, ...props }: MockChildrenProps) => <button {...props}>{children}</button>,
	Value: ({ placeholder }: MockChildrenProps) => <span>{String(placeholder || "")}</span>,
	Icon: ({ children }: MockChildrenProps) => <span>{children}</span>,
	Portal: () => null,
	Content: ({ children }: MockChildrenProps) => <div>{children}</div>,
	Viewport: ({ children }: MockChildrenProps) => <div>{children}</div>,
	Item: ({ children }: MockChildrenProps) => <div>{children}</div>,
	ItemText: ({ children }: MockChildrenProps) => <span>{children}</span>,
	ItemIndicator: ({ children }: MockChildrenProps) => <span>{children}</span>,
}));

vi.mock("../internal", () => ({ resolveCurrentDialog: mocks.resolveCurrentDialog }));

import { DuplicatePersonDialogContent } from "./duplicate-person-content";

let mount: HTMLDivElement | null = null;

function renderIntoDocument(content: ComponentChild) {
	mount = document.createElement("div");
	document.body.appendChild(mount);
	act(() => {
		render(content, mount as HTMLDivElement);
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
	radioOnValueChange = undefined;
	mocks.resolveCurrentDialog.mockReset();
	document.body.innerHTML = "";
});

describe("DuplicatePersonDialogContent", () => {
	it("keeps merge instructions distinct from the dialog summary and all labels linked", () => {
		// Arrange: reproduce the outer dialog's description alongside its content.
		const descriptionId = "duplicate-person-description";
		const root = renderIntoDocument(
			<div role="dialog" aria-describedby={descriptionId}>
				<p id={descriptionId}>Two people look duplicated.</p>
				<DuplicatePersonDialogContent
					descriptionId={descriptionId}
					request={{
						actors: [
							{ actorId: "local", isLocal: true, label: "You" },
							{ actorId: "duplicate", isLocal: false, label: "Laptop" },
						],
						kind: "duplicate-person",
						summary: "Two people look duplicated.",
						title: "Review duplicate people",
					}}
				/>
			</div>,
		);
		const choice = Array.from(root.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("These are both me"),
		);
		// Act
		act(() => choice?.click());
		// Assert: neither summary nor legend can steal the other's ID.
		const legend = root.querySelector("legend");
		expect(legend?.id).toBeTruthy();
		expect(legend?.id).not.toBe(descriptionId);
		expect(root.querySelectorAll(`[id="${descriptionId}"]`)).toHaveLength(1);
		expect(
			document.getElementById(
				root.querySelector('[role="dialog"]')?.getAttribute("aria-describedby") || "",
			)?.textContent,
		).toBe("Two people look duplicated.");
		const group = root.querySelector('[role="radiogroup"]');
		expect(group?.getAttribute("aria-describedby")).toBe(legend?.id);
		expect(document.getElementById(group?.getAttribute("aria-describedby") || "")).toBe(legend);
		for (const radio of root.querySelectorAll('input[type="radio"]')) {
			expect(
				document.getElementById(radio.getAttribute("aria-labelledby") || "")?.textContent,
			).toBeTruthy();
		}
		for (const label of root.querySelectorAll<HTMLLabelElement>("label[for]")) {
			expect(document.getElementById(label.htmlFor)).not.toBeNull();
		}
		// Act: returning to the choice step removes only the merge instructions.
		act(() =>
			Array.from(root.querySelectorAll("button"))
				.find((button) => button.textContent === "Back")
				?.click(),
		);
		// Assert
		expect(document.getElementById(legend?.id || "")).toBeNull();
		expect(document.getElementById(descriptionId)?.textContent).toBe("Two people look duplicated.");
	});

	it("submits the merge decision when Enter is pressed on the focused primary selector", () => {
		const root = renderIntoDocument(
			<DuplicatePersonDialogContent
				descriptionId="duplicate-person-description"
				request={{
					actors: [
						{ actorId: "local", isLocal: true, label: "You" },
						{ actorId: "duplicate", isLocal: false, label: "You on laptop" },
					],
					kind: "duplicate-person",
					summary: "Two people look duplicated.",
					title: "Review duplicate people",
				}}
			/>,
		);

		const samePersonButton = Array.from(root.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("These are both me"),
		);
		act(() => {
			samePersonButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		const primarySelector = root.querySelector('input[type="radio"]');
		act(() => {
			primarySelector?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }),
			);
		});

		expect(mocks.resolveCurrentDialog).toHaveBeenCalledWith({
			action: "merge",
			primaryActorId: "local",
			secondaryActorId: "duplicate",
		});
	});
});
