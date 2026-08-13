import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	RecipientPolicyIntentGraphV1,
	RecipientPolicyReconciliationStatusV1,
} from "../lib/api/sync";
import { mountDevices, projectDevices } from "./devices";

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

describe("read-only Devices", () => {
	beforeEach(() => {
		document.body.innerHTML = '<div id="mount"></div>';
	});

	afterEach(() => {
		const element = document.getElementById("mount");
		if (element) act(() => render(null, element));
		document.body.innerHTML = "";
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
		expect(document.querySelector('[role="status"]')?.textContent).toContain("Loading Devices");

		mount(intent(), reconciliation(), { loadError: true });
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
			"Refresh failed; showing previous device information.",
		);
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
});
