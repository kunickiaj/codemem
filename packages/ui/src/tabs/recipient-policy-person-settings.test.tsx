import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/primitives/radix-dialog", () => ({
	RadixDialog: ({
		ariaLabelledby,
		children,
		contentId,
		open,
	}: {
		ariaLabelledby?: string;
		children?: ComponentChildren;
		contentId: string;
		open: boolean;
	}) =>
		open ? (
			<div aria-labelledby={ariaLabelledby} id={contentId} role="dialog">
				{children}
			</div>
		) : null,
}));

import {
	mergeFailure,
	type PersonSettingsActions,
	RecipientPolicyPersonSettings,
	removeFailure,
	renameFailure,
} from "./recipient-policy-person-settings";

const TARGETS = [
	{ identityId: "identity-adam", label: "Adam (you)" },
	{ identityId: "identity-casey", label: "Casey" },
];

function actions(overrides: Partial<PersonSettingsActions> = {}): PersonSettingsActions {
	return {
		rename: vi.fn().mockResolvedValue({}),
		merge: vi.fn().mockResolvedValue({}),
		deactivate: vi.fn().mockResolvedValue({}),
		...overrides,
	};
}

interface MountOptions {
	accessChangesAllowed?: boolean;
	/** "api" uses the component's own actions, which call the Viewer API. */
	actions?: PersonSettingsActions | "api";
	disabled?: boolean;
	onChanged?: () => unknown;
}

function renderSettings(options: MountOptions) {
	const element = document.getElementById("mount");
	if (!element) throw new Error("mount missing");
	act(() =>
		render(
			<RecipientPolicyPersonSettings
				accessChangesAllowed={options.accessChangesAllowed ?? true}
				actions={options.actions === "api" ? undefined : (options.actions ?? actions())}
				disabled={options.disabled ?? false}
				displayName="Brian"
				identityId="identity-brian"
				mergeTargets={TARGETS}
				onChanged={options.onChanged}
			/>,
			element,
		),
	);
}

/** Renders the settings and opens the dialog. Returns a rerender with new props. */
function mount(options: MountOptions) {
	renderSettings(options);
	act(() => button("Person settings").click());
	return (next: MountOptions) => renderSettings({ ...options, ...next });
}

function button(label: string): HTMLButtonElement {
	const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent === label,
	);
	if (!match) throw new Error(`button missing: ${label}`);
	return match;
}

function type(element: HTMLInputElement | HTMLSelectElement, value: string, event = "input") {
	act(() => {
		element.value = value;
		element.dispatchEvent(new Event(event, { bubbles: true }));
	});
}

function nameInput(): HTMLInputElement {
	return document.getElementById("recipient-policy-person-settings-name") as HTMLInputElement;
}

function mergeSelect(): HTMLSelectElement {
	return document.getElementById("recipient-policy-person-merge-target") as HTMLSelectElement;
}

beforeEach(() => {
	document.body.innerHTML = '<div id="mount"></div>';
});

afterEach(() => {
	const element = document.getElementById("mount");
	if (element) act(() => render(null, element));
	document.body.innerHTML = "";
});

describe("person settings rename", () => {
	it("renames the person and refreshes Sharing only after the dialog closes", async () => {
		// Arrange
		const personActions = actions();
		const onChanged = vi.fn();
		mount({ actions: personActions, onChanged });

		// Act
		type(nameInput(), "Brian Smith");
		await act(async () => button("Save name").click());

		// Assert
		expect(personActions.rename).toHaveBeenCalledWith("identity-brian", "Brian Smith");
		expect(document.querySelector('[role="status"]')?.textContent).toBe("Renamed to Brian Smith.");
		expect(onChanged).not.toHaveBeenCalled();
		act(() => button("Done").click());
		expect(onChanged).toHaveBeenCalledOnce();
	});

	it("rejects a machine-looking name before calling the server", () => {
		const personActions = actions();
		mount({ actions: personActions });

		type(nameInput(), "actor:machine");
		act(() => button("Save name").click());

		expect(personActions.rename).not.toHaveBeenCalled();
		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"Enter a human-readable name.",
		);
	});
});

describe("person settings merge", () => {
	it("merges this person into the chosen person after confirmation", async () => {
		const personActions = actions();
		const onChanged = vi.fn();
		mount({ actions: personActions, onChanged });

		type(mergeSelect(), "identity-casey", "change");
		act(() => button("Review merge").click());
		expect(document.body.textContent).toContain("Merge Brian into Casey?");
		await act(async () => button("Merge people").click());
		act(() => button("Done").click());

		expect(personActions.merge).toHaveBeenCalledWith("identity-casey", "identity-brian");
		expect(onChanged).toHaveBeenCalledOnce();
	});

	it("keeps the dialog open with the next step when Team memberships conflict", async () => {
		const personActions = actions({
			merge: vi.fn().mockRejectedValue(new Error("actor team memberships conflict")),
		});
		const onChanged = vi.fn();
		mount({ actions: personActions, onChanged });

		type(mergeSelect(), "identity-casey", "change");
		act(() => button("Review merge").click());
		await act(async () => button("Merge people").click());

		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"Brian and Casey have different roles or invitation states in the same Team, so they can't be merged. Nothing changed. Keep them separate, or remove Brian if that entry is no longer used.",
		);
		act(() => button("Close").click());
		expect(onChanged).not.toHaveBeenCalled();
	});

	it("returns to the settings without merging when the person keeps them separate", () => {
		const personActions = actions();
		mount({ actions: personActions });

		type(mergeSelect(), "identity-adam", "change");
		act(() => button("Review merge").click());
		act(() => button("Keep separate").click());

		expect(personActions.merge).not.toHaveBeenCalled();
		expect(nameInput()).not.toBeNull();
	});
});

describe("person settings removal", () => {
	it("removes the person after a confirmation that names the access change", async () => {
		const personActions = actions();
		const onChanged = vi.fn();
		mount({ actions: personActions, onChanged });

		act(() => button("Remove Brian").click());
		expect(document.body.textContent).toContain(
			"Brian's devices stop receiving every Project shared with Brian",
		);
		await act(async () => button("Remove person").click());
		act(() => button("Done").click());

		expect(personActions.deactivate).toHaveBeenCalledWith("identity-brian");
		expect(onChanged).toHaveBeenCalledOnce();
	});

	it("disables merge and removal with a plain reason on a device without the admin secret", () => {
		mount({ accessChangesAllowed: false });

		expect(button("Remove Brian").disabled).toBe(true);
		expect(mergeSelect().disabled).toBe(true);
		expect(button("Save name").disabled).toBe(true);
		type(nameInput(), "Brian Smith");
		expect(button("Save name").disabled).toBe(false);
		expect(document.body.textContent).toContain(
			"Only a device with the coordinator admin secret can make that change. Use that device.",
		);
	});
});

describe("person settings when access changes become unavailable", () => {
	it.each([
		["the admin secret is no longer available", { accessChangesAllowed: false }],
		["Sharing fails to refresh", { disabled: true }],
	])("blocks an open removal confirmation when %s", async (_label, next) => {
		// Arrange: the confirmation opened while changes were allowed.
		const personActions = actions();
		const rerender = mount({ actions: personActions });
		act(() => button("Remove Brian").click());

		// Act
		rerender(next);
		await act(async () => button("Remove person").click());

		// Assert
		expect(button("Remove person").disabled).toBe(true);
		expect(personActions.deactivate).not.toHaveBeenCalled();
	});

	it("blocks an open merge confirmation when the admin secret is no longer available", async () => {
		const personActions = actions();
		const rerender = mount({ actions: personActions });
		type(mergeSelect(), "identity-casey", "change");
		act(() => button("Review merge").click());

		rerender({ accessChangesAllowed: false });
		await act(async () => button("Merge people").click());

		expect(personActions.merge).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("coordinator admin secret");
	});
});

describe("person settings with an unconfirmed outcome", () => {
	it("says the removal could not be confirmed and refreshes Sharing on close", async () => {
		// Arrange: the response failed after the request may have been applied.
		const onChanged = vi.fn();
		const personActions = actions({
			deactivate: vi.fn().mockRejectedValue(new TypeError("network error")),
		});
		mount({ actions: personActions, onChanged });

		// Act
		act(() => button("Remove Brian").click());
		await act(async () => button("Remove person").click());
		act(() => button("Close").click());

		// Assert
		expect(onChanged).toHaveBeenCalledOnce();
	});

	it("does not refresh after a recognized rejection", async () => {
		const onChanged = vi.fn();
		const personActions = actions({
			deactivate: vi.fn().mockRejectedValue(new Error("actor not active")),
		});
		mount({ actions: personActions, onChanged });

		act(() => button("Remove Brian").click());
		await act(async () => button("Remove person").click());
		act(() => button("Close").click());

		expect(onChanged).not.toHaveBeenCalled();
	});
});

describe("person settings when the server response can't be read", () => {
	afterEach(() => vi.unstubAllGlobals());

	function respond(body: string) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);
	}

	/** Lets the stubbed fetch and response read settle. */
	async function settle() {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}

	const steps: Record<string, () => Promise<void>> = {
		rename: async () => {
			type(nameInput(), "  Brian   Lee ");
			await act(async () => button("Save name").click());
			await settle();
		},
		merge: async () => {
			type(mergeSelect(), "identity-casey", "change");
			act(() => button("Review merge").click());
			await act(async () => button("Merge people").click());
			await settle();
		},
		removal: async () => {
			act(() => button("Remove Brian").click());
			await act(async () => button("Remove person").click());
			await settle();
		},
	};

	it.each(["rename", "merge", "removal"])(
		"reports an unconfirmed %s instead of success for an empty response",
		async (step) => {
			// Arrange
			respond("");
			const onChanged = vi.fn();
			mount({ actions: "api", onChanged });

			// Act
			await steps[step]?.();

			// Assert
			expect(document.body.textContent).toContain("codemem couldn't confirm whether");
			expect(document.body.textContent).not.toContain("stop receiving shared Projects once");
			act(() => button("Close").click());
			expect(onChanged).toHaveBeenCalledOnce();
		},
	);

	it.each([
		["rename", '{"actor_id":"identity-brian","display_name":"Brian Lee"}', "Renamed to Brian Lee."],
		["merge", '{"merged_count":1}', "Brian was merged into Casey."],
		["removal", '{"ok":true}', "Brian was removed."],
	])("reports the %s once the server confirms it", async (step, body, message) => {
		respond(body);
		mount({ actions: "api" });

		await steps[step]?.();

		expect(document.body.textContent).toContain(message);
	});
});

describe("person settings error messages", () => {
	it.each([
		[renameFailure(new Error("actor not found")), "Refresh Sharing", true],
		[renameFailure(new Error("display_name_too_long")), "120 characters or fewer", true],
		[renameFailure(new Error("boom")), "couldn't confirm whether the name was saved", false],
		[
			mergeFailure(new Error("actor project recipients conflict"), "Brian", "Casey"),
			"Make both shares match in Manage projects",
			true,
		],
		[
			mergeFailure(new Error("secondary actor not active"), "Brian", "Casey"),
			"Refresh Sharing",
			true,
		],
		[
			mergeFailure(new Error("boom"), "Brian", "Casey"),
			"couldn't confirm whether Brian was merged into Casey",
			false,
		],
		[removeFailure(new Error("actor not active"), "Brian"), "Refresh Sharing", true],
		[
			removeFailure(new Error("boom"), "Brian"),
			"couldn't confirm whether Brian was removed",
			false,
		],
	])("names what happened and the next step: %o", (failure, expected, outcomeKnown) => {
		expect(failure.text).toContain(expected);
		expect(failure.outcomeKnown).toBe(outcomeKnown);
		expect(failure.text).not.toMatch(/actor|scope|Space|enrollment/);
	});
});
