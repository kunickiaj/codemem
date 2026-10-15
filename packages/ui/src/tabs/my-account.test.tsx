import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountOperation, AccountView } from "../lib/api/account";
import { MyAccount } from "./my-account";
import {
	deferred,
	operation,
	privateUrl,
	response,
	settle,
	status,
	tick,
} from "./my-account-test-utils";

const transport = vi.fn<typeof fetch>();
let view: AccountView;
let mount: HTMLDivElement;
let popup: {
	opener: unknown;
	closed: boolean;
	close: ReturnType<typeof vi.fn>;
	location: { replace: ReturnType<typeof vi.fn> };
};
const buttons = () => [...mount.querySelectorAll<HTMLButtonElement>("button")];
function button(name: string) {
	const found = buttons().find((node) => node.textContent === name);
	if (!found) throw new Error(`Missing button: ${name}`);
	return found;
}
const show = async () => {
	await act(async () => {
		render(<MyAccount />, mount);
	});
	await settle();
};
const click = async (name: string) => {
	await act(async () => {
		button(name).click();
	});
	await settle();
};
const calls = (suffix: string) =>
	transport.mock.calls.filter(([url]) => String(url).endsWith(suffix));
beforeEach(() => {
	vi.useFakeTimers();
	view = status();
	mount = document.createElement("div");
	document.body.append(mount);
	popup = { opener: {}, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
	vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
	vi.stubGlobal(
		"fetch",
		transport.mockReset().mockImplementation(async (url) => {
			if (url === "/api/account/session")
				return response({ version: 1, csrfToken: "fixture-token" });
			if (String(url).includes("link-status")) return response(view);
			if (String(url).endsWith("browser-url")) return response({ version: 1, url: privateUrl });
			return response({ version: 1, operation: operation(), current: true });
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

describe("My Account safe operator review guidance", () => {
	it.each([
		"group with spaces",
		"group'\"quotes",
		"$(touch marker)",
		"`touch marker`",
		"group;touch marker",
	])("keeps review guidance command fixed for group %s", async (groupId) => {
		view = status({
			selectedGroupId: groupId,
			groups: [groupId],
			canLink: false,
			remote: {
				kind: "status",
				coordinatorId: "coordinator-one",
				identityId: null,
				identityMatches: false,
				state: "review_required",
				account: {},
			},
		});
		await show();
		expect(mount.textContent).toContain('codemem coordinator review-device-owner "your-group".');
		expect(mount.textContent).toContain('Replace "your-group" with your group argument');
		expect(mount.textContent).not.toContain(groupId);
		expect(mount.textContent).toContain(
			"exact database, config, coordinator and environment settings (including the keys directory)",
		);
	});
});

describe("My Account read-only status", () => {
	it("explains a foreign active operation without exposing its details or enabling linking", async () => {
		// Arrange: the selected group's unlinked status is not permission to start another job.
		view = status({ blockedReason: "operation_active", operation: null, canLink: false });
		// Act
		await show();
		// Assert
		expect(mount.textContent).toContain("Another account link is running in this Viewer");
		expect(button("Link Google account").disabled).toBe(true);
		expect(buttons().some((node) => node.textContent === "Cancel linking")).toBe(false);
		expect(mount.innerHTML).not.toContain("op-one");
		expect(mount.innerHTML).not.toContain("private-fixture");
		expect(calls("browser-url")).toHaveLength(0);
	});
	it("shows verified account, local device and coordinator without account administration", async () => {
		// Arrange
		view = status({
			canLink: false,
			remote: {
				kind: "status",
				coordinatorId: "coordinator-one",
				identityId: "identity-one",
				identityMatches: true,
				state: "linked",
				account: { displayName: "Example Person", email: "person@example.test" },
			},
		});
		// Act
		await show();
		// Assert
		expect(mount.textContent).toContain("My Account");
		for (const text of [
			"Example Person",
			"person@example.test",
			"Local identity",
			"Laptop",
			"https://coordinator.example",
		])
			expect(mount.textContent).toContain(text);
		expect(
			buttons()
				.filter((node) => !node.disabled)
				.map((node) => node.textContent),
		).toEqual(["Check status"]);
		expect(mount.querySelector('[role="status"][aria-live="polite"]')).not.toBeNull();
	});
	it.each([
		"review_required",
		"revoked",
		"conflict",
		"mismatch",
		"linked_mismatch",
		"offline",
		"unsupported",
	])("never treats %s as unlinked", async (state) => {
		// Arrange
		const remote: AccountView["remote"] = {
			kind: "status",
			coordinatorId: "coordinator-one",
			identityId: state === "review_required" ? null : "identity-one",
			identityMatches: !["mismatch", "linked_mismatch", "review_required", "conflict"].includes(
				state,
			),
			state: "unlinked",
			account: { displayName: "Unverified secret", email: "unverified@example.test" },
		};
		if (state === "review_required" || state === "revoked" || state === "conflict")
			remote.state = state;
		if (state === "linked_mismatch") remote.state = "linked";
		view = status({ canLink: false, remote });
		if (state === "offline") view.remote = { kind: "unavailable", code: "network" };
		if (state === "unsupported") view.remote = { kind: "unsupported" };
		// Act
		await show();
		// Assert
		expect(button("Link Google account").disabled).toBe(true);
		expect(mount.textContent).not.toContain("No Google account is linked");
		expect(mount.textContent).not.toContain("Unverified secret");
		expect(mount.textContent).not.toContain("unverified@example.test");
		if (state === "review_required") {
			expect(mount.textContent).toContain("review-device-owner");
			expect(mount.textContent).toContain(
				"Reuse the exact database, config, coordinator and environment settings (including the keys directory) used to start this Viewer",
			);
			expect(mount.textContent).toContain("Example only, with those same selections");
			expect(mount.textContent).toContain("Confirmation defaults to No");
			expect(mount.textContent).not.toContain("enroll-owner");
		}
		if (state === "conflict") expect(mount.textContent).toContain("conflicting account link");
	});
	it("requires explicit group selection rather than choosing the first group", async () => {
		// Arrange
		view = status({
			groups: ["group-one", "group-two"],
			selectedGroupId: null,
			setup: "group_selection_required",
			canLink: false,
		});
		// Act
		await show();
		// Assert
		expect(mount.querySelector<HTMLSelectElement>("select")?.value).toBe("");
		expect(mount.querySelector('label[for="my-account-group"]')?.textContent).toBe("Group");
		expect(button("Link Google account").disabled).toBe(true);
	});
});

describe("My Account retained outcomes and current guidance", () => {
	it.each(["review_required", "mismatch"] as const)(
		"keeps the retained outcome and fresh %s guidance visible",
		async (state) => {
			// Arrange: a retained terminal job must not hide the current reason linking is blocked.
			view = status({
				canLink: false,
				operation: operation(state === "review_required" ? "outcome_unknown" : "failed"),
				remote: {
					kind: "status",
					coordinatorId: "coordinator-one",
					identityId: null,
					identityMatches: false,
					state: state === "review_required" ? "review_required" : "unlinked",
					account: { displayName: "Unverified secret", email: "unverified@example.test" },
				},
			});
			// Act
			await show();
			await click("Check status");
			// Assert
			expect(mount.textContent).toContain(
				state === "review_required"
					? "couldn’t confirm whether linking finished"
					: "Linking did not finish",
			);
			expect(mount.textContent).toContain(
				state === "review_required" ? "review-device-owner" : "does not match this local Identity",
			);
			expect(button("Link Google account").disabled).toBe(true);
			expect(mount.textContent).not.toContain("Unverified secret");
			expect(mount.textContent).not.toContain("unverified@example.test");
		},
	);
	it("explains link-conflict recovery without offering account replacement controls", async () => {
		// Arrange: fresh status is unlinked, but the retained failed attempt has a specific cause.
		view = status({ operation: { ...operation("failed"), failure: "link_conflict" } });
		// Act
		await show();
		// Assert
		expect(mount.textContent).toContain("Ask the coordinator operator");
		expect(mount.textContent).toContain("cannot replace links or move Identities");
		expect(
			buttons().some((node) => /rename|unlink|replace|move/i.test(node.textContent ?? "")),
		).toBe(false);
		expect(calls("browser-url")).toHaveLength(0);
	});
});

describe("My Account linking lifecycle", () => {
	it.each(["starting", "awaiting_browser"] as const)(
		"ignores repeated status clicks during %s and retains one browser delivery",
		async (state) => {
			vi.mocked(window.open).mockReturnValue(null);
			view = status({ operation: operation(state), canLink: false });
			await show();
			for (let attempt = 0; attempt < 6; attempt++) await click("Check status");
			expect(button("Check status").disabled).toBe(true);
			expect(calls("link-status")).toHaveLength(1);
			expect(button("Cancel linking").disabled).toBe(false);
			if (state === "starting") {
				transport.mockResolvedValueOnce(
					response({ version: 1, current: true, operation: operation("awaiting_browser") }),
				);
				await tick();
			}
			expect(button("Open Google sign-in").disabled).toBe(false);
			expect(calls("browser-url")).toHaveLength(1);
			expect(calls("browser-url")[0]?.[1]?.method).toBe("POST");
			await click("Open Google sign-in");
			expect(window.open).toHaveBeenCalledWith(privateUrl, "_blank", "noopener,noreferrer");
			expect(mount.innerHTML).not.toContain("private-fixture");
		},
	);
	it.each(["starting", "awaiting_browser"] as const)(
		"locks group selection during %s without losing Cancel or browser delivery",
		async (state) => {
			vi.mocked(window.open).mockReturnValue(null);
			view = status({
				groups: ["group-one", "group-two"],
				operation: operation(state),
				canLink: false,
			});
			await show();
			const select = mount.querySelector<HTMLSelectElement>("select");
			if (!select) throw new Error("Missing group selector");
			expect(select.disabled).toBe(true);
			await act(async () => {
				select.value = "group-two";
				select.dispatchEvent(new Event("change", { bubbles: true }));
			});
			await settle();
			expect(calls("link-status?group_id=group-two")).toHaveLength(0);
			expect(button("Cancel linking").disabled).toBe(false);
			expect(calls("/cancel")).toHaveLength(0);
			if (state === "awaiting_browser") {
				await click("Open Google sign-in");
				expect(window.open).toHaveBeenCalledWith(privateUrl, "_blank", "noopener,noreferrer");
			}
			await click("Cancel linking");
			expect(calls("/cancel")).toHaveLength(1);
		},
	);
	it("reserves a blank popup synchronously, clears opener and waits for browser readiness", async () => {
		// Arrange
		view = status({ groups: ["group-one", "group-two"] });
		await show();
		const pending = deferred<Response>();
		transport.mockImplementationOnce(() => pending.promise);
		// Act
		act(() => button("Link Google account").click());
		// Assert: no awaited work or protected navigation precedes popup isolation.
		expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
		expect(popup.opener).toBeNull();
		expect(popup.location.replace).not.toHaveBeenCalled();
		expect(button("Link Google account").disabled).toBe(true);
		expect(mount.querySelector<HTMLSelectElement>("select")?.disabled).toBe(true);
		await act(async () => {
			pending.resolve(response({ version: 1, operation: operation() }));
		});
		await settle();
		expect(calls("browser-url")).toHaveLength(0);
		transport.mockResolvedValueOnce(
			response({ version: 1, current: true, operation: operation("awaiting_browser") }),
		);
		await tick();
		expect(popup.location.replace).toHaveBeenCalledWith(privateUrl);
		expect(mount.innerHTML).not.toContain("private-fixture");
		expect(mount.textContent).toContain("does not grant sharing access");
		await click("Check status");
		expect(popup.close).not.toHaveBeenCalled();
	});
	it("uses an explicit synchronous fallback with noopener, without re-fetching private URLs", async () => {
		// Arrange
		vi.mocked(window.open).mockReturnValue(null);
		view = status({ operation: operation("awaiting_browser"), canLink: false });
		await show();
		// Act
		await click("Open Google sign-in");
		// Assert: null is the normal noopener return, not an opening failure.
		expect(window.open).toHaveBeenCalledWith(privateUrl, "_blank", "noopener,noreferrer");
		expect(mount.textContent).not.toContain("could not be opened");
		expect(mount.innerHTML).not.toContain("private-fixture");
		expect(window.location.href).not.toContain("private-fixture");
		await tick();
		await tick();
		expect(calls("browser-url")).toHaveLength(1);
	});
	it.each([
		"https://other.example/auth/link/start",
		"https://coordinator.example/auth/link/start#secret",
	])("never opens invalid private URL %s", async (url) => {
		// Arrange
		view = status({ operation: operation("awaiting_browser"), canLink: false });
		transport.mockImplementation(async (path) =>
			String(path).endsWith("browser-url") ? response({ version: 1, url }) : response(view),
		);
		// Act
		await show();
		// Assert
		expect(window.open).not.toHaveBeenCalled();
		expect(popup.location.replace).not.toHaveBeenCalled();
		expect(mount.textContent).toContain("Check status");
	});
});

describe("My Account configured coordinator browser origins", () => {
	it.each([
		["http://127.0.0.1:8787", "http://127.0.0.1:8787", true],
		["http://[::1]:8787", "http://[::1]:8787", true],
		["http://localhost:8787", "http://localhost:8787", false],
		["http://coordinator.example", "http://coordinator.example", false],
		["http://127.0.0.1:8787", "http://127.0.0.1:8788", false],
		["http://127.0.0.1:8787", "http://[::1]:8787", false],
	])("opens %s only when its URL origin %s is allowed: %s", async (origin, urlOrigin, allowed) => {
		// Arrange: literal loopback HTTP is allowed only for this exact configured origin.
		const url = `${urlOrigin}/auth/link/start?code=private-fixture`;
		view = status({
			coordinator: { origin },
			operation: operation("awaiting_browser"),
			canLink: false,
		});
		transport.mockImplementation(async (path) =>
			String(path).endsWith("browser-url") ? response({ version: 1, url }) : response(view),
		);
		await show();
		// Act: the private URL is opened only by an explicit user click after reload.
		if (allowed) await click("Open Google sign-in");
		// Assert
		if (allowed) {
			expect(window.open).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
			expect(mount.textContent).toContain("on this computer");
		} else {
			expect(window.open).not.toHaveBeenCalled();
			expect(buttons().some((node) => node.textContent === "Open Google sign-in")).toBe(false);
		}
		expect(mount.innerHTML).not.toContain("private-fixture");
		expect(window.location.href).not.toContain("private-fixture");
	});
});

describe("My Account uncertain cancellation recovery", () => {
	it("offers explicit previous-link cancellation after drift without attaching its account or URL", async () => {
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		vi.mocked(window.open).mockReturnValue(null);
		view = status({ operation: operation("awaiting_browser"), canLink: false });
		await show();
		transport.mockResolvedValueOnce(
			response({ operation: operation("awaiting_browser"), current: false }),
		);
		view = status({
			contextId: "context-two",
			selectedGroupId: "group-two",
			groups: ["group-two", "group-three"],
			blockedReason: "operation_active",
			canLink: false,
			local: {
				deviceId: "device-two",
				fingerprint: "fingerprint-two",
				identityId: "identity-two",
				identityLabel: "New identity",
			},
		});
		await tick();
		expect(mount.textContent).toContain("New identity");
		expect(mount.textContent).not.toContain("Local identity");
		expect(mount.textContent).toContain("earlier link may still finish for its original Identity");
		expect(button("Cancel previous link").disabled).toBe(false);
		expect(button("Check status").disabled).toBe(false);
		expect(mount.querySelector<HTMLSelectElement>("select")?.disabled).toBe(false);
		expect(buttons().some((node) => node.textContent === "Open Google sign-in")).toBe(false);
		expect(calls("/cancel")).toHaveLength(0);
		transport.mockResolvedValueOnce(response({ operation: operation("cancelled") }));
		await click("Cancel previous link");
		expect(calls("/cancel")).toHaveLength(1);
		expect(buttons().some((node) => node.textContent === "Cancel previous link")).toBe(false);
		expect(calls("browser-url")).toHaveLength(1);
		expect(mount.innerHTML).not.toContain("private-fixture");
		expect(window.open).not.toHaveBeenCalled();
	});
	it("keeps status and cancellation available when polling remains unavailable past its deadline", async () => {
		vi.setSystemTime(new Date("2026-01-01T00:04:59Z"));
		view = status({ operation: operation("awaiting_browser"), canLink: false });
		await show();
		transport.mockRejectedValueOnce(new TypeError("offline"));
		await tick();
		await tick();
		expect(button("Cancel previous link").disabled).toBe(false);
		expect(button("Check status").disabled).toBe(false);
		expect(buttons().some((node) => node.textContent === "Open Google sign-in")).toBe(false);
		expect(calls("/op-one")).toHaveLength(1);
	});
	it("keeps polling after a lost cancellation reply until verified status resolves linking", async () => {
		vi.mocked(window.open).mockReturnValue(null);
		view = status({ operation: operation("awaiting_browser"), canLink: false });
		await show();
		expect(calls("browser-url")).toHaveLength(1);
		transport.mockRejectedValueOnce(new TypeError("private-cancel-failure"));
		await click("Cancel linking");
		expect(button("Check status").disabled).toBe(true);
		expect(button("Cancel linking").disabled).toBe(false);
		expect(mount.textContent).toContain("Cancellation could not be confirmed");
		expect(mount.textContent).not.toContain("private-cancel-failure");
		expect(buttons().some((node) => node.textContent === "Open Google sign-in")).toBe(false);
		transport.mockResolvedValueOnce(
			response({ version: 1, current: true, operation: operation("awaiting_browser") }),
		);
		await tick();
		expect(calls("/op-one")).toHaveLength(1);
		transport.mockResolvedValueOnce(
			response({ version: 1, current: true, operation: operation("succeeded") }),
		);
		view = status({
			canLink: false,
			remote: {
				kind: "status",
				coordinatorId: "coordinator-one",
				identityId: "identity-one",
				identityMatches: true,
				state: "linked",
				account: { email: "verified@example.test" },
			},
		});
		await tick();
		expect(calls("/op-one")).toHaveLength(2);
		expect(calls("link-status")).toHaveLength(2);
		expect(mount.textContent).toContain("verified@example.test");
		expect(button("Check status").disabled).toBe(false);
		expect(calls("/cancel")).toHaveLength(1);
		expect(calls("link-operations")).toHaveLength(0);
		expect(calls("browser-url")).toHaveLength(1);
		expect(window.open).not.toHaveBeenCalled();
	});
});

describe("My Account recovery", () => {
	it("resumes from status without storage and reloads verified account on terminal success", async () => {
		// Arrange
		const storage = vi.spyOn(Storage.prototype, "setItem");
		view = status({ operation: operation(), canLink: false });
		await show();
		transport.mockResolvedValueOnce(
			response({ version: 1, current: true, operation: operation("succeeded") }),
		);
		view = status({
			canLink: false,
			remote: {
				kind: "status",
				coordinatorId: "coordinator-one",
				identityId: "identity-one",
				identityMatches: true,
				state: "linked",
				account: { email: "verified@example.test" },
			},
		});
		// Act
		await tick();
		await tick();
		// Assert
		expect(mount.textContent).toContain("verified@example.test");
		expect(calls("/op-one")).toHaveLength(1);
		expect(calls("link-status")).toHaveLength(2);
		expect(storage).not.toHaveBeenCalled();
		expect(calls("link-operations")).toHaveLength(0);
	});
	it("does not retry a lost start reply and redacts transport errors", async () => {
		// Arrange
		await show();
		transport.mockRejectedValueOnce(new Error("private-raw-token"));
		// Act
		await click("Link Google account");
		await tick();
		// Assert
		expect(calls("link-operations")).toHaveLength(1);
		expect(mount.textContent).not.toContain("private-raw-token");
		expect(mount.textContent).toContain("Check status");
		expect(popup.close).toHaveBeenCalled();
	});
	it.each(["starting", "outcome_unknown"] as const)(
		"reports %s cancellation without claiming nothing changed",
		async (state) => {
			// Arrange
			view = status({ operation: operation(), canLink: false });
			await show();
			const result = {
				...operation(state),
				failure: state === "outcome_unknown" ? "cancellation_unconfirmed" : null,
			};
			transport.mockResolvedValueOnce(response({ version: 1, operation: result }));
			if (state === "outcome_unknown")
				view = status({ operation: result as AccountOperation, canLink: false });
			// Act
			await click("Cancel linking");
			// Assert
			expect(calls("/cancel")).toHaveLength(1);
			expect(mount.textContent).toContain("Check status");
			expect(mount.textContent).not.toContain("nothing changed");
		},
	);
});
