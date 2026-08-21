import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DeviceIdentityBindingPreviewV1,
	DeviceIdentityInventoryV1,
	RecipientPolicyIntentGraphV1,
	RecipientPolicyReconciliationStatusV1,
} from "../lib/api/sync";
import { DeviceIdentityBindingApiError } from "../lib/api/sync";
import { state } from "../lib/state";
import { deviceIdentitySetupError, mountDevices, projectDevices } from "./devices";

const projects = [
	{ canonicalProjectIdentity: "project-direct-filter-id", displayName: "API" },
	{ canonicalProjectIdentity: "project-team-grant-id", displayName: "Codemem" },
];

function intent(
	overrides: Partial<RecipientPolicyIntentGraphV1> = {},
): RecipientPolicyIntentGraphV1 {
	return {
		version: 1,
		identities: [
			{
				version: 1,
				identityId: "identity-scope-secret",
				displayName: "Adam & Co",
				kind: "personal",
				verification: "local",
				status: "active",
				mergedIntoIdentityId: null,
			},
		],
		teams: [
			{
				version: 1,
				teamId: "team-epoch-secret",
				displayName: "Platform Team",
				status: "active",
			},
		],
		teamMemberships: [
			{
				version: 1,
				teamId: "team-epoch-secret",
				identityId: "identity-scope-secret",
				role: "member",
				status: "active",
			},
		],
		identityDevices: [
			{
				version: 1,
				identityId: "identity-scope-secret",
				deviceId: "device-address-fingerprint-secret",
				displayName: "Work Laptop",
				status: "active",
			},
			{
				version: 1,
				identityId: "identity-scope-secret",
				deviceId: "revoked-cursor-secret",
				displayName: "Old Laptop",
				status: "revoked",
			},
		],
		projectRecipients: [
			{
				version: 1,
				canonicalProjectIdentity: "project-direct-filter-id",
				recipientKind: "identity",
				identityId: "identity-scope-secret",
				intentSource: "user",
				policyRevision: "revision-secret",
				status: "active",
			},
			{
				version: 1,
				canonicalProjectIdentity: "project-team-grant-id",
				recipientKind: "team",
				teamId: "team-epoch-secret",
				intentSource: "user",
				policyRevision: "revision-secret",
				status: "active",
			},
		],
		...overrides,
	};
}

function inventory(items: DeviceIdentityInventoryV1["items"]): DeviceIdentityInventoryV1 {
	return {
		version: 1,
		items,
		coordinatorEvidence: { availability: "available", safeErrorCode: null },
		truncated: false,
	};
}

function inventoryItem(
	deviceId: string,
	displayName: string,
	state: DeviceIdentityInventoryV1["items"][number]["state"],
	overrides: Partial<DeviceIdentityInventoryV1["items"][number]> = {},
): DeviceIdentityInventoryV1["items"][number] {
	return {
		version: 1,
		deviceId,
		evidenceDeviceIds: [deviceId],
		displayName,
		state,
		identityId: state === "configured" ? "identity-scope-secret" : null,
		suggestedIdentityId: null,
		validatedFingerprint: null,
		isLocal: false,
		sources: state === "pairing_required" ? ["coordinator_enrollment"] : ["sync_peer"],
		conflictCodes: state === "conflicted" ? ["binding_conflict"] : [],
		...overrides,
	};
}

function reconciliation(
	overrides: Partial<RecipientPolicyReconciliationStatusV1> = {},
): RecipientPolicyReconciliationStatusV1 {
	return {
		version: 1,
		items: [
			{
				canonicalProjectIdentity: "project-direct-filter-id",
				state: "active",
				label: "Up to date",
				explanation: "Future activity is ready for this device.",
				deliveredCopiesMayRemain: true,
				revocationWarning: "Raw scope grant warning must not render.",
			},
			{
				canonicalProjectIdentity: "project-team-grant-id",
				state: "needs_attention",
				label: "Needs attention",
				explanation: "Current access remains in place until it is safe to retry.",
				deliveredCopiesMayRemain: true,
				revocationWarning: "Raw fingerprint warning must not render.",
			},
		],
		...overrides,
	};
}

function mount(
	graph = intent(),
	status = reconciliation(),
	options: Parameters<typeof mountDevices>[5] = {},
) {
	const element = document.getElementById("mount");
	if (!element) throw new Error("mount missing");
	act(() =>
		mountDevices(
			element,
			graph,
			status,
			projects,
			[{ deviceId: "device-address-fingerprint-secret", state: "available" }],
			options,
		),
	);
}

function deviceCard(name: string): HTMLElement {
	const match = [...document.querySelectorAll<HTMLElement>("article")].find(
		(article) => article.querySelector("h3")?.textContent?.replace(" (this device)", "") === name,
	);
	if (!match) throw new Error(`device card missing: ${name}`);
	return match;
}

function cardCheckbox(card: HTMLElement, label: string): HTMLInputElement {
	const match = [...card.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
		(input) => input.parentElement?.textContent?.includes(label),
	);
	if (!match) throw new Error(`checkbox missing: ${label}`);
	return match;
}

function setCheckbox(input: HTMLInputElement, checked = true): void {
	input.checked = checked;
	act(() => {
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("read-only Devices", () => {
	beforeEach(() => {
		document.body.innerHTML = '<div id="mount"></div>';
		state.pendingDeviceIdentityFocus = undefined;
	});

	afterEach(() => {
		const element = document.getElementById("mount");
		if (element) act(() => render(null, element));
		document.body.innerHTML = "";
		state.pendingDeviceIdentityFocus = undefined;
	});

	it("focuses a requested setup card only after inventory content renders", () => {
		state.pendingDeviceIdentityFocus = "setup-device";
		mount(intent(), reconciliation(), { loading: true });
		expect(state.pendingDeviceIdentityFocus).toBe("setup-device");

		mount(intent(), reconciliation(), {
			inventory: inventory([inventoryItem("setup-device", "Setup device", "setup_required")]),
		});

		expect(document.activeElement).toBe(
			document.getElementById("device-identity-card-setup-device"),
		);
		expect(state.pendingDeviceIdentityFocus).toBeUndefined();
	});

	it("does not render conflicted binding evidence as a configured device", () => {
		state.pendingDeviceIdentityFocus = "device-address-fingerprint-secret";
		mount(intent(), reconciliation(), {
			inventory: inventory([
				inventoryItem("conflicted-alias", "Work Laptop", "conflicted", {
					evidenceDeviceIds: ["conflicted-alias", "device-address-fingerprint-secret"],
				}),
			]),
		});

		const matchingCards = [...document.querySelectorAll<HTMLElement>("article")].filter(
			(card) => card.querySelector("h3")?.textContent === "Work Laptop",
		);
		expect(matchingCards).toHaveLength(1);
		expect(matchingCards[0].textContent).toContain("Review required");
		expect(matchingCards[0].textContent).not.toContain("Configured");
		expect(document.activeElement).toBe(matchingCards[0]);
		expect(state.pendingDeviceIdentityFocus).toBeUndefined();
	});

	it("retains requested setup focus through degraded inventory and applies it after recovery", () => {
		state.pendingDeviceIdentityFocus = "setup-device";
		mount(intent(), reconciliation(), { inventoryUnavailable: true });
		expect(state.pendingDeviceIdentityFocus).toBe("setup-device");

		mount(intent(), reconciliation(), {
			inventory: inventory([inventoryItem("setup-device", "Setup device", "setup_required")]),
		});
		expect(document.activeElement).toBe(
			document.getElementById("device-identity-card-setup-device"),
		);
		expect(state.pendingDeviceIdentityFocus).toBeUndefined();
	});

	it("does not claim there are no configured devices when a fallback card is visible", () => {
		mount(intent({ identityDevices: [] }), reconciliation(), {
			inventory: inventory([
				inventoryItem("configured-fallback", "Configured fallback", "configured"),
			]),
		});

		expect(document.body.textContent).toContain("Configured fallback");
		expect(document.body.textContent).toContain("No additional active devices are registered.");
		expect(document.body.textContent).not.toContain("No configured devices are registered.");
	});

	it("surfaces safe coordinator reconciliation attention without inferring ownership", () => {
		mount(intent(), reconciliation(), {
			coordinatorEnrollmentIssueCount: 1,
			inventory: inventory([]),
		});

		const attention = document.querySelector<HTMLElement>(
			'[aria-labelledby="devices-coordinator-reconciliation-heading"]',
		);
		expect(attention?.textContent).toContain(
			"1 coordinator enrollment could not be safely reconciled",
		);
		expect(attention?.textContent).toContain("No ownership was inferred");
		expect(attention?.textContent).toContain("No device on this page can be corrected from here");
		expect(attention?.textContent).not.toContain("Advanced diagnostics");
		expect(attention?.textContent).not.toMatch(/fingerprint|group[_ -]?id|coordinator[_ -]?id/i);
	});

	it("keeps coordinator reconciliation attention visible when inventory is unavailable", () => {
		mount(intent(), reconciliation(), {
			coordinatorEnrollmentIssueCount: 1,
			inventoryUnavailable: true,
		});

		const attention = document.querySelector<HTMLElement>(
			'[aria-labelledby="devices-coordinator-reconciliation-heading"]',
		);
		expect(attention?.textContent).toContain(
			"1 coordinator enrollment could not be safely reconciled",
		);
		expect(attention?.textContent).toContain("No ownership was inferred");
	});

	it("points coordinator reconciliation attention at rendered setup recovery", () => {
		mount(intent(), reconciliation(), {
			coordinatorEnrollmentIssueCount: 1,
			inventory: inventory([inventoryItem("setup-device", "Setup device", "setup_required")]),
		});

		const attention = document.querySelector<HTMLElement>(
			'[aria-labelledby="devices-coordinator-reconciliation-heading"]',
		);
		expect(attention?.textContent).toContain(
			"Review the affected device setup or pairing state here",
		);
	});

	it("focuses a projected configured-device card from its canonical inventory ID", () => {
		state.pendingDeviceIdentityFocus = "canonical-alias";
		mount(intent(), reconciliation(), {
			inventory: inventory([
				inventoryItem("canonical-alias", "Work Laptop", "configured", {
					evidenceDeviceIds: ["canonical-alias", "device-address-fingerprint-secret"],
				}),
			]),
		});

		expect(document.activeElement).toBe(
			document.getElementById("device-identity-card-device-address-fingerprint-secret"),
		);
		expect(state.pendingDeviceIdentityFocus).toBeUndefined();
	});

	it("does not apply delayed setup focus after the user moves focus within Devices", () => {
		const needsAttention = reconciliation({
			items: reconciliation().items.map((item) =>
				item.canonicalProjectIdentity === "project-direct-filter-id"
					? { ...item, state: "needs_attention", label: "Needs attention" }
					: item,
			),
		});
		mount(intent(), needsAttention, { inventoryUnavailable: true, onNavigate: vi.fn() });
		const action = document.querySelector<HTMLButtonElement>(
			'button[aria-label="Review sharing for Work Laptop"]',
		);
		if (!action) throw new Error("Devices action missing");
		action.focus();
		state.pendingDeviceIdentityFocus = "setup-device";

		mount(intent(), needsAttention, {
			inventory: inventory([inventoryItem("setup-device", "Setup device", "setup_required")]),
			onNavigate: vi.fn(),
		});

		expect(document.activeElement).not.toBe(
			document.getElementById("device-identity-card-setup-device"),
		);
		expect(state.pendingDeviceIdentityFocus).toBeUndefined();
	});

	it("retains requested device focus while a refresh is showing stale inventory", () => {
		state.pendingDeviceIdentityFocus = "new-device";

		mount(intent(), reconciliation(), {
			inventory: inventory([]),
			refreshError: true,
		});

		expect(state.pendingDeviceIdentityFocus).toBe("new-device");
	});

	it("projects direct access without inferring per-device Team access from membership intent", () => {
		const graph = intent();
		const before = JSON.stringify(graph);

		const result = projectDevices(graph, reconciliation(), projects, [
			{ deviceId: "device-address-fingerprint-secret", state: "available" },
		]);

		expect(result.devices).toHaveLength(1);
		expect(result.revokedDeviceCount).toBe(1);
		expect(result.devices[0]).toMatchObject({
			displayName: "Work Laptop",
			identityName: "Adam & Co",
			availabilityLabel: "Available",
			statusState: "active",
			action: null,
		});
		expect(result.devices[0]?.directProjects.map((project) => project.displayName)).toEqual([
			"API",
		]);
		expect(result.devices[0]?.inheritedProjects).toEqual([]);
		expect(JSON.stringify(graph)).toBe(before);
	});

	it("does not suggest per-device access through Team membership intent", () => {
		const graph = intent({
			projectRecipients: intent().projectRecipients.filter(
				(recipient) => recipient.recipientKind === "team",
			),
		});

		const result = projectDevices(graph, reconciliation(), projects, [
			{ deviceId: "device-address-fingerprint-secret", state: "available" },
		]);

		expect(result.devices[0]).toMatchObject({
			statusLabel: "No directly shared Projects",
			statusCopy: "Team access is not shown here without authoritative per-device eligibility.",
			action: null,
		});
	});

	it("preserves the health action for unavailable devices with Team membership intent", () => {
		const graph = intent({
			projectRecipients: intent().projectRecipients.filter(
				(recipient) => recipient.recipientKind === "team",
			),
		});

		const result = projectDevices(graph, reconciliation(), projects, [
			{ deviceId: "device-address-fingerprint-secret", state: "offline" },
		]);

		expect(result.devices[0]?.action).toEqual({
			label: "Check device health",
			target: "health",
		});
	});

	it("presents paired-peer runtime metadata without changing device behavior", () => {
		const baseline = projectDevices(
			intent(),
			reconciliation(),
			projects,
			[{ deviceId: "device-address-fingerprint-secret", state: "available" }],
			[
				{
					deviceId: "device-address-fingerprint-secret",
					runtimeVersion: null,
					runtimeVersionObservedAt: null,
				},
			],
		);
		const withVersion = projectDevices(
			intent(),
			reconciliation(),
			projects,
			[{ deviceId: "device-address-fingerprint-secret", state: "available" }],
			[
				{
					deviceId: "device-address-fingerprint-secret",
					runtimeVersion: "0.42.0",
					runtimeVersionObservedAt: "2026-08-11T12:00:00.000Z",
				},
			],
		);
		const withChangedVersion = projectDevices(
			intent(),
			reconciliation(),
			projects,
			[{ deviceId: "device-address-fingerprint-secret", state: "available" }],
			[
				{
					deviceId: "device-address-fingerprint-secret",
					runtimeVersion: "0.43.1",
					runtimeVersionObservedAt: "2026-08-11T13:00:00.000Z",
				},
			],
		);
		const withoutRuntimeMetadata = (projection: (typeof baseline.devices)[number]) => {
			const { reportedRuntimeVersion, runtimeVersionObservedAt, ...deviceBehavior } = projection;
			void reportedRuntimeVersion;
			void runtimeVersionObservedAt;
			return deviceBehavior;
		};

		expect(withVersion.devices[0]).toMatchObject({
			deviceId: "device-address-fingerprint-secret",
			displayName: "Work Laptop",
			identityName: "Adam & Co",
			availability: "available",
			statusState: "active",
			action: null,
			reportedRuntimeVersion: "0.42.0",
			runtimeVersionObservedAt: "2026-08-11T12:00:00.000Z",
		});
		expect(withoutRuntimeMetadata(withVersion.devices[0])).toEqual(
			withoutRuntimeMetadata(baseline.devices[0]),
		);
		expect(withoutRuntimeMetadata(withChangedVersion.devices[0])).toEqual(
			withoutRuntimeMetadata(baseline.devices[0]),
		);
	});

	it("renders a reported Codemem version and falls back for legacy peers", () => {
		mount(intent(), reconciliation(), {
			peerRuntimeMetadata: [
				{
					deviceId: "device-address-fingerprint-secret",
					runtimeVersion: "0.42.0",
					runtimeVersionObservedAt: "2026-08-11T12:00:00.000Z",
				},
			],
		});

		const versionRow = [...document.querySelectorAll("dl > div")].find(
			(row) => row.querySelector("dt")?.textContent === "Codemem version",
		);
		expect(versionRow?.querySelector("dd")?.textContent).toBe("0.42.0");

		mount(intent(), reconciliation(), {
			peerRuntimeMetadata: [
				{
					deviceId: "device-address-fingerprint-secret",
					runtimeVersion: null,
					runtimeVersionObservedAt: null,
				},
			],
		});
		const fallbackRow = [...document.querySelectorAll("dl > div")].find(
			(row) => row.querySelector("dt")?.textContent === "Codemem version",
		);
		expect(fallbackRow?.querySelector("dd")?.textContent).toBe("Not reported");
	});

	it("excludes devices owned by pending or merged Identities", () => {
		const graph = intent({
			identities: [
				intent().identities[0],
				{
					...intent().identities[0],
					identityId: "identity-pending-secret",
					displayName: "Pending Identity",
					status: "pending",
				},
				{
					...intent().identities[0],
					identityId: "identity-merged-secret",
					displayName: "Merged Identity",
					status: "merged",
					mergedIntoIdentityId: "identity-scope-secret",
				},
				{
					...intent().identities[0],
					identityId: "identity-malformed-merged-secret",
					displayName: "Malformed Merged Identity",
					mergedIntoIdentityId: "identity-scope-secret",
				},
			],
			identityDevices: [
				...intent().identityDevices,
				{
					version: 1,
					identityId: "identity-pending-secret",
					deviceId: "device-pending-secret",
					displayName: "Pending Laptop",
					status: "active",
				},
				{
					version: 1,
					identityId: "identity-merged-secret",
					deviceId: "device-merged-secret",
					displayName: "Merged Laptop",
					status: "active",
				},
				{
					version: 1,
					identityId: "identity-malformed-merged-secret",
					deviceId: "device-malformed-merged-secret",
					displayName: "Malformed Merged Laptop",
					status: "active",
				},
			],
		});

		const result = projectDevices(graph, reconciliation(), projects, []);

		expect(result.devices.map((device) => device.displayName)).toEqual(["Work Laptop"]);
		expect(result.revokedDeviceCount).toBe(1);
	});

	it("renders friendly semantic cards, safe copy, and revoked summary", () => {
		const onNavigate = vi.fn();
		mount(intent(), reconciliation(), { onNavigate });

		const devicesSection = document.querySelector("#mount > section");
		const article = document.querySelector("article");
		if (!devicesSection || !article) throw new Error("Devices surface missing");
		expect(devicesSection.getAttribute("aria-labelledby")).toBe("devices-heading");
		expect(devicesSection.querySelector(":scope > header")).toBeNull();
		expect(devicesSection.querySelector(":scope > .recipient-policy-sharing-header")?.tagName).toBe(
			"DIV",
		);
		expect(document.querySelector("h2")?.textContent).toBe("Devices");
		expect(article.querySelector("h3")?.textContent).toBe("Work Laptop");
		expect(article.textContent).toContain("Owning IdentityAdam & Co");
		expect(article.textContent).toContain("Direct Projects");
		expect(article.textContent).toContain("API — Up to date");
		expect(article.textContent).toContain(
			"Per-device Team access is not shown because Team membership alone does not prove this device receives the Team’s Projects.",
		);
		expect(article.textContent).toContain("Changing access stops future delivery");
		expect(article.querySelectorAll("button")).toHaveLength(0);
		expect(onNavigate).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain("1 revoked device is not included");
	});

	it("renders loading, error, and active-device empty states with live-region semantics", () => {
		mount(intent(), reconciliation(), { loading: true });
		const loading = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find(
			(status) => status.textContent === "Loading Devices",
		);
		const skeleton = document.querySelector<HTMLElement>(".loading-card-list");
		expect(loading?.textContent).toBe("Loading Devices");
		expect(loading?.hasAttribute("aria-busy")).toBe(false);
		expect(skeleton?.getAttribute("aria-busy")).toBe("true");
		expect(skeleton?.querySelectorAll(".loading-card")).toHaveLength(2);
		expect(skeleton?.querySelector(".loading-card")?.getAttribute("aria-hidden")).toBe("true");

		mount(intent(), reconciliation(), { loadError: true });
		expect(document.querySelector(".loading-card-list")).toBeNull();
		expect(document.querySelector('[role="alert"]')?.textContent).toContain(
			"Devices are unavailable",
		);

		mount(
			intent({
				identityDevices: [
					{
						version: 1,
						identityId: "identity-scope-secret",
						deviceId: "revoked-cursor-secret",
						displayName: "Old Laptop",
						status: "revoked",
					},
				],
			}),
		);
		expect(document.querySelector('[role="status"]')?.textContent).toContain(
			"No active devices are registered. 1 revoked device is not shown.",
		);
		expect(document.body.textContent).not.toContain("Old Laptop");
	});

	it("keeps stale cards visible while announcing a post-load refresh failure", () => {
		mount(intent(), reconciliation(), {
			onNavigate: vi.fn(),
			refreshError: true,
		});

		expect(document.querySelector("article h3")?.textContent).toBe("Work Laptop");
		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"Refresh failed; showing previous device information. Identity setup is disabled until a refresh succeeds.",
		);
	});

	it("disables Identity mutations while showing stale cards after a refresh failure", () => {
		mount(intent(), reconciliation(), {
			inventory: inventory([
				inventoryItem("device-address-fingerprint-secret", "Work Laptop", "configured"),
			]),
			refreshError: true,
		});

		expect(document.querySelector("article h3")?.textContent).toBe("Work Laptop");
		expect(
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "Change Identity…",
			)?.disabled,
		).toBe(true);
	});

	it("gives repeated actions unique device-specific accessible names", () => {
		mount(
			intent({
				identityDevices: [
					intent().identityDevices[0],
					{
						version: 1,
						identityId: "identity-scope-secret",
						deviceId: "second-device-secret",
						displayName: 'Home <Laptop> & "Dock"',
						status: "active",
					},
				],
			}),
			reconciliation({
				items: reconciliation().items.map((item) =>
					item.canonicalProjectIdentity === "project-direct-filter-id"
						? {
								...item,
								state: "needs_attention",
								label: "Needs attention",
								explanation: "Current access remains in place until it is safe to retry.",
							}
						: item,
				),
			}),
			{ onNavigate: vi.fn() },
		);

		const actions = [...document.querySelectorAll<HTMLButtonElement>("article button")];
		expect(actions.map((action) => action.textContent)).toEqual([
			"Review sharing",
			"Review sharing",
		]);
		expect(actions.map((action) => action.getAttribute("aria-label"))).toEqual([
			'Review sharing for Home <Laptop> & "Dock"',
			"Review sharing for Work Laptop",
		]);
		expect(document.querySelector("article script")).toBeNull();
	});

	it("escapes friendly names and never renders internal identifiers or unsafe warning text", () => {
		mount(
			intent({
				identities: [
					{
						...intent().identities[0],
						displayName: '<img src=x onerror="alert(1)"> & Identity',
					},
				],
				identityDevices: [
					{
						...intent().identityDevices[0],
						displayName: "<script>unsafe()</script>",
					},
				],
			}),
		);

		expect(document.querySelector("article img")).toBeNull();
		expect(document.querySelector("article script")).toBeNull();
		expect(document.querySelector("article h3")?.textContent).toBe("<script>unsafe()</script>");
		expect(document.body.textContent).toContain('<img src=x onerror="alert(1)"> & Identity');
		expect(document.body.textContent).not.toMatch(
			/identity-scope-secret|device-address-fingerprint-secret|project-direct-filter-id|revision-secret/i,
		);
		expect(document.body.textContent).not.toMatch(
			/\b(scope|grant|address|fingerprint|filter|epoch|cursor)\b/i,
		);
	});

	it("uses explicit missing availability and hides actions when no navigation callback exists", () => {
		const element = document.getElementById("mount");
		if (!element) throw new Error("mount missing");
		act(() => mountDevices(element, intent(), reconciliation(), projects, []));

		const article = document.querySelector("article");
		expect(article?.textContent).toContain("Availability unknown");
		expect(article?.querySelector("button")).toBeNull();
	});

	it("renders every authoritative inventory state with truthful gated next steps", () => {
		const onNavigate = vi.fn();
		mount(intent(), reconciliation(), {
			inventory: inventory([
				inventoryItem("device-address-fingerprint-secret", "Work Laptop", "configured"),
				inventoryItem("setup-device", "Home Laptop", "setup_required"),
				inventoryItem("pair-device", "Tablet", "pairing_required"),
				inventoryItem("conflict-device", "Server", "conflicted"),
			]),
			onNavigate,
		});

		const text = document.body.textContent ?? "";
		expect(text).toContain("Configured · Available");
		expect(text).toContain("Setup required");
		expect(text).toContain("Pair this device first");
		expect(text).toContain("Device evidence conflicts");
		expect(document.querySelectorAll(".device-identity-setup-card select")).toHaveLength(1);
		for (const label of ["Review this device", "Go to pairing", "Open Advanced review"]) {
			const action = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === label,
			);
			expect(action?.parentElement?.classList.contains("device-identity-card-actions")).toBe(true);
			expect(action?.closest(".device-identity-setup-card")).not.toBeNull();
		}
		expect(document.querySelectorAll(".device-identity-setup-card > fieldset button")).toHaveLength(
			0,
		);
		expect(deviceCard("Home Laptop").querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
		expect(
			deviceCard("Home Laptop")
				.querySelector<HTMLSelectElement>("select")
				?.getAttribute("aria-label"),
		).toBe("Choose an Identity for Home Laptop");
		expect(text).not.toContain("Confirm Home Laptop belongs");
		expect([...document.querySelectorAll("button")].map((button) => button.textContent)).toContain(
			"Go to pairing",
		);
		act(() =>
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Go to pairing",
				) as HTMLButtonElement
			).click(),
		);
		expect(onNavigate).toHaveBeenCalledWith("advanced_sync");
		act(() =>
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Open Advanced review",
				) as HTMLButtonElement
			).click(),
		);
		expect(onNavigate).toHaveBeenNthCalledWith(2, "advanced_sync");
		expect(text).not.toContain("Confirm Tablet belongs");
	});

	it("routes missing-Identity recovery to Identity administration", () => {
		const onNavigate = vi.fn();
		mount(intent({ identities: [] }), reconciliation(), {
			inventory: inventory([inventoryItem("setup-device", "Home Laptop", "setup_required")]),
			onNavigate,
		});

		act(() =>
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Open Identity administration",
				) as HTMLButtonElement
			).click(),
		);

		expect(onNavigate).toHaveBeenCalledWith("advanced_sync");
	});

	it("reviews exactly the selected devices without per-device confirmation", async () => {
		const previewBindings = vi.fn().mockResolvedValue({
			version: 1,
			status: "ready",
			reviewedInventoryDigest: "digest",
			errorCode: null,
			outcomes: [
				{
					deviceId: "one",
					displayName: "One",
					targetIdentityId: "identity-scope-secret",
					previousIdentityId: null,
					action: "bind",
					isLocal: false,
				},
				{
					deviceId: "two",
					displayName: "Two",
					targetIdentityId: "identity-scope-secret",
					previousIdentityId: null,
					action: "bind",
					isLocal: false,
				},
			],
			writeCount: 2,
		});
		mount(intent(), reconciliation(), {
			inventory: inventory([
				inventoryItem("one", "One", "setup_required", {
					suggestedIdentityId: "identity-scope-secret",
				}),
				inventoryItem("two", "Two", "setup_required", {
					suggestedIdentityId: "identity-scope-secret",
				}),
				inventoryItem("three", "Three", "setup_required", {
					suggestedIdentityId: "identity-scope-secret",
				}),
			]),
			previewBindings,
		});
		const setupCards = [...document.querySelectorAll<HTMLElement>(".device-identity-setup-card")];
		expect(setupCards).toHaveLength(3);
		for (const [index, card] of setupCards.entries()) {
			const name = ["One", "Two", "Three"][index];
			expect(card.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
			expect(card.textContent).toContain("Select for setup");
			expect(card.textContent).not.toContain("Confirm ");
			expect(
				card.querySelector<HTMLInputElement>('input[type="checkbox"]')?.getAttribute("aria-label"),
			).toBe(`Select for setup: ${name}`);
			expect(card.querySelector<HTMLSelectElement>("select")?.getAttribute("aria-label")).toBe(
				`Choose an Identity for ${name}`,
			);
		}
		const selected = setupCards.slice(0, 2).map((card) => cardCheckbox(card, "Select for setup"));
		for (const input of selected) {
			setCheckbox(input);
		}
		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
					button.textContent?.startsWith("Review 2 selected"),
				) as HTMLButtonElement
			).click();
		});
		expect(previewBindings).toHaveBeenCalledWith({
			bindings: [
				{ deviceId: "one", targetIdentityId: "identity-scope-secret", confirmed: true },
				{ deviceId: "two", targetIdentityId: "identity-scope-secret", confirmed: true },
			],
		});
		expect(document.body.textContent).toContain("Review Identity setup");
		expect(document.body.textContent).toContain("I reviewed every device and target Identity");
		expect(
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "Apply setup to 2 devices",
			),
		).toBeTruthy();
	});

	it("blocks bulk review when a selected device has no Identity", async () => {
		const previewBindings = vi.fn();
		mount(intent(), reconciliation(), {
			inventory: inventory([
				inventoryItem("one", "One", "setup_required", {
					suggestedIdentityId: "identity-scope-secret",
				}),
				inventoryItem("two", "Two", "setup_required", {
					suggestedIdentityId: "identity-scope-secret",
				}),
			]),
			previewBindings,
		});
		setCheckbox(cardCheckbox(deviceCard("One"), "Select for setup"));
		setCheckbox(cardCheckbox(deviceCard("Two"), "Select for setup"));
		const secondIdentity = deviceCard("Two").querySelector<HTMLSelectElement>("select");
		if (!secondIdentity) throw new Error("Identity select missing");
		secondIdentity.value = "";
		act(() => {
			secondIdentity.dispatchEvent(new Event("input", { bubbles: true }));
		});

		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Review 2 selected",
				) as HTMLButtonElement
			).click();
		});

		expect(document.querySelector('[role="alert"]')?.textContent).toBe(
			"Choose an Identity for every selected device before review.",
		);
		expect(previewBindings).not.toHaveBeenCalled();
	});

	it("does not guess an Identity or allow review for a local device without a target", () => {
		mount(intent(), reconciliation(), {
			inventory: inventory([inventoryItem("local", "Local", "setup_required", { isLocal: true })]),
		});
		const select = document.querySelector<HTMLSelectElement>(".device-identity-setup-card select");
		expect(select?.value).toBe("");
		expect(select?.getAttribute("aria-label")).toBe("Choose an Identity for Local");
		expect(deviceCard("Local").querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
		expect(
			[...deviceCard("Local").querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "Review this device",
			)?.disabled,
		).toBe(true);
	});

	it("blocks incomplete and unavailable remote inventory but permits local-only setup when unconfigured", () => {
		const local = inventoryItem("local", "Local", "setup_required", {
			isLocal: true,
			suggestedIdentityId: "identity-scope-secret",
		});
		mount(intent(), reconciliation(), {
			inventory: { ...inventory([local]), truncated: true },
		});
		expect(
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "Review this device",
			)?.disabled,
		).toBe(true);
		mount(intent(), reconciliation(), {
			inventory: {
				...inventory([
					inventoryItem("device-address-fingerprint-secret", "Work Laptop", "configured"),
				]),
				truncated: true,
			},
		});
		expect(
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "Change Identity…",
			)?.disabled,
		).toBe(true);

		mount(intent(), reconciliation(), {
			inventory: {
				...inventory([local]),
				coordinatorEvidence: {
					availability: "unavailable",
					safeErrorCode: "coordinator_not_configured",
				},
			},
		});
		expect(
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "Review this device",
			)?.disabled,
		).toBe(false);

		mount(intent(), reconciliation(), {
			inventory: {
				...inventory([{ ...local, isLocal: false }]),
				coordinatorEvidence: {
					availability: "unavailable",
					safeErrorCode: "coordinator_not_configured",
				},
			},
		});
		expect(
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "Review this device",
			)?.disabled,
		).toBe(true);
	});

	it("preserves setup review state but disables every write control during inventory degradation", async () => {
		const graph = intent({
			identities: [
				...intent().identities,
				{ ...intent().identities[0], identityId: "identity-target", displayName: "Brian" },
			],
		});
		const setupInventory = inventory([
			inventoryItem("one", "One", "setup_required", {
				suggestedIdentityId: "identity-target",
			}),
			inventoryItem("two", "Two", "setup_required", {
				suggestedIdentityId: "identity-target",
			}),
		]);
		const previewBindings = vi.fn().mockResolvedValue({
			version: 1,
			status: "ready",
			reviewedInventoryDigest: "digest",
			errorCode: null,
			outcomes: [
				{
					deviceId: "one",
					displayName: "One",
					targetIdentityId: "identity-target",
					previousIdentityId: null,
					action: "bind",
					isLocal: false,
				},
			],
			writeCount: 1,
		});
		const commitBindings = vi.fn();
		mount(graph, reconciliation(), { inventory: setupInventory, previewBindings, commitBindings });
		const firstSelection = cardCheckbox(deviceCard("One"), "Select for setup");
		setCheckbox(firstSelection);
		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Review this device" && !button.disabled,
				) as HTMLButtonElement
			).click();
		});
		expect(document.body.textContent).toContain("Review Identity setup");

		mount(graph, reconciliation(), {
			inventory: setupInventory,
			inventoryUnavailable: true,
			previewBindings,
			commitBindings,
		});

		expect(firstSelection.checked).toBe(true);
		expect(document.body.textContent).toContain("Review Identity setup");
		for (const control of document.querySelectorAll<
			HTMLButtonElement | HTMLInputElement | HTMLSelectElement
		>(
			".device-identity-setup-summary button, .device-identity-setup-card input, .device-identity-setup-card select, .device-identity-setup-card button, .device-identity-review-panel input, .device-identity-review-panel .sync-dialog-confirm",
		)) {
			expect(control.disabled).toBe(true);
		}
		expect(previewBindings).toHaveBeenCalledOnce();
		expect(commitBindings).not.toHaveBeenCalled();

		mount(graph, reconciliation(), { inventory: setupInventory, previewBindings, commitBindings });
		expect(firstSelection.checked).toBe(true);
		expect(document.body.textContent).toContain("Review Identity setup");
		expect(
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "Review this device",
			)?.disabled,
		).toBe(false);
	});

	it("preserves a preview across a device rename but reconciles removed Identities", async () => {
		const graph = intent({
			identities: [
				...intent().identities,
				{ ...intent().identities[0], identityId: "identity-target", displayName: "Brian" },
			],
		});
		const item = inventoryItem("one", "One", "setup_required", {
			suggestedIdentityId: "identity-target",
		});
		const previewBindings = vi.fn().mockResolvedValue({
			version: 1,
			status: "ready",
			reviewedInventoryDigest: "digest",
			errorCode: null,
			outcomes: [
				{
					deviceId: "one",
					displayName: "One",
					targetIdentityId: "identity-target",
					previousIdentityId: null,
					action: "bind",
					isLocal: false,
				},
			],
			writeCount: 1,
		});
		mount(graph, reconciliation(), { inventory: inventory([item]), previewBindings });
		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Review this device",
				) as HTMLButtonElement
			).click();
		});
		expect(document.body.textContent).toContain("Review Identity setup");

		mount(graph, reconciliation(), {
			inventory: inventory([{ ...item, displayName: "One updated" }]),
			previewBindings,
		});
		expect(document.body.textContent).toContain("Review Identity setup");
		mount(intent(), reconciliation(), { inventory: inventory([item]), previewBindings });
		expect(
			document.querySelector<HTMLSelectElement>(".device-identity-setup-card select")?.value,
		).toBe("");
	});

	it("preserves valid explicit choices while adding newly discovered setup devices", () => {
		const graph = intent({
			identities: [
				...intent().identities,
				{ ...intent().identities[0], identityId: "identity-target", displayName: "Brian" },
			],
		});
		const first = inventoryItem("one", "One", "setup_required", {
			suggestedIdentityId: "identity-target",
		});
		mount(graph, reconciliation(), { inventory: inventory([first]) });
		const firstSelect = document.querySelector<HTMLSelectElement>(
			".device-identity-setup-card select",
		);
		if (!firstSelect) throw new Error("first select missing");
		firstSelect.value = "identity-scope-secret";
		act(() => {
			firstSelect.dispatchEvent(new Event("input", { bubbles: true }));
		});

		mount(graph, reconciliation(), {
			inventory: inventory([
				first,
				inventoryItem("two", "Two", "setup_required", {
					suggestedIdentityId: "identity-target",
				}),
			]),
		});
		expect(
			[...document.querySelectorAll<HTMLSelectElement>(".device-identity-setup-card select")].map(
				(select) => select.value,
			),
		).toEqual(["identity-scope-secret", "identity-target"]);
	});

	it("clears selection when a setup-required device becomes conflicted and prevents preview", () => {
		const setupItems = ["One", "Two", "Three"].map((name) =>
			inventoryItem(name.toLowerCase(), name, "setup_required", {
				suggestedIdentityId: "identity-scope-secret",
			}),
		);
		const previewBindings = vi.fn();
		mount(intent(), reconciliation(), { inventory: inventory(setupItems), previewBindings });
		setCheckbox(cardCheckbox(deviceCard("One"), "Select for setup"));
		expect(document.body.textContent).toContain("Review 1 selected");

		mount(intent(), reconciliation(), {
			inventory: inventory([{ ...setupItems[0], state: "conflicted" }, ...setupItems.slice(1)]),
			previewBindings,
		});
		const batchReview = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
			button.textContent?.startsWith("Review 0 selected"),
		);
		expect(batchReview?.disabled).toBe(true);
		expect(deviceCard("One").querySelector('input[type="checkbox"]')).toBeNull();
		batchReview?.click();
		expect(previewBindings).not.toHaveBeenCalled();
	});

	it("retains an explicit target but clears selection when its evidence changes", () => {
		const graph = intent({
			identities: [
				...intent().identities,
				{ ...intent().identities[0], identityId: "identity-target", displayName: "Brian" },
			],
		});
		const item = inventoryItem("one", "One", "setup_required", {
			suggestedIdentityId: "identity-target",
			validatedFingerprint: "fingerprint-one",
		});
		mount(graph, reconciliation(), {
			inventory: inventory([
				item,
				inventoryItem("two", "Two", "setup_required", {
					suggestedIdentityId: "identity-target",
				}),
			]),
		});
		const card = deviceCard("One");
		const select = card.querySelector<HTMLSelectElement>("select");
		if (!select) throw new Error("Identity select missing");
		select.value = "identity-scope-secret";
		act(() => {
			select.dispatchEvent(new Event("input", { bubbles: true }));
		});
		setCheckbox(cardCheckbox(card, "Select for setup"));

		mount(graph, reconciliation(), {
			inventory: inventory([
				{
					...item,
					validatedFingerprint: "fingerprint-two",
					evidenceDeviceIds: ["one", "one-alias"],
				},
				inventoryItem("two", "Two", "setup_required", {
					suggestedIdentityId: "identity-target",
				}),
			]),
		});
		const updatedCard = deviceCard("One");
		expect(updatedCard.querySelector<HTMLSelectElement>("select")?.value).toBe(
			"identity-scope-secret",
		);
		expect(updatedCard.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
		expect(cardCheckbox(updatedCard, "Select for setup").checked).toBe(false);
		expect(document.body.textContent).toContain("Review 0 selected");
	});

	it("preserves selection for an unchanged active target when unrelated evidence changes", () => {
		const one = inventoryItem("one", "One", "setup_required", {
			suggestedIdentityId: "identity-scope-secret",
			validatedFingerprint: "one-fingerprint",
		});
		const two = inventoryItem("two", "Two", "setup_required", {
			suggestedIdentityId: "identity-scope-secret",
			validatedFingerprint: "two-fingerprint",
		});
		mount(intent(), reconciliation(), { inventory: inventory([one, two]) });
		setCheckbox(cardCheckbox(deviceCard("One"), "Select for setup"));

		mount(intent(), reconciliation(), {
			inventory: inventory([one, { ...two, validatedFingerprint: "two-fingerprint-updated" }]),
		});
		expect(deviceCard("One").querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
		expect(deviceCard("One").querySelector<HTMLSelectElement>("select")?.value).toBe(
			"identity-scope-secret",
		);
		expect(cardCheckbox(deviceCard("One"), "Select for setup").checked).toBe(true);
		expect(document.body.textContent).toContain("Review 1 selected");
	});

	it("commits only the per-device B1 request when other setup devices are selected", async () => {
		const items = ["One", "Two", "Three"].map((name) =>
			inventoryItem(name.toLowerCase(), name, "setup_required", {
				suggestedIdentityId: "identity-scope-secret",
			}),
		);
		const previewBindings = vi.fn().mockResolvedValue({
			version: 1,
			status: "ready",
			reviewedInventoryDigest: "third-only-digest",
			errorCode: null,
			outcomes: [
				{
					deviceId: "three",
					displayName: "Three",
					targetIdentityId: "identity-scope-secret",
					previousIdentityId: null,
					action: "bind",
					isLocal: false,
				},
			],
			writeCount: 1,
		});
		const commitBindings = vi.fn().mockResolvedValue({ version: 1, status: "applied" });
		mount(intent(), reconciliation(), {
			inventory: inventory(items),
			previewBindings,
			commitBindings,
		});
		for (const name of ["One", "Two", "Three"]) {
			setCheckbox(cardCheckbox(deviceCard(name), "Select for setup"));
		}
		expect(document.body.textContent).toContain("Review 3 selected");
		await act(async () => {
			(
				[...deviceCard("Three").querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Review this device",
				) as HTMLButtonElement
			).click();
		});
		expect(previewBindings).toHaveBeenCalledWith({
			bindings: [{ deviceId: "three", targetIdentityId: "identity-scope-secret", confirmed: true }],
		});
		expect(
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "Apply setup to 1 device",
			),
		).toBeTruthy();
		setCheckbox(
			[...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
				input.parentElement?.textContent?.includes("I reviewed every device"),
			) as HTMLInputElement,
		);
		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Apply setup to 1 device",
				) as HTMLButtonElement
			).click();
		});
		expect(commitBindings).toHaveBeenCalledWith({
			bindings: [{ deviceId: "three", targetIdentityId: "identity-scope-secret", confirmed: true }],
			reviewedInventoryDigest: "third-only-digest",
		});
		expect(commitBindings.mock.calls[0]?.[0].bindings[0]).not.toHaveProperty("allowRebind");
	});

	it.each([
		["missing outcome", []],
		[
			"rebind action",
			[
				{
					deviceId: "one",
					displayName: "One",
					targetIdentityId: "identity-scope-secret",
					previousIdentityId: "identity-other",
					action: "rebind" as const,
					isLocal: false,
				},
			],
		],
		[
			"mismatched target",
			[
				{
					deviceId: "one",
					displayName: "One",
					targetIdentityId: "identity-other",
					previousIdentityId: null,
					action: "bind" as const,
					isLocal: false,
				},
			],
		],
		[
			"unrelated device",
			[
				{
					deviceId: "other",
					displayName: "Other",
					targetIdentityId: "identity-scope-secret",
					previousIdentityId: null,
					action: "bind" as const,
					isLocal: false,
				},
			],
		],
	])("rejects setup preview with %s", async (_case, outcomes) => {
		const previewBindings = vi.fn().mockResolvedValue({
			version: 1,
			status: "ready",
			reviewedInventoryDigest: "digest",
			errorCode: null,
			outcomes,
			writeCount: outcomes.length,
		});
		const commitBindings = vi.fn();
		mount(intent(), reconciliation(), {
			inventory: inventory([
				inventoryItem("one", "One", "setup_required", {
					suggestedIdentityId: "identity-scope-secret",
				}),
			]),
			previewBindings,
			commitBindings,
		});
		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Review this device",
				) as HTMLButtonElement
			).click();
		});
		expect(document.body.textContent).toContain(
			"Identity setup preview was incomplete. Refresh and try again.",
		);
		expect(document.body.textContent).not.toContain("Review Identity setup");
		expect(commitBindings).not.toHaveBeenCalled();
	});

	it("does not restore a stale preview response after a setup choice diverges", async () => {
		let resolvePreview: ((value: DeviceIdentityBindingPreviewV1) => void) | undefined;
		const previewBindings = vi.fn(
			() =>
				new Promise<DeviceIdentityBindingPreviewV1>((resolve) => {
					resolvePreview = resolve;
				}),
		);
		mount(intent(), reconciliation(), {
			inventory: inventory([
				inventoryItem("one", "One", "setup_required", {
					suggestedIdentityId: "identity-scope-secret",
				}),
			]),
			previewBindings,
		});
		act(() => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Review this device",
				) as HTMLButtonElement
			).click();
		});
		const select = document.querySelector<HTMLSelectElement>(".device-identity-setup-card select");
		if (!select) throw new Error("select missing");
		select.value = "";
		act(() => {
			select.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () =>
			resolvePreview?.({
				version: 1,
				status: "ready",
				reviewedInventoryDigest: "stale",
				errorCode: null,
				outcomes: [],
				writeCount: 1,
			}),
		);
		expect(document.body.textContent).not.toContain("Review Identity setup");
	});

	it("discloses both Identities and requires separate review confirmation for rebind", async () => {
		const graph = intent({
			identities: [
				...intent().identities,
				{ ...intent().identities[0], identityId: "identity-previous", displayName: "Alice" },
				{ ...intent().identities[0], identityId: "identity-target", displayName: "Brian" },
			],
		});
		const previewBindings = vi.fn().mockResolvedValue({
			version: 1,
			status: "ready",
			reviewedInventoryDigest: "digest",
			errorCode: null,
			outcomes: [
				{
					deviceId: "device-address-fingerprint-secret",
					displayName: "Work Laptop",
					targetIdentityId: "identity-target",
					previousIdentityId: "identity-previous",
					action: "rebind",
					isLocal: false,
				},
			],
			writeCount: 1,
		});
		mount(graph, reconciliation(), {
			inventory: inventory([
				inventoryItem("device-address-fingerprint-secret", "Work Laptop", "configured"),
			]),
			previewBindings,
		});
		act(() =>
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Change Identity…",
				) as HTMLButtonElement
			).click(),
		);
		expect(document.body.textContent).toContain(
			"Suggested current Identity (unconfirmed): Adam & Co",
		);
		const select = document.querySelector<HTMLSelectElement>(".device-identity-rebind select");
		if (!select) throw new Error("rebind select missing");
		select.value = "identity-target";
		act(() => {
			select.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const confirmation = document.querySelector<HTMLInputElement>(
			'.device-identity-rebind input[type="checkbox"]',
		);
		if (!confirmation) throw new Error("rebind confirmation missing");
		setCheckbox(confirmation);
		expect(document.body.textContent).toContain("Confirm reassigning Work Laptop to Brian");
		expect(
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "Reassign Identity",
			),
		).toBeUndefined();
		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Review reassignment",
				) as HTMLButtonElement
			).click();
		});
		const review = document.querySelector(".device-identity-rebind-review");
		expect(review?.textContent).toContain("Work Laptop: Alice → Brian");
		expect(review?.textContent).not.toContain("Adam & Co → Brian");
	});

	it("matches configured devices by evidence alias and rebinds the authoritative binding ID", async () => {
		const graph = intent({
			identities: [
				...intent().identities,
				{ ...intent().identities[0], identityId: "identity-target", displayName: "Brian" },
			],
		});
		const previewBindings = vi.fn().mockResolvedValue({
			version: 1,
			status: "ready",
			reviewedInventoryDigest: "digest",
			errorCode: null,
			outcomes: [
				{
					deviceId: "device-address-fingerprint-secret",
					displayName: "Work Laptop",
					targetIdentityId: "identity-target",
					previousIdentityId: "identity-scope-secret",
					action: "rebind",
					isLocal: false,
				},
			],
			writeCount: 1,
		});
		mount(graph, reconciliation(), {
			inventory: inventory([
				inventoryItem("canonical-alias", "Work Laptop", "configured", {
					evidenceDeviceIds: ["canonical-alias", "device-address-fingerprint-secret"],
				}),
			]),
			previewBindings,
		});

		const triggers = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
			(button) => button.textContent === "Change Identity…",
		);
		expect(triggers).toHaveLength(1);
		act(() => triggers[0]?.click());
		const select = document.querySelector<HTMLSelectElement>(".device-identity-rebind select");
		if (!select) throw new Error("rebind select missing");
		select.value = "identity-target";
		act(() => {
			select.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const confirmation = document.querySelector<HTMLInputElement>(
			'.device-identity-rebind input[type="checkbox"]',
		);
		if (!confirmation) throw new Error("rebind confirmation missing");
		setCheckbox(confirmation);
		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Review reassignment",
				) as HTMLButtonElement
			).click();
		});

		expect(previewBindings).toHaveBeenCalledWith({
			bindings: [
				{
					deviceId: "canonical-alias",
					targetIdentityId: "identity-target",
					confirmed: true,
					allowRebind: true,
				},
			],
		});
	});

	it("preserves a reviewed reassignment across a configured-device rename", async () => {
		const graph = intent({
			identities: [
				...intent().identities,
				{ ...intent().identities[0], identityId: "identity-target", displayName: "Brian" },
			],
		});
		const item = inventoryItem("device-address-fingerprint-secret", "Work Laptop", "configured");
		const previewBindings = vi.fn().mockResolvedValue({
			version: 1,
			status: "ready",
			reviewedInventoryDigest: "digest",
			errorCode: null,
			outcomes: [
				{
					deviceId: "device-address-fingerprint-secret",
					displayName: "Work Laptop",
					targetIdentityId: "identity-target",
					previousIdentityId: "identity-scope-secret",
					action: "rebind",
					isLocal: false,
				},
			],
			writeCount: 1,
		});
		mount(graph, reconciliation(), { inventory: inventory([item]), previewBindings });
		const trigger = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Change Identity…",
		);
		act(() => trigger?.click());
		const select = document.querySelector<HTMLSelectElement>(".device-identity-rebind select");
		if (!select) throw new Error("rebind select missing");
		select.value = "identity-target";
		act(() => {
			select.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const confirmation = document.querySelector<HTMLInputElement>(
			'.device-identity-rebind input[type="checkbox"]',
		);
		if (!confirmation) throw new Error("rebind confirmation missing");
		setCheckbox(confirmation);
		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Review reassignment",
				) as HTMLButtonElement
			).click();
		});

		mount(graph, reconciliation(), {
			inventory: inventory([{ ...item, displayName: "Work Laptop renamed" }]),
			previewBindings,
		});

		expect(document.querySelector(".device-identity-rebind-review")?.textContent).toContain(
			"Work Laptop: Adam & Co → Brian",
		);
	});

	it.each([
		[true, "Identity reassignment completed. Devices and Sharing were refreshed."],
		[
			false,
			"Identity reassignment completed, but refreshing Devices and Sharing failed. Refresh to see current state.",
		],
	])("uses the dedicated rebind flow and reports refresh result %s", async (refreshResult, expectedStatus) => {
		const graph = intent({
			identities: [
				...intent().identities,
				{ ...intent().identities[0], identityId: "identity-target", displayName: "Brian" },
			],
		});
		const previewBindings = vi.fn().mockResolvedValue({
			version: 1,
			status: "ready",
			reviewedInventoryDigest: "rebind-digest",
			errorCode: null,
			outcomes: [
				{
					deviceId: "device-address-fingerprint-secret",
					displayName: "Work Laptop",
					targetIdentityId: "identity-target",
					previousIdentityId: "identity-scope-secret",
					action: "rebind",
					isLocal: false,
				},
			],
			writeCount: 1,
		});
		const commitBindings = vi.fn().mockResolvedValue({ version: 1, status: "applied" });
		const configuredItems = [
			inventoryItem("device-address-fingerprint-secret", "Work Laptop", "configured"),
			inventoryItem("fallback", "Fallback", "configured"),
		];
		const onCommitted = vi.fn(() => {
			mount(graph, reconciliation(), {
				inventory: inventory(configuredItems),
				previewBindings,
				commitBindings,
				onCommitted,
			});
			return refreshResult;
		});
		mount(graph, reconciliation(), {
			inventory: inventory(configuredItems),
			previewBindings,
			commitBindings,
			onCommitted,
		});
		const triggers = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
			(button) => button.textContent === "Change Identity…",
		);
		expect(triggers).toHaveLength(2);
		act(() => {
			triggers[1]?.click();
		});
		const select = document.querySelector<HTMLSelectElement>(".device-identity-rebind select");
		if (!select) throw new Error("rebind select missing");
		select.value = "identity-target";
		act(() => {
			select.dispatchEvent(new Event("input", { bubbles: true }));
		});
		const confirmation = document.querySelector<HTMLInputElement>(
			'.device-identity-rebind input[type="checkbox"]',
		);
		if (!confirmation) throw new Error("rebind confirmation missing");
		confirmation.checked = true;
		act(() => {
			confirmation.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Review reassignment",
				) as HTMLButtonElement
			).click();
		});
		const finalConfirmation = [
			...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
		].find((input) => input.parentElement?.textContent?.includes("I reviewed the previous"));
		if (!finalConfirmation) throw new Error("final confirmation missing");
		finalConfirmation.checked = true;
		act(() => {
			finalConfirmation.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Reassign Identity",
				) as HTMLButtonElement
			).click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(commitBindings).toHaveBeenCalledWith({
			bindings: [
				{
					deviceId: "device-address-fingerprint-secret",
					targetIdentityId: "identity-target",
					confirmed: true,
					allowRebind: true,
				},
			],
			reviewedInventoryDigest: "rebind-digest",
		});
		expect(onCommitted).toHaveBeenCalledOnce();
		expect(
			[...document.querySelectorAll('[role="status"]')].some(
				(status) => status.textContent === expectedStatus,
			),
		).toBe(true);
		expect(document.activeElement?.id).toBe(triggers[1]?.id);
		expect(document.querySelector(".device-identity-rebind fieldset")).toBeNull();
	});

	it.each([
		[true, "Identity setup completed. Devices and Sharing were refreshed."],
		[
			false,
			"Identity setup completed, but refreshing Devices and Sharing failed. Refresh to see current state.",
		],
	])("commits setup after review and reports refresh result %s", async (refreshResult, expectedStatus) => {
		const previewBindings = vi.fn().mockResolvedValue({
			version: 1,
			status: "ready",
			reviewedInventoryDigest: "digest",
			errorCode: null,
			outcomes: [
				{
					deviceId: "one",
					displayName: "One",
					targetIdentityId: "identity-scope-secret",
					previousIdentityId: null,
					action: "bind",
					isLocal: true,
				},
			],
			writeCount: 1,
		});
		const commitBindings = vi.fn().mockResolvedValue({ version: 1, status: "applied" });
		const onCommitted = vi.fn(() => {
			mount(intent(), reconciliation(), {
				inventory: inventory([inventoryItem("one", "One", "configured")]),
				previewBindings,
				commitBindings,
				onCommitted,
			});
			return refreshResult;
		});
		mount(intent(), reconciliation(), {
			inventory: inventory([inventoryItem("one", "One", "setup_required", { isLocal: true })]),
			previewBindings,
			commitBindings,
			onCommitted,
		});
		const identitySelect = document.querySelector<HTMLSelectElement>(
			".device-identity-setup-card select",
		);
		if (!identitySelect) throw new Error("Identity select missing");
		identitySelect.value = "identity-scope-secret";
		act(() => {
			identitySelect.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () =>
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Review this device",
				) as HTMLButtonElement
			).click(),
		);
		expect(
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "Apply setup to 1 device",
			),
		).toBeTruthy();
		const finalConfirmation = [
			...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
		].find((input) => input.parentElement?.textContent?.includes("I reviewed every device"));
		if (!finalConfirmation) throw new Error("final confirmation missing");
		finalConfirmation.checked = true;
		act(() => {
			finalConfirmation.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Apply setup to 1 device",
				) as HTMLButtonElement
			).click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(commitBindings).toHaveBeenCalledWith({
			bindings: [
				{
					deviceId: "one",
					targetIdentityId: "identity-scope-secret",
					confirmed: true,
				},
			],
			reviewedInventoryDigest: "digest",
		});
		expect(onCommitted).toHaveBeenCalledOnce();
		expect(
			[...document.querySelectorAll('[role="status"]')].some(
				(status) => status.textContent === expectedStatus,
			),
		).toBe(true);
	});

	it.each([
		[503, "binding_preview_busy", "busy. Wait a moment"],
		[409, "binding_evidence_stale", "changed after review"],
		[503, "binding_write_stale", "changed after review"],
		[409, "binding_write_conflict", "evidence conflicts"],
		[404, "target_identity_unavailable", "no longer available"],
		[503, "deciding_identity_unavailable", "Open Identity administration"],
		[404, "unavailable_but_unknown", "no longer available"],
		[500, "binding_commit_failed", "could not be completed"],
	])("maps safe binding failure %s/%s to actionable recovery", (status, code, expected) => {
		expect(
			deviceIdentitySetupError(new DeviceIdentityBindingApiError(status, code, null)),
		).toContain(expected);
	});
});
