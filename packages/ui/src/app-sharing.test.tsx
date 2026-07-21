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
		const loadProjects = vi.fn().mockResolvedValue(projects);
		const loadIntent = vi.fn().mockResolvedValue(intent);
		const load = createRecipientPolicySharingLoader({ loadIntent, loadProjects });

		await act(async () => load());
		act(() => button("Identities").click());
		expect(document.body.textContent).toContain("Manage projects");
		act(() => button("Manage projects").click());
		expect(document.body.textContent).toContain("Review changes");

		loadIntent.mockRejectedValueOnce(new Error("refresh failed"));
		await act(async () => load());
		expect(document.body.textContent).toContain(
			"Sharing details are unavailable. Refresh and try again.",
		);
		expect(document.body.textContent).toContain(
			"The complete recipient access inventory is unavailable. Refresh and try again.",
		);
		expect(document.body.textContent).not.toContain("Manage projects");
		expect(document.body.textContent).not.toContain("Review changes");

		await act(async () => load());
		expect(document.body.textContent).toContain("Manage projects");
		expect(document.body.textContent).toContain("Review changes");
		expect(document.body.textContent).not.toContain("Sharing details are unavailable");
	});
});
