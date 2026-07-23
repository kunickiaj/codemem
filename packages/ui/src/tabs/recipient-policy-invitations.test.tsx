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

const projectShareInspection = {
	kind: "project_share_invite" as const,
	operation_id: "share-projects",
	inviter_name: "Adam",
	team_name: "Example Team",
	recipient_name: "Brian",
	device_name: "Brian’s Mac",
	projects: [
		{ display_name: "Codemem", existing_memory_count: 41 },
		{ display_name: "Viewer", existing_memory_count: 1 },
	],
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

	it("inspects and accepts a Team invitation with required names, digest, and Team result copy", async () => {
		vi.mocked(api.inspectCoordinatorInvite).mockResolvedValue({
			kind: "team_member",
			recipient_name: "Local Identity",
			device_name: "Work Laptop",
			onboarding: teamPreview,
		});
		vi.mocked(api.importCoordinatorInvite).mockResolvedValue({ status: "accepted" });
		mount();

		act(() => button("Review invitation").click());
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		const dialog = document.querySelector('[role="dialog"]');
		if (!textarea || !dialog) throw new Error("acceptance dialog missing");
		act(() => {
			textarea.value = "team-member-invite";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => button("Review invitation", dialog).click());
		await vi.waitFor(() => expect(dialog.textContent).toContain("Current Projects for"));
		act(() => button("Accept invitation", dialog).click());

		await vi.waitFor(() => expect(api.importCoordinatorInvite).toHaveBeenCalledOnce());
		expect(api.importCoordinatorInvite).toHaveBeenCalledWith("team-member-invite", {
			recipient_name: "Local Identity",
			device_name: "Work Laptop",
			reviewed_onboarding_digest: teamPreview.reviewedOnboardingDigest,
		});
		await vi.waitFor(() => expect(dialog.textContent).toContain("Team invitation accepted"));
		expect(dialog.textContent).not.toContain("Project setup is pending");
	});

	it("keeps unknown recipient-import errors generic", async () => {
		vi.mocked(api.inspectCoordinatorInvite).mockResolvedValue({
			kind: "team_member",
			recipient_name: "Local Identity",
			device_name: "Work Laptop",
			onboarding: teamPreview,
		});
		vi.mocked(api.importCoordinatorInvite).mockRejectedValue(
			new Error("recipient_invite_unmapped_internal"),
		);
		mount();
		act(() => button("Review invitation").click());
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		const dialog = document.querySelector('[role="dialog"]');
		if (!textarea || !dialog) throw new Error("acceptance dialog missing");
		act(() => {
			textarea.value = "team-member-invite";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => button("Review invitation", dialog).click());
		await vi.waitFor(() => expect(dialog.textContent).toContain("Current Projects for"));
		act(() => button("Accept invitation", dialog).click());

		await vi.waitFor(() =>
			expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
				"Unable to accept this invitation.",
			),
		);
		expect(dialog.textContent).not.toContain("recipient_invite_unmapped_internal");
	});

	it("reviews and accepts direct exact-Project access in the same dialog without repasting", async () => {
		vi.mocked(api.inspectCoordinatorInvite).mockResolvedValue(projectShareInspection);
		vi.mocked(api.importCoordinatorInvite).mockResolvedValue({
			status: "pending_setup",
			setup_state: "pending_inviter",
			sync_enabled: true,
			type: "project_share",
		});
		mount();

		const trigger = button("Review invitation");
		trigger.focus();
		act(() => trigger.click());
		const dialog = document.querySelector('[role="dialog"]');
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		if (!dialog || !textarea) throw new Error("acceptance dialog missing");
		act(() => {
			textarea.value = "project-invite-payload";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => button("Review invitation", dialog).click());

		await vi.waitFor(() =>
			expect(api.inspectCoordinatorInvite).toHaveBeenCalledWith("project-invite-payload"),
		);
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(
				document.getElementById("project-share-invitation-projects"),
			),
		);
		expect(dialog.textContent).toContain("Invitation from Adam");
		expect(dialog.textContent).toContain("direct access only");
		expect(dialog.textContent).toContain("Codemem — 41 existing memories and future activity");
		expect(dialog.textContent).toContain("Viewer — 1 existing memory and future activity");
		expect(dialog.textContent).toContain("does not join a Team");
		expect(dialog.textContent).toContain("No other Projects are included");
		expect(dialog.textContent).not.toContain("Use Advanced Team administration");
		expect(document.querySelector("textarea")).toBeNull();

		const recipientName = dialog.querySelector<HTMLInputElement>("#project-share-recipient-name");
		const deviceName = dialog.querySelector<HTMLInputElement>("#project-share-device-name");
		if (!recipientName || !deviceName) throw new Error("Project identity fields missing");
		expect(recipientName.value).toBe("Brian");
		expect(deviceName.value).toBe("Brian’s Mac");
		act(() => {
			recipientName.value = "Reviewed Brian";
			recipientName.dispatchEvent(new Event("input", { bubbles: true }));
			deviceName.value = "Reviewed Mac";
			deviceName.dispatchEvent(new Event("input", { bubbles: true }));
		});

		const accept = button("Accept Project access", dialog);
		expect(accept.type).toBe("button");
		accept.focus();
		act(() => accept.click());
		await vi.waitFor(() => expect(api.importCoordinatorInvite).toHaveBeenCalledOnce());
		expect(api.importCoordinatorInvite).toHaveBeenCalledWith("project-invite-payload", {
			recipient_name: "Reviewed Brian",
			device_name: "Reviewed Mac",
		});
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(
				document.getElementById("project-share-invitation-result"),
			),
		);
		expect(dialog.textContent).toContain("Project setup is pending");
		expect(dialog.textContent).toContain("owner still needs to finish access setup");
		expect(dialog.textContent).not.toContain("Team invitation accepted");
		expect(document.querySelector('[role="dialog"]')).toBe(dialog);
	});

	it.each([
		["empty names", "project-share-recipient-name", "   ", "Identity display name is required"],
		[
			"names over 120 Unicode code points",
			"project-share-recipient-name",
			"😀".repeat(121),
			"120 characters or fewer",
		],
		[
			"control characters",
			"project-share-device-name",
			"Travel\u0007Laptop",
			"control or format characters",
		],
		[
			"format characters",
			"project-share-device-name",
			"Travel\u200bLaptop",
			"control or format characters",
		],
	])("blocks Project import for %s", async (_label, fieldId, invalidValue, message) => {
		vi.mocked(api.inspectCoordinatorInvite).mockResolvedValue(projectShareInspection);
		mount();
		act(() => button("Review invitation").click());
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		const dialog = document.querySelector('[role="dialog"]');
		if (!textarea || !dialog) throw new Error("acceptance dialog missing");
		act(() => {
			textarea.value = "invalid-project-name";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => button("Review invitation", dialog).click());
		await vi.waitFor(() => expect(dialog.textContent).toContain("Who will receive access"));

		const field = dialog.querySelector<HTMLInputElement>(`#${fieldId}`);
		if (!field) throw new Error(`field missing: ${fieldId}`);
		act(() => {
			field.value = invalidValue;
			field.dispatchEvent(new Event("input", { bubbles: true }));
		});

		expect(field.getAttribute("aria-invalid")).toBe("true");
		expect(dialog.textContent).toContain(message);
		const accept = button("Accept Project access", dialog);
		expect(accept.disabled).toBe(true);
		act(() => accept.click());
		expect(api.importCoordinatorInvite).not.toHaveBeenCalled();
	});

	it.each([
		["missing", undefined],
		["empty", []],
	] as Array<
		[string, typeof projectShareInspection.projects | undefined]
	>)("blocks Project acceptance when the inspected Project list is $0", async (_label, projects) => {
		vi.mocked(api.inspectCoordinatorInvite).mockResolvedValue({
			...projectShareInspection,
			projects,
		});
		mount();
		act(() => button("Review invitation").click());
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		const dialog = document.querySelector('[role="dialog"]');
		if (!textarea || !dialog) throw new Error("acceptance dialog missing");
		act(() => {
			textarea.value = "project-without-details";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => button("Review invitation", dialog).click());

		await vi.waitFor(() =>
			expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
				"Project details are unavailable",
			),
		);
		const accept = button("Accept Project access", dialog);
		expect(accept.disabled).toBe(true);
		act(() => accept.click());
		expect(api.importCoordinatorInvite).not.toHaveBeenCalled();
	});

	it("retries failed Project inspection with the preserved invite text", async () => {
		vi.mocked(api.inspectCoordinatorInvite)
			.mockRejectedValueOnce(new Error("coordinator_unavailable"))
			.mockResolvedValueOnce(projectShareInspection);
		mount();
		act(() => button("Review invitation").click());
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		const dialog = document.querySelector('[role="dialog"]');
		if (!textarea || !dialog) throw new Error("acceptance dialog missing");
		act(() => {
			textarea.value = "preserved-project-invite";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => button("Review invitation", dialog).click());
		await vi.waitFor(() =>
			expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
				"Unable to review this invitation",
			),
		);
		expect(textarea.value).toBe("preserved-project-invite");

		act(() => button("Review invitation", dialog).click());
		await vi.waitFor(() => expect(dialog.textContent).toContain("Exact Projects shared directly"));
		expect(api.inspectCoordinatorInvite).toHaveBeenCalledTimes(2);
		expect(api.inspectCoordinatorInvite).toHaveBeenNthCalledWith(1, "preserved-project-invite");
		expect(api.inspectCoordinatorInvite).toHaveBeenNthCalledWith(2, "preserved-project-invite");
		expect(api.importCoordinatorInvite).not.toHaveBeenCalled();
	});

	it("discards a stale Project inspection after the invitation text changes", async () => {
		let resolveInspection: (
			value: Awaited<ReturnType<typeof api.inspectCoordinatorInvite>>,
		) => void = () => undefined;
		vi.mocked(api.inspectCoordinatorInvite)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					resolveInspection = resolve;
				}),
			)
			.mockResolvedValueOnce({
				...projectShareInspection,
				inviter_name: "Payload B owner",
				projects: [{ display_name: "Current Project B", existing_memory_count: 8 }],
			});
		mount();
		act(() => button("Review invitation").click());
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		const dialog = document.querySelector('[role="dialog"]');
		if (!textarea || !dialog) throw new Error("acceptance dialog missing");
		act(() => {
			textarea.value = "payload-a";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => button("Review invitation", dialog).click());
		await vi.waitFor(() => expect(api.inspectCoordinatorInvite).toHaveBeenCalledWith("payload-a"));

		act(() => {
			textarea.value = "payload-b";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			resolveInspection({
				...projectShareInspection,
				inviter_name: "Stale payload A owner",
				projects: [{ display_name: "Stale Project A", existing_memory_count: 99 }],
			});
			await Promise.resolve();
		});

		expect(textarea.value).toBe("payload-b");
		expect(dialog.textContent).not.toContain("Stale payload A owner");
		expect(dialog.textContent).not.toContain("Stale Project A");
		expect(
			[...dialog.querySelectorAll("button")].some(
				(candidate) => candidate.textContent?.trim() === "Accept Project access",
			),
		).toBe(false);
		expect(api.importCoordinatorInvite).not.toHaveBeenCalled();

		act(() => button("Review invitation", dialog).click());
		await vi.waitFor(() => expect(dialog.textContent).toContain("Current Project B"));
		expect(api.inspectCoordinatorInvite).toHaveBeenNthCalledWith(2, "payload-b");
		expect(button("Accept Project access", dialog).disabled).toBe(false);
		expect(api.importCoordinatorInvite).not.toHaveBeenCalled();
	});

	it("shows restart-required Project setup as pending and restores focus after keyboard close", async () => {
		vi.mocked(api.inspectCoordinatorInvite).mockResolvedValue(projectShareInspection);
		vi.mocked(api.importCoordinatorInvite).mockResolvedValue({
			status: "pending_setup",
			setup_state: "restart_required",
			restart_required: true,
			type: "project_share",
		});
		mount();
		const trigger = button("Review invitation");
		trigger.focus();
		act(() => trigger.click());
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		const dialog = document.querySelector('[role="dialog"]');
		if (!textarea || !dialog) throw new Error("acceptance dialog missing");
		act(() => {
			textarea.value = "restart-project-invite";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => button("Review invitation", dialog).click());
		await vi.waitFor(() => expect(dialog.textContent).toContain("Exact Projects shared directly"));
		act(() => button("Accept Project access", dialog).click());
		await vi.waitFor(() => expect(dialog.textContent).toContain("codemem must be restarted"));
		expect(dialog.textContent).toContain("Access remains pending");
		expect(dialog.textContent).not.toContain("Joined the team");

		const props = dialogSpy.mock.calls.at(-1)?.[0] as {
			onCloseAutoFocus: (event: Event) => void;
			onOpenChange: (open: boolean) => void;
		};
		const event = new Event("focus", { cancelable: true });
		act(() => props.onOpenChange(false));
		props.onCloseAutoFocus(event);
		expect(event.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(trigger);
	});

	it("shows add-device restart guidance when the active Identity could not refresh", async () => {
		vi.mocked(api.inspectCoordinatorInvite).mockResolvedValue({
			kind: "add_device",
			recipient_name: "Owner Identity",
			device_name: "Travel Laptop",
			onboarding: addDevicePreview,
		});
		vi.mocked(api.importCoordinatorInvite).mockResolvedValue({
			status: "accepted",
			type: "recipient_onboarding",
			setup_state: "restart_required",
			restart_required: true,
			detail: "Restart codemem before continuing with the adopted Identity.",
		});
		mount();
		act(() => button("Review invitation").click());
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		const dialog = document.querySelector('[role="dialog"]');
		if (!textarea || !dialog) throw new Error("acceptance dialog missing");
		act(() => {
			textarea.value = "add-device-restart";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => button("Review invitation", dialog).click());
		await vi.waitFor(() => expect(dialog.textContent).toContain("Direct Projects"));
		act(() => button("Accept invitation", dialog).click());

		await vi.waitFor(() =>
			expect(dialog.textContent).toContain(
				"Restart codemem before continuing with the adopted Identity.",
			),
		);
		expect(dialog.textContent).not.toContain("Device added.");
	});

	it("uses safe fallback result copy after reviewing unavailable optional Project identity names", async () => {
		vi.mocked(api.inspectCoordinatorInvite).mockResolvedValue({
			...projectShareInspection,
			recipient_name: undefined,
			device_name: undefined,
		});
		vi.mocked(api.importCoordinatorInvite).mockResolvedValue({
			status: "accepted",
			type: "team_join",
		});
		mount();
		act(() => button("Review invitation").click());
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		const dialog = document.querySelector('[role="dialog"]');
		if (!textarea || !dialog) throw new Error("acceptance dialog missing");
		act(() => {
			textarea.value = "project-without-names";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => button("Review invitation", dialog).click());
		await vi.waitFor(() => expect(dialog.textContent).toContain("Exact Projects shared directly"));
		const recipientName = dialog.querySelector<HTMLInputElement>("#project-share-recipient-name");
		const deviceName = dialog.querySelector<HTMLInputElement>("#project-share-device-name");
		if (!recipientName || !deviceName) throw new Error("Project identity fields missing");
		expect(recipientName.value).toBe("");
		expect(deviceName.value).toBe("");
		expect(button("Accept Project access", dialog).disabled).toBe(true);
		act(() => {
			recipientName.value = "Reviewed recipient";
			recipientName.dispatchEvent(new Event("input", { bubbles: true }));
			deviceName.value = "Reviewed device";
			deviceName.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => button("Accept Project access", dialog).click());

		await vi.waitFor(() => expect(api.importCoordinatorInvite).toHaveBeenCalledOnce());
		expect(api.importCoordinatorInvite).toHaveBeenCalledWith("project-without-names", {
			recipient_name: "Reviewed recipient",
			device_name: "Reviewed device",
		});
		await vi.waitFor(() =>
			expect(dialog.textContent).toContain("Project setup status could not be confirmed"),
		);
		expect(dialog.textContent).not.toContain("Joined the team");
	});

	it("keeps the reviewed Project payload available for retry after an acceptance error", async () => {
		vi.mocked(api.inspectCoordinatorInvite).mockResolvedValue(projectShareInspection);
		vi.mocked(api.importCoordinatorInvite)
			.mockRejectedValueOnce(new Error("Ask the owner for a new invitation, then try again."))
			.mockResolvedValueOnce({
				status: "pending_setup",
				setup_state: "pending_inviter",
				type: "project_share",
			});
		mount();
		act(() => button("Review invitation").click());
		const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
		const dialog = document.querySelector('[role="dialog"]');
		if (!textarea || !dialog) throw new Error("acceptance dialog missing");
		act(() => {
			textarea.value = "retry-project-invite";
			textarea.dispatchEvent(new Event("input", { bubbles: true }));
		});
		act(() => button("Review invitation", dialog).click());
		await vi.waitFor(() => expect(dialog.textContent).toContain("Exact Projects shared directly"));

		act(() => button("Accept Project access", dialog).click());
		await vi.waitFor(() =>
			expect(dialog.querySelector('[role="alert"]')?.textContent).toContain(
				"Ask the owner for a new invitation, then try again.",
			),
		);
		expect(dialog.textContent).toContain("Codemem — 41 existing memories");
		expect(button("Accept Project access", dialog).disabled).toBe(false);
		act(() => button("Accept Project access", dialog).click());
		await vi.waitFor(() => expect(api.importCoordinatorInvite).toHaveBeenCalledTimes(2));
		expect(api.importCoordinatorInvite).toHaveBeenNthCalledWith(2, "retry-project-invite", {
			recipient_name: "Brian",
			device_name: "Brian’s Mac",
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
