import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dialogSpy = vi.hoisted(() => vi.fn());
const openProjectShare = vi.hoisted(() => vi.fn());

vi.mock("../components/primitives/radix-dialog", () => ({
	RadixDialog: (props: {
		ariaDescribedby?: string;
		ariaLabelledby?: string;
		children?: ComponentChildren;
		contentId: string;
		onCloseAutoFocus?: (event: Event) => void;
		onOpenAutoFocus?: (event: Event) => void;
		onOpenChange: (open: boolean) => void;
		open: boolean;
	}) => {
		dialogSpy(props);
		return props.open ? (
			<div
				aria-describedby={props.ariaDescribedby}
				aria-labelledby={props.ariaLabelledby}
				id={props.contentId}
				role="dialog"
			>
				{props.children}
			</div>
		) : null;
	},
}));

vi.mock("../lib/api", () => ({
	createRecipientInvite: vi.fn(),
	importCoordinatorInvite: vi.fn(),
	inspectCoordinatorInvite: vi.fn(),
	previewRecipientInvite: vi.fn(),
}));

vi.mock("./project-sharing", () => ({ openProjectShareFlow: openProjectShare }));

import * as api from "../lib/api";
import type { RecipientOnboardingPreviewV1, RecipientPolicyIntentGraphV1 } from "../lib/api/sync";
import { RecipientPolicyInvitations } from "./recipient-policy-invitations";

const escapedName = '<img src=x onerror="alert(1)">';
const intent: RecipientPolicyIntentGraphV1 = {
	version: 1,
	identities: [
		{
			version: 1,
			identityId: "identity-local",
			displayName: "Local Identity",
			kind: "personal",
			verification: "local",
			status: "active",
			mergedIntoIdentityId: null,
		},
	],
	teams: [{ version: 1, teamId: "team-one", displayName: escapedName, status: "active" }],
	teamMemberships: [],
	identityDevices: [],
	projectRecipients: [],
};

const teamPreview: RecipientOnboardingPreviewV1 = {
	version: 1,
	journey: "team",
	binding: {
		invitationId: "invite-team",
		identityId: "identity-local",
		deviceId: "device-one",
		deviceKeyFingerprint: "fingerprint",
		deviceDisplayName: "Laptop",
	},
	team: { teamId: "team-one", displayName: escapedName, futureProjectsInherit: true },
	projects: [
		{
			canonicalProjectIdentity: "project-one",
			displayName: "Codemem",
			existingMemoryCount: 41,
			futureMemoriesShared: true,
			sources: [{ kind: "team", teamId: "team-one", displayName: escapedName }],
		},
	],
	excludedProjects: [
		{ canonicalProjectIdentity: "project-other", displayName: "Private", existingMemoryCount: 9 },
	],
	reviewedOnboardingDigest: "recipient-onboarding-preview-v1:team",
};

const addDevicePreview: RecipientOnboardingPreviewV1 = {
	...teamPreview,
	journey: "add_device",
	team: null,
	projects: [
		{
			canonicalProjectIdentity: "project-direct",
			displayName: "Direct work",
			existingMemoryCount: 3,
			futureMemoriesShared: true,
			sources: [{ kind: "direct" }],
		},
		{
			canonicalProjectIdentity: "project-team",
			displayName: "Team work",
			existingMemoryCount: 7,
			futureMemoriesShared: true,
			sources: [{ kind: "team", teamId: "team-one", displayName: "Example Team" }],
		},
	],
	reviewedOnboardingDigest: "recipient-onboarding-preview-v1:device",
};

function button(label: string, root: ParentNode = document): HTMLButtonElement {
	const match = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.textContent?.trim() === label,
	);
	if (!match) throw new Error(`button missing: ${label}`);
	return match;
}

function mount(graph = intent) {
	const element = document.getElementById("mount");
	if (!element) throw new Error("mount missing");
	act(() => render(<RecipientPolicyInvitations intent={graph} />, element));
}

describe("recipient-policy invitations", () => {
	beforeEach(() => {
		document.body.innerHTML = '<div id="mount"></div>';
	});

	afterEach(() => {
		const element = document.getElementById("mount");
		if (element) act(() => render(null, element));
		vi.resetAllMocks();
		document.body.innerHTML = "";
	});

	it("previews and creates a Team-member invitation with the exact reviewed request", async () => {
		vi.mocked(api.previewRecipientInvite).mockResolvedValue({
			kind: "team_member",
			preview: teamPreview,
		});
		vi.mocked(api.createRecipientInvite).mockResolvedValue({
			ok: true,
			kind: "team_member",
			preview: teamPreview,
			invite: { link: "codemem://join?invite=team" },
		});
		mount();

		act(() => button("Invite Team member").click());
		const dialog = document.querySelector('[role="dialog"]');
		if (!dialog) throw new Error("dialog missing");
		act(() => button("Review invitation", dialog).click());
		await vi.waitFor(() => expect(api.previewRecipientInvite).toHaveBeenCalledOnce());

		expect(api.previewRecipientInvite).toHaveBeenCalledWith({
			kind: "team_member",
			policy_team_id: "team-one",
		});
		await vi.waitFor(() =>
			expect(dialog.textContent).toContain("41 existing memories and future activity"),
		);
		expect(dialog.textContent).toContain(
			"Future Projects shared with this Team will also be inherited",
		);
		expect(dialog.textContent).toContain(
			"No other Projects will be shared through this invitation",
		);
		expect(dialog.textContent).toContain(escapedName);
		expect(dialog.querySelector("img")).toBeNull();

		act(() => button("Create invitation", dialog).click());
		await vi.waitFor(() => expect(api.createRecipientInvite).toHaveBeenCalledOnce());
		expect(api.createRecipientInvite).toHaveBeenCalledWith({
			kind: "team_member",
			policy_team_id: "team-one",
			reviewed_onboarding_digest: teamPreview.reviewedOnboardingDigest,
		});
	});

	it("inspects and accepts add-device access with direct, inherited, and excluded Projects", async () => {
		vi.mocked(api.inspectCoordinatorInvite).mockResolvedValue({
			kind: "add_device",
			recipient_name: "Local Identity",
			device_name: "Travel Laptop",
			onboarding: addDevicePreview,
		});
		vi.mocked(api.importCoordinatorInvite).mockResolvedValue({ status: "accepted" });
		mount();

		act(() => button("Review invitation").click());
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) throw new Error("textarea missing");
		act(() => {
			textarea.value = "recipient-invite";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const dialog = document.querySelector('[role="dialog"]');
		if (!dialog) throw new Error("dialog missing");
		act(() => button("Review invitation", dialog).click());
		await vi.waitFor(() =>
			expect(api.inspectCoordinatorInvite).toHaveBeenCalledWith("recipient-invite"),
		);

		await vi.waitFor(() => expect(dialog.textContent).toContain("Direct Projects"));
		expect(dialog.textContent).toContain("Direct work — 3 existing memories");
		expect(dialog.textContent).toContain("Team work — 7 existing memories");
		expect(dialog.textContent).toContain("through Example Team");
		expect(dialog.textContent).toContain("Private — 9 existing memories");
		expect(dialog.textContent).toContain("This device will not receive the Projects listed here");

		act(() => button("Accept invitation", dialog).click());
		await vi.waitFor(() => expect(api.importCoordinatorInvite).toHaveBeenCalledOnce());
		expect(api.importCoordinatorInvite).toHaveBeenCalledWith("recipient-invite", {
			recipient_name: "Local Identity",
			device_name: "Travel Laptop",
			reviewed_onboarding_digest: addDevicePreview.reviewedOnboardingDigest,
		});
	});

	it("shows loading, error, and empty states without exposing internal language", async () => {
		let rejectPreview: (cause: Error) => void = () => undefined;
		vi.mocked(api.previewRecipientInvite).mockImplementation(
			() => new Promise((_, reject) => (rejectPreview = reject)),
		);
		mount();
		act(() => button("Invite Team member").click());
		const dialog = document.querySelector('[role="dialog"]');
		if (!dialog) throw new Error("dialog missing");
		act(() => button("Review invitation", dialog).click());
		expect(dialog.querySelector('[role="status"]')?.textContent).toContain("Reviewing invitation");
		rejectPreview(new Error("internal_failure"));
		await vi.waitFor(() =>
			expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
				"Unable to review this invitation",
			),
		);

		act(() =>
			render(
				<RecipientPolicyInvitations intent={{ ...intent, identities: [], teams: [] }} />,
				document.getElementById("mount") as HTMLElement,
			),
		);
		expect(document.body.textContent).toContain("No active Teams or Identities are available");
		expect(document.body.textContent).not.toMatch(/\b(scope|grant|actor|filter|epoch|cursor)\b/i);
	});

	it("moves focus to the heading and restores it after Radix keyboard close", () => {
		mount();
		const trigger = button("Add a device");
		trigger.focus();
		act(() => trigger.click());
		const props = dialogSpy.mock.calls.at(-1)?.[0] as {
			onCloseAutoFocus: (event: Event) => void;
			onOpenAutoFocus: (event: Event) => void;
			onOpenChange: (open: boolean) => void;
		};
		const event = new Event("focus", { cancelable: true });
		props.onOpenAutoFocus(event);
		expect(event.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(document.getElementById("recipient-invitation-title"));

		act(() => props.onOpenChange(false));
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		props.onCloseAutoFocus(event);
		expect(document.activeElement).toBe(trigger);
	});

	it("keeps direct Project review and legacy import routed to their established journeys", async () => {
		vi.mocked(api.inspectCoordinatorInvite).mockResolvedValue({ kind: "legacy_team_invite" });
		mount();
		act(() => button("Share exact Projects").click());
		expect(openProjectShare).toHaveBeenCalledOnce();

		act(() => button("Review invitation").click());
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		if (!textarea) throw new Error("textarea missing");
		act(() => {
			textarea.value = "legacy";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const dialog = document.querySelector('[role="dialog"]');
		if (!dialog) throw new Error("dialog missing");
		act(() => button("Review invitation", dialog).click());
		await vi.waitFor(() =>
			expect(dialog.textContent).toContain("Use Advanced Team administration to review and import"),
		);
		expect(api.importCoordinatorInvite).not.toHaveBeenCalled();
	});
});
