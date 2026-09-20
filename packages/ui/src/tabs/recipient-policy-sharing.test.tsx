/// <reference types="vite/client" />
import { type ComponentChildren, render } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import html from "../../static/index.html?raw";

const openManagement = vi.hoisted(() => vi.fn());

vi.mock("../components/primitives/radix-dialog", () => ({
	RadixDialog: ({
		ariaDescribedby,
		ariaLabelledby,
		children,
		contentClassName,
		contentId,
		onCloseAutoFocus,
		onOpenAutoFocus,
		open,
	}: {
		ariaDescribedby?: string;
		ariaLabelledby?: string;
		children?: ComponentChildren;
		contentClassName?: string;
		contentId: string;
		onCloseAutoFocus?: (event: { preventDefault: () => void }) => void;
		onOpenAutoFocus?: (event: { preventDefault: () => void }) => void;
		open: boolean;
	}) => {
		const wasOpen = useRef(false);
		useEffect(() => {
			const event = { preventDefault: () => undefined };
			if (open && !wasOpen.current) onOpenAutoFocus?.(event);
			if (!open && wasOpen.current) onCloseAutoFocus?.(event);
			wasOpen.current = open;
		}, [onCloseAutoFocus, onOpenAutoFocus, open]);
		return open ? (
			<div
				aria-describedby={ariaDescribedby}
				aria-labelledby={ariaLabelledby}
				className={contentClassName}
				id={contentId}
				role="dialog"
			>
				{children}
			</div>
		) : null;
	},
}));

vi.mock("./recipient-policy-management", async (importOriginal) => {
	const original = await importOriginal<typeof import("./recipient-policy-management")>();
	return { ...original, openRecipientPolicyManagement: openManagement };
});

import type {
	DeviceIdentityInventoryV1,
	LegacyTeamSetupSummaryResponseV1,
	RecipientPolicyIntentGraphV1,
} from "../lib/api/sync";
import { RecipientPolicyTeamRenameApiError } from "../lib/api/sync";
import type { RecipientPolicyManagementProject } from "./recipient-policy-management";
import { mountRecipientPolicySharing, requestSharingNavigation } from "./recipient-policy-sharing";
import { deriveTeamSyncPrimaryStatus } from "./sync/view-model";

const projects: RecipientPolicyManagementProject[] = [
	{ canonicalProjectIdentity: "project-codemem", displayName: "Codemem", existingMemoryCount: 40 },
	{ canonicalProjectIdentity: "project-api", displayName: "API", existingMemoryCount: 12 },
	{ canonicalProjectIdentity: "project-tools", displayName: "Tools", existingMemoryCount: 7 },
];

function intent(
	overrides: Partial<RecipientPolicyIntentGraphV1> = {},
): RecipientPolicyIntentGraphV1 {
	return {
		version: 1,
		identities: [
			{
				version: 1,
				identityId: "identity-adam",
				displayName: "Adam",
				kind: "personal",
				verification: "local",
				status: "active",
				mergedIntoIdentityId: null,
			},
			{
				version: 1,
				identityId: "identity-brian",
				displayName: "Brian",
				kind: "work",
				verification: "local",
				status: "active",
				mergedIntoIdentityId: null,
			},
		],
		teams: [
			{ version: 1, teamId: "team-example", displayName: "ExampleCo", status: "active" },
			{ version: 1, teamId: "team-old", displayName: "Old Team", status: "archived" },
		],
		teamMemberships: [
			{
				version: 1,
				teamId: "team-example",
				identityId: "identity-adam",
				role: "admin",
				status: "active",
			},
			{
				version: 1,
				teamId: "team-example",
				identityId: "identity-brian",
				role: "member",
				status: "active",
			},
		],
		identityDevices: [
			{
				version: 1,
				identityId: "identity-adam",
				deviceId: "device-adam-1",
				displayName: "Adam’s Mac",
				status: "active",
			},
			{
				version: 1,
				identityId: "identity-adam",
				deviceId: "device-adam-old",
				displayName: "Old Mac",
				status: "revoked",
			},
			{
				version: 1,
				identityId: "identity-brian",
				deviceId: "device-brian-1",
				displayName: "Brian’s PC",
				status: "active",
			},
		],
		projectRecipients: [
			{
				version: 1,
				canonicalProjectIdentity: "project-codemem",
				recipientKind: "team",
				teamId: "team-example",
				intentSource: "user",
				policyRevision: "one",
				status: "active",
			},
			{
				version: 1,
				canonicalProjectIdentity: "project-api",
				recipientKind: "identity",
				identityId: "identity-adam",
				intentSource: "user",
				policyRevision: "two",
				status: "active",
			},
			{
				version: 1,
				canonicalProjectIdentity: "project-tools",
				recipientKind: "identity",
				identityId: "identity-brian",
				intentSource: "user",
				policyRevision: "three",
				status: "active",
			},
			{
				version: 1,
				canonicalProjectIdentity: "project-api",
				recipientKind: "team",
				teamId: "team-example",
				intentSource: "user",
				policyRevision: "four",
				status: "revoked",
			},
		],
		...overrides,
	};
}

function mount(
	graph = intent(),
	options: Parameters<typeof mountRecipientPolicySharing>[3] = {},
	projectInventory = projects,
) {
	const element = document.getElementById("mount");
	if (!element) throw new Error("mount missing");
	act(() => mountRecipientPolicySharing(element, projectInventory, graph, options));
}

function tab(label: string): HTMLButtonElement {
	const match = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) =>
		button.textContent?.startsWith(label),
	);
	if (!match) throw new Error(`tab missing: ${label}`);
	return match;
}

function clickTab(label: string) {
	act(() => tab(label).click());
}

function visiblePanel(): HTMLElement {
	const panel = [...document.querySelectorAll<HTMLElement>('[role="tabpanel"]')].find(
		(item) => !item.hidden,
	);
	if (!panel) throw new Error("visible panel missing");
	return panel;
}

function setupSharingMount(): void {
	document.body.innerHTML = '<div id="mount"></div>';
}

function cleanupSharingMount(): void {
	const element = document.getElementById("mount");
	if (element) act(() => render(null, element));
	openManagement.mockReset();
	document.body.innerHTML = "";
}

function rendersReceivedProjectSources(): void {
	mount(intent(), {
		received: [
			{
				canonicalProjectIdentity: "git:received-api",
				displayName: "Received API",
				existingMemoryCount: 2,
				latestSessionAt: "2026-07-25T12:00:00.000Z",
				originDevices: [
					{ deviceId: "device-a", displayName: "Work Laptop" },
					{ deviceId: "device-b", displayName: "Desk Computer" },
					{ deviceId: "device-c", displayName: null },
					{ deviceId: "device-a", displayName: "Work Laptop" },
				],
			},
			{
				canonicalProjectIdentity: "git:received-tools",
				displayName: "Received Tools",
				existingMemoryCount: 1,
				latestSessionAt: null,
				originDevices: [{ deviceId: "private-device-id", displayName: null }],
			},
			{
				canonicalProjectIdentity: "git:received-private",
				displayName: "Received Private",
				existingMemoryCount: 3,
				latestSessionAt: null,
				originDevices: [
					{ deviceId: "private-device-a", displayName: null },
					{ deviceId: "private-device-b", displayName: null },
				],
			},
			{
				canonicalProjectIdentity: "git:received-legacy",
				displayName: "Received Legacy",
				existingMemoryCount: 1,
				latestSessionAt: null,
				originDevices: [],
			},
		],
	});
	clickTab("From other devices");
	const text = visiblePanel().textContent ?? "";
	expect(text).toContain("Received API");
	expect(text).toContain("Work Laptop · Desk Computer · +1");
	expect(text).toContain("Received Tools");
	expect(text).toContain("1");
	expect(text).toContain("Unknown device");
	expect(text).toContain("2 unknown devices");
	expect(text).not.toContain("0 unknown devices");
	expect(text).not.toContain("device-a");
	expect(text).not.toContain("device-c");
	expect(text).not.toContain("private-device-id");
	expect(text).not.toContain("private-device-a");
	expect(text).not.toContain("private-device-b");
	expect(text).toContain("No recent sessions");
	const search = visiblePanel().querySelector<HTMLInputElement>('input[type="search"]');
	if (!search) throw new Error("received-project search missing");
	act(() => {
		search.value = "tools";
		search.dispatchEvent(new Event("input", { bubbles: true }));
	});
	expect(visiblePanel().textContent).not.toContain("Received API");
	expect(visiblePanel().textContent).toContain("Received Tools");
}

describe("received project sources", () => {
	beforeEach(setupSharingMount);
	afterEach(cleanupSharingMount);
	it(
		"counts distinct unresolved origins without showing raw identifiers",
		rendersReceivedProjectSources,
	);
});

function registerRecipientFocusedSharingLifecycle(): void {
	beforeEach(setupSharingMount);
	afterEach(cleanupSharingMount);
}

function testRecipientFocusedNavigation() {
	registerRecipientFocusedSharingLifecycle();

	it("renders all four accessible views and recipient-aware invitation controls", () => {
		mount();
		expect(document.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe(
			"Sharing views",
		);
		expect([...document.querySelectorAll('[role="tab"]')].map((item) => item.textContent)).toEqual([
			"Teams 1",
			"Identities 2",
			"From other devices 0",
			"Invitations",
		]);
		expect(tab("Teams").getAttribute("aria-controls")).toBe("recipient-policy-sharing-panel-teams");
		expect(tab("Teams").getAttribute("aria-selected")).toBe("true");

		clickTab("Identities");
		expect(visiblePanel().textContent).toContain("Local identity");
		clickTab("From other devices");
		expect(visiblePanel().getAttribute("tabindex")).toBe("0");
		expect(visiblePanel().textContent).toContain("No projects from other devices yet");
		clickTab("Invitations");
		expect(visiblePanel().textContent).toContain("Invite a teammate");
		expect(visiblePanel().textContent).toContain("Add a device");
		expect(visiblePanel().textContent).toContain("Share specific projects");
		expect(visiblePanel().textContent).toContain("Older invite codes →");
	});

	it("selects Teams when the first successfully loaded intent has active Teams", () => {
		mount(intent({ teams: [] }), { loading: true });
		expect(tab("Identities").getAttribute("aria-selected")).toBe("true");

		mount(intent(), { loading: false });
		expect(tab("Teams").getAttribute("aria-selected")).toBe("true");

		clickTab("Identities");
		mount(intent(), { loading: false });
		expect(tab("Identities").getAttribute("aria-selected")).toBe("true");
	});

	it("opens Teams for canonical navigation from Devices", () => {
		mount();
		clickTab("From other devices");

		act(() => {
			window.dispatchEvent(new CustomEvent("codemem:navigate-sharing", { detail: "teams" }));
		});

		expect(tab("Teams").getAttribute("aria-selected")).toBe("true");
	});

	it("keeps a Teams request made before Sharing mounts", () => {
		requestSharingNavigation("teams");
		mount(intent({ teams: [] }));

		expect(tab("Teams").getAttribute("aria-selected")).toBe("true");
	});

	it("keeps a requested Teams tab through the initial loading transition", () => {
		requestSharingNavigation("teams");
		mount(intent({ teams: [] }), { loading: true });
		expect(tab("Teams").getAttribute("aria-selected")).toBe("true");

		mount(intent({ teams: [] }), { loading: false });
		expect(tab("Teams").getAttribute("aria-selected")).toBe("true");
	});
	it("keeps a clicked tab when the first successful load supplies Teams", () => {
		mount(intent({ teams: [] }), { loading: true });
		act(() => document.getElementById("recipient-policy-sharing-tab-invitations")?.click());
		mount(intent(), { loading: false });
		expect(
			document
				.getElementById("recipient-policy-sharing-tab-invitations")
				?.getAttribute("aria-selected"),
		).toBe("true");
	});

	it("discloses when device setup attention cannot be loaded", () => {
		mount(intent(), {
			deviceInventory: {
				version: 1,
				items: [
					{
						version: 1,
						deviceId: "stale-device",
						evidenceDeviceIds: ["stale-device"],
						displayName: "Stale Device",
						state: "setup_required",
						identityId: null,
						suggestedIdentityId: null,
						validatedFingerprint: null,
						isLocal: false,
						sources: ["sync_peer"],
						conflictCodes: [],
					},
				],
				coordinatorEvidence: { availability: "available", safeErrorCode: null },
				truncated: false,
			},
			deviceInventoryUnavailable: true,
		});

		expect(document.querySelector('[role="status"]')?.textContent).toContain(
			"Device Identity information is unavailable",
		);
		expect(document.body.textContent).toContain("Manage projects");
		expect(document.getElementById("sharing-device-setup-heading")).toBeNull();
		expect(document.body.textContent).not.toContain("Identity setup needed");
		expect(document.body.textContent).not.toContain("Review Devices");
	});
}

describe("recipient-focused Sharing navigation", testRecipientFocusedNavigation);

function testRecipientFocusedSetupAndKeyboard() {
	registerRecipientFocusedSharingLifecycle();

	it("counts only the same nonconfigured inventory states that Devices sends to setup", () => {
		const item = (
			deviceId: string,
			state: "configured" | "setup_required" | "pairing_required",
		) => ({
			version: 1 as const,
			deviceId,
			evidenceDeviceIds: [deviceId],
			displayName: deviceId,
			state,
			identityId: state === "configured" ? "identity-adam" : null,
			suggestedIdentityId: null,
			validatedFingerprint: null,
			isLocal: false,
			sources: ["sync_peer" as const],
			conflictCodes: [],
		});
		const onReviewDevices = vi.fn();
		mount(intent(), {
			deviceInventory: {
				version: 1,
				items: [
					item("configured", "configured"),
					item("setup", "setup_required"),
					item("pair", "pairing_required"),
				],
				coordinatorEvidence: { availability: "available", safeErrorCode: null },
				truncated: false,
			},
			onReviewDevices,
		});
		expect(
			document.getElementById("sharing-device-setup-heading")?.parentElement?.textContent,
		).toContain("2 devices need");
		act(() =>
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Review devices",
				) as HTMLButtonElement
			).click(),
		);
		expect(onReviewDevices).toHaveBeenCalledWith("setup");
		act(() => tab("Identities").click());
		const adam = [...visiblePanel().querySelectorAll("article")].find(
			(card) => card.querySelector("h3")?.textContent === "Adam",
		);
		expect(adam?.textContent).toContain("Devices · 2");
		expect(adam?.textContent).toContain("configured");
	});

	it("supports automatic keyboard tab activation, wraparound, Home, End, and focus", () => {
		mount();
		const teams = tab("Teams");
		teams.focus();

		act(() => {
			teams.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }),
			);
		});
		expect(document.activeElement).toBe(tab("Identities"));
		expect(tab("Identities").getAttribute("aria-selected")).toBe("true");

		act(() => {
			tab("Identities").dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "End" }),
			);
		});
		expect(document.activeElement).toBe(tab("Invitations"));

		act(() => {
			tab("Invitations").dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }),
			);
		});
		expect(document.activeElement).toBe(tab("Teams"));

		act(() => {
			tab("Teams").dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowLeft" }),
			);
		});
		expect(document.activeElement).toBe(tab("Invitations"));

		act(() => {
			tab("Invitations").dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Home" }),
			);
		});
		expect(document.activeElement).toBe(tab("Teams"));
	});
}

describe("recipient-focused Sharing setup", testRecipientFocusedSetupAndKeyboard);

describe("Sharing long member names", () => {
	registerRecipientFocusedSharingLifecycle();
	it.each([1, 2, 3])("keeps %i long member names accessible", (count) => {
		const graph = intent();
		const names = Array.from({ length: count }, (_, index) =>
			`Member ${index} ${"Long name ".repeat(30)}`.trim(),
		);
		graph.identities = names.map((displayName, index) => ({
			...graph.identities[0],
			displayName,
			identityId: `identity-${index}`,
		}));
		graph.teamMemberships = graph.identities.map(({ identityId }) => ({
			version: 1,
			teamId: "team-example",
			identityId,
			role: "member",
			status: "active",
		}));
		mount(graph);
		const preview = visiblePanel().querySelector(".sharing-member-preview");
		const disclosure = preview?.closest("details");
		if (count <= 2) {
			expect(disclosure).toBeNull();
			for (const name of names) expect(preview?.textContent).toContain(name);
		} else {
			expect(disclosure?.querySelector("summary")?.textContent).toContain("+1 more");
			for (const name of names) expect(disclosure?.querySelector("p")?.textContent).toContain(name);
		}
		const rules = [...html.matchAll(/([^{}]+)\{([^{}]+)\}/g)];
		const previewRules = rules.filter((rule) => rule[1].includes(".sharing-member-preview"));
		expect(previewRules).toHaveLength(2);
		for (const rule of previewRules) {
			if (!rule[2].includes("line-clamp")) continue;
			expect(rule[1].trim()).toBe(".sharing-member-names .sharing-member-preview");
		}
		expect(
			previewRules.find((rule) => rule[1].trim() === ".sharing-member-preview")?.[2],
		).toContain("overflow-wrap: anywhere");
	});
});

function testRecipientFocusedTeamViews() {
	registerRecipientFocusedSharingLifecycle();
	it("shows Team members, current devices, shared Projects, and future-member inheritance", () => {
		const graph = intent();
		graph.identities = graph.identities.map((identity) => ({
			...identity,
			displayName: identity.identityId === "identity-adam" ? "Adam Rivera" : "Brian Jones",
		}));
		mount(graph);
		const text = visiblePanel().textContent ?? "";
		expect(text).toContain("ExampleCo");
		expect(text).toContain("2Members · Adam Rivera, Brian Jones");
		expect(text).toContain("2Registered devices");
		expect(text).toContain("1Shared projects");
		expect(text).toContain("Auto-shares with new members");
		expect(text).not.toContain("Old Team");
	});

	it("keeps active Team intent visible while Project enforcement needs attention", () => {
		const graph = intent();
		const sharedProject = graph.projectRecipients.find(
			(recipient) => recipient.recipientKind === "team" && recipient.status === "active",
		);
		if (!sharedProject) throw new Error("active Team Project recipient missing");
		mount(graph);
		const sharingText = visiblePanel().textContent ?? "";
		const advancedStatus = deriveTeamSyncPrimaryStatus({
			status: { enabled: true, daemon_state: "ok", daemon_running: true },
			coordinator: {
				configured: true,
				groups: ["ExampleCo"],
				presence_status: "posted",
			},
			reconciliation: {
				items: [
					{
						canonicalProjectIdentity: sharedProject.canonicalProjectIdentity,
						state: "needs_attention",
					},
				],
			},
		});

		expect(sharingText).toContain("2Members · Adam, Brian");
		expect(sharingText).toContain("2Registered devices");
		expect(sharingText).toContain("1Shared projects");
		expect(sharingText).not.toContain("needs review");
		expect(sharingText).not.toContain("Project access");
		expect(advancedStatus).toMatchObject({
			state: "needs-attention",
			meta: "Team: ExampleCo. A Project access reconciliation needs review.",
			nextAction: "Open Sharing, review this Project's access decision, then sync again.",
		});
		expect(advancedStatus.meta).not.toContain(sharedProject.canonicalProjectIdentity);
	});

	it("shows every Team member in the compact member summary", () => {
		const extraIdentities = ["Casey", "Devon"].map((displayName) => ({
			version: 1 as const,
			identityId: `identity-${displayName.toLowerCase()}`,
			displayName,
			kind: "personal" as const,
			verification: "local" as const,
			status: "active" as const,
			mergedIntoIdentityId: null,
		}));
		const graph = intent();
		mount({
			...graph,
			identities: [...graph.identities, ...extraIdentities],
			teamMemberships: [
				...graph.teamMemberships,
				...extraIdentities.map((identity) => ({
					version: 1 as const,
					teamId: "team-example",
					identityId: identity.identityId,
					role: "member" as const,
					status: "active" as const,
				})),
			],
		});

		expect(visiblePanel().textContent).toContain("Adam, Brian, Casey, Devon");
		const disclosure = visiblePanel().querySelector<HTMLDetailsElement>(".sharing-member-names");
		expect(disclosure?.open).toBe(false);
		expect(disclosure?.querySelector("summary")?.textContent).toContain("+2 more");
		expect(disclosure?.querySelector("summary")?.textContent).not.toContain("Devon");
		expect(visiblePanel().querySelector(".recipient-policy-sharing-name-details")).toBeNull();
	});
}

describe("recipient-focused Sharing Team views", testRecipientFocusedTeamViews);

function configuredInventory(
	items: { deviceId: string; identityId: string; evidenceDeviceIds?: string[] }[],
): DeviceIdentityInventoryV1 {
	return {
		version: 1,
		truncated: false,
		coordinatorEvidence: { availability: "available", safeErrorCode: null },
		items: items.map(({ deviceId, identityId, evidenceDeviceIds = [deviceId] }) => ({
			version: 1,
			deviceId,
			identityId,
			evidenceDeviceIds,
			displayName: `Inventory ${deviceId}`,
			state: "configured",
			suggestedIdentityId: null,
			validatedFingerprint: null,
			isLocal: false,
			sources: ["sync_peer"],
			conflictCodes: [],
		})),
	};
}

describe("Sharing merged device summaries", () => {
	registerRecipientFocusedSharingLifecycle();
	it.each(["device-adam-1", "reassigned-alias"])(
		"keeps intent ownership when successful inventory disagrees for %s",
		(deviceId) => {
			mount(intent(), {
				refreshError: false,
				deviceInventoryUnavailable: false,
				deviceInventory: configuredInventory([
					{ deviceId, identityId: "identity-brian", evidenceDeviceIds: ["device-adam-1"] },
				]),
			});
			expect(visiblePanel().textContent).toContain("2Registered devices");
			clickTab("Identities");
			const cards = [...visiblePanel().querySelectorAll(".recipient-policy-sharing-identity-card")];
			expect(cards[0]?.textContent).toContain("Devices · 1Adam’s Mac");
			expect(cards[1]?.textContent).toContain("Devices · 1Brian’s PC");
			expect(visiblePanel().textContent).not.toContain(`Inventory ${deviceId}`);
		},
	);
	it("counts fallback devices once across Team members and duplicate memberships", () => {
		const graph = intent();
		graph.teamMemberships.push({ ...graph.teamMemberships[0] });
		mount(graph, {
			deviceInventory: configuredInventory([
				{ deviceId: "fallback", identityId: "identity-adam", evidenceDeviceIds: ["shared-alias"] },
				{ deviceId: "shared-alias", identityId: "identity-brian" },
			]),
		});
		expect(visiblePanel().textContent).toContain("3Registered devices");
		clickTab("Identities");
		const cards = [...visiblePanel().querySelectorAll(".recipient-policy-sharing-identity-card")];
		expect(cards[0]?.textContent).toContain("Devices · 2");
		expect(cards[0]?.textContent).toContain("Inventory fallback");
		expect(cards[1]?.textContent).toContain("Devices · 1");
		expect(cards[1]?.textContent).not.toContain("Inventory shared-alias");
	});
	it.each(["refreshError", "deviceInventoryUnavailable"])(
		"excludes fallback from both views on %s",
		(error) => {
			mount(intent(), {
				[error]: true,
				deviceInventory: configuredInventory([
					{ deviceId: "fallback", identityId: "identity-adam" },
				]),
			});
			expect(visiblePanel().textContent).toContain("2Registered devices");
			clickTab("Identities");
			expect(visiblePanel().textContent).not.toContain("Inventory fallback");
		},
	);
});

describe("Sharing intent aliases", () => {
	registerRecipientFocusedSharingLifecycle();
	it.each(["identity-adam", "identity-brian"])(
		"collapses same-owner intent aliases without adopting inventory owner %s",
		(identityId) => {
			const graph = intent();
			graph.identityDevices.push({
				...graph.identityDevices[0],
				deviceId: "adam-alias",
				displayName: "Alias laptop",
			});
			mount(graph, {
				deviceInventory: configuredInventory([
					{ deviceId: "canonical", identityId, evidenceDeviceIds: ["device-adam-1", "adam-alias"] },
				]),
			});
			expect(visiblePanel().textContent).toContain("2Registered devices");
			clickTab("Identities");
			const cards = [...visiblePanel().querySelectorAll(".recipient-policy-sharing-identity-card")];
			expect(cards[0]?.textContent).toContain("Devices · 1Adam’s Mac");
			expect(cards[1]?.textContent).toContain("Devices · 1Brian’s PC");
			expect(visiblePanel().textContent).not.toContain("Alias laptop");
			expect(visiblePanel().textContent).not.toContain("Inventory canonical");
		},
	);
	it("retains conflicting intent owners without adding the inventory owner", () => {
		const graph = intent();
		graph.identities.push({
			...graph.identities[0],
			identityId: "identity-casey",
			displayName: "Casey",
		});
		const activeDeviceIds = graph.identityDevices
			.filter((device) => device.status === "active")
			.map((device) => device.deviceId);
		mount(graph, {
			deviceInventory: configuredInventory([
				{ deviceId: "canonical", identityId: "identity-casey", evidenceDeviceIds: activeDeviceIds },
			]),
		});
		expect(visiblePanel().textContent).toContain("2Registered devices");
		clickTab("Identities");
		const cards = [...visiblePanel().querySelectorAll(".recipient-policy-sharing-identity-card")];
		expect(cards[0]?.textContent).toContain("Devices · 1Adam’s Mac");
		expect(cards[1]?.textContent).toContain("Devices · 1Brian’s PC");
		expect(cards[2]?.textContent).toContain("Devices · 0");
		expect(visiblePanel().textContent).not.toContain("Inventory canonical");
	});
});

function testRecipientFocusedIdentityViews() {
	registerRecipientFocusedSharingLifecycle();
	it("does not combine cached intent with fresh reassigned inventory after a required refresh fails", () => {
		const graph = intent();
		mount(graph);
		clickTab("Identities");
		mount(graph, {
			refreshError: true,
			deviceInventoryUnavailable: false,
			deviceInventory: {
				version: 1,
				truncated: false,
				coordinatorEvidence: { availability: "available", safeErrorCode: null },
				items: [
					{
						version: 1,
						deviceId: "device-adam-1",
						evidenceDeviceIds: ["device-adam-1"],
						displayName: "Reassigned laptop",
						state: "configured",
						identityId: "identity-brian",
						suggestedIdentityId: null,
						validatedFingerprint: null,
						isLocal: false,
						sources: ["sync_peer"],
						conflictCodes: [],
					},
				],
			},
		});
		const cards = [...visiblePanel().querySelectorAll(".recipient-policy-sharing-identity-card")];
		expect(cards[0]?.textContent).toContain("Devices · 1Adam’s Mac");
		expect(cards[1]?.textContent).toContain("Devices · 1");
		expect(cards[1]?.textContent).not.toContain("Devices · 2");
		expect(visiblePanel().textContent).not.toContain("Reassigned laptop");
	});
	it("does not add cached configured devices after inventory refresh fails", () => {
		mount(intent({ identityDevices: [] }), {
			deviceInventoryUnavailable: true,
			deviceInventory: {
				version: 1,
				truncated: false,
				coordinatorEvidence: { availability: "available", safeErrorCode: null },
				items: [
					{
						version: 1,
						deviceId: "removed-device",
						evidenceDeviceIds: ["removed-device"],
						displayName: "Removed laptop",
						state: "configured",
						identityId: "identity-adam",
						suggestedIdentityId: null,
						validatedFingerprint: null,
						isLocal: false,
						sources: ["sync_peer"],
						conflictCodes: [],
					},
				],
			},
		});
		act(() => tab("Identities").click());
		expect(visiblePanel().textContent).toContain("Devices · 0");
		expect(visiblePanel().textContent).not.toContain("Removed laptop");
	});

	it("does not infer per-Identity Team access from membership intent", () => {
		mount();
		clickTab("Identities");
		const adamCard = document.querySelector<HTMLElement>(".recipient-policy-sharing-identity-card");
		if (!adamCard) throw new Error("Adam card missing");
		const text = adamCard.textContent ?? "";
		expect(text).toContain("Local identity");
		expect(text).toContain("Devices · 1Adam’s Mac");
		expect(text).toContain("Teams · 1ExampleCo");
		expect(text).toContain("Shared directlyAPI");
		expect(text).not.toContain("Team-inherited Project");
		expect(text).not.toContain("Codemem");
		expect(text).not.toContain("directly shared active Project — Codemem");
	});

	it("groups exact same-label Project identities with a bounded accessible preview", () => {
		const privatePath = "/private/worktrees/codemem";
		const privateRemote = "ssh://git@private.example.test/codemem.git";
		const repeatedProjects: RecipientPolicyManagementProject[] = [
			{ canonicalProjectIdentity: privateRemote, displayName: "Codemem", existingMemoryCount: 2 },
			{ canonicalProjectIdentity: "git:docs", displayName: "Docs", existingMemoryCount: 3 },
			{ canonicalProjectIdentity: privatePath, displayName: "Codemem", existingMemoryCount: 1 },
			{ canonicalProjectIdentity: "git:api", displayName: "API", existingMemoryCount: 4 },
			{ canonicalProjectIdentity: "git:tools", displayName: "Tools", existingMemoryCount: 5 },
		];
		const teamEdges = repeatedProjects.map((project, index) => ({
			version: 1 as const,
			canonicalProjectIdentity: project.canonicalProjectIdentity,
			recipientKind: "team" as const,
			teamId: "team-example",
			intentSource: "user" as const,
			policyRevision: `team-${index}`,
			status: "active" as const,
		}));
		const identityEdges = repeatedProjects.map((project, index) => ({
			version: 1 as const,
			canonicalProjectIdentity: project.canonicalProjectIdentity,
			recipientKind: "identity" as const,
			identityId: "identity-adam",
			intentSource: "user" as const,
			policyRevision: `identity-${index}`,
			status: "active" as const,
		}));

		mount(intent({ projectRecipients: [...teamEdges, ...identityEdges] }), {}, repeatedProjects);

		expect(visiblePanel().textContent).toContain("5Shared projects");
		expect(visiblePanel().querySelectorAll(".tag-chip")).toHaveLength(5);
		clickTab("Identities");
		expect(visiblePanel().textContent).toContain(
			"Shared directlyAPICodemem — duplicate name 1 of 2Codemem — duplicate name 2 of 2DocsTools",
		);
		expect(document.body.outerHTML).not.toContain(privatePath);
		expect(document.body.outerHTML).not.toContain(privateRemote);
	});
}

describe("recipient-focused Sharing Identity views", testRecipientFocusedIdentityViews);

function testRecipientFocusedRecipientActions() {
	registerRecipientFocusedSharingLifecycle();

	it("shows eight shared projects before expanding the remaining chips", () => {
		const manyProjects = Array.from({ length: 10 }, (_, index) => ({
			canonicalProjectIdentity: `project-${index}`,
			displayName: `Project ${index}`,
			existingMemoryCount: index,
		}));
		const projectRecipients = manyProjects.map((project, index) => ({
			version: 1 as const,
			canonicalProjectIdentity: project.canonicalProjectIdentity,
			recipientKind: "team" as const,
			teamId: "team-example",
			intentSource: "user" as const,
			policyRevision: `revision-${index}`,
			status: "active" as const,
		}));
		mount(intent({ projectRecipients }), {}, manyProjects);

		expect(visiblePanel().querySelectorAll(".tag-chip")).toHaveLength(8);
		const more = [...visiblePanel().querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "+2 more",
		);
		more?.focus();
		act(() => more?.click());
		expect(visiblePanel().querySelectorAll(".tag-chip")).toHaveLength(10);
		expect(more?.textContent).toBe("Show fewer");
		expect(document.activeElement).toBe(more);
	});
}

describe("recipient-focused Sharing Identity projects", testRecipientFocusedRecipientActions);

function testRecipientFocusedRecipientActionsAndDialog() {
	registerRecipientFocusedSharingLifecycle();

	it("opens exact recipient management requests from both action labels", () => {
		mount();
		for (const button of visiblePanel().querySelectorAll<HTMLButtonElement>("button")) {
			if (button.textContent !== "Team settings") act(() => button.click());
		}
		clickTab("Identities");
		const adamCard = document.querySelector<HTMLElement>(".recipient-policy-sharing-identity-card");
		if (!adamCard) throw new Error("Adam card missing");
		for (const button of adamCard.querySelectorAll<HTMLButtonElement>("button")) {
			act(() => button.click());
		}

		expect(openManagement.mock.calls).toEqual([
			[
				{
					mode: "recipient-add",
					recipient: { recipientKind: "team", teamId: "team-example" },
				},
			],
			[
				{
					mode: "recipient-manage",
					recipient: { recipientKind: "team", teamId: "team-example" },
				},
			],
			[
				{
					mode: "recipient-add",
					recipient: { recipientKind: "identity", identityId: "identity-adam" },
				},
			],
			[
				{
					mode: "recipient-manage",
					recipient: { recipientKind: "identity", identityId: "identity-adam" },
				},
			],
		]);
		expect(document.body.textContent).not.toContain("Add projects only adds");
	});

	it("opens a narrow focused Team settings dialog with the current name and restores focus", async () => {
		const renameTeam = vi.fn().mockResolvedValue({
			version: 1,
			teamId: "team-example",
			displayName: "Renamed Team",
			revision: "revision-two",
			linkedCoordinatorGroupRenamed: false,
		});
		const onTeamRenamed = vi.fn();
		mount(intent(), { onTeamRenamed, renameTeam });
		const trigger = [...visiblePanel().querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Team settings",
		);
		if (!trigger) throw new Error("Team settings trigger missing");

		act(() => trigger.click());
		const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
		const input = document.getElementById(
			"recipient-policy-team-settings-name",
		) as HTMLInputElement;
		expect(dialog?.classList.contains("recipient-policy-team-settings-dialog")).toBe(true);
		expect(dialog?.getAttribute("aria-labelledby")).toBe("recipient-policy-team-settings-title");
		expect(input.value).toBe("ExampleCo");
		await vi.waitFor(() => expect(document.activeElement).toBe(input));

		act(() => {
			input.value = "Renamed Team";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const save = [...(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
			(button) => button.textContent === "Save",
		);
		await act(async () => save?.click());
		expect(renameTeam).toHaveBeenCalledWith({
			teamId: "team-example",
			displayName: "Renamed Team",
			expectedDisplayName: "ExampleCo",
		});
		expect(onTeamRenamed).toHaveBeenCalledOnce();
		await vi.waitFor(() =>
			expect(document.querySelector('[role="status"]')?.textContent).toContain(
				"Team renamed to Renamed Team",
			),
		);
		const done = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Done",
		);
		await vi.waitFor(() => expect(document.activeElement).toBe(done));
		act(() => done?.click());
		await vi.waitFor(() => expect(document.activeElement).toBe(trigger));
	});
}

describe(
	"recipient-focused Sharing recipient actions",
	testRecipientFocusedRecipientActionsAndDialog,
);

function testRecipientFocusedTeamValidation() {
	registerRecipientFocusedSharingLifecycle();

	it("validates Team names before save without exposing identifiers", () => {
		const renameTeam = vi.fn();
		mount(intent(), { renameTeam });
		const trigger = [...visiblePanel().querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Team settings",
		);
		act(() => trigger?.click());
		const input = document.getElementById(
			"recipient-policy-team-settings-name",
		) as HTMLInputElement;
		act(() => {
			input.value = "actor:machine";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Save",
		);
		act(() => save?.click());

		expect(renameTeam).not.toHaveBeenCalled();
		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"Enter a human-readable Team name.",
		);
		expect(document.body.textContent).not.toContain("team-example");
	});

	it("keeps coordinator failure visible and retries the same explicit rename", async () => {
		const renameTeam = vi
			.fn()
			.mockRejectedValueOnce(
				new RecipientPolicyTeamRenameApiError(503, "team_coordinator_rename_failed"),
			)
			.mockResolvedValueOnce({
				version: 1,
				teamId: "team-example",
				displayName: "Retry Team",
				revision: "revision-two",
				linkedCoordinatorGroupRenamed: true,
			});
		mount(intent(), { renameTeam });
		const trigger = [...visiblePanel().querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Team settings",
		);
		act(() => trigger?.click());
		const input = document.getElementById(
			"recipient-policy-team-settings-name",
		) as HTMLInputElement;
		act(() => {
			input.value = "Retry Team";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const click = async (label: string) => {
			const target = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === label,
			);
			await act(async () => target?.click());
		};

		await click("Save");
		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"The connected Team service could not be updated. Nothing changed locally. Try again.",
		);
		expect(document.body.textContent).not.toContain("team_coordinator_rename_failed");
		await click("Try again");
		expect(renameTeam).toHaveBeenCalledTimes(2);
		expect(document.body.textContent).toContain("Team renamed to Retry Team");
	});

	it("shows a bounded fail-closed message for ambiguous connected Team history", async () => {
		const renameTeam = vi
			.fn()
			.mockRejectedValue(new RecipientPolicyTeamRenameApiError(409, "team_link_ambiguous"));
		mount(intent(), { renameTeam });
		const trigger = [...visiblePanel().querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Team settings",
		);
		act(() => trigger?.click());
		const input = document.getElementById(
			"recipient-policy-team-settings-name",
		) as HTMLInputElement;
		act(() => {
			input.value = "Ambiguous Team";
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const save = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Save",
		);

		await act(async () => save?.click());

		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"This Team has conflicting connected setup records. Nothing was changed. Review the Team setup before retrying.",
		);
		expect(document.body.textContent).not.toContain("team_link_ambiguous");
	});
}

describe("recipient-focused Sharing Team validation", testRecipientFocusedTeamValidation);

function testRecipientFocusedStates() {
	registerRecipientFocusedSharingLifecycle();

	it("renders loading, error, and empty states with live-region semantics", () => {
		mount(intent(), { loading: true });
		const loading = visiblePanel().querySelector<HTMLElement>('[role="status"]');
		const skeleton = visiblePanel().querySelector<HTMLElement>(".loading-card-list");
		expect(loading?.textContent).toBe("Loading Sharing details");
		expect(loading?.hasAttribute("aria-busy")).toBe(false);
		expect(
			[...document.querySelectorAll('[role="status"]')].filter(
				(status) => status.textContent === "Loading Sharing details",
			),
		).toHaveLength(1);
		expect(skeleton?.getAttribute("aria-busy")).toBe("true");
		expect(skeleton?.querySelectorAll(".loading-card")).toHaveLength(2);
		expect(skeleton?.querySelector(".loading-card")?.getAttribute("aria-hidden")).toBe("true");

		mount(intent(), { loadError: true });
		expect(document.querySelector(".loading-card-list")).toBeNull();
		const alerts = document.querySelectorAll<HTMLElement>('[role="alert"]');
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.textContent).toContain("Sharing details are unavailable");
		expect(visiblePanel().contains(alerts[0] ?? null)).toBe(true);

		mount(
			intent({
				identities: [],
				teams: [],
				teamMemberships: [],
				identityDevices: [],
				projectRecipients: [],
			}),
		);
		expect(tab("Identities").getAttribute("aria-selected")).toBe("true");
		expect(visiblePanel().textContent).toContain("No active Identities are available");
		clickTab("Teams");
		expect(visiblePanel().textContent).toContain("No active Teams are available");
	});

	it("keeps loaded Sharing cards visible during a failed background refresh", () => {
		mount(intent(), { refreshError: true });

		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"Refresh failed; showing previous Sharing details. Team and Identity Project changes are disabled until a refresh succeeds.",
		);
		expect(visiblePanel().textContent).toContain("ExampleCo");
		expect(document.querySelector(".loading-card-list")).toBeNull();
		const mutationButtons = visiblePanel().querySelectorAll<HTMLButtonElement>(
			".recipient-policy-sharing-card-actions button",
		);
		expect(mutationButtons).toHaveLength(3);
		for (const button of mutationButtons) {
			expect(button.disabled).toBe(false);
			expect(button.getAttribute("aria-disabled")).toBe("true");
			button.click();
		}
		expect(openManagement).not.toHaveBeenCalled();
		expect(document.getElementById("recipientPolicyTeamSettingsDialog")).toBeNull();
		const manage = [...mutationButtons].find((button) => button.textContent === "Manage projects");
		expect(manage?.hasAttribute("aria-describedby")).toBe(false);
		expect(visiblePanel().getAttribute("tabindex")).toBe("0");
	});
}

describe("recipient-focused Sharing states", testRecipientFocusedStates);

function testRecipientFocusedAttention() {
	registerRecipientFocusedSharingLifecycle();

	it("surfaces device setup attention without implying access and links to Devices", () => {
		const onReviewDevices = vi.fn();
		mount(intent(), {
			deviceInventory: {
				version: 1,
				items: [
					{
						version: 1,
						deviceId: "device-setup",
						evidenceDeviceIds: ["device-setup"],
						displayName: "Home Laptop",
						state: "setup_required",
						identityId: null,
						suggestedIdentityId: "identity-adam",
						validatedFingerprint: null,
						isLocal: false,
						sources: ["sync_peer"],
						conflictCodes: [],
					},
				],
				coordinatorEvidence: { availability: "available", safeErrorCode: null },
				truncated: false,
			},
			onReviewDevices,
		});

		const attention = document.querySelector<HTMLElement>(".recipient-policy-sharing-attention");
		expect(attention?.getAttribute("aria-labelledby")).toBe("sharing-device-setup-heading");
		expect(attention?.textContent).toContain("1 device needs setup");
		expect(attention?.textContent).toContain("before ownership can be shown");
		const reviewButton = attention?.querySelector<HTMLButtonElement>("button");
		expect(reviewButton).toBeDefined();
		act(() => reviewButton?.click());
		expect(onReviewDevices).toHaveBeenCalledWith("device-setup");
	});

	it("surfaces a safe coordinator reconciliation count without converting groups to Teams", () => {
		const onReviewDevices = vi.fn();
		mount(intent(), { coordinatorEnrollmentIssueCount: 2, onReviewDevices });

		const attention = document.querySelector<HTMLElement>(
			'[aria-labelledby="sharing-coordinator-reconciliation-heading"]',
		);
		expect(attention?.textContent).toContain("2 coordinator enrollments need device review");
		expect(attention?.textContent).not.toMatch(/fingerprint|group[_ -]?id|coordinator[_ -]?id/i);
		const reviewButton = attention?.querySelector<HTMLButtonElement>("button");
		expect(reviewButton).toBeDefined();
		act(() => reviewButton?.click());
		expect(onReviewDevices).toHaveBeenCalledOnce();
	});
}

describe("recipient-focused Sharing attention", testRecipientFocusedAttention);

function testRecipientFocusedMigration() {
	registerRecipientFocusedSharingLifecycle();

	it("renders migration-specific statuses and opens the selected opaque candidate", () => {
		const onOpenTeamSetup = vi.fn();
		mount(intent(), {
			onOpenTeamSetup,
			teamSetupUnavailable: true,
			teamSetupSummary: {
				version: 1,
				candidates: [
					{
						candidateRef: "candidate-needs",
						displayName: "Needs Team",
						status: "stale",
						deviceCount: 8,
						projectCount: 2,
						unresolvedDeviceCount: 0,
						unresolvedProjectCount: 0,
					},
					{
						candidateRef: "candidate-progress",
						displayName: "Progress Team",
						status: "in_progress",
						deviceCount: 0,
						projectCount: 0,
						unresolvedDeviceCount: 0,
						unresolvedProjectCount: 0,
					},
				],
			},
		});

		const overview = document.querySelector<HTMLElement>(
			'[aria-labelledby="sharing-team-setup-heading"]',
		);
		expect(overview?.querySelector("h3")?.textContent).toBe("Legacy groups to migrate");
		expect(overview?.textContent).toContain(
			"Review current devices before migrating Team membership or project access.",
		);
		expect(document.body.textContent).toContain(
			"Team setup status is temporarily unavailable. The previous Team setup status is being shown.",
		);
		expect(overview?.textContent).toContain(
			"Needs Team · 8 devices, 2 Projects — Migration review needs update",
		);
		expect(overview?.textContent).toContain(
			"Progress Team · 0 devices, 0 Projects — Migration in progress",
		);
		expect(overview?.textContent).not.toContain("Ready Team");
		expect(overview?.textContent).not.toContain("5 unresolved");
		expect(
			[...document.querySelectorAll<HTMLElement>(".project-status-badge")].map((badge) => [
				badge.textContent,
				badge.className,
			]),
		).toEqual([
			["Migration review needs update", "project-status-badge needs_attention"],
			["Migration in progress", "project-status-badge suggested"],
		]);
		const buttons = overview?.querySelectorAll<HTMLButtonElement>("button") ?? [];
		expect(buttons).toHaveLength(2);
		expect([...buttons].map((button) => button.getAttribute("aria-label"))).toEqual([
			"Review and migrate Needs Team: 8 devices, 2 Projects",
			"Review and migrate Progress Team: 0 devices, 0 Projects",
		]);
		expect([...buttons].map((button) => button.textContent)).toEqual([
			"Review and migrate",
			"Review and migrate",
		]);
		act(() => buttons[1]?.click());
		expect(onOpenTeamSetup).toHaveBeenCalledWith("candidate-progress");
	});
}

describe("recipient-focused Sharing migration", testRecipientFocusedMigration);

function testRecipientFocusedMigrationGroups() {
	registerRecipientFocusedSharingLifecycle();

	it("groups duplicate Team labels into compact rows with unique safe setup actions", () => {
		// Arrange
		const onOpenTeamSetup = vi.fn();
		mount(intent(), {
			onOpenTeamSetup,
			teamSetupSummary: {
				version: 1,
				candidates: (
					[
						{
							candidateRef: "opaque-candidate-one",
							displayName: "Legacy Team",
							status: "needs_setup",
							deviceCount: 2,
							projectCount: 3,
							unresolvedDeviceCount: 1,
							unresolvedProjectCount: 0,
						},
						{
							candidateRef: "opaque-candidate-two",
							displayName: "Legacy Team",
							status: "in_progress",
							deviceCount: 4,
							projectCount: 5,
							unresolvedDeviceCount: 0,
							unresolvedProjectCount: 1,
						},
					] satisfies LegacyTeamSetupSummaryResponseV1["candidates"]
				).reverse(),
			},
		});

		// Act
		const duplicateGroup = document.querySelector<HTMLElement>(
			".recipient-policy-sharing-team-setup-group",
		);
		expect(
			document.querySelector(".recipient-policy-sharing-team-setup-list")?.getAttribute("role"),
		).toBe("list");
		expect(duplicateGroup?.getAttribute("role")).toBe("listitem");
		const rows = [
			...(duplicateGroup?.querySelectorAll<HTMLElement>(
				".recipient-policy-sharing-team-setup-row",
			) ?? []),
		];
		const buttons = rows.flatMap((row) => [...row.querySelectorAll<HTMLButtonElement>("button")]);

		// Assert
		expect(duplicateGroup?.textContent).toContain("Legacy Team");
		expect(duplicateGroup?.textContent).toContain("2 Teams");
		expect(duplicateGroup?.textContent).toContain("2 devices, 3 Projects");
		expect(duplicateGroup?.textContent).toContain("4 devices, 5 Projects");
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.querySelector(".recipient-policy-sharing-team-setup-status")).not.toBeNull();
			expect(row.querySelector(".recipient-policy-sharing-team-setup-action")).not.toBeNull();
		}
		expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
			"Review and migrate Legacy Team 1 of 2: 2 devices, 3 Projects",
			"Review and migrate Legacy Team 2 of 2: 4 devices, 5 Projects",
		]);
		expect(new Set(buttons.map((button) => button.getAttribute("aria-label"))).size).toBe(2);
		expect(duplicateGroup?.textContent).not.toMatch(/opaque-candidate|coordinator|group[_ -]?id/i);

		act(() => buttons[1]?.click());
		expect(onOpenTeamSetup).toHaveBeenCalledWith("opaque-candidate-two");
	});

	it("shows Team setup unavailability without inventing candidates on first load", () => {
		mount(intent(), { teamSetupUnavailable: true });

		const status = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find(
			(item) => item.textContent === "Team setup status is temporarily unavailable.",
		);
		expect(status?.getAttribute("aria-live")).toBe("polite");
		expect(document.getElementById("sharing-team-setup-heading")).toBeNull();
		expect(document.querySelector(".project-status-badge")).toBeNull();
	});

	it("keeps cached Team setup visible without a transient refresh banner", () => {
		mount(intent(), {
			teamSetupLoading: true,
			teamSetupSummary: { version: 1, candidates: [] },
		});

		expect(document.body.textContent).not.toContain("Team setup status is being refreshed");
		expect(document.body.textContent).not.toContain("previous Team setup status");
	});
}

describe("recipient-focused Sharing migration groups", testRecipientFocusedMigrationGroups);

function testRecipientFocusedMigrationFallbacks() {
	registerRecipientFocusedSharingLifecycle();

	it("labels first-load Team setup discovery as loading without claiming stale status", () => {
		mount(intent(), { teamSetupLoading: true });

		const status = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find(
			(item) => item.textContent === "Team setup status is loading.",
		);
		expect(status?.getAttribute("aria-live")).toBe("polite");
		expect(document.body.textContent).not.toContain("previous Team setup status");
	});

	it("fails an unknown runtime Team setup status closed to migration review", () => {
		const teamSetupSummary = {
			version: 1,
			candidates: [
				{
					candidateRef: "candidate-future",
					displayName: "Future Team",
					status: "future_status",
					deviceCount: 1,
					projectCount: 1,
					unresolvedDeviceCount: 0,
					unresolvedProjectCount: 0,
				},
			],
		} as unknown as LegacyTeamSetupSummaryResponseV1;

		mount(intent(), { teamSetupSummary });

		const badge = document.querySelector<HTMLElement>(".project-status-badge");
		expect(badge?.textContent).toBe("Ready to review");
		expect(badge?.className).toBe("project-status-badge needs_attention");
		expect(document.getElementById("sharing-team-setup-heading")?.textContent).toBe(
			"Legacy groups to migrate",
		);
	});
}

describe("recipient-focused Sharing migration fallbacks", testRecipientFocusedMigrationFallbacks);

function testRecipientFocusedMigrationSurface() {
	registerRecipientFocusedSharingLifecycle();

	it("offers six current SRE devices for review without implying canonical Team access", () => {
		const onOpenTeamSetup = vi.fn();
		mount(intent({ teams: [], teamMemberships: [] }), {
			onOpenTeamSetup,
			teamSetupSummary: {
				version: 1,
				candidates: [
					{
						candidateRef: "opaque-scope-backed-candidate",
						displayName: "SRE",
						status: "needs_setup",
						deviceCount: 6,
						projectCount: 1,
						unresolvedDeviceCount: 6,
						unresolvedProjectCount: 0,
					},
				],
			},
		});

		const overview = document.querySelector<HTMLElement>(
			'[aria-labelledby="sharing-team-setup-heading"]',
		);
		const action = overview?.querySelector<HTMLButtonElement>("button");
		expect(overview?.textContent).toContain("Legacy groups to migrate");
		expect(overview?.textContent).toContain("SRE");
		expect(overview?.textContent).toContain("6 devices, 1 Project");
		expect(overview?.textContent).toContain("Ready to review");
		expect(action?.textContent).toBe("Review and migrate");
		expect(action?.getAttribute("aria-label")).toBe("Review and migrate SRE: 6 devices, 1 Project");
		expect(document.body.textContent).toContain(
			"No active Teams are available for Project sharing",
		);
		expect(document.body.outerHTML).not.toMatch(
			/opaque-scope-backed-candidate|coordinator[_ -]?id/i,
		);

		act(() => action?.click());
		expect(onOpenTeamSetup).toHaveBeenCalledWith("opaque-scope-backed-candidate");
	});

	it("hides migration work when the pending summary is empty", () => {
		mount(intent(), {
			teamSetupSummary: {
				version: 1,
				candidates: [],
			},
		});

		expect(document.getElementById("sharing-team-setup-heading")).toBeNull();
		expect(document.body.textContent).not.toContain("Current devices are proposed for review");
	});

	it("uses visible labels, responsive and target hooks, and no prohibited internal copy", () => {
		mount();
		expect(document.querySelector("h2")?.textContent).toBe("Sharing");
		expect(document.querySelectorAll(".recipient-policy-sharing-target-24").length).toBeGreaterThan(
			3,
		);
		expect(document.querySelector(".recipient-policy-sharing-responsive-grid")).not.toBeNull();
		expect(document.querySelector(".recipient-policy-sharing-responsive-tabs")).not.toBeNull();
		expect(document.body.textContent).not.toMatch(
			/\b(scope|grant|actor|peer|filter|epoch|cursor)\b/i,
		);
	});
}

describe("recipient-focused Sharing migration surface", testRecipientFocusedMigrationSurface);
