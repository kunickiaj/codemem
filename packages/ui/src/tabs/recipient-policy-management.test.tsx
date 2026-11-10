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
		outcomes: changes.map((change) => ({
			change,
			outcome: change.action === "add" ? "added" : "removed",
		})),
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

function actionButton(label: string): HTMLButtonElement {
	const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.textContent === label,
	);
	if (!match) throw new Error(`button missing: ${label}`);
	return match;
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

async function confirmChanges() {
	await act(async () => {
		(
			[...document.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent === "Confirm changes",
			) as HTMLButtonElement
		).click();
		await Promise.resolve();
		await Promise.resolve();
	});
}

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

describe("saved direct sharing coverage", () => {
	it.each([0, 1, 2])("shows %i direct entries separately from unchecked additions", (count) => {
		// Arrange: a one-member Team and the same Identity are separate recipients.
		const graph = intent();
		graph.teams[0].displayName = "Studio";
		graph.identities[0].displayName = "Alex";
		graph.teamMemberships = graph.teamMemberships.slice(0, 1);
		graph.projectRecipients = projects.slice(0, count).map((project) => ({
			...intent().projectRecipients[0],
			canonicalProjectIdentity: project.canonicalProjectIdentity,
		}));
		mount(graph);
		// Act: duplicate Project IDs must not inflate coverage.
		act(() => {
			openRecipientPolicyManagement({
				mode: "project-add",
				projectIds: ["git:codemem", "git:api", "git:api"],
			});
		});
		// Assert: saved direct relationships never become requested additions.
		const team = checkbox("Studio");
		expect(team.checked).toBe(false);
		expect(team.disabled).toBe(count === 2);
		expect(team.getAttribute("aria-label")).toBe(
			count === 2
				? "Studio already added to all selected Project entries"
				: "Add Studio to remaining Project entries",
		);
		expect(team.closest("label")?.textContent).toContain(
			count === 0 ? "Not added directly" : `Added to ${count} of 2 selected Project entries`,
		);
		expect(checkbox("Alex").checked).toBe(false);
		expect(checkbox("Alex").disabled).toBe(false);
		if (count > 0)
			expect(checkbox("Alex").closest("label")?.textContent).toContain(
				`Access through Team Studio: ${count} of 2 selected Project entries`,
			);
		expect(document.body.textContent).toContain(
			"Existing sharing stays unchanged. Select additions below.",
		);
		expect(document.body.textContent).not.toContain("locally verified");
		expect(document.body.textContent).not.toContain("You");
		expect(api.previewRecipientPolicyEdges).not.toHaveBeenCalled();
		expect(api.commitRecipientPolicyEdges).not.toHaveBeenCalled();
		const descriptionId = team.getAttribute("aria-describedby");
		expect(document.getElementById(descriptionId ?? "")?.textContent).toContain("Team");
		if (count === 2) {
			// Act: a fully covered choice cannot request a duplicate addition.
			act(() => team.click());
			// Assert
			expect(team.checked).toBe(false);
			expect(actionButton("Review changes").disabled).toBe(true);
		}
	});

	it.each(["active", "pending", "revoked"] as const)(
		"shows inherited context only for active membership (%s)",
		(status) => {
			// Arrange
			const graph = intent();
			graph.identities[0].displayName = "Alex";
			graph.teamMemberships[0].status = status;
			mount(graph);
			// Act
			act(() => {
				openRecipientPolicyManagement({ mode: "project-add", projectIds: ["git:codemem"] });
			});
			// Assert
			expect(checkbox("Alex").closest("label")?.textContent?.includes("Access through Team")).toBe(
				status === "active",
			);
			expect(checkbox("Alex").checked).toBe(false);
			expect(checkbox("Alex").disabled).toBe(true);
		},
	);

	it("shows unavailable saved recipients in bulk without offering additions", () => {
		// Arrange
		const graph = intent({ teams: [], identities: [] });
		mount(graph);
		// Act
		act(() => {
			openRecipientPolicyManagement({
				mode: "project-add",
				projectIds: projects.map((project) => project.canonicalProjectIdentity),
			});
		});
		// Assert
		expect(checkbox("Unavailable Team").disabled).toBe(true);
		expect(checkbox("Unavailable Identity").disabled).toBe(true);
		expect(checkbox("Unavailable Team").closest("label")?.textContent).toContain(
			"Added to 1 of 2 selected Project entries",
		);
		expect(document.body.textContent).not.toContain("team-example");
	});
});

describe("sharing paths and preview coverage", () => {
	it("keeps direct and inherited access separate when removing one relationship", async () => {
		// Arrange
		mount();
		act(() => {
			openRecipientPolicyManagement({ mode: "project-manage", projectId: "git:codemem" });
		});
		// Act
		act(() => checkbox("Adam").click());
		// Assert
		expect(checkbox("Adam").checked).toBe(false);
		expect(checkbox("ExampleCo").checked).toBe(true);
		expect(checkbox("Adam").closest("label")?.textContent).toContain(
			"Access through Team ExampleCo: 1 of 1 selected Project entries",
		);
		expect(document.body.textContent).toContain(
			"Removing one relationship does not remove access through another Team or direct relationship.",
		);
		// Act
		await reviewSelection();
		// Assert
		expect(api.previewRecipientPolicyEdges).toHaveBeenCalledWith({
			version: 1,
			changes: [
				{
					canonicalProjectIdentity: "git:codemem",
					recipient: { recipientKind: "identity", identityId: "identity-adam" },
					action: "remove",
				},
			],
		});
		expect(api.commitRecipientPolicyEdges).not.toHaveBeenCalled();
	});

	it("preserves authoritative partial device coverage without promising delivery", async () => {
		// Arrange: the local inventory has a device the authoritative preview excludes.
		const reviewed = preview([]);
		reviewed.projects.push({
			...reviewed.projects[0],
			canonicalProjectIdentity: "git:api",
			displayName: "API",
		});
		reviewed.effectiveDevices = [{ ...reviewed.effectiveDevices[0], displayName: "Studio laptop" }];
		vi.mocked(api.previewRecipientPolicyEdges).mockResolvedValue(reviewed);
		const graph = intent();
		graph.identities[0].displayName = "Alex";
		graph.identityDevices.push({
			...graph.identityDevices[0],
			deviceId: "device-excluded",
			displayName: "Excluded desktop",
		});
		graph.identityDevices.push({
			...graph.identityDevices[0],
			deviceId: "device-revoked",
			displayName: "Revoked laptop",
			status: "revoked",
		});
		mount(graph);
		act(() => {
			openRecipientPolicyManagement({
				mode: "project-add",
				projectIds: ["git:codemem", "git:api"],
			});
		});
		act(() => checkbox("Brian").click());
		// Act
		await reviewSelection();
		// Assert
		expect(document.body.textContent).toContain("Devices included after this update");
		expect(document.body.textContent).toContain(
			"Studio laptop — Alex — 1 of 2 affected Project entries",
		);
		expect(document.body.textContent).toContain(
			"Access settings do not confirm delivery. Devices sync in the background.",
		);
		expect(document.body.textContent).not.toContain("will be available");
		expect(document.body.textContent).not.toContain("Excluded desktop");
		expect(document.body.textContent).not.toContain("Revoked laptop");
		expect(api.commitRecipientPolicyEdges).not.toHaveBeenCalled();
		// Act
		await confirmChanges();
		// Assert
		expect(document.getElementById("recipient-policy-management-title")?.textContent).toBe(
			"Sharing settings saved",
		);
	});
});

describe("recipient policy management dialog", () => {
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

	it("labels an already-active Project recipient edge as unchanged", async () => {
		vi.mocked(api.previewRecipientPolicyEdges).mockImplementationOnce(async (request) => {
			const value = preview(request.changes);
			return {
				...value,
				outcomes: request.changes.map((change) => ({ change, outcome: "already_present" })),
				unchangedProjects: value.projects,
				addCount: 0,
				netWriteCount: 0,
			};
		});
		mount(
			intent({
				projectRecipients: intent().projectRecipients.filter(
					(edge) => edge.recipientKind !== "team" || edge.teamId !== "team-example",
				),
			}),
		);
		act(() => {
			openRecipientPolicyManagement({ mode: "project-add", projectIds: ["git:codemem"] });
		});
		act(() => checkbox("ExampleCo").click());
		await reviewSelection();

		expect(document.body.textContent).toContain("ExampleCo — Already has access · Team");
		expect(document.body.textContent).not.toContain("ExampleCo — Adding access · Team");
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

	it("labels recipient removals and additions without claiming unchanged recipients receive access", async () => {
		vi.mocked(api.previewRecipientPolicyEdges).mockImplementationOnce(async (request) => {
			const value = preview(request.changes);
			const [team] = value.selectedRecipients;
			if (team?.recipientKind !== "team") throw new Error("team fixture is incomplete");
			return {
				...value,
				selectedRecipients: [
					team,
					{
						recipientKind: "identity",
						identityId: "identity-brian",
						displayName: "Brian",
						verification: "local",
					},
				],
			};
		});
		mount();
		act(() => {
			openRecipientPolicyManagement({ mode: "project-manage", projectId: "git:codemem" });
		});
		expect(checkbox("Adam").checked).toBe(true);
		act(() => {
			checkbox("ExampleCo").click();
			checkbox("Brian").click();
		});
		await reviewSelection();

		expect(document.body.textContent).toContain("Recipient changes");
		expect(document.body.textContent).not.toContain("Who receives it");
		expect(document.body.textContent).toContain("ExampleCo — Removing access · Team");
		expect(document.body.textContent).toContain("Brian — Adding access · Identity");
		expect(
			vi.mocked(api.previewRecipientPolicyEdges).mock.calls[0]?.[0].changes,
		).not.toContainEqual({
			canonicalProjectIdentity: "git:codemem",
			recipient: { recipientKind: "identity", identityId: "identity-adam" },
			action: expect.any(String),
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
		expect(
			checkbox("Archived Team")
				.closest("label")
				?.querySelector(".recipient-policy-management-description")?.textContent,
		).toBe("Archived Team · unavailable for additions. Existing access can only be removed.");
		act(() => {
			checkbox("Archived Team").click();
			checkbox("Merged recipient").click();
			checkbox("Unavailable Identity").click();
		});
		await reviewSelection();
		expect(document.body.textContent).toContain("Archived Team — Removing access · Team");
		expect(document.body.textContent).toContain("Merged recipient — Removing access · Identity");
		expect(document.body.textContent).toContain(
			"Unavailable Identity — Removing access · Identity",
		);
		expect(document.body.outerHTML).not.toContain("identity-deactivated");

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
		expect(checkbox("Archived Team").disabled).toBe(true);
		expect(checkbox("Merged recipient").disabled).toBe(true);
		expect(checkbox("Unavailable Identity").disabled).toBe(true);
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

	it("keeps same-label Project choices separate, stable, and private while selecting exact identities", async () => {
		const privatePath = "/private/worktrees/codemem";
		const privateRemote = "ssh://git@private.example.test/codemem.git";
		vi.mocked(api.previewRecipientPolicyEdges).mockImplementationOnce(async (request) => ({
			...preview(request.changes),
			projects: [
				{
					canonicalProjectIdentity: privatePath,
					displayName: "codemem",
					existingMemoryCount: 1,
					futureMemoriesShared: true,
				},
			],
		}));
		mount(intent({ projectRecipients: [] }), {}, [
			{ canonicalProjectIdentity: privateRemote, displayName: "codemem", existingMemoryCount: 2 },
			{ canonicalProjectIdentity: privatePath, displayName: "codemem", existingMemoryCount: 1 },
		]);
		act(() => {
			openRecipientPolicyManagement({
				mode: "recipient-add",
				recipient: { recipientKind: "identity", identityId: "identity-adam" },
			});
		});

		const labels = [...document.querySelectorAll(".recipient-policy-management-name")].map(
			(label) => label.textContent,
		);
		expect(labels).toEqual(["codemem — duplicate name 2 of 2", "codemem — duplicate name 1 of 2"]);
		expect(document.body.outerHTML).not.toContain(privatePath);
		expect(document.body.outerHTML).not.toContain(privateRemote);

		act(() => checkbox("codemem — duplicate name 1 of 2").click());
		await reviewSelection();

		expect(api.previewRecipientPolicyEdges).toHaveBeenCalledWith({
			version: 1,
			changes: [
				{
					canonicalProjectIdentity: privatePath,
					recipient: { recipientKind: "identity", identityId: "identity-adam" },
					action: "add",
				},
			],
		});
		expect(document.body.textContent).toContain(
			"codemem — duplicate name 1 of 2 — Access changes affect 1 existing memories",
		);
		expect(document.body.outerHTML).not.toContain(privatePath);
		expect(document.body.outerHTML).not.toContain(privateRemote);
	});

	it("labels one recipient with mixed changes across selected Projects", async () => {
		vi.mocked(api.previewRecipientPolicyEdges).mockImplementationOnce(async (request) => ({
			...preview(request.changes),
			selectedRecipients: [
				{
					recipientKind: "identity",
					identityId: "identity-adam",
					displayName: "Adam",
					verification: "local",
				},
			],
		}));
		mount();
		act(() => {
			openRecipientPolicyManagement({
				mode: "recipient-manage",
				recipient: { recipientKind: "identity", identityId: "identity-adam" },
			});
		});
		act(() => {
			checkbox("Codemem").click();
			checkbox("API").click();
		});
		await reviewSelection();

		expect(document.body.textContent).toContain("Adam — Mixed changes · Identity");
	});

	it("keeps unavailable private Projects generic while allowing their access to be removed", async () => {
		const privatePath = "/Users/private-user/work/secret-client";
		const privateRemote = "ssh://git@private.example.test/secret/client.git";
		vi.mocked(api.previewRecipientPolicyEdges).mockImplementationOnce(async (request) => ({
			...preview(request.changes),
			projects: [privatePath, privateRemote].map((canonicalProjectIdentity) => ({
				canonicalProjectIdentity,
				displayName: canonicalProjectIdentity,
				existingMemoryCount: 0,
				futureMemoriesShared: true as const,
			})),
			selectedRecipients: [
				{
					recipientKind: "identity" as const,
					identityId: "identity-adam",
					displayName: "Adam",
					verification: "local" as const,
				},
			],
		}));
		vi.mocked(api.commitRecipientPolicyEdges).mockImplementationOnce(async (request) => ({
			version: 1,
			status: "applied",
			reviewedPolicyDigest: request.reviewedPolicyDigest,
			errorCode: null,
			outcomes: request.changes.map((change) => ({ change, outcome: "removed" as const })),
			writeCount: request.changes.length,
			idempotent: false,
		}));
		const onCommitted = vi.fn(async () => {
			mount(intent(), { onCommitted }, [
				...projects,
				{
					canonicalProjectIdentity: privatePath,
					displayName: "Recovered Project A",
					existingMemoryCount: 0,
				},
				{
					canonicalProjectIdentity: privateRemote,
					displayName: "Recovered Project B",
					existingMemoryCount: 0,
				},
			]);
		});
		mount(
			intent({
				projectRecipients: [
					...intent().projectRecipients,
					{
						version: 1,
						canonicalProjectIdentity: privatePath,
						recipientKind: "identity",
						identityId: "identity-adam",
						intentSource: "user",
						policyRevision: "revision-stale-path",
						status: "active",
					},
					{
						version: 1,
						canonicalProjectIdentity: privateRemote,
						recipientKind: "identity",
						identityId: "identity-adam",
						intentSource: "user",
						policyRevision: "revision-stale-remote",
						status: "active",
					},
				],
			}),
			{ onCommitted },
		);
		act(() => {
			openRecipientPolicyManagement({
				mode: "recipient-manage",
				recipient: { recipientKind: "identity", identityId: "identity-adam" },
			});
		});

		const unavailableProjects = [...document.querySelectorAll<HTMLLabelElement>("label")].filter(
			(label) => label.querySelector("strong")?.textContent?.startsWith("Unavailable Project"),
		);
		expect(unavailableProjects).toHaveLength(2);
		expect(unavailableProjects.map((label) => label.querySelector("strong")?.textContent)).toEqual([
			"Unavailable Project 1 of 2",
			"Unavailable Project 2 of 2",
		]);
		expect(document.body.textContent).toContain(
			"Unavailable Project 1 of 2 · existing access can only be removed",
		);
		expect(document.body.outerHTML).not.toContain(privatePath);
		expect(document.body.outerHTML).not.toContain(privateRemote);
		act(() => {
			for (const label of unavailableProjects) {
				label.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
			}
		});
		await reviewSelection();
		expect(document.body.textContent).toContain("Unavailable Project 1 of 2");
		expect(document.body.textContent).toContain("Unavailable Project 2 of 2");
		expect(document.body.outerHTML).not.toContain(privatePath);
		expect(document.body.outerHTML).not.toContain(privateRemote);
		expect(api.previewRecipientPolicyEdges).toHaveBeenCalledWith({
			version: 1,
			changes: [
				{
					canonicalProjectIdentity: privatePath,
					recipient: { recipientKind: "identity", identityId: "identity-adam" },
					action: "remove",
				},
				{
					canonicalProjectIdentity: privateRemote,
					recipient: { recipientKind: "identity", identityId: "identity-adam" },
					action: "remove",
				},
			],
		});
		await confirmChanges();
		expect(onCommitted).toHaveBeenCalledOnce();
		expect(document.body.textContent).toContain("Unavailable Project 1 of 2");
		expect(document.body.textContent).toContain("Unavailable Project 2 of 2");
		expect(document.body.outerHTML).not.toContain(privatePath);
		expect(document.body.outerHTML).not.toContain(privateRemote);

		act(() => {
			openRecipientPolicyManagement({
				mode: "recipient-add",
				recipient: { recipientKind: "identity", identityId: "identity-adam" },
			});
		});
		expect(document.body.outerHTML).not.toContain(privatePath);
		expect(document.body.outerHTML).not.toContain(privateRemote);
	});

	it("keeps reviewed aliases after committed recipients disappear from refreshed intent", async () => {
		const opaqueTeamIds = ["team_opaque_private_7ca891", "team_opaque_private_8db902"];
		const opaqueIdentityIds = ["identity_opaque_private_52de04", "identity_opaque_private_63ef15"];
		const base = intent();
		const graph = intent({
			projectRecipients: [
				...base.projectRecipients,
				...opaqueTeamIds.map((teamId, index) => ({
					version: 1 as const,
					canonicalProjectIdentity: "git:codemem",
					recipientKind: "team" as const,
					teamId,
					intentSource: "user" as const,
					policyRevision: `revision-opaque-team-${index}`,
					status: "active" as const,
				})),
				...opaqueIdentityIds.map((identityId, index) => ({
					version: 1 as const,
					canonicalProjectIdentity: "git:codemem",
					recipientKind: "identity" as const,
					identityId,
					intentSource: "user" as const,
					policyRevision: `revision-opaque-identity-${index}`,
					status: "active" as const,
				})),
			],
		});
		vi.mocked(api.commitRecipientPolicyEdges).mockImplementationOnce(async (request) => ({
			version: 1,
			status: "applied",
			reviewedPolicyDigest: request.reviewedPolicyDigest,
			errorCode: null,
			outcomes: request.changes.map((change) => ({ change, outcome: "removed" as const })),
			writeCount: request.changes.length,
			idempotent: false,
		}));
		const onCommitted = vi.fn(async () => {
			mount(base, { onCommitted });
		});
		mount(graph, { onCommitted });
		act(() => {
			openRecipientPolicyManagement({ mode: "project-manage", projectId: "git:codemem" });
		});
		act(() => {
			checkbox("Unavailable Team 1 of 2").click();
			checkbox("Unavailable Team 2 of 2").click();
			checkbox("Unavailable Identity 1 of 2").click();
			checkbox("Unavailable Identity 2 of 2").click();
		});
		await reviewSelection();

		for (const label of [
			"Unavailable Team 1 of 2",
			"Unavailable Team 2 of 2",
			"Unavailable Identity 1 of 2",
			"Unavailable Identity 2 of 2",
		]) {
			expect(document.body.textContent).toContain(`${label} — Removing access`);
		}
		for (const opaqueId of [...opaqueTeamIds, ...opaqueIdentityIds]) {
			expect(document.body.outerHTML).not.toContain(opaqueId);
		}

		await confirmChanges();
		expect(onCommitted).toHaveBeenCalledOnce();
		for (const label of [
			"Unavailable Team 1 of 2",
			"Unavailable Team 2 of 2",
			"Unavailable Identity 1 of 2",
			"Unavailable Identity 2 of 2",
		]) {
			expect(document.body.textContent).toContain(`Remove ${label} from Codemem: removed`);
		}
		for (const opaqueId of [...opaqueTeamIds, ...opaqueIdentityIds]) {
			expect(document.body.outerHTML).not.toContain(opaqueId);
		}
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

	it("renders the three review sections in order and commits normalized changes plus digest", async () => {
		vi.mocked(api.commitRecipientPolicyEdges).mockResolvedValueOnce({
			version: 1,
			status: "applied",
			reviewedPolicyDigest: "policy:digest",
			errorCode: null,
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
		mount(intent({ projectRecipients: [] }));
		act(() => {
			openRecipientPolicyManagement({ mode: "project-add", projectIds: ["git:codemem"] });
		});
		act(() => checkbox("ExampleCo").click());
		await reviewSelection();

		expect(document.getElementById("recipient-policy-management-title")?.textContent).toBe(
			"Review recipient access",
		);
		expect(document.getElementById("recipient-policy-management-description")?.textContent).toBe(
			"Confirm the exact Projects, recipients, and resulting access.",
		);
		expect(
			[...document.querySelectorAll(".recipient-policy-management-review > section > h3")].map(
				(heading) => heading.textContent,
			),
		).toEqual(["Projects affected", "Recipient changes", "Devices included after this update"]);
		expect(document.body.textContent).not.toContain("Who receives it");
		expect(document.body.textContent).toContain(
			"Codemem — Access changes affect 436 existing memories and future activity",
		);
		expect(document.body.textContent).toContain("ExampleCo");
		expect(document.body.textContent).toContain("Team · 2 current members");
		expect(document.body.textContent).toContain("Adam, Brian");
		expect(document.body.textContent).toContain("Eligible future Team members inherit access");
		expect(document.body.textContent).toContain(
			"The reviewed access settings include 1 current device.",
		);
		const reviewFooter = document.querySelector(
			".modal-footer.recipient-policy-management-actions",
		);
		const backButton = actionButton("Back");
		const confirmButton = actionButton("Confirm changes");
		expect(reviewFooter?.contains(backButton)).toBe(true);
		expect(reviewFooter?.contains(confirmButton)).toBe(true);
		expect(backButton.type).toBe("button");
		expect(confirmButton.type).toBe("button");
		const changeDetails = [...document.querySelectorAll<HTMLDetailsElement>("details")].find(
			(details) => details.querySelector("summary")?.textContent === "Change details",
		);
		expect(changeDetails).toBeInstanceOf(HTMLDetailsElement);
		expect(changeDetails?.open).toBe(false);
		expect(document.querySelector(".recipient-policy-management-details h4")).toBeNull();
		expect(document.body.textContent).not.toContain("existing memories total");

		await confirmChanges();
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
		expect(document.getElementById("recipient-policy-management-title")?.textContent).toBe(
			"Sharing settings saved",
		);
		const resultDescription = document.getElementById("recipient-policy-management-description");
		const appliedSummary =
			"Access settings do not confirm delivery. Devices sync in the background.";
		expect(resultDescription?.textContent).toBe(appliedSummary);
		expect(resultDescription?.hasAttribute("aria-live")).toBe(false);
		expect(resultDescription?.hasAttribute("role")).toBe(false);
		expect(document.activeElement).toBe(
			document.getElementById("recipient-policy-management-title"),
		);
		expect(document.body.textContent?.split(appliedSummary)).toHaveLength(2);
		expect(document.body.textContent).not.toContain("updated with");
		expect(document.body.textContent).not.toContain("changes saved");
		const resultFooter = document.querySelector(
			".modal-footer.recipient-policy-management-actions",
		);
		const doneButton = actionButton("Done");
		expect(resultFooter?.contains(doneButton)).toBe(true);
		expect(doneButton.type).toBe("button");
		expect(document.body.textContent).not.toContain("Confirm changes");
		const technicalDetails = document.querySelector<HTMLDetailsElement>(
			".recipient-policy-management-result details",
		);
		expect(technicalDetails).toBeInstanceOf(HTMLDetailsElement);
		expect(technicalDetails?.open).toBe(false);
		expect(technicalDetails?.querySelector("summary")?.textContent).toBe("Technical details");
	});

	it("describes zero current-device impact", async () => {
		vi.mocked(api.previewRecipientPolicyEdges).mockImplementationOnce(async (request) => ({
			...preview(request.changes),
			effectiveDevices: [],
		}));
		mount(intent({ projectRecipients: [] }));
		act(() => {
			openRecipientPolicyManagement({ mode: "project-add", projectIds: ["git:codemem"] });
		});
		act(() => checkbox("ExampleCo").click());
		await reviewSelection();

		expect(document.body.textContent).toContain(
			"No recipient devices are included in this preview.",
		);
		expect(document.body.textContent).toContain("Your own access on this device is not affected.");
	});

	it("deduplicates effective devices by device ID while preserving first-item order", async () => {
		vi.mocked(api.previewRecipientPolicyEdges).mockImplementationOnce(async (request) => {
			const value = preview(request.changes);
			const [device] = value.effectiveDevices;
			if (!device) throw new Error("device fixture is incomplete");
			return {
				...value,
				projects: [
					...value.projects,
					{ ...value.projects[0], canonicalProjectIdentity: "git:api", displayName: "API" },
				],
				effectiveDevices: [
					device,
					{
						...device,
						canonicalProjectIdentity: "git:api",
						displayName: "Duplicate project label",
					},
					{
						...device,
						deviceId: "device-brian",
						identityId: "identity-brian",
						displayName: "Brian’s Mac",
					},
				],
			};
		});
		mount(intent({ projectRecipients: [] }));
		act(() => {
			openRecipientPolicyManagement({ mode: "project-add", projectIds: ["git:codemem"] });
		});
		act(() => checkbox("ExampleCo").click());
		await reviewSelection();

		expect(document.body.textContent).toContain(
			"The reviewed access settings include 2 current devices.",
		);
		const availableSection = document
			.getElementById("recipient-policy-review-availability")
			?.closest("section");
		const deviceNames = [...(availableSection?.querySelectorAll("summary") ?? [])].map(
			(item) => item.textContent,
		);
		expect(deviceNames).toEqual([
			"Adam’s Mac — Adam — 2 of 2 affected Project entries",
			"Brian’s Mac — Brian — 1 of 2 affected Project entries",
		]);
		expect(document.body.textContent).not.toContain("Duplicate project label");
	});

	it("marks long Project, Team, Identity, member, and device names as wrappable", async () => {
		const longProject = "Project-with-a-very-long-unbroken-name-that-must-wrap";
		const longProjectLabel = `${longProject} — duplicate name 1 of 2`;
		const longTeam = "Team-with-a-very-long-unbroken-name-that-must-wrap";
		const longIdentity = "Identity-with-a-very-long-unbroken-name-that-must-wrap";
		const longMember = "Member-with-a-very-long-unbroken-name-that-must-wrap";
		const longDevice = "Device-with-a-very-long-unbroken-name-that-must-wrap";
		vi.mocked(api.previewRecipientPolicyEdges).mockImplementationOnce(async (request) => {
			const value = preview(request.changes);
			const [project] = value.projects;
			const [recipient] = value.selectedRecipients;
			const [device] = value.effectiveDevices;
			if (!project || !recipient || recipient.recipientKind !== "team" || !device) {
				throw new Error("preview fixture is incomplete");
			}
			const [currentMember] = recipient.currentMembers;
			if (!currentMember) {
				throw new Error("preview fixture is incomplete");
			}
			return {
				...value,
				projects: [{ ...project, displayName: longProject }],
				selectedRecipients: [
					{
						...recipient,
						displayName: longTeam,
						currentMembers: [{ ...currentMember, displayName: longMember }],
					},
					{
						recipientKind: "identity",
						identityId: "identity-brian",
						displayName: longIdentity,
						verification: "local",
					},
				],
				effectiveDevices: [{ ...device, displayName: longDevice }],
			};
		});
		const baseIntent = intent();
		mount(
			intent({
				projectRecipients: [],
				identities: baseIntent.identities.map((identity, index) => ({
					...identity,
					displayName: index === 0 ? longMember : longIdentity,
				})),
			}),
			{},
			[
				{
					canonicalProjectIdentity: "git:codemem",
					displayName: longProject,
					existingMemoryCount: 436,
				},
				{
					canonicalProjectIdentity: "git:duplicate-long-project",
					displayName: longProject,
					existingMemoryCount: 1,
				},
			],
		);
		act(() => {
			openRecipientPolicyManagement({ mode: "project-add", projectIds: ["git:codemem"] });
		});
		const teamDescription = checkbox("ExampleCo")
			.closest("label")
			?.querySelector(".recipient-policy-management-description");
		expect(teamDescription?.textContent).toContain(longMember);
		expect(checkbox(longIdentity).closest(".recipient-policy-management-choice")).not.toBeNull();
		act(() => checkbox("ExampleCo").click());
		await reviewSelection();

		for (const name of [longProjectLabel, longTeam, longIdentity, longDevice]) {
			const node = [...document.querySelectorAll(".recipient-policy-management-name")].find(
				(candidate) => candidate.textContent === name,
			);
			expect(node).not.toBeUndefined();
		}
		expect(document.querySelector(".recipient-policy-management-member-names")?.textContent).toBe(
			longMember,
		);
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
		mount(intent({ projectRecipients: [] }));
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

		const alerts = document.querySelectorAll("[role='alert']");
		expect(alerts).toHaveLength(1);
		expect(alerts[0]?.textContent).toBe(
			"Recipient access changed after this review. Review the refreshed changes before trying again.",
		);
		expect(document.querySelector(".recipient-policy-management-status")?.textContent).toBe("");
		expect(checkbox("ExampleCo").checked).toBe(true);
		expect(document.body.textContent).toContain("Review changes");
	});

	it("clears review-ready status when returning to selection", async () => {
		mount(intent({ projectRecipients: [] }));
		act(() => {
			openRecipientPolicyManagement({ mode: "project-add", projectIds: ["git:codemem"] });
		});
		act(() => checkbox("ExampleCo").click());
		await reviewSelection();
		expect(document.querySelector(".recipient-policy-management-status")?.textContent).toContain(
			"Review ready",
		);

		act(() => {
			[...document.querySelectorAll<HTMLButtonElement>("button")]
				.find((button) => button.textContent === "Back")
				?.click();
		});
		expect(document.querySelector(".recipient-policy-management-status")?.textContent).toBe("");
	});

	it("provides labels, live regions, busy state, semantic actions, and neutral opening focus", () => {
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
		const closeButton = document.querySelector<HTMLButtonElement>(
			".modal-close-button.recipient-policy-management-target",
		);
		expect(closeButton?.getAttribute("aria-label")).toBe("Close Update sharing");
		expect(closeButton?.type).toBe("button");
		expect(closeButton?.textContent).toContain("Close");
		expect(closeButton?.querySelector(".modal-close-button-icon")).not.toBeNull();
		const footer = document.querySelector(".modal-footer.recipient-policy-management-actions");
		const cancelButton = actionButton("Cancel");
		const reviewButton = actionButton("Review changes");
		expect(footer?.contains(cancelButton)).toBe(true);
		expect(footer?.contains(reviewButton)).toBe(true);
		expect(cancelButton.type).toBe("button");
		expect(reviewButton.type).toBe("button");

		const props = dialogSpy.mock.calls.at(-1)?.[0] as {
			onOpenAutoFocus: (event: Event) => void;
			onOpenChange: (open: boolean) => void;
		};
		const event = new Event("focus");
		const preventDefault = vi.spyOn(event, "preventDefault");
		props.onOpenAutoFocus(event);
		expect(preventDefault).toHaveBeenCalled();
		expect(document.activeElement).toBe(
			document.getElementById("recipient-policy-management-title"),
		);
		act(() => props.onOpenChange(false));
		expect(document.getElementById("recipientPolicyManagementDialog")).toBeNull();
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

	it("restores focus to the connected opening trigger", () => {
		const trigger = document.getElementById("trigger") as HTMLButtonElement;
		trigger.focus();
		mount();
		act(() => {
			openRecipientPolicyManagement({ mode: "project-manage", projectId: "git:codemem" });
		});
		const props = dialogSpy.mock.calls.at(-1)?.[0] as {
			onCloseAutoFocus: (event: Event) => void;
		};
		const event = new Event("close");
		const preventDefault = vi.spyOn(event, "preventDefault");
		document.getElementById("recipient-policy-management-title")?.focus();
		props.onCloseAutoFocus(event);

		expect(preventDefault).toHaveBeenCalled();
		expect(document.activeElement).toBe(trigger);
	});

	it("blocks duplicate preview submissions before the first request settles", async () => {
		let resolvePreview: ((value: RecipientPolicyEdgePreviewResponseV1) => void) | null = null;
		vi.mocked(api.previewRecipientPolicyEdges).mockImplementationOnce((request) =>
			new Promise((resolve) => {
				resolvePreview = resolve;
			}).then(() => preview(request.changes)),
		);
		mount(intent({ projectRecipients: [] }));
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
		expect(document.querySelector<HTMLButtonElement>(".modal-close-button")?.disabled).toBe(true);

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

	it("renders a realistic non-idempotent conflict with text rather than color-only meaning", async () => {
		vi.mocked(api.commitRecipientPolicyEdges).mockResolvedValueOnce({
			version: 1,
			status: "conflict",
			reviewedPolicyDigest: "policy:digest",
			errorCode: null,
			outcomes: [],
			writeCount: 0,
			idempotent: false,
		});
		mount(intent({ projectRecipients: [] }));
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

		expect(document.getElementById("recipient-policy-management-title")?.textContent).toBe(
			"Recipient access needs attention",
		);
		expect(document.getElementById("recipient-policy-management-description")?.textContent).toBe(
			"Some reviewed recipient access changes were not applied. Review the technical details.",
		);
		expect(document.activeElement).toBe(
			document.getElementById("recipient-policy-management-title"),
		);
		expect(document.body.textContent).toContain("Status: Conflict");
		expect(document.body.textContent).not.toContain("already present");
		expect(document.querySelector(".recipient-policy-management-result summary")?.textContent).toBe(
			"Technical details",
		);
	});
});
