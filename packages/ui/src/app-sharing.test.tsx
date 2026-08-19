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
import type { RecipientPolicyIntentGraphV1 } from "./lib/api/sync";

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
	it("replaces stale actions after a refresh failure and restores them after recovery", async () => {
		document.body.innerHTML =
			'<div id="recipientPolicySharingMount"></div><div id="recipientPolicyManagementMount"></div>';
		const loadProjects = vi.fn().mockResolvedValue({ manageable: projects, received: [] });
		const loadIntent = vi.fn().mockResolvedValue(intent);
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
			"Sharing details are unavailable. Refresh and try again.",
		);
		expect(document.body.textContent).toContain(
			"The complete recipient access inventory is unavailable. Refresh and try again.",
		);
		expect(document.body.textContent).not.toContain("Manage projects");
		expect(document.body.textContent).not.toContain("Review changes");

		await act(async () => {
			await load();
		});
		expect(document.body.textContent).toContain("Manage projects");
		expect(document.body.textContent).toContain("Review changes");
		expect(document.body.textContent).not.toContain("Sharing details are unavailable");
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
		expect(document.body.textContent).toContain("Sharing details are unavailable");
		expect(document.body.textContent).toContain("Device Identity information is unavailable");
	});

	it("waits for delayed device inventory failure before rendering a broader load error", async () => {
		document.body.innerHTML =
			'<div id="recipientPolicySharingMount"></div><div id="recipientPolicyManagementMount"></div>';
		const inventoryResult = deferred<never>();
		const load = createRecipientPolicySharingLoader({
			loadDeviceInventory: vi.fn(() => inventoryResult.promise),
			loadIntent: vi.fn().mockRejectedValue(new Error("intent unavailable")),
			loadProjects: vi.fn().mockResolvedValue({ manageable: projects, received: [] }),
		});

		const result = load();
		await Promise.resolve();
		expect(document.body.textContent).not.toContain("Sharing details are unavailable");
		inventoryResult.reject(new Error("inventory unavailable"));
		await expect(result).resolves.toBe(false);
		expect(document.body.textContent).toContain("Sharing details are unavailable");
		expect(document.body.textContent).toContain("Device Identity information is unavailable");
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
});
