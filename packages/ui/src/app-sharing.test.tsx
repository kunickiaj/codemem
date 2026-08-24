import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./components/primitives/radix-dialog", () => ({
	RadixDialog: (props: {
		children?: ComponentChildren;
		contentId: string;
		onOpenChange: (open: boolean) => void;
		open: boolean;
	}) =>
		props.open ? (
			<div id={props.contentId} role="dialog">
				{props.children}
			</div>
		) : null,
}));

import { createRecipientPolicySharingLoader } from "./app-sharing";
import type {
	LegacyTeamSetupSummaryResponseV1,
	RecipientPolicyIntentGraphV1,
} from "./lib/api/sync";

const projects = [
	{ canonicalProjectIdentity: "git:codemem", displayName: "Codemem", existingMemoryCount: 12 },
];

const intent: RecipientPolicyIntentGraphV1 = {
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
	],
	teams: [],
	teamMemberships: [],
	identityDevices: [],
	projectRecipients: [
		{
			version: 1,
			canonicalProjectIdentity: "git:codemem",
			recipientKind: "identity",
			identityId: "identity-adam",
			intentSource: "user",
			policyRevision: "revision-1",
			status: "active",
		},
	],
};

function button(label: string): HTMLButtonElement {
	const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent === label,
	);
	if (!match) throw new Error(`button missing: ${label}`);
	return match;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

afterEach(() => {
	for (const id of ["recipientPolicySharingMount", "recipientPolicyManagementMount"]) {
		const mount = document.getElementById(id);
		if (mount) act(() => render(null, mount));
	}
	document.body.innerHTML = "";
	vi.clearAllMocks();
});

describe("Sharing app data refresh", () => {
	it("keeps stale Sharing cards after a refresh failure and restores fresh state after recovery", async () => {
		document.body.innerHTML =
			'<div id="recipientPolicySharingMount"></div><div id="recipientPolicyManagementMount"></div>';
		const loadProjects = vi.fn().mockResolvedValue({ manageable: projects, received: [] });
		const loadIntent = vi.fn().mockResolvedValue(intent);
		const teamSetupSummary: LegacyTeamSetupSummaryResponseV1 = {
			version: 1,
			candidates: [
				{
					candidateRef: "candidate-one",
					displayName: "Example Team",
					status: "needs_setup",
					deviceCount: 1,
					projectCount: 1,
					unresolvedDeviceCount: 1,
					unresolvedProjectCount: 0,
				},
			],
		};
		const loadTeamSetupSummary = vi
			.fn()
			.mockResolvedValueOnce(teamSetupSummary)
			.mockRejectedValueOnce(new Error("setup unavailable"))
			.mockResolvedValueOnce(teamSetupSummary);
		const loadDeviceInventory = vi.fn().mockResolvedValue({
			version: 1,
			items: [],
			coordinatorEvidence: { availability: "available", safeErrorCode: null },
			truncated: false,
		});
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory,
			loadIntent,
			loadProjects,
			loadTeamSetupSummary,
		});

		let refreshResult: boolean | undefined;
		await act(async () => {
			refreshResult = await load();
		});
		expect(refreshResult).toBe(true);
		act(() => button("Identities").click());
		expect(document.body.textContent).toContain("Manage projects");
		act(() => button("Manage projects").click());
		expect(document.body.textContent).toContain("Review changes");

		loadIntent.mockRejectedValueOnce(new Error("refresh failed"));
		await act(async () => {
			refreshResult = await load();
		});
		expect(refreshResult).toBe(false);
		expect(document.body.textContent).toContain(
			"Refresh failed; showing previous Sharing details.",
		);
		expect(document.body.textContent).toContain(
			"The complete recipient access inventory is unavailable. Refresh and try again.",
		);
		expect(document.body.textContent).toContain("Manage projects");
		expect(document.body.textContent).toContain("Example Team");
		expect(document.body.textContent).toContain("The previous Team setup status is being shown.");
		expect(document.body.textContent).not.toContain("Review changes");

		await act(async () => {
			await load();
		});
		expect(document.body.textContent).toContain("Manage projects");
		expect(document.body.textContent).toContain("Review changes");
		expect(document.body.textContent).not.toContain(
			"Refresh failed; showing previous Sharing details",
		);
		expect(document.body.textContent).not.toContain(
			"The previous Team setup status is being shown.",
		);
	});

	it("keeps Sharing usable when only device inventory is unavailable", async () => {
		document.body.innerHTML =
			'<div id="recipientPolicySharingMount"></div><div id="recipientPolicyManagementMount"></div>';
		const loadIntent = vi
			.fn()
			.mockResolvedValueOnce(intent)
			.mockRejectedValueOnce(new Error("intent unavailable"));
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory: vi.fn().mockRejectedValue(new Error("inventory unavailable")),
			loadIntent,
			loadProjects: vi.fn().mockResolvedValue({ manageable: projects, received: [] }),
		});

		await act(async () => {
			await load();
		});

		expect(document.body.textContent).toContain("Manage projects");
		expect(document.body.textContent).not.toContain("Sharing details are unavailable");
		expect(document.body.textContent).toContain(
			"Device Identity information is unavailable. Devices needing setup or review cannot be shown until a refresh succeeds.",
		);

		await act(async () => {
			await load();
		});
		expect(document.body.textContent).toContain(
			"Refresh failed; showing previous Sharing details.",
		);
		expect(document.body.textContent).toContain("Manage projects");
		expect(document.body.textContent).toContain("Device Identity information is unavailable");
	});

	it("uses current inventory availability while preserving stale Sharing content", async () => {
		document.body.innerHTML = '<div id="recipientPolicySharingMount"></div>';
		const firstInventory = {
			version: 1 as const,
			items: [],
			coordinatorEvidence: { availability: "available" as const, safeErrorCode: null },
			truncated: false,
		};
		const loadDeviceInventory = vi
			.fn()
			.mockResolvedValueOnce(firstInventory)
			.mockRejectedValueOnce(new Error("inventory unavailable"));
		const loadIntent = vi
			.fn()
			.mockResolvedValueOnce(intent)
			.mockRejectedValueOnce(new Error("intent unavailable"));
		const mountSharing = vi.fn();
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory,
			loadIntent,
			loadProjects: vi.fn().mockResolvedValue({ manageable: projects, received: [] }),
			mountSharing,
		});

		await load();
		await load();

		expect(mountSharing).toHaveBeenLastCalledWith(
			document.getElementById("recipientPolicySharingMount"),
			projects,
			intent,
			expect.objectContaining({
				deviceInventory: firstInventory,
				deviceInventoryUnavailable: true,
				refreshError: true,
			}),
		);
		expect(
			mountSharing.mock.calls.filter((call) => call[3]?.loading === true).length,
		).toBeGreaterThanOrEqual(1);
	});

	it("preserves failed-refresh guards while a retry is pending", async () => {
		document.body.innerHTML = '<div id="recipientPolicySharingMount"></div>';
		const inventory = {
			version: 1 as const,
			items: [],
			coordinatorEvidence: { availability: "available" as const, safeErrorCode: null },
			truncated: false,
		};
		const pendingProjects = deferred<{ manageable: typeof projects; received: [] }>();
		const pendingIntent = deferred<typeof intent>();
		const pendingInventory = deferred<typeof inventory>();
		const mountSharing = vi.fn();
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory: vi
				.fn()
				.mockResolvedValueOnce(inventory)
				.mockRejectedValueOnce(new Error("inventory unavailable"))
				.mockImplementationOnce(() => pendingInventory.promise),
			loadIntent: vi
				.fn()
				.mockResolvedValueOnce(intent)
				.mockRejectedValueOnce(new Error("intent unavailable"))
				.mockImplementationOnce(() => pendingIntent.promise),
			loadProjects: vi
				.fn()
				.mockResolvedValueOnce({ manageable: projects, received: [] })
				.mockRejectedValueOnce(new Error("projects unavailable"))
				.mockImplementationOnce(() => pendingProjects.promise),
			mountSharing,
		});

		await load();
		await load();
		const retry = load();
		expect(mountSharing.mock.calls.at(-1)?.[3]).toEqual(
			expect.objectContaining({
				deviceInventoryUnavailable: true,
				refreshError: true,
				teamSetupLoading: true,
			}),
		);

		pendingProjects.resolve({ manageable: projects, received: [] });
		pendingIntent.resolve(intent);
		pendingInventory.resolve(inventory);
		await expect(retry).resolves.toBe(true);
	});

	it("waits for delayed device inventory failure before rendering a broader load error", async () => {
		document.body.innerHTML =
			'<div id="recipientPolicySharingMount"></div><div id="recipientPolicyManagementMount"></div>';
		const inventoryResult = deferred<never>();
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory: vi.fn(() => inventoryResult.promise),
			loadIntent: vi.fn().mockRejectedValue(new Error("intent unavailable")),
			loadProjects: vi.fn().mockResolvedValue({ manageable: projects, received: [] }),
			loadTeamSetupSummary: vi.fn().mockRejectedValue(new Error("setup unavailable")),
		});

		const result = load();
		await Promise.resolve();
		expect(document.body.textContent).not.toContain("Sharing details are unavailable");
		inventoryResult.reject(new Error("inventory unavailable"));
		await expect(result).resolves.toBe(false);
		expect(document.body.textContent).toContain("Sharing details are unavailable");
		expect(document.body.textContent).toContain("Device Identity information is unavailable");
		expect(document.body.textContent).toContain("Team setup status is temporarily unavailable.");
	});

	it("forwards a successful Team summary through first-load required-data failure", async () => {
		document.body.innerHTML = '<div id="recipientPolicySharingMount"></div>';
		const teamSetupSummary: LegacyTeamSetupSummaryResponseV1 = {
			version: 1,
			candidates: [
				{
					candidateRef: "candidate-one",
					displayName: "Example Team",
					status: "needs_setup",
					deviceCount: 1,
					projectCount: 1,
					unresolvedDeviceCount: 1,
					unresolvedProjectCount: 0,
				},
			],
		};
		const mountSharing = vi.fn();
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory: vi.fn().mockResolvedValue({ version: 1, items: [], truncated: false }),
			loadIntent: vi.fn().mockRejectedValue(new Error("intent unavailable")),
			loadProjects: vi.fn().mockRejectedValue(new Error("projects unavailable")),
			loadSyncStatus: vi.fn().mockResolvedValue({}),
			loadTeamSetupSummary: vi.fn().mockResolvedValue(teamSetupSummary),
			mountSharing,
		});

		await expect(load()).resolves.toBe(false);
		expect(mountSharing).toHaveBeenLastCalledWith(
			document.getElementById("recipientPolicySharingMount"),
			[],
			expect.objectContaining({ version: 1, teams: [] }),
			expect.objectContaining({
				loadError: true,
				teamSetupSummary,
				teamSetupUnavailable: false,
			}),
		);
	});

	it("lets the newest overlapping refresh own the final mount and result", async () => {
		document.body.innerHTML =
			'<div id="recipientPolicySharingMount"></div><div id="recipientPolicyManagementMount"></div>';
		const firstIntent = deferred<RecipientPolicyIntentGraphV1>();
		const secondIntent = deferred<RecipientPolicyIntentGraphV1>();
		const mountSharing = vi.fn();
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory: vi.fn().mockResolvedValue({ version: 1, items: [], truncated: false }),
			loadIntent: vi
				.fn()
				.mockReturnValueOnce(firstIntent.promise)
				.mockReturnValueOnce(secondIntent.promise),
			loadProjects: vi.fn().mockResolvedValue({ manageable: projects, received: [] }),
			mountManagement: vi.fn(),
			mountSharing,
		});

		const first = load();
		const second = load();
		const newestIntent = {
			...intent,
			identities: [{ ...intent.identities[0], displayName: "Newest" }],
		};
		secondIntent.resolve(newestIntent);
		await expect(second).resolves.toBe(true);
		firstIntent.resolve(intent);
		await expect(first).resolves.toBe(true);

		const completedMounts = mountSharing.mock.calls.filter((call) => call[3]?.loading !== true);
		expect(completedMounts).toHaveLength(1);
		expect(completedMounts[0]?.[2]).toBe(newestIntent);
	});

	it("loads the redacted coordinator reconciliation count into normal Sharing", async () => {
		document.body.innerHTML = '<div id="recipientPolicySharingMount"></div>';
		const mountSharing = vi.fn();
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory: vi.fn().mockResolvedValue({
				version: 1,
				items: [],
				coordinatorEvidence: { availability: "available", safeErrorCode: null },
				truncated: false,
			}),
			loadIntent: vi.fn().mockResolvedValue(intent),
			loadProjects: vi.fn().mockResolvedValue({ manageable: projects, received: [] }),
			loadSyncStatus: vi.fn().mockResolvedValue({
				status: {
					coordinator_enrollment_reconciliation_issues: {
						counts: { open: 3, resolved: 8 },
						issues: [{ coordinator_id: "must-not-reach-normal-sharing" }],
					},
				},
			}),
			mountSharing,
		});

		await load();

		expect(mountSharing).toHaveBeenLastCalledWith(
			document.getElementById("recipientPolicySharingMount"),
			projects,
			intent,
			expect.objectContaining({ coordinatorEnrollmentIssueCount: 3 }),
		);
		expect(JSON.stringify(mountSharing.mock.calls.at(-1)?.[3])).not.toContain("coordinator_id");
	});

	it("preserves reconciliation attention across a transient sync-status failure", async () => {
		document.body.innerHTML = '<div id="recipientPolicySharingMount"></div>';
		const mountSharing = vi.fn();
		const loadSyncStatus = vi
			.fn()
			.mockResolvedValueOnce({
				status: {
					coordinator_enrollment_reconciliation_issues: {
						counts: { open: 2, resolved: 0 },
						issues: [],
					},
				},
			})
			.mockRejectedValueOnce(new Error("temporarily unavailable"));
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory: vi.fn().mockResolvedValue({
				version: 1,
				items: [],
				coordinatorEvidence: { availability: "available", safeErrorCode: null },
				truncated: false,
			}),
			loadIntent: vi.fn().mockResolvedValue(intent),
			loadProjects: vi.fn().mockResolvedValue({ manageable: projects, received: [] }),
			loadSyncStatus,
			mountSharing,
		});

		await load();
		await load();

		expect(mountSharing.mock.calls.at(-1)?.[3]).toEqual(
			expect.objectContaining({ coordinatorEnrollmentIssueCount: 2 }),
		);
	});

	it("loads Team setup independently and keeps Sharing usable when that optional request fails", async () => {
		document.body.innerHTML = '<div id="recipientPolicySharingMount"></div>';
		const onOpenTeamSetup = vi.fn();
		const mountSharing = vi.fn();
		const loadTeamSetupSummary = vi
			.fn()
			.mockResolvedValueOnce({
				version: 1,
				candidates: [
					{
						candidateRef: "candidate-one",
						displayName: "Example Team",
						status: "needs_setup",
						deviceCount: 1,
						projectCount: 1,
						unresolvedDeviceCount: 1,
						unresolvedProjectCount: 0,
					},
				],
			})
			.mockRejectedValueOnce(new Error("optional setup unavailable"));
		const load = createRecipientPolicySharingLoader(
			{
				loadDeviceInventory: vi.fn().mockResolvedValue({ version: 1, items: [], truncated: false }),
				loadIntent: vi.fn().mockResolvedValue(intent),
				loadProjects: vi.fn().mockResolvedValue({ manageable: projects, received: [] }),
				loadTeamSetupSummary,
				mountSharing,
			},
			{ onOpenTeamSetup },
		);

		await expect(load()).resolves.toBe(true);
		expect(mountSharing).toHaveBeenLastCalledWith(
			document.getElementById("recipientPolicySharingMount"),
			projects,
			intent,
			expect.objectContaining({
				onOpenTeamSetup,
				teamSetupSummary: expect.objectContaining({ version: 1 }),
				teamSetupUnavailable: false,
			}),
		);
		await expect(load()).resolves.toBe(true);
		expect(mountSharing.mock.calls.at(-1)?.[3]).toEqual(
			expect.objectContaining({
				teamSetupSummary: expect.objectContaining({ version: 1 }),
				teamSetupUnavailable: true,
			}),
		);
		expect(mountSharing.mock.calls.at(-1)?.[3]?.refreshError).toBeUndefined();
	});

	it("renders required Sharing data before optional Team setup discovery settles", async () => {
		document.body.innerHTML = '<div id="recipientPolicySharingMount"></div>';
		const teamSetupResult = deferred<LegacyTeamSetupSummaryResponseV1>();
		const mountSharing = vi.fn();
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory: vi.fn().mockResolvedValue({ version: 1, items: [], truncated: false }),
			loadIntent: vi.fn().mockResolvedValue(intent),
			loadProjects: vi.fn().mockResolvedValue({ manageable: projects, received: [] }),
			loadTeamSetupSummary: vi.fn(() => teamSetupResult.promise),
			mountSharing,
		});

		const operation = load();
		await expect(operation).resolves.toBe(true);
		expect(mountSharing).toHaveBeenLastCalledWith(
			document.getElementById("recipientPolicySharingMount"),
			projects,
			intent,
			expect.objectContaining({ teamSetupLoading: true, teamSetupSummary: undefined }),
		);

		await act(async () => {
			teamSetupResult.resolve({ version: 1, candidates: [] });
			await Promise.resolve();
		});
		expect(mountSharing.mock.calls.at(-1)?.[3]).toEqual(
			expect.objectContaining({
				teamSetupSummary: { version: 1, candidates: [] },
				teamSetupUnavailable: false,
			}),
		);
	});

	it("renders fresh Team setup status before a required Sharing refresh settles", async () => {
		document.body.innerHTML = '<div id="recipientPolicySharingMount"></div>';
		const projectRefresh = deferred<{ manageable: typeof projects; received: [] }>();
		const initialSummary: LegacyTeamSetupSummaryResponseV1 = { version: 1, candidates: [] };
		const freshSummary: LegacyTeamSetupSummaryResponseV1 = {
			version: 1,
			candidates: [
				{
					candidateRef: "candidate-fresh",
					displayName: "Fresh Team",
					status: "needs_setup",
					deviceCount: 1,
					projectCount: 0,
					unresolvedDeviceCount: 1,
					unresolvedProjectCount: 0,
				},
			],
		};
		const mountSharing = vi.fn();
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory: vi.fn().mockResolvedValue({ version: 1, items: [], truncated: false }),
			loadIntent: vi.fn().mockResolvedValue(intent),
			loadProjects: vi
				.fn()
				.mockResolvedValueOnce({ manageable: projects, received: [] })
				.mockImplementationOnce(() => projectRefresh.promise),
			loadTeamSetupSummary: vi
				.fn()
				.mockResolvedValueOnce(initialSummary)
				.mockResolvedValueOnce(freshSummary),
			mountSharing,
		});

		await load();
		const refresh = load();
		await vi.waitFor(() =>
			expect(mountSharing.mock.calls.at(-1)?.[3]).toEqual(
				expect.objectContaining({
					teamSetupLoading: false,
					teamSetupSummary: freshSummary,
				}),
			),
		);

		projectRefresh.resolve({ manageable: projects, received: [] });
		await expect(refresh).resolves.toBe(true);
	});

	it("marks a cached Team setup summary as previous while its refresh is pending", async () => {
		document.body.innerHTML = '<div id="recipientPolicySharingMount"></div>';
		const refreshResult = deferred<LegacyTeamSetupSummaryResponseV1>();
		const initialSummary: LegacyTeamSetupSummaryResponseV1 = { version: 1, candidates: [] };
		const mountSharing = vi.fn();
		const loadTeamSetupSummary = vi
			.fn()
			.mockResolvedValueOnce(initialSummary)
			.mockRejectedValueOnce(new Error("temporary setup failure"))
			.mockReturnValueOnce(refreshResult.promise);
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory: vi.fn().mockResolvedValue({ version: 1, items: [], truncated: false }),
			loadIntent: vi.fn().mockResolvedValue(intent),
			loadProjects: vi.fn().mockResolvedValue({ manageable: projects, received: [] }),
			loadTeamSetupSummary,
			mountSharing,
		});

		await expect(load()).resolves.toBe(true);
		await expect(load()).resolves.toBe(true);
		expect(mountSharing.mock.calls.at(-1)?.[3]).toEqual(
			expect.objectContaining({
				teamSetupSummary: initialSummary,
				teamSetupLoading: false,
				teamSetupUnavailable: true,
			}),
		);
		await expect(load()).resolves.toBe(true);
		expect(mountSharing.mock.calls.at(-1)?.[3]).toEqual(
			expect.objectContaining({
				teamSetupSummary: initialSummary,
				teamSetupLoading: true,
				teamSetupUnavailable: false,
			}),
		);

		refreshResult.resolve({ version: 1, candidates: [] });
	});

	it("reports first-load Team setup unavailability without inventing candidates", async () => {
		document.body.innerHTML = '<div id="recipientPolicySharingMount"></div>';
		const mountSharing = vi.fn();
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory: vi.fn().mockResolvedValue({ version: 1, items: [], truncated: false }),
			loadIntent: vi.fn().mockResolvedValue(intent),
			loadProjects: vi.fn().mockResolvedValue({ manageable: projects, received: [] }),
			loadTeamSetupSummary: vi.fn().mockRejectedValue(new Error("optional setup unavailable")),
			mountSharing,
		});

		await expect(load()).resolves.toBe(true);
		expect(mountSharing).toHaveBeenLastCalledWith(
			document.getElementById("recipientPolicySharingMount"),
			projects,
			intent,
			expect.objectContaining({
				teamSetupSummary: undefined,
				teamSetupUnavailable: true,
			}),
		);
	});

	it("does not let an older Team summary refresh replace the newest unavailable state", async () => {
		document.body.innerHTML = '<div id="recipientPolicySharingMount"></div>';
		const initialSummary: LegacyTeamSetupSummaryResponseV1 = {
			version: 1,
			candidates: [
				{
					candidateRef: "candidate-initial",
					displayName: "Initial Team",
					status: "needs_setup",
					deviceCount: 1,
					projectCount: 1,
					unresolvedDeviceCount: 1,
					unresolvedProjectCount: 0,
				},
			],
		};
		const olderSummary = deferred<LegacyTeamSetupSummaryResponseV1>();
		const mountSharing = vi.fn();
		const loadTeamSetupSummary = vi
			.fn()
			.mockResolvedValueOnce(initialSummary)
			.mockReturnValueOnce(olderSummary.promise)
			.mockRejectedValueOnce(new Error("newest summary unavailable"));
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory: vi.fn().mockResolvedValue({ version: 1, items: [], truncated: false }),
			loadIntent: vi.fn().mockResolvedValue(intent),
			loadProjects: vi.fn().mockResolvedValue({ manageable: projects, received: [] }),
			loadTeamSetupSummary,
			mountSharing,
		});

		await expect(load()).resolves.toBe(true);
		const olderLoad = load();
		const newestLoad = load();
		await expect(newestLoad).resolves.toBe(true);
		expect(mountSharing.mock.calls.at(-1)?.[3]).toEqual(
			expect.objectContaining({
				teamSetupSummary: initialSummary,
				teamSetupUnavailable: true,
			}),
		);

		olderSummary.resolve({
			version: 1,
			candidates: [
				{
					candidateRef: "candidate-obsolete",
					displayName: "Obsolete Team",
					status: "in_progress",
					deviceCount: 2,
					projectCount: 1,
					unresolvedDeviceCount: 0,
					unresolvedProjectCount: 0,
				},
			],
		});
		await expect(olderLoad).resolves.toBe(true);
		expect(mountSharing.mock.calls.at(-1)?.[3]).toEqual(
			expect.objectContaining({
				teamSetupSummary: initialSummary,
				teamSetupUnavailable: true,
			}),
		);
	});
});
