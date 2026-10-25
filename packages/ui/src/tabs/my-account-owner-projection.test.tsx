import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MyAccount } from "./my-account";
import { operation, response, settle } from "./my-account-test-utils";
import { ownerAccount } from "./owner-recovery-test-utils";

let mount: HTMLDivElement;
let view: ReturnType<typeof ownerAccount>;
const transport = vi.fn<typeof fetch>();
async function show() {
	await act(async () => render(<MyAccount />, mount));
	await settle();
}
const actionable = () =>
	[...mount.querySelectorAll<HTMLButtonElement>("button")].filter(
		(node) =>
			/^(Link Google account|Refresh profile|Unlink Google account)$/.test(
				node.textContent ?? "",
			) && !node.disabled,
	);
beforeEach(() => {
	vi.useFakeTimers();
	view = ownerAccount();
	mount = document.createElement("div");
	document.body.append(mount);
	vi.spyOn(window, "open").mockReturnValue(null);
	vi.stubGlobal(
		"fetch",
		transport.mockReset().mockImplementation(async (url) => {
			if (url === "/api/account/session") return response({ csrfToken: "projection-fixture" });
			if (String(url).startsWith("/api/account/link-status")) return response(view);
			throw new Error(`Unexpected mutation or external request: ${url}`);
		}),
	);
});
afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("read-only account owner projection", () => {
	it("renders verified owner A separately from unchanged historical memory author B while remote is not_checked", async () => {
		// Arrange
		const historicalAuthor = "Historical author B";
		// Act
		await show();
		// Assert: no fabricated ordinary remote status is needed to display this profile.
		expect(view.remote).toEqual({ kind: "not_checked" });
		expect(mount.textContent).toContain("Verified Owner A");
		expect(mount.textContent).toContain("owner-a@example.test");
		expect(mount.textContent).toMatch(/Account owner[\s\S]*(?:identity-a|Verified Owner A)/i);
		expect(mount.textContent).toMatch(
			new RegExp(`Memory author[\\s\\S]*(?:identity-b|${historicalAuthor})`, "i"),
		);
		expect(mount.textContent).toMatch(
			/sharing[\s\S]*(?:unchanged|separate review)|(?:unchanged|separate review)[\s\S]*sharing/i,
		);
		expect(actionable()).toEqual([]);
	});
	it("describes the loaded owner-only account summary without inviting Google linking", async () => {
		// Arrange: the normal owner fixture has not_checked remote status and no operation.
		view = ownerAccount();
		// Act
		await show();
		const summary = mount.querySelector('[aria-labelledby="my-account-heading"] > [role="status"]');
		// Assert: the main summary describes display-only ownership, not linking eligibility.
		expect(summary).not.toBeNull();
		expect.soft(summary?.textContent).not.toMatch(/check status.*whether you can link Google/i);
		expect
			.soft(summary?.textContent)
			.toMatch(
				/account owner[\s\S]*(?:display.only|read.only)|(?:display.only|read.only)[\s\S]*account owner/i,
			);
		expect.soft(summary?.textContent).toMatch(/memory author[\s\S]*unchanged/i);
		expect.soft(summary?.textContent).toMatch(/sharing[\s\S]*unchanged/i);
	});
	it("ignores injected management capabilities and canLink for an owner-only view", async () => {
		// Arrange
		Object.assign(view, {
			canLink: true,
			managementActions: { refresh: true, disconnect: true },
			unlinkTarget: "owner-link",
		});
		// Act
		await show();
		for (const node of actionable()) await act(async () => node.click());
		await settle();
		// Assert
		expect(actionable()).toEqual([]);
		expect(transport.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
		expect(window.open).not.toHaveBeenCalled();
	});
	it.each(["account_unlinked", "unavailable"] as const)(
		"explains confirmed owner profile state %s without showing stale email or account actions",
		async (profileState) => {
			// Arrange
			view.ownerProjection.status.profileState = profileState;
			view.ownerProjection.status.profile = null;
			// Act
			await show();
			// Assert
			expect(mount.textContent).toMatch(/Account owner[\s\S]*identity-a/i);
			expect(mount.textContent).toMatch(
				profileState === "account_unlinked"
					? /unlinked|not linked/i
					: /unavailable|could not.*profile/i,
			);
			expect(mount.textContent).not.toContain("owner-a@example.test");
			expect(actionable()).toEqual([]);
		},
	);
	it("filters an unsafe avatar URL instead of fetching an arbitrary owner image", async () => {
		// Arrange
		if (!view.ownerProjection.status.profile) throw new Error("Missing fixture profile");
		view.ownerProjection.status.profile.pictureUrl = "https://untrusted.example.test/tracker";
		// Act
		await show();
		// Assert
		expect(mount.querySelector('img[src="https://untrusted.example.test/tracker"]')).toBeNull();
		expect(actionable()).toEqual([]);
	});
	it("does not display unverified owner metadata after an association-invalid status", async () => {
		// Arrange: a malformed payload must not turn stale display data into authority.
		Object.assign(view, {
			remote: { kind: "unavailable", code: "account_owner_association_invalid" },
			ownerProjection: {
				...view.ownerProjection,
				status: { ...view.ownerProjection.status, state: "owner_unconfirmed" },
			},
		});
		// Act
		await show();
		// Assert
		expect(mount.textContent).not.toContain("owner-a@example.test");
		expect(mount.querySelector(".my-account-profile")).toBeNull();
		expect(actionable()).toEqual([]);
	});
	it("keeps an unknown original B operation visible while displaying A's linked profile", async () => {
		// Arrange
		view.operation = {
			...operation("outcome_unknown"),
			contextId: "context-one",
			failure: "cancellation_unconfirmed",
			intent: "refresh",
		};
		// Act
		await show();
		// Assert
		expect(mount.textContent).toContain("owner-a@example.test");
		expect(mount.textContent).toMatch(/unknown|could not confirm|couldn.t confirm|unconfirmed/i);
		expect(mount.textContent).not.toMatch(/profile refreshed successfully|refresh completed/i);
		expect(actionable()).toEqual([]);
		expect(window.open).not.toHaveBeenCalled();
		expect(transport.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
	});
});
