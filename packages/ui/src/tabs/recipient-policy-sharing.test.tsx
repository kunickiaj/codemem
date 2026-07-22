import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const openManagement = vi.hoisted(() => vi.fn());

vi.mock("./recipient-policy-management", async (importOriginal) => {
	const original = await importOriginal<typeof import("./recipient-policy-management")>();
	return { ...original, openRecipientPolicyManagement: openManagement };
});

import type { RecipientPolicyIntentGraphV1 } from "../lib/api/sync";
import type { RecipientPolicyManagementProject } from "./recipient-policy-management";
import { mountRecipientPolicySharing } from "./recipient-policy-sharing";

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

function mount(graph = intent(), options: Parameters<typeof mountRecipientPolicySharing>[3] = {}) {
	const element = document.getElementById("mount");
	if (!element) throw new Error("mount missing");
	act(() => mountRecipientPolicySharing(element, projects, graph, options));
}

function tab(label: string): HTMLButtonElement {
	const match = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
		(button) => button.textContent === label,
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

describe("recipient-focused Sharing", () => {
	beforeEach(() => {
		document.body.innerHTML = '<div id="mount"></div>';
	});

	afterEach(() => {
		const element = document.getElementById("mount");
		if (element) act(() => render(null, element));
		openManagement.mockReset();
		document.body.innerHTML = "";
	});

	it("renders all three accessible views and recipient-aware invitation controls", () => {
		mount();
		expect(document.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe(
			"Sharing views",
		);
		expect([...document.querySelectorAll('[role="tab"]')].map((item) => item.textContent)).toEqual([
			"Teams",
			"Identities",
			"Invitations",
		]);
		expect(tab("Teams").getAttribute("aria-controls")).toBe("recipient-policy-sharing-panel-teams");
		expect(tab("Teams").getAttribute("aria-selected")).toBe("true");

		clickTab("Identities");
		expect(visiblePanel().textContent).toContain("Local identity");
		clickTab("Invitations");
		expect(visiblePanel().textContent).toContain("Invite Team member");
		expect(visiblePanel().textContent).toContain("Add a device");
		expect(visiblePanel().textContent).toContain("Share exact Projects");
		expect(visiblePanel().textContent).toContain(
			"Legacy invitation import remains under Advanced Team administration",
		);
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

	it("shows Team members, current devices, shared Projects, and future-member inheritance", () => {
		mount();
		const text = visiblePanel().textContent ?? "";
		expect(text).toContain("ExampleCo");
		expect(text).toContain("2 active members — Adam, Brian");
		expect(text).toContain("2 active registered devices");
		expect(text).toContain("1 active shared Project — Codemem");
		expect(text).toContain("Yes — future Team members inherit the Team’s shared Projects");
		expect(text).not.toContain("Old Team");
	});

	it("separates direct Identity Projects from Projects inherited through active Teams", () => {
		mount();
		clickTab("Identities");
		const adamCard = document.querySelector<HTMLElement>(".recipient-policy-sharing-identity-card");
		if (!adamCard) throw new Error("Adam card missing");
		const text = adamCard.textContent ?? "";
		expect(text).toContain("Local identity");
		expect(text).toContain("1 active registered device — Adam’s Mac");
		expect(text).toContain("1 active Team membership — ExampleCo");
		expect(text).toContain("1 directly shared active Project — API");
		expect(text).toContain("1 Team-inherited Project — Codemem");
		expect(text).toContain("not direct Identity shares");
		expect(text).not.toContain("directly shared active Project — Codemem");
	});

	it("opens exact recipient management requests from both action labels", () => {
		mount();
		for (const button of visiblePanel().querySelectorAll<HTMLButtonElement>("button")) {
			act(() => button.click());
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
		expect(document.body.textContent).toContain(
			"Add projects only adds the selected Projects after you preview the exact changes",
		);
	});

	it("renders loading, error, and empty states with live-region semantics", () => {
		mount(intent(), { loading: true });
		expect(document.querySelector('[role="status"]')?.textContent).toContain(
			"Loading Sharing details",
		);

		mount(intent(), { loadError: true });
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"Sharing details are unavailable",
		);

		mount(
			intent({
				identities: [],
				teams: [],
				teamMemberships: [],
				identityDevices: [],
				projectRecipients: [],
			}),
		);
		expect(visiblePanel().textContent).toContain("No active Teams are available");
		clickTab("Identities");
		expect(visiblePanel().textContent).toContain("No active Identities are available");
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
});
