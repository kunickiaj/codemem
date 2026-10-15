import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as account from "../lib/api/account";
import type { RecipientPolicyIntentGraphV1 } from "../lib/api/sync";
import { deferred, operation, privateUrl, settle, status } from "./my-account-test-utils";
import {
	mountRecipientPolicySharing,
	type RecipientPolicySharingOptions,
} from "./recipient-policy-sharing";

vi.mock("../lib/api/account", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/api/account")>()),
	getAccountStatus: vi.fn(),
	startAccountLink: vi.fn(),
	getAccountOperation: vi.fn(),
	getAccountBrowserUrl: vi.fn(),
	cancelAccountLink: vi.fn(),
}));

const graph: RecipientPolicyIntentGraphV1 = {
	version: 1,
	identities: [
		{
			version: 1,
			identityId: "identity-one",
			displayName: "Local identity",
			kind: "personal",
			verification: "local",
			status: "active",
			mergedIntoIdentityId: null,
		},
	],
	teams: [{ version: 1, teamId: "team-one", displayName: "Example Team", status: "active" }],
	teamMemberships: [],
	identityDevices: [],
	projectRecipients: [],
};
let mount: HTMLDivElement;
function required<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("Required Sharing test element or request is missing");
	return value;
}
const card = () =>
	required(mount.querySelector<HTMLElement>('section[aria-labelledby="my-account-heading"]'));
const tabs = () => [...mount.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
function button(name: string) {
	const found = [...card().querySelectorAll<HTMLButtonElement>("button")].find(
		(node) => node.textContent === name,
	);
	if (!found) throw new Error(`Missing account button: ${name}`);
	return found;
}
async function show(options: RecipientPolicySharingOptions = {}, intent = graph) {
	await act(async () => mountRecipientPolicySharing(mount, [], intent, options));
	await settle();
}
async function click(name: string) {
	await act(async () => button(name).click());
	await settle();
}
function assertSharingNavigation() {
	const [teams, identities, received] = tabs();
	act(() => teams.click());
	act(() => {
		teams.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
	});
	expect(identities.getAttribute("aria-selected")).toBe("true");
	expect(document.activeElement).toBe(identities);
	act(() => received.click());
	expect(received.getAttribute("aria-selected")).toBe("true");
	expect(
		mount.querySelector<HTMLElement>(`#${received.getAttribute("aria-controls")}`)?.hidden,
	).toBe(false);
	act(() => teams.click());
	expect(teams.getAttribute("aria-selected")).toBe("true");
}
function assertNoAccountWrites() {
	expect(account.startAccountLink).not.toHaveBeenCalled();
	expect(account.cancelAccountLink).not.toHaveBeenCalled();
	expect(account.getAccountBrowserUrl).not.toHaveBeenCalled();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetAllMocks();
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network request");
		}),
	);
	vi.mocked(account.getAccountStatus).mockResolvedValue(status());
	vi.mocked(account.startAccountLink).mockResolvedValue({ version: 1, operation: operation() });
	vi.mocked(account.getAccountBrowserUrl).mockResolvedValue({ version: 1, url: privateUrl });
	vi.spyOn(window, "open").mockReturnValue(null);
	mount = document.createElement("div");
	document.body.append(mount);
});
afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("My Account inside Sharing", () => {
	it("places a uniquely labelled independent card before the unchanged recipient views", async () => {
		// Arrange
		const expectedLabels = ["Teams 1", "Identities 1", "From other devices 0", "Invitations"];
		// Act
		await show();
		// Assert: the actual child is not part of the recipient tab panels.
		const heading = required(card().querySelector("h3"));
		expect(heading.textContent).toBe("My Account");
		expect(mount.querySelectorAll(`#${heading.id}`)).toHaveLength(1);
		expect(card().getAttribute("aria-labelledby")).toBe(heading.id);
		const tablist = required(mount.querySelector('[role="tablist"][aria-label="Sharing views"]'));
		expect(heading.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
		for (const panel of mount.querySelectorAll('[role="tabpanel"]')) {
			expect(heading.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
		}
		expect(tabs().map((tab) => tab.textContent)).toEqual(expectedLabels);
		expect(card().closest('[role="tabpanel"]')).toBeNull();
		expect(card().querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
		expect(account.getAccountStatus).toHaveBeenCalledTimes(1);
		expect(account.getAccountOperation).not.toHaveBeenCalled();
		assertNoAccountWrites();
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each(["loading", "loadError", "refreshError"] as const)(
		"keeps account status and refresh independent of Sharing %s",
		async (state) => {
			// Arrange
			await show({ [state]: true });
			const heading = card().querySelector("h3");
			// Act
			await click("Check status");
			// Assert: account refresh neither remounts nor changes the recipient error/loading state.
			expect(card().querySelector("h3")).toBe(heading);
			expect(card().textContent).toContain("No Google account is linked");
			expect(account.getAccountStatus).toHaveBeenCalledTimes(2);
			expect(
				mount.querySelector(".recipient-policy-sharing-state, .loading-card-list"),
			).not.toBeNull();
			assertSharingNavigation();
			assertNoAccountWrites();
		},
	);

	it.each(["pending", "unavailable", "unsupported", "review_required"] as const)(
		"does not gate Sharing navigation or project actions on account %s",
		async (state) => {
			// Arrange
			const onReviewDevices = vi.fn();
			if (state === "pending")
				vi.mocked(account.getAccountStatus).mockReturnValue(
					deferred<account.AccountView>().promise,
				);
			if (state === "unavailable")
				vi.mocked(account.getAccountStatus).mockRejectedValue(
					new account.AccountRequestError(503, "request_failed"),
				);
			if (state === "unsupported")
				vi.mocked(account.getAccountStatus).mockResolvedValue(
					status({ canLink: false, remote: { kind: "unsupported" } }),
				);
			if (state === "review_required")
				vi.mocked(account.getAccountStatus).mockResolvedValue(
					status({
						canLink: false,
						remote: {
							kind: "status",
							coordinatorId: "coordinator-one",
							identityId: null,
							identityMatches: false,
							state: "review_required",
							account: null,
						},
					}),
				);
			// Act
			await show({ coordinatorEnrollmentIssueCount: 1, onReviewDevices });
			act(() =>
				required(
					mount.querySelector<HTMLButtonElement>(
						'aside[aria-labelledby="sharing-coordinator-reconciliation-heading"] button',
					),
				).click(),
			);
			// Assert
			expect(onReviewDevices).toHaveBeenCalledExactlyOnceWith();
			assertSharingNavigation();
			const manage = mount.querySelector<HTMLButtonElement>(
				'button[aria-label="Manage projects for Example Team"]',
			);
			expect(manage).not.toBeNull();
			expect(manage?.disabled).toBe(false);
			expect(card().querySelector('[role="status"]')?.textContent).toBeTruthy();
			if (state === "pending") expect(card().textContent).toContain("Checking account status");
			if (state === "unavailable") expect(card().textContent).toContain("unavailable right now");
			if (state === "review_required") {
				expect(card().querySelector('[role="status"]')?.textContent).toBe(
					"This device needs a one-time owner review before Google sign-in.",
				);
				const details = required(card().querySelector("details"));
				expect(details.open).toBe(false);
				expect(details.querySelector("summary")?.textContent).toBe("How to approve this device");
				expect(details.querySelector("code")?.textContent).toBe(
					'codemem coordinator review-device-owner "your-group"',
				);
				expect(card().textContent).not.toContain("review-device-owner group-one");
				expect(card().textContent).not.toContain("enroll-owner");
			} else expect(card().querySelector("details")).toBeNull();
			assertNoAccountWrites();
		},
	);
});

describe("My Account data and lifetime inside Sharing", () => {
	it.each([true, false])(
		"shows Google account data only for a matched Identity (%s)",
		async (identityMatches) => {
			// Arrange
			vi.mocked(account.getAccountStatus).mockResolvedValue(
				status({
					canLink: false,
					remote: {
						kind: "status",
						coordinatorId: "coordinator-one",
						identityId: "identity-one",
						identityMatches,
						state: "linked",
						account: { displayName: "Example Person", email: "fake@example.test" },
					},
				}),
			);
			// Act
			await show();
			// Assert
			expect(card().textContent?.includes("fake@example.test")).toBe(identityMatches);
			expect(card().textContent?.includes("Example Person")).toBe(identityMatches);
			for (const text of ["Local identity", "Laptop", "https://coordinator.example"])
				expect(card().textContent).toContain(text);
			expect(button("Link Google account").disabled).toBe(true);
			expect(card().querySelector("input, select, textarea")).toBeNull();
			expect(card().textContent).not.toMatch(/rename|unlink|administrator/i);
			assertNoAccountWrites();
		},
	);

	it.each([true, false])(
		"honors server canLink=%s without automatically starting",
		async (canLink) => {
			// Arrange
			vi.mocked(account.getAccountStatus).mockResolvedValue(status({ canLink }));
			// Act
			await show();
			// Assert
			expect(button("Link Google account").disabled).toBe(!canLink);
			expect(window.open).not.toHaveBeenCalled();
			assertNoAccountWrites();
		},
	);

	it("retains an active account flow and private URL delivery across Sharing rerenders", async () => {
		// Arrange
		vi.mocked(account.startAccountLink).mockResolvedValue({
			version: 1,
			operation: operation("awaiting_browser"),
		});
		await show();
		await click("Link Google account");
		const originalCard = card();
		// Act: both data and options change while the same Sharing mount remains alive.
		await show({ refreshError: true }, { ...graph, identities: [...graph.identities] });
		// Assert
		expect(card()).toBe(originalCard);
		expect(button("Cancel linking").disabled).toBe(false);
		expect(button("Open Google sign-in")).toBeTruthy();
		expect(account.getAccountStatus).toHaveBeenCalledTimes(1);
		expect(account.startAccountLink).toHaveBeenCalledExactlyOnceWith(
			"group-one",
			"context-one",
			expect.any(AbortSignal),
		);
		expect(account.getAccountBrowserUrl).toHaveBeenCalledTimes(1);
		expect(card().innerHTML).not.toContain(privateUrl);
		expect(account.cancelAccountLink).not.toHaveBeenCalled();
	});

	it("aborts a local pending status request on unmount without backend cancellation", async () => {
		// Arrange
		const pending = deferred<account.AccountView>();
		vi.mocked(account.getAccountStatus).mockReturnValue(pending.promise);
		await show();
		const signal = required(vi.mocked(account.getAccountStatus).mock.calls[0][1]);
		expect(signal.aborted).toBe(false);
		// Act
		act(() => render(null, mount));
		pending.resolve(status());
		await settle();
		// Assert
		expect(signal.aborted).toBe(true);
		expect(mount.textContent).toBe("");
		assertNoAccountWrites();
	});
});
