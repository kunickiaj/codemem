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

import { TeamMemberRemovalApiError } from "../lib/api/team-member-removal";
import {
	RecipientPolicyTeamMemberRemoval,
	type TeamMemberRemovalActions,
} from "./recipient-policy-team-member-removal";

const PREVIEW = {
	teamName: "Product",
	identityId: "identity-casey",
	displayName: "Casey",
	devices: [{ deviceId: "device-casey", displayName: "Casey's laptop" }],
	pendingInvitations: [
		{ inviteId: "invite-1", createdAt: "2026-11-01T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z" },
		{ inviteId: "invite-2", createdAt: "2026-11-02T00:00:00Z", expiresAt: "2026-12-02T00:00:00Z" },
	],
	expectedDigest: "digest-1",
};

function actions(overrides: Partial<TeamMemberRemovalActions> = {}): TeamMemberRemovalActions {
	return {
		preview: vi.fn().mockResolvedValue(PREVIEW),
		commit: vi.fn().mockResolvedValue({
			appliedHere: true,
			invitations: [
				{ inviteId: "invite-1", result: "revoked" },
				{ inviteId: "invite-2", result: "revoked" },
			],
		}),
		retryRevokes: vi.fn().mockResolvedValue([]),
		...overrides,
	};
}

function mount(removal: TeamMemberRemovalActions, onRemoved = vi.fn()) {
	const element = document.getElementById("mount");
	if (!element) throw new Error("mount missing");
	act(() =>
		render(
			<RecipientPolicyTeamMemberRemoval
				actions={removal}
				disabled={false}
				members={[
					{ identityId: "identity-brian", displayName: "Brian" },
					{ identityId: "identity-casey", displayName: "Casey" },
				]}
				onRemoved={onRemoved}
				teamId="team-product"
				teamName="Product"
			/>,
			element,
		),
	);
	act(() => button("Remove member").click());
	return onRemoved;
}

function button(label: string): HTMLButtonElement {
	const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent === label,
	);
	if (!match) throw new Error(`button missing: ${label}`);
	return match;
}

async function press(label: string) {
	await act(async () => {
		button(label).click();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function choose(name: string) {
	const radio = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
		(input) => input.parentElement?.textContent === name,
	);
	if (!radio) throw new Error(`member missing: ${name}`);
	act(() => radio.click());
}

const dialogText = () => document.querySelector('[role="dialog"]')?.textContent ?? "";

beforeEach(() => {
	document.body.innerHTML = '<div id="mount"></div>';
});

afterEach(() => {
	const element = document.getElementById("mount");
	if (element) act(() => render(null, element));
	document.body.innerHTML = "";
});

describe("removing a member from a Team", () => {
	it("reviews the person's devices and pending invitations, then removes with the chosen revokes", async () => {
		const removal = actions();
		const onRemoved = mount(removal);

		choose("Casey");
		await press("Review removal");
		expect(dialogText()).toContain("Casey stops receiving Product's Projects.");
		expect(dialogText()).toContain("Casey's laptop");
		const second = document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
		act(() => second?.click());
		await press("Remove Casey");

		expect(removal.preview).toHaveBeenCalledWith({
			teamId: "team-product",
			identityId: "identity-casey",
		});
		expect(removal.commit).toHaveBeenCalledWith({
			teamId: "team-product",
			identityId: "identity-casey",
			expectedDigest: "digest-1",
			revokeInvitationIds: ["invite-1"],
		});
		expect(dialogText()).toContain("Casey was removed from the Team.");
		expect(onRemoved).not.toHaveBeenCalled();
		act(() => button("Done").click());
		expect(onRemoved).toHaveBeenCalledOnce();
	});

	it("offers to retry invitations whose revoke failed, and says when this device applies it later", async () => {
		const removal = actions({
			commit: vi.fn().mockResolvedValue({
				appliedHere: false,
				invitations: [
					{ inviteId: "invite-1", result: "unknown" },
					{ inviteId: "invite-2", result: "revoked" },
				],
			}),
			retryRevokes: vi.fn().mockResolvedValue([{ inviteId: "invite-1", result: "revoked" }]),
		});
		mount(removal);
		choose("Casey");
		await press("Review removal");
		await press("Remove Casey");

		expect(dialogText()).toContain("1 invitation couldn't be revoked and can still be used.");
		expect(dialogText()).toContain("It applies it at its next coordinator check.");
		await press("Retry revoking");

		expect(removal.retryRevokes).toHaveBeenCalledWith({
			teamId: "team-product",
			inviteIds: ["invite-1"],
		});
		expect(dialogText()).not.toContain("couldn't be revoked");
		expect(() => button("Retry revoking")).toThrow();
	});

	it.each([
		["removal_preview_stale", "Something changed since you reviewed this removal."],
		["team_link_conflict", "This Team's coordinator group is unclear, so removals are paused."],
		["coordinator_unavailable", "The coordinator couldn't record the removal. Nothing changed."],
	] as const)("explains a refused removal: %s", async (code, message) => {
		const removal = actions({
			commit: vi.fn().mockRejectedValue(new TeamMemberRemovalApiError(409, code)),
		});
		mount(removal);
		choose("Casey");
		await press("Review removal");
		await press("Remove Casey");

		expect(document.querySelector('[role="alert"]')?.textContent).toContain(message);
		expect(button("Remove Casey").disabled).toBe(false);
	});

	it("does not promise nothing changed when the commit's answer is lost, and refreshes on close", async () => {
		const removal = actions({
			commit: vi
				.fn()
				.mockRejectedValue(new TeamMemberRemovalApiError(0, "team_member_removal_failed")),
		});
		const onRemoved = mount(removal);
		choose("Casey");
		await press("Review removal");
		await press("Remove Casey");

		const alert = document.querySelector('[role="alert"]')?.textContent ?? "";
		expect(alert).toContain("couldn't confirm whether the removal was recorded");
		expect(alert).not.toContain("Nothing changed");
		act(() => button("Back").click());
		act(() => button("Cancel").click());
		expect(onRemoved).toHaveBeenCalledOnce();
	});

	it("locks the invitation choices while the removal is being sent", async () => {
		let finish: (value: unknown) => void = () => undefined;
		const removal = actions({
			commit: vi.fn(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			) as TeamMemberRemovalActions["commit"],
		});
		mount(removal);
		choose("Casey");
		await press("Review removal");

		act(() => button("Remove Casey").click());

		const boxes = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
		expect(boxes.map((box) => box.disabled)).toEqual([true, true]);
		await act(async () => {
			finish({ appliedHere: true, invitations: [] });
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	});
});
