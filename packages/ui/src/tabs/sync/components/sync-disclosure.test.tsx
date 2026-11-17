import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHARING_HANDOFF_EVENT } from "../../../lib/sharing-handoff";
import { renderTeamSetupDisclosure } from "./sync-disclosure";

describe("Advanced team setup handoff", () => {
	let mount: HTMLElement;

	beforeEach(() => {
		document.body.innerHTML = '<div id="mount"></div>';
		mount = document.getElementById("mount") as HTMLElement;
	});

	afterEach(() => {
		act(() => render(null, mount));
		document.body.innerHTML = "";
	});

	it.each([
		["Create a Team in Sharing", "create_team"],
		["Invite someone in Sharing", "invite"],
	])("%s opens Sharing instead of creating a connection-only code", (label, target) => {
		// Arrange
		const onHandoff = vi.fn();
		window.addEventListener(SHARING_HANDOFF_EVENT, onHandoff, { once: true });
		act(() => renderTeamSetupDisclosure(mount, { open: true, onOpenChange: vi.fn() }));
		const button = [...mount.querySelectorAll("button")].find(
			(candidate) => candidate.textContent === label,
		);

		// Act
		act(() => button?.click());

		// Assert
		expect(onHandoff).toHaveBeenCalledWith(expect.objectContaining({ detail: target }));
		expect(mount.querySelector("#syncCreateInviteButton")).toBeNull();
		expect(mount.textContent).not.toMatch(/Expires in|Join policy/);
	});
});
