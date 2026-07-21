import { type ComponentChildren, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dialogSpy = vi.hoisted(() => vi.fn());

vi.mock("../components/primitives/radix-dialog", () => ({
	RadixDialog: (props: {
		ariaDescribedby?: string;
		ariaLabelledby?: string;
		children?: ComponentChildren;
		contentClassName?: string;
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
				className={props.contentClassName}
				id={props.contentId}
				role="dialog"
			>
				{props.children}
			</div>
		) : null;
	},
}));

vi.mock("../lib/api", async (importOriginal) => {
	const original = await importOriginal<typeof import("../lib/api")>();
	return {
		...original,
		commitRecipientPolicyEdges: vi.fn(),
		previewRecipientPolicyEdges: vi.fn(),
	};
});

import * as api from "../lib/api";
import type {
	RecipientPolicyEdgeChangeV1,
	RecipientPolicyEdgePreviewResponseV1,
	RecipientPolicyIntentGraphV1,
} from "../lib/api/sync";
import {
	mountRecipientPolicyManagement,
	openRecipientPolicyManagement,
	type RecipientPolicyManagementProject,
} from "./recipient-policy-management";

const projects: RecipientPolicyManagementProject[] = [
	{ canonicalProjectIdentity: "git:codemem", displayName: "Codemem", existingMemoryCount: 436 },
	{ canonicalProjectIdentity: "git:api", displayName: "API", existingMemoryCount: 18 },
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
		teams: [{ version: 1, teamId: "team-example", displayName: "ExampleCo", status: "active" }],
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
				deviceId: "device-adam",
				displayName: "Adam’s Mac",
				status: "active",
			},
		],
		projectRecipients: [
			{
				version: 1,
				canonicalProjectIdentity: "git:codemem",
				recipientKind: "team",
				teamId: "team-example",
				intentSource: "user",
				policyRevision: "revision-1",
				status: "active",
			},
			{
				version: 1,
				canonicalProjectIdentity: "git:codemem",
				recipientKind: "identity",
				identityId: "identity-adam",
				intentSource: "user",
				policyRevision: "revision-2",
				status: "active",
			},
		],
		...overrides,
	};
}

function preview(changes: RecipientPolicyEdgeChangeV1[]): RecipientPolicyEdgePreviewResponseV1 {
	return {
		version: 1,
		normalizedChanges: changes,
		projects: [
			{
				canonicalProjectIdentity: "git:codemem",
				displayName: "Codemem",
				existingMemoryCount: 436,
				futureMemoriesShared: true,
			},
		],
		selectedRecipients: [
			{
				recipientKind: "team",
				teamId: "team-example",
				displayName: "ExampleCo",
				currentMembers: [
					{ identityId: "identity-adam", displayName: "Adam", verification: "local" },
					{ identityId: "identity-brian", displayName: "Brian", verification: "local" },
				],
				futureMembersInherit: true,
			},
		],
		effectiveDevices: [
			{
				canonicalProjectIdentity: "git:codemem",
				identityId: "identity-adam",
				deviceId: "device-adam",
				displayName: "Adam’s Mac",
			},
		],
		unchangedProjects: [],
		reviewedPolicyDigest: "policy:digest",
		addCount: changes.filter((change) => change.action === "add").length,
		removeCount: changes.filter((change) => change.action === "remove").length,
		netWriteCount: changes.length,
	};
}

function mount(
	graph = intent(),
	options: Parameters<typeof mountRecipientPolicyManagement>[3] = {},
	projectInventory = projects,
) {
	const element = document.getElementById("mount");
	if (!element) throw new Error("mount missing");
	act(() => mountRecipientPolicyManagement(element, projectInventory, graph, options));
}

function checkbox(label: string): HTMLInputElement {
	const match = [...document.querySelectorAll<HTMLLabelElement>("label")].find(
		(item) => item.querySelector("strong")?.textContent === label,
	);
	const input = match?.querySelector<HTMLInputElement>('input[type="checkbox"]');
	if (!input) throw new Error(`checkbox missing: ${label}`);
	return input;
}

async function reviewSelection() {
	await act(async () => {
		(
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "Review changes",
			) as HTMLButtonElement
		).click();
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("recipient policy management dialog", () => {
	beforeEach(() => {
		document.body.innerHTML = '<button id="trigger">Manage</button><div id="mount"></div>';
		vi.mocked(api.previewRecipientPolicyEdges).mockImplementation(async (request) =>
			preview(request.changes),
		);
		vi.mocked(api.commitRecipientPolicyEdges).mockResolvedValue({
			version: 1,
			status: "applied",
			reviewedPolicyDigest: "policy:digest",
			errorCode: null,
			outcomes: [],
			writeCount: 1,
			idempotent: false,
		});
	});

	afterEach(() => {
		const element = document.getElementById("mount");
		if (element) act(() => render(null, element));
		vi.clearAllMocks();
		document.body.innerHTML = "";
	});

	it("project-add emits canonical add edges for every seeded Project and selected recipient", async () => {
		mount();
		act(() => {
			openRecipientPolicyManagement({
				mode: "project-add",
				projectIds: ["git:codemem", "git:api"],
			});
		});
		act(() => checkbox("ExampleCo").click());
		await reviewSelection();

		expect(api.previewRecipientPolicyEdges).toHaveBeenCalledWith({
			version: 1,
			changes: [
				{
					canonicalProjectIdentity: "git:codemem",
					recipient: { recipientKind: "team", teamId: "team-example" },
					action: "add",
				},
				{
					canonicalProjectIdentity: "git:api",
					recipient: { recipientKind: "team", teamId: "team-example" },
					action: "add",
				},
			],
		});
	});

	it("project-manage emits only recipient add and remove diffs", async () => {
		mount();
		act(() => {
			openRecipientPolicyManagement({ mode: "project-manage", projectId: "git:codemem" });
		});
		expect(checkbox("ExampleCo").checked).toBe(true);
		expect(checkbox("Brian").checked).toBe(false);
		act(() => {
			checkbox("ExampleCo").click();
			checkbox("Brian").click();
		});
		await reviewSelection();

		expect(api.previewRecipientPolicyEdges).toHaveBeenCalledWith({
			version: 1,
			changes: [
				{
					canonicalProjectIdentity: "git:codemem",
					recipient: { recipientKind: "team", teamId: "team-example" },
					action: "remove",
				},
				{
					canonicalProjectIdentity: "git:codemem",
					recipient: { recipientKind: "identity", identityId: "identity-brian" },
					action: "add",
				},
			],
		});
	});

	it("project-manage exposes stale recipient edges only so they can be removed", async () => {
		const base = intent();
		mount(
			intent({
				identities: [
					...base.identities,
					{
						version: 1,
						identityId: "identity-merged",
						displayName: "Merged recipient",
						kind: null,
						verification: "local",
						status: "merged",
						mergedIntoIdentityId: "identity-adam",
					},
				],
				teams: [
					...base.teams,
					{ version: 1, teamId: "team-archived", displayName: "Archived Team", status: "archived" },
				],
				projectRecipients: [
					...base.projectRecipients,
					{
						version: 1,
						canonicalProjectIdentity: "git:codemem",
						recipientKind: "team",
						teamId: "team-archived",
						intentSource: "user",
						policyRevision: "revision-archived",
						status: "active",
					},
					{
						version: 1,
						canonicalProjectIdentity: "git:codemem",
						recipientKind: "identity",
						identityId: "identity-merged",
						intentSource: "user",
						policyRevision: "revision-merged",
						status: "active",
					},
					{
						version: 1,
						canonicalProjectIdentity: "git:codemem",
						recipientKind: "identity",
						identityId: "identity-deactivated",
						intentSource: "user",
						policyRevision: "revision-deactivated",
						status: "active",
					},
				],
			}),
		);
		act(() => {
			openRecipientPolicyManagement({ mode: "project-manage", projectId: "git:codemem" });
		});
		expect(checkbox("Archived Team").checked).toBe(true);
		expect(checkbox("Merged recipient").checked).toBe(true);
		expect(checkbox("Unavailable Identity").checked).toBe(true);
		expect(document.body.textContent).toContain("existing access can only be removed");
		act(() => {
			checkbox("Archived Team").click();
			checkbox("Merged recipient").click();
			checkbox("Unavailable Identity").click();
		});
		await reviewSelection();

		expect(api.previewRecipientPolicyEdges).toHaveBeenCalledWith({
			version: 1,
			changes: [
				{
					canonicalProjectIdentity: "git:codemem",
					recipient: { recipientKind: "team", teamId: "team-archived" },
					action: "remove",
				},
				{
					canonicalProjectIdentity: "git:codemem",
					recipient: { recipientKind: "identity", identityId: "identity-merged" },
					action: "remove",
				},
				{
					canonicalProjectIdentity: "git:codemem",
					recipient: { recipientKind: "identity", identityId: "identity-deactivated" },
					action: "remove",
				},
			],
		});

		act(() => {
			openRecipientPolicyManagement({ mode: "project-add", projectIds: ["git:codemem"] });
		});
		expect(document.body.textContent).not.toContain("Archived Team");
		expect(document.body.textContent).not.toContain("Merged recipient");
		expect(document.body.textContent).not.toContain("Unavailable Identity");
	});

	it("recipient-manage emits the same canonical edge shape with only Project diffs", async () => {
		mount();
		act(() => {
			openRecipientPolicyManagement({
				mode: "recipient-manage",
				recipient: { recipientKind: "identity", identityId: "identity-adam" },
			});
		});
		expect(checkbox("Codemem").checked).toBe(true);
		act(() => {
			checkbox("Codemem").click();
			checkbox("API").click();
		});
		await reviewSelection();

		expect(api.previewRecipientPolicyEdges).toHaveBeenCalledWith({
			version: 1,
			changes: [
				{
					canonicalProjectIdentity: "git:codemem",
					recipient: { recipientKind: "identity", identityId: "identity-adam" },
					action: "remove",
				},
				{
					canonicalProjectIdentity: "git:api",
					recipient: { recipientKind: "identity", identityId: "identity-adam" },
					action: "add",
				},
			],
		});
	});

	it("recipient-manage exposes stale active Projects only so they can be removed", async () => {
		mount(
			intent({
				projectRecipients: [
					...intent().projectRecipients,
					{
						version: 1,
						canonicalProjectIdentity: "git:removed",
						recipientKind: "identity",
						identityId: "identity-adam",
						intentSource: "user",
						policyRevision: "revision-stale-project",
						status: "active",
					},
				],
			}),
		);
		act(() => {
			openRecipientPolicyManagement({
				mode: "recipient-manage",
				recipient: { recipientKind: "identity", identityId: "identity-adam" },
			});
		});

		expect(checkbox("git:removed").checked).toBe(true);
		expect(document.body.textContent).toContain(
			"Unavailable Project · existing access can only be removed",
		);
		act(() => checkbox("git:removed").click());
		await reviewSelection();
		expect(api.previewRecipientPolicyEdges).toHaveBeenCalledWith({
			version: 1,
			changes: [
				{
					canonicalProjectIdentity: "git:removed",
					recipient: { recipientKind: "identity", identityId: "identity-adam" },
					action: "remove",
				},
			],
		});

		act(() => {
			openRecipientPolicyManagement({
				mode: "recipient-add",
				recipient: { recipientKind: "identity", identityId: "identity-adam" },
			});
		});
		expect(document.body.textContent).not.toContain("git:removed");
	});

	it("recipient-add offers only additional Projects and cannot emit removals", async () => {
		mount();
		act(() => {
			openRecipientPolicyManagement({
				mode: "recipient-add",
				recipient: { recipientKind: "identity", identityId: "identity-adam" },
			});
		});
		expect(document.body.textContent).not.toContain("Codemem");
		expect(document.body.textContent).toContain("Existing access cannot be removed here");
		act(() => checkbox("API").click());
		await reviewSelection();

		expect(api.previewRecipientPolicyEdges).toHaveBeenCalledWith({
			version: 1,
			changes: [
				{
					canonicalProjectIdentity: "git:api",
					recipient: { recipientKind: "identity", identityId: "identity-adam" },
					action: "add",
				},
			],
		});
	});

	it("allows exactly 500 changes and blocks larger reviews without an API call", async () => {
		const projectInventory = Array.from({ length: 501 }, (_, index) => ({
			canonicalProjectIdentity: `git:bulk-${index.toString().padStart(3, "0")}`,
			displayName: `Bulk ${index}`,
			existingMemoryCount: index,
		}));
		mount(intent({ projectRecipients: [] }), {}, projectInventory);
		act(() => {
			openRecipientPolicyManagement({
				mode: "project-add",
				projectIds: projectInventory.map((project) => project.canonicalProjectIdentity),
			});
		});
		act(() => checkbox("ExampleCo").click());
		const blockedReview = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Review changes",
		);
		expect(document.body.textContent).toContain(
			"This selection creates 501 access changes. Review at most 500 changes at a time",
		);
		expect(blockedReview?.disabled).toBe(true);
		act(() => blockedReview?.click());
		expect(api.previewRecipientPolicyEdges).not.toHaveBeenCalled();

		act(() => {
			openRecipientPolicyManagement({
				mode: "project-add",
				projectIds: projectInventory
					.slice(0, 500)
					.map((project) => project.canonicalProjectIdentity),
			});
		});
		act(() => checkbox("ExampleCo").click());
		expect(document.body.textContent).not.toContain("Review at most 500 changes at a time");
		await reviewSelection();
		expect(vi.mocked(api.previewRecipientPolicyEdges).mock.calls[0]?.[0].changes).toHaveLength(500);
	});

	it("renders exact preview detail and commits only normalized changes plus digest", async () => {
		mount();
		act(() => {
			openRecipientPolicyManagement({ mode: "project-add", projectIds: ["git:codemem"] });
		});
		act(() => checkbox("ExampleCo").click());
		await reviewSelection();

		expect(document.body.textContent).toContain(
			"Codemem — 436 existing memories and future activity",
		);
		expect(document.body.textContent).toContain("436 existing memories total");
		expect(document.body.textContent).toContain("ExampleCo");
		expect(document.body.textContent).toContain("Adam, Brian");
		expect(document.body.textContent).toContain("Future Team members inherit access");
		expect(document.body.textContent).toContain("1 effective device");
		expect(document.body.textContent).toContain("No other Projects will change");

		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Confirm changes",
				) as HTMLButtonElement
			).click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(api.commitRecipientPolicyEdges).toHaveBeenCalledWith({
			version: 1,
			changes: preview([
				{
					canonicalProjectIdentity: "git:codemem",
					recipient: { recipientKind: "team", teamId: "team-example" },
					action: "add",
				},
			]).normalizedChanges,
			reviewedPolicyDigest: "policy:digest",
		});
	});

	it("discards stale preview, preserves selection, and announces another review", async () => {
		vi.mocked(api.commitRecipientPolicyEdges).mockRejectedValueOnce(
			new api.RecipientPolicyEdgesStaleError({
				version: 1,
				status: "stale",
				reviewedPolicyDigest: "policy:old",
				errorCode: "reviewed_policy_stale",
				outcomes: [],
				writeCount: 0,
				idempotent: false,
			}),
		);
		mount();
		act(() => {
			openRecipientPolicyManagement({ mode: "project-add", projectIds: ["git:codemem"] });
		});
		act(() => checkbox("ExampleCo").click());
		await reviewSelection();
		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Confirm changes",
				) as HTMLButtonElement
			).click();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(document.body.textContent).toContain("Review the refreshed changes before trying again");
		expect(document.querySelector("[aria-live='polite']")?.textContent).toContain(
			"Refresh and review the preserved selection again",
		);
		expect(checkbox("ExampleCo").checked).toBe(true);
		expect(document.body.textContent).toContain("Review changes");
	});

	it("provides labels, live regions, busy state, target hooks, and neutral opening focus", () => {
		mount();
		act(() => {
			openRecipientPolicyManagement({ mode: "project-manage", projectId: "git:codemem" });
		});

		const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
		expect(inputs.length).toBeGreaterThan(0);
		for (const input of inputs) {
			expect(document.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
		}
		expect(document.querySelector("[aria-busy='false']")).not.toBeNull();
		expect(document.querySelector("[aria-live='polite']")).not.toBeNull();
		expect(document.querySelectorAll(".recipient-policy-management-target").length).toBeGreaterThan(
			2,
		);

		const props = dialogSpy.mock.calls.at(-1)?.[0] as { onOpenAutoFocus: (event: Event) => void };
		const event = new Event("focus");
		const preventDefault = vi.spyOn(event, "preventDefault");
		props.onOpenAutoFocus(event);
		expect(preventDefault).toHaveBeenCalled();
		expect(document.activeElement).toBe(
			document.getElementById("recipient-policy-management-title"),
		);
	});

	it("restores focus to a stable tab when polling replaced the original trigger", () => {
		document.body.insertAdjacentHTML("afterbegin", '<button id="tabBtn-sharing">Sharing</button>');
		const trigger = document.getElementById("trigger") as HTMLButtonElement;
		trigger.focus();
		mount();
		act(() => {
			openRecipientPolicyManagement({
				mode: "recipient-manage",
				recipient: { recipientKind: "identity", identityId: "identity-adam" },
			});
		});
		trigger.remove();
		const props = dialogSpy.mock.calls.at(-1)?.[0] as {
			onCloseAutoFocus: (event: Event) => void;
		};
		const event = new Event("close");
		const preventDefault = vi.spyOn(event, "preventDefault");
		props.onCloseAutoFocus(event);

		expect(preventDefault).toHaveBeenCalled();
		expect(document.activeElement).toBe(document.getElementById("tabBtn-sharing"));
	});

	it("blocks duplicate preview submissions before the first request settles", async () => {
		let resolvePreview: ((value: RecipientPolicyEdgePreviewResponseV1) => void) | null = null;
		vi.mocked(api.previewRecipientPolicyEdges).mockImplementationOnce((request) =>
			new Promise((resolve) => {
				resolvePreview = resolve;
			}).then(() => preview(request.changes)),
		);
		mount();
		act(() => {
			openRecipientPolicyManagement({ mode: "project-add", projectIds: ["git:codemem"] });
		});
		act(() => checkbox("ExampleCo").click());
		const review = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === "Review changes",
		);
		if (!review) throw new Error("review button missing");
		act(() => {
			review.click();
			review.click();
		});
		expect(api.previewRecipientPolicyEdges).toHaveBeenCalledTimes(1);
		expect(checkbox("ExampleCo").disabled).toBe(true);

		await act(async () => {
			resolvePreview?.(preview([]));
			await Promise.resolve();
		});
	});

	it("shows loading and empty states without enabling an unsafe review", () => {
		mount(intent(), { loading: true });
		act(() => {
			openRecipientPolicyManagement({ mode: "project-add", projectIds: ["git:codemem"] });
		});
		expect(document.body.textContent).toContain("Loading the complete recipient access inventory");
		expect(document.body.textContent).not.toContain("Review changes");

		mount(intent({ identities: [], teams: [], teamMemberships: [], projectRecipients: [] }));
		act(() => {
			openRecipientPolicyManagement({ mode: "project-add", projectIds: ["git:codemem"] });
		});
		expect(document.body.textContent).toContain("No active Teams or Identities are available");
		expect(
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "Review changes",
			)?.disabled,
		).toBe(true);
	});

	it("renders partial commit outcomes with text rather than color-only meaning", async () => {
		vi.mocked(api.commitRecipientPolicyEdges).mockResolvedValueOnce({
			version: 1,
			status: "conflict",
			reviewedPolicyDigest: "policy:digest",
			errorCode: "edge_conflict",
			outcomes: [
				{
					change: {
						canonicalProjectIdentity: "git:codemem",
						recipient: { recipientKind: "team", teamId: "team-example" },
						action: "add",
					},
					outcome: "already_present",
				},
			],
			writeCount: 0,
			idempotent: true,
		});
		mount();
		act(() => {
			openRecipientPolicyManagement({ mode: "project-add", projectIds: ["git:codemem"] });
		});
		act(() => checkbox("ExampleCo").click());
		await reviewSelection();
		await act(async () => {
			(
				[...document.querySelectorAll<HTMLButtonElement>("button")].find(
					(button) => button.textContent === "Confirm changes",
				) as HTMLButtonElement
			).click();
			await Promise.resolve();
			await Promise.resolve();
		});

		expect(document.body.textContent).toContain(
			"Some recipient access changes could not be completed",
		);
		expect(document.body.textContent).toContain("already present");
	});
});
