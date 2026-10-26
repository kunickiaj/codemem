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
	it("names both Identities and where account changes work, without the owner's Google profile", async () => {
		// Arrange: this device runs as B; the coordinator confirmed A as the account owner.
		view.accountOwner = { ...view.accountOwner, displayName: "Owner A" };
		// Act
		await show();
		const summary = mount.querySelector('[aria-labelledby="my-account-heading"] > [role="status"]');
		// Assert
		expect(view.remote).toEqual({ kind: "not_checked" });
		expect(summary?.textContent).toBe(
			"This device runs as Historical author B, but the Google account belongs to Owner A. To refresh or unlink it, use a device that runs as Owner A.",
		);
		expect(mount.querySelector(".my-account-profile")).toBeNull();
		expect(mount.textContent).not.toContain("owner-a@example.test");
		expect(mount.textContent).not.toContain("Verified Owner A");
		expect(mount.querySelector("img")).toBeNull();
		expect(mount.textContent).not.toMatch(
			/\(unchanged\)|read-only|Memory author|Sharing access is unchanged/i,
		);
		expect(actionable()).toEqual([]);
	});
	it("falls back to a generic owner name when the owner has no local People name", async () => {
		// Act
		await show();
		// Assert
		expect(mount.textContent).toContain("use a device that runs as the account owner");
		expect(mount.textContent).not.toContain("identity-a");
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
			expect(mount.textContent).toMatch(
				profileState === "account_unlinked" ? /no linked Google account/i : /unavailable/i,
			);
			expect(mount.textContent).not.toContain("owner-a@example.test");
			expect(actionable()).toEqual([]);
		},
	);
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
	it("keeps an unknown original B operation visible in the owner-only state", async () => {
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
		expect(mount.textContent).not.toContain("owner-a@example.test");
		expect(mount.textContent).toMatch(/unknown|could not confirm|couldn.t confirm|unconfirmed/i);
		expect(mount.textContent).not.toMatch(/profile refreshed successfully|refresh completed/i);
		expect(actionable()).toEqual([]);
		expect(window.open).not.toHaveBeenCalled();
		expect(transport.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
	});
});
