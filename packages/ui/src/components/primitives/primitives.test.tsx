import { type ComponentChild, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

let selectOnValueChange: ((value: string) => void) | undefined;
let tabsOnValueChange: ((value: string) => void) | undefined;
let radioOnValueChange: ((value: string) => void) | undefined;
let switchOnCheckedChange: ((checked: boolean) => void) | undefined;

type MockChildrenProps = {
	children?: ComponentChild;
	[key: string]: unknown;
};

vi.mock("@radix-ui/react-select", () => ({
	Root: ({
		children,
		onValueChange,
	}: {
		children: ComponentChild;
		onValueChange: (value: string) => void;
	}) => {
		selectOnValueChange = onValueChange;
		return <div data-testid="select-root">{children}</div>;
	},
	Trigger: ({ children, ...props }: MockChildrenProps) => <button {...props}>{children}</button>,
	Value: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
	Icon: ({ children, ...props }: MockChildrenProps) => <span {...props}>{children}</span>,
	Portal: ({ children }: { children: ComponentChild }) => <>{children}</>,
	Content: ({ children, ...props }: MockChildrenProps) => <div {...props}>{children}</div>,
	Viewport: ({ children, ...props }: MockChildrenProps) => <div {...props}>{children}</div>,
	Item: ({ children, value, ...props }: MockChildrenProps) => (
		<button {...props} onClick={() => selectOnValueChange?.(String(value))} type="button">
			{children}
		</button>
	),
	ItemText: ({ children }: { children: ComponentChild }) => <span>{children}</span>,
	ItemIndicator: ({ children, ...props }: MockChildrenProps) => <span {...props}>{children}</span>,
}));

vi.mock("@radix-ui/react-tabs", () => ({
	Root: ({
		children,
		onValueChange,
		value,
	}: {
		children: ComponentChild;
		onValueChange: (value: string) => void;
		value: string;
	}) => {
		tabsOnValueChange = onValueChange;
		return <div data-state-value={value}>{children}</div>;
	},
	List: ({ children, ...props }: MockChildrenProps) => <div {...props}>{children}</div>,
	Trigger: ({ children, value, ...props }: MockChildrenProps) => (
		<button
			{...props}
			data-state={props.disabled ? "disabled" : props.value}
			onClick={() => tabsOnValueChange?.(String(value))}
			role="tab"
			type="button"
		>
			{children}
		</button>
	),
	Content: ({ children, ...props }: MockChildrenProps) => <div {...props}>{children}</div>,
}));

vi.mock("@radix-ui/react-radio-group", () => ({
	Root: ({
		children,
		onValueChange,
	}: {
		children: ComponentChild;
		onValueChange: (value: string) => void;
	}) => {
		radioOnValueChange = onValueChange;
		return <div>{children}</div>;
	},
	Item: ({ id, value, ...props }: MockChildrenProps) => (
		<input
			{...props}
			id={String(id)}
			onChange={() => radioOnValueChange?.(String(value))}
			type="radio"
			value={String(value)}
		/>
	),
	Indicator: ({ children, ...props }: MockChildrenProps) => <span {...props}>{children}</span>,
}));

vi.mock("@radix-ui/react-switch", () => ({
	Root: ({ children, checked, onCheckedChange, ...props }: MockChildrenProps) => {
		switchOnCheckedChange = onCheckedChange as ((checked: boolean) => void) | undefined;
		return (
			<button
				{...props}
				aria-checked={checked ? "true" : "false"}
				onClick={() => switchOnCheckedChange?.(!checked)}
				role="switch"
				type="button"
			>
				{children}
			</button>
		);
	},
	Thumb: ({ children, ...props }: MockChildrenProps) => <span {...props}>{children}</span>,
}));

import { DialogCloseButton } from "./dialog-close-button";
import { RadixRadioGroup } from "./radix-radio-group";
import { RadixSelect } from "./radix-select";
import { RadixSwitch } from "./radix-switch";
import { RadixTabs } from "./radix-tabs";
import { TextArea } from "./text-area";
import { TextInput } from "./text-input";

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
	selectOnValueChange = undefined;
	tabsOnValueChange = undefined;
	radioOnValueChange = undefined;
	switchOnCheckedChange = undefined;
	document.body.innerHTML = "";
});

describe("DialogCloseButton", () => {
	it("renders an accessible close control and calls onClick", () => {
		const onClick = vi.fn();
		const root = renderIntoDocument(
			<DialogCloseButton ariaLabel="Close settings" onClick={onClick} />,
		);

		const button = root.querySelector("button");
		expect(button?.getAttribute("aria-label")).toBe("Close settings");
		expect(button?.textContent).toContain("Close");

		act(() => {
			button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(onClick).toHaveBeenCalledTimes(1);
	});
});

describe("RadixTabs", () => {
	it("exposes tabs and reports value changes", () => {
		const onValueChange = vi.fn();
		const root = renderIntoDocument(
			<RadixTabs
				ariaLabel="Settings sections"
				onValueChange={onValueChange}
				tabs={[
					{ label: "Connection", value: "observer" },
					{ label: "Processing", value: "queue" },
				]}
				value="observer"
			/>,
		);

		const tabs = Array.from(root.querySelectorAll('[role="tab"]'));
		expect(tabs).toHaveLength(2);

		act(() => {
			tabs[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(onValueChange).toHaveBeenCalledWith("queue");
	});
});

describe("RadixSelect", () => {
	it("keeps the explicit accessible name instead of falling back to placeholder text", () => {
		const root = renderIntoDocument(
			<RadixSelect
				ariaLabel="Model provider"
				onValueChange={() => undefined}
				options={[{ label: "Auto", value: "" }]}
				placeholder="auto (default)"
				value=""
			/>,
		);

		const trigger = root.querySelector("button");
		expect(trigger?.getAttribute("aria-label")).toBe("Model provider");
		expect(trigger?.textContent).toContain("auto (default)");
	});

	it("decodes the empty-option sentinel before notifying callers", () => {
		const onValueChange = vi.fn();
		const root = renderIntoDocument(
			<RadixSelect
				ariaLabel="Model provider"
				onValueChange={onValueChange}
				options={[{ label: "Auto", value: "" }]}
				placeholder="auto (default)"
				value=""
			/>,
		);

		const optionButton = root.querySelectorAll("button")[1];
		act(() => {
			optionButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(onValueChange).toHaveBeenCalledWith("");
	});
});

describe("RadixRadioGroup", () => {
	it("lets users select an option by clicking the visible label row", () => {
		const onValueChange = vi.fn();
		const root = renderIntoDocument(
			<RadixRadioGroup
				ariaLabel="Person to keep after combining duplicates"
				onValueChange={onValueChange}
				options={[
					{ label: "Alex", value: "alex" },
					{ label: "Sam", value: "sam" },
				]}
				value="alex"
			/>,
		);

		const samLabel = Array.from(root.querySelectorAll("label")).find((label) =>
			label.textContent?.includes("Sam"),
		);
		expect(samLabel).toBeTruthy();

		act(() => {
			samLabel?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(onValueChange).toHaveBeenCalledWith("sam");
	});
});

describe("RadixSwitch", () => {
	it("reports checked changes through the shared switch primitive", () => {
		const onCheckedChange = vi.fn();
		const root = renderIntoDocument(
			<RadixSwitch
				aria-labelledby="settingsAdvancedToggleLabel"
				checked={false}
				id="settingsAdvancedToggle"
				onCheckedChange={onCheckedChange}
			/>,
		);

		const button = root.querySelector('[role="switch"]');
		expect(button?.getAttribute("aria-labelledby")).toBe("settingsAdvancedToggleLabel");
		expect(button?.getAttribute("id")).toBe("settingsAdvancedToggle");

		act(() => {
			switchOnCheckedChange?.(true);
		});

		expect(onCheckedChange).toHaveBeenCalledWith(true);
	});

	it("supports label-driven toggle behavior with a real label association", () => {
		const onCheckedChange = vi.fn();
		const root = renderIntoDocument(
			<>
				<label htmlFor="settingsAdvancedToggle" id="settingsAdvancedToggleLabel">
					Show advanced controls
				</label>
				<RadixSwitch
					aria-labelledby="settingsAdvancedToggleLabel"
					checked={false}
					id="settingsAdvancedToggle"
					onCheckedChange={onCheckedChange}
				/>
			</>,
		);

		const label = Array.from(root.querySelectorAll("label")).find((item) =>
			item.textContent?.includes("Show advanced controls"),
		);
		expect(label).toBeTruthy();

		act(() => {
			label?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(onCheckedChange).toHaveBeenCalledWith(true);
	});
});

describe("TextInput", () => {
	it("preserves accessible naming and input events", () => {
		const onInput = vi.fn();
		const root = renderIntoDocument(
			<>
				<label htmlFor="observerModel">Observer model</label>
				<TextInput
					id="observerModel"
					onInput={onInput}
					placeholder="leave empty for default"
					value=""
				/>
			</>,
		);

		const input = root.querySelector("input");
		expect(input?.getAttribute("id")).toBe("observerModel");
		expect(input?.getAttribute("placeholder")).toBe("leave empty for default");

		act(() => {
			if (input) {
				input.value = "gpt-5.1-mini";
				input.dispatchEvent(new Event("input", { bubbles: true }));
			}
		});

		expect(onInput).toHaveBeenCalledTimes(1);
	});
});

describe("TextArea", () => {
	it("preserves textarea props for read-only and sizing behavior", () => {
		const root = renderIntoDocument(
			<>
				<label htmlFor="syncInviteOutput">Generated invite</label>
				<TextArea id="syncInviteOutput" readOnly rows={3} value="invite-token" />
			</>,
		);

		const textarea = root.querySelector("textarea");
		expect(textarea?.getAttribute("id")).toBe("syncInviteOutput");
		expect(textarea?.readOnly).toBe(true);
		expect(textarea?.getAttribute("rows")).toBe("3");
		expect(textarea?.value).toBe("invite-token");
	});
});
