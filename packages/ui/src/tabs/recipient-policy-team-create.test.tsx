import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/primitives/radix-dialog", () => ({
	RadixDialog: ({
		children,
		contentId,
		open,
	}: {
		children?: ComponentChildren;
		contentId: string;
		open: boolean;
	}) =>
		open ? (
			<div id={contentId} role="dialog">
				{children}
			</div>
		) : null,
}));

import { RecipientPolicyTeamCreateApiError } from "../lib/api/sync";
import { type CoordinatorAccess, RecipientPolicyTeamCreate } from "./recipient-policy-team-create";

interface Options {
	access?: CoordinatorAccess;
	createTeam?: (displayName: string) => Promise<{
		version: 1;
		teamId: string;
		displayName: string;
	}>;
	onCreated?: () => unknown;
	refreshFailed?: boolean;
}

function renderCreate(options: Options) {
	const element = document.getElementById("mount");
	if (!element) throw new Error("mount missing");
	act(() =>
		render(
			<RecipientPolicyTeamCreate
				access={options.access ?? "ready"}
				createTeam={options.createTeam ?? created()}
				onCreated={options.onCreated}
				refreshFailed={options.refreshFailed ?? false}
			/>,
			element,
		),
	);
	return (next: Options) => renderCreate({ ...options, ...next });
}

function created() {
	return vi.fn(async (displayName: string) => ({
		version: 1 as const,
		teamId: "team-new",
		displayName,
	}));
}

function button(label: string, root: ParentNode = document): HTMLButtonElement {
	const match = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent === label,
	);
	if (!match) throw new Error(`button missing: ${label}`);
	return match;
}

function dialog(): HTMLElement {
	const element = document.querySelector<HTMLElement>('[role="dialog"]');
	if (!element) throw new Error("dialog missing");
	return element;
}

function openAndName(name: string) {
	act(() => button("Create Team").click());
	const input = document.getElementById("recipient-policy-team-create-name") as HTMLInputElement;
	act(() => {
		input.value = name;
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

beforeEach(() => {
	document.body.innerHTML = '<div id="mount"></div>';
});

afterEach(() => {
	const element = document.getElementById("mount");
	if (element) act(() => render(null, element));
	document.body.innerHTML = "";
});

describe("Create Team", () => {
	it("creates the Team and refreshes Sharing after the dialog closes", async () => {
		// Arrange
		const createTeam = created();
		const onCreated = vi.fn();
		renderCreate({ createTeam, onCreated });

		// Act
		openAndName("  Platform ");
		await act(async () => button("Create Team", dialog()).click());

		// Assert
		expect(createTeam).toHaveBeenCalledWith("Platform");
		expect(document.querySelector('[role="status"]')?.textContent).toBe(
			"Platform was created with you as its admin. Add Projects or invite people to it next.",
		);
		expect(onCreated).not.toHaveBeenCalled();
		act(() => button("Done").click());
		expect(onCreated).toHaveBeenCalledOnce();
	});

	it("rejects a machine-looking name before calling the server", async () => {
		const createTeam = created();
		renderCreate({ createTeam });

		openAndName("actor:machine");
		await act(async () => button("Create Team", dialog()).click());

		expect(createTeam).not.toHaveBeenCalled();
		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"Enter a human-readable Team name.",
		);
	});
});

describe("Create Team availability", () => {
	it.each([
		[
			"admin_secret_missing",
			"Only a device that holds the coordinator admin secret can create Teams.",
		],
		["coordinator_missing", "Set the coordinator URL and group in Settings."],
		["unknown", "Refresh Sharing to try again."],
	] as const)("is disabled with a plain reason when access is %s", (access, reason) => {
		renderCreate({ access });

		act(() => button("Create Team").click());

		expect(button("Create Team").getAttribute("aria-disabled")).toBe("true");
		expect(document.body.textContent).toContain(reason);
		expect(document.querySelector('[role="dialog"]')).toBeNull();
	});

	it("is disabled while Sharing shows details from a failed refresh", () => {
		renderCreate({ refreshFailed: true });

		expect(button("Create Team").getAttribute("aria-disabled")).toBe("true");
		expect(document.body.textContent).toContain("Sharing could not refresh");
	});

	it("does not create when access is lost while the dialog is open", async () => {
		const createTeam = created();
		const rerender = renderCreate({ createTeam });
		openAndName("Platform");

		rerender({ access: "admin_secret_missing" });
		await act(async () => button("Create Team", dialog()).click());

		expect(button("Create Team", dialog()).disabled).toBe(true);
		expect(createTeam).not.toHaveBeenCalled();
	});
});

describe("Create Team failures", () => {
	it("names a taken Team name and does not refresh", async () => {
		const onCreated = vi.fn();
		renderCreate({
			createTeam: vi
				.fn()
				.mockRejectedValue(new RecipientPolicyTeamCreateApiError(409, "team_name_taken", true)),
			onCreated,
		});

		openAndName("Platform");
		await act(async () => button("Create Team", dialog()).click());
		act(() => button("Cancel").click());

		expect(onCreated).not.toHaveBeenCalled();
	});

	it("shows the taken-name guidance", async () => {
		renderCreate({
			createTeam: vi
				.fn()
				.mockRejectedValue(new RecipientPolicyTeamCreateApiError(409, "team_name_taken", true)),
		});

		openAndName("Platform");
		await act(async () => button("Create Team", dialog()).click());

		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"A Team named Platform already exists. Choose a different name.",
		);
	});

	it("reports an unconfirmed outcome and refreshes Sharing on close", async () => {
		const onCreated = vi.fn();
		renderCreate({
			createTeam: vi
				.fn()
				.mockRejectedValue(new RecipientPolicyTeamCreateApiError(0, "team_create_failed", false)),
			onCreated,
		});

		openAndName("Platform");
		await act(async () => button("Create Team", dialog()).click());

		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"codemem couldn't confirm whether the Team was created",
		);
		act(() => button("Cancel").click());
		expect(onCreated).toHaveBeenCalledOnce();
	});
});
