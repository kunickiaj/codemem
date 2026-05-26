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

vi.mock("../../../../components/primitives/radix-radio-group", () => ({
	RadixRadioGroup: ({ options, onValueChange, rootClassName, value }: MockChildrenProps) => {
		radioOnValueChange = onValueChange as (value: string) => void;
		return (
			<div className={String(rootClassName || "")}>
				{(options as Array<{ label: ComponentChild; value: string }>).map((option) => (
					<label key={option.value}>
						<input
							aria-label={option.value}
							checked={option.value === value}
							onChange={() => radioOnValueChange?.(option.value)}
							type="radio"
							value={option.value}
						/>
						{option.label}
					</label>
				))}
			</div>
		);
	},
}));

vi.mock("../../../../components/primitives/radix-select", () => ({
	RadixSelect: ({ ariaLabel }: MockChildrenProps) => (
		<button aria-label={String(ariaLabel || "Select")} type="button">
			Select merge target
		</button>
	),
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
