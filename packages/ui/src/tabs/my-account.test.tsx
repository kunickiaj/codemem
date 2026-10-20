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
function statusIdentity(state: string): {
	identityId: string | null;
	authority: "device_claim" | null;
} {
	if (["review_required", "conflict"].includes(state)) return { identityId: null, authority: null };
	return { identityId: "identity-one", authority: "device_claim" };
}
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
function assertIsolatedPopup(url: string) {
	expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
	expect(popup.opener).toBeNull();
	expect(popup.location.replace).toHaveBeenCalledWith(url);
}
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
	])("keeps review recovery free of admin commands for group %s", async (groupId) => {
		// Arrange: group arguments must never become executable example text.
		view = status({
			selectedGroupId: groupId,
			groups: [groupId],
			canLink: false,
			remote: {
				kind: "status",
				coordinatorId: "coordinator-one",
				identityId: null,
				authority: null,
				identityMatches: false,
				state: "review_required",
				account: {},
			},
		});
		// Act
		await show();
		// Assert
		expect(mount.textContent).toMatch(/profile/i);
		expect(mount.textContent).toMatch(/group/i);
		expect(mount.textContent).toMatch(/operator|person who runs/i);
		expect(mount.textContent).toMatch(/device|binding/i);
		expect(mount.textContent).not.toMatch(
			/review-device-owner|one-time owner review|administrator|credential|keys directory/i,
		);
		expect(mount.querySelector("code")).toBeNull();
		expect(mount.textContent).not.toContain(groupId);
		expect(button("Link Google account").disabled).toBe(true);
	});
});

describe("My Account optional device review instructions", () => {
	it("keeps device recovery separate from the short live status without admin onboarding", async () => {
		// Arrange
		view = status({
			canLink: false,
			remote: {
				kind: "status",
				coordinatorId: "coordinator-one",
				identityId: null,
				identityMatches: false,
				authority: null,
				state: "review_required",
				account: null,
			},
		});
		// Act
		await show();
		// Assert: technical instructions are available without filling the live status.
		const liveStatus = mount.querySelector('[role="status"][aria-live="polite"]');
		expect(liveStatus?.textContent).toMatch(/device|Identity|profile/i);
		expect(liveStatus?.textContent).not.toMatch(
			/codemem coordinator|database|config|keys directory/,
		);
		const details = mount.querySelector("details.recipient-policy-management-details");
		if (!(details instanceof HTMLDetailsElement)) throw new Error("Missing native review details");
		expect(details.open).toBe(false);
		expect(details.hasAttribute("open")).toBe(false);
		expect(details.firstElementChild?.tagName).toBe("SUMMARY");
		expect(details.querySelector("summary")?.textContent).toMatch(/device|link|check/i);
		expect(details.querySelector("summary")?.hasAttribute("role")).toBe(false);
		expect(details.textContent).toMatch(/profile/i);
		expect(details.textContent).toMatch(/group/i);
		expect(details.textContent).toMatch(/operator|person who runs/i);
		expect(details.textContent).toMatch(/binding|device/i);
		expect(mount.textContent).not.toMatch(
			/review-device-owner|one-time owner review|administrator|credential|keys directory/i,
		);
		expect(details.previousElementSibling?.textContent).toContain("Codemem Identity:");
		expect(details.nextElementSibling?.contains(button("Check status"))).toBe(true);
		const outsideInstructions = mount.cloneNode(true) as HTMLElement;
		outsideInstructions.querySelector("details")?.remove();
		expect(outsideInstructions.textContent).not.toMatch(
			/review-device-owner|database|config|keys directory|Confirmation defaults/,
		);
		expect(button("Link Google account").disabled).toBe(true);
		expect(button("Check status").disabled).toBe(false);
	});
	it("opens and closes native instructions without requests or account actions", async () => {
		// Arrange
		view = status({
			canLink: false,
			remote: {
				kind: "status",
				coordinatorId: "coordinator-one",
				identityId: null,
				identityMatches: false,
				state: "review_required",
				authority: null,
				account: null,
			},
		});
		await show();
		const details = mount.querySelector<HTMLDetailsElement>(
			"details.recipient-policy-management-details",
		);
		const summary = details?.querySelector("summary");
		if (!details || !summary) throw new Error("Missing native review disclosure");
		const initialRequests = transport.mock.calls.length;
		// Act
		await act(async () => summary.click());
		await settle();
		// Assert: JSDOM native click toggles the element; this is not a browser keyboard test.
		expect(details.open).toBe(true);
		expect(transport).toHaveBeenCalledTimes(initialRequests);
		expect(window.open).not.toHaveBeenCalled();
		expect(transport.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
		expect(button("Link Google account").disabled).toBe(true);
		expect(button("Check status").disabled).toBe(false);
		// Act: closing the instructions must be equally read-only.
		await act(async () => summary.click());
		await settle();
		// Assert
		expect(details.open).toBe(false);
		expect(transport).toHaveBeenCalledTimes(initialRequests);
		expect(window.open).not.toHaveBeenCalled();
	});
});

describe("My Account unavailable recovery", () => {
	it.each([
		[
			"coordinator_incompatible",
			/coordinator.*rejected|rejected.*request/i,
			/update/i,
			/person who runs|operator/i,
		],
		[
			"coordinator_unreachable",
			/connect|network|reach/i,
			/check/i,
			/connection|network|address|coordinator/i,
		],
		["coordinator_unavailable", /unavailable|service/i, /wait|later/i, /check|try/i],
		["coordinator_rejected", /reject/i, /enroll|device/i, /operator|person who runs/i],
		["rate_limited", /too many|limit/i, /wait/i, /check|try/i],
		["device_unavailable", /device/i, /profile/i, /check|restart|open/i],
		[
			"coordinator_auth_schema_upgrade_required",
			/schema/i,
			/upgrade/i,
			/operator|person who runs/i,
		],
		["context_changed", /changed/i, /profile|group/i, /check/i],
		["invalid_response", /reply|response/i, /operator|person who runs/i, /update|check/i],
	] as const)(
		"gives actionable %s guidance without automatically linking or polling",
		async (code, reason, action, helper) => {
			// Arrange: unavailable status cannot prove whether Google is linked.
			view = status({ canLink: false, remote: { kind: "unavailable", code } });
			// Act: elapsed time and a disabled link click must not trigger account work.
			await show();
			await click("Link Google account");
			await tick();
			await tick();
			// Assert: each known reason has its own safe recovery, not a generic retry.
			const text = mount.querySelector('[role="status"]')?.textContent;
			expect(text).toMatch(reason);
			expect(text).toMatch(action);
			expect(text).toMatch(helper);
			expect(text).not.toContain("Account status could not be verified. Check status again;");
			expect(text).not.toMatch(
				/No Google account is linked|This Google account is linked|review-device-owner/,
			);
			expect(button("Link Google account").disabled).toBe(true);
			expect(calls("link-status")).toHaveLength(1);
			expect(transport.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
			expect(window.open).not.toHaveBeenCalled();
		},
	);
	it.each(["unknown_reason", "__proto__", "constructor", `private-upstream-error ${privateUrl}`])(
		"uses a fixed safe fallback for unknown unavailable reason %s",
		async (code) => {
			// Arrange: future or malicious reason strings are not display copy.
			view = status({ canLink: false, remote: { kind: "unavailable", code } });
			// Act
			await show();
			await tick();
			// Assert
			expect(mount.textContent).not.toContain(code);
			expect(mount.innerHTML).not.toContain("private-fixture");
			expect(mount.querySelector('[role="status"]')?.textContent).toMatch(
				/check|operator|person who runs/i,
			);
			expect(button("Link Google account").disabled).toBe(true);
			expect(calls("link-status")).toHaveLength(1);
			expect(transport.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
			expect(window.open).not.toHaveBeenCalled();
		},
	);
});

describe("My Account read-only status", () => {
	it("explains a foreign active operation without exposing its details or enabling linking", async () => {
		// Arrange: the selected group's unlinked status is not permission to start another job.
		view = status({ blockedReason: "operation_active", operation: null, canLink: false });
		// Act
		await show();
		// Assert
		expect(mount.textContent).toContain("Another account operation is in progress in this Viewer");
		expect(button("Link Google account").disabled).toBe(true);
		expect(buttons().some((node) => node.textContent === "Cancel linking")).toBe(false);
		expect(mount.innerHTML).not.toContain("op-one");
		expect(mount.innerHTML).not.toContain("private-fixture");
		expect(calls("browser-url")).toHaveLength(0);
		expect(mount.querySelector("details.recipient-policy-management-details")).toBeNull();
	});
	it("shows verified account, local device and coordinator without account administration", async () => {
		// Arrange
		view = status({
			canLink: false,
			remote: {
				kind: "status",
				coordinatorId: "coordinator-one",
				identityId: "identity-one",
				authority: "device_claim",
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
		expect(mount.querySelector("details.recipient-policy-management-details")).toBeNull();
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
			...statusIdentity(state),
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
		if (state === "linked_mismatch")
			expect(buttons().some((node) => node.textContent === "Link Google account")).toBe(false);
		else expect(button("Link Google account").disabled).toBe(true);
		expect(mount.textContent).not.toContain("No Google account is linked");
		expect(mount.textContent).not.toContain("Unverified secret");
		expect(mount.textContent).not.toContain("unverified@example.test");
		if (state === "review_required") {
			expect(mount.textContent).toMatch(/profile/i);
			expect(mount.textContent).not.toMatch(/review-device-owner|enroll-owner/);
		} else expect(mount.querySelector("details.recipient-policy-management-details")).toBeNull();
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
	it.each(["failed", "cancelled", "outcome_unknown"] as const)(
		"retains closed review instructions alongside a %s outcome",
		async (state) => {
			// Arrange: a terminal result must not hide a known device review requirement.
			view = status({
				canLink: false,
				operation: operation(state),
				remote: {
					kind: "status",
					coordinatorId: "coordinator-one",
					identityId: null,
					authority: null,
					identityMatches: false,
					state: "review_required",
					account: null,
				},
			});
			const outcome = {
				failed: "Linking did not finish. Check status before trying again.",
				cancelled: "Cancellation was reported. Check status to confirm the account state.",
				outcome_unknown: "We couldn’t confirm whether linking finished. Check status.",
			}[state];
			// Act
			await show();
			// Assert
			expect(mount.querySelector('[role="status"]')?.textContent).toBe(outcome);
			expect(mount.textContent).toMatch(/profile/i);
			const details = mount.querySelector<HTMLDetailsElement>(
				"details.recipient-policy-management-details",
			);
			expect(details?.open).toBe(false);
			expect(details?.textContent).toMatch(/operator|person who runs/i);
			expect(mount.textContent).not.toMatch(/review-device-owner|one-time owner review/);
			expect(button("Link Google account").disabled).toBe(true);
			expect(button("Check status").disabled).toBe(false);
			expect(transport.mock.calls.some(([, options]) => options?.method === "POST")).toBe(false);
			expect(window.open).not.toHaveBeenCalled();
		},
	);
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
					authority: state === "review_required" ? null : "device_claim",
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
				state === "review_required" ? "profile" : "does not match this local Identity",
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

describe.each([
	{ intent: undefined, activity: "linking", subject: "Linking", attempt: "link" },
	{ intent: "connect", activity: "linking", subject: "Linking", attempt: "link" },
	{ intent: "refresh", activity: "refresh", subject: "Refresh", attempt: "refresh" },
	{ intent: "disconnect", activity: "unlinking", subject: "Unlinking", attempt: "unlink" },
] as const)("My Account $intent operation copy", ({ intent, activity, subject, attempt }) => {
	it.each(["starting", "awaiting_browser", "failed", "cancelled", "outcome_unknown"] as const)(
		"shows accurate %s copy and cancellation labels",
		async (state) => {
			view = status({ operation: { ...operation(state), intent }, canLink: false });
			// Keep the private browser handoff out of this status-copy assertion.
			if (view.operation) view.operation.browserUrlAvailable = false;
			await show();
			const copy = {
				starting: {
					link: "Preparing Google sign-in…",
					refresh: "Preparing Google sign-in to refresh your profile…",
					unlink: "Unlinking Google account…",
				}[attempt],
				awaiting_browser: {
					link: "Waiting for Google sign-in. Keep this Viewer open on the same computer.",
					refresh:
						"Waiting for Google sign-in to refresh your account. Keep this Viewer open on the same computer.",
					unlink: "Unlinking Google account…",
				}[attempt],
				failed: `${subject} did not finish. Check status before trying again.`,
				cancelled: "Cancellation was reported. Check status to confirm the account state.",
				outcome_unknown: `We couldn’t confirm whether ${activity} finished. Check status.`,
			}[state];
			expect(mount.querySelector('[role="status"]')?.textContent).toBe(copy);
			if (state === "starting" || state === "awaiting_browser")
				expect(button(`Cancel ${activity}`).disabled).toBe(false);
		},
	);
	it("names the action when browser delivery and cancellation fail, then polling is lost", async () => {
		view = status({ operation: { ...operation("awaiting_browser"), intent }, canLink: false });
		transport.mockImplementation(async (url) => {
			if (String(url).endsWith("browser-url")) throw new Error("private-delivery-error");
			return response(view);
		});
		await show();
		expect(mount.querySelector('[role="status"]')?.textContent).toBe(
			intent === "disconnect"
				? "Unlinking Google account…"
				: `Google sign-in could not be opened. Cancel ${activity}, or wait for status to update.`,
		);
		transport.mockRejectedValueOnce(new Error("private-cancel-error"));
		await click(`Cancel ${activity}`);
		expect(mount.querySelector('[role="status"]')?.textContent).toBe(
			`Cancellation could not be confirmed. ${subject} may still finish; you can try cancellation again.`,
		);
		transport.mockRejectedValueOnce(new Error("private-poll-error"));
		await tick();
		expect(mount.querySelector('[role="status"]')?.textContent).toBe(
			`We couldn’t confirm whether ${activity} finished. Check status.`,
		);
		expect(button(`Cancel previous ${attempt}`).disabled).toBe(false);
		expect(mount.textContent).toContain(`An earlier ${attempt} may still finish`);
	});
	it("names a stopped action without promising rollback", async () => {
		view = status({ operation: { ...operation("failed"), intent, failure: "link_stopped" } });
		await show();
		expect(mount.querySelector('[role="status"]')?.textContent).toBe(
			`${subject} stopped. Check status before trying again.`,
		);
	});
	it.each(["starting", "outcome_unknown"] as const)(
		"reports a %s cancellation reply without claiming rollback",
		async (state) => {
			view = status({ operation: { ...operation("starting"), intent }, canLink: false });
			await show();
			const result = { ...operation(state), intent };
			transport.mockResolvedValueOnce(response({ version: 1, operation: result }));
			if (state === "outcome_unknown") view = status({ operation: result, canLink: false });
			await click(`Cancel ${activity}`);
			expect(mount.querySelector('[role="status"]')?.textContent).toBe(
				state === "outcome_unknown"
					? `We couldn’t confirm whether ${activity} finished. Check status.`
					: "Cancellation is pending. Check status to confirm.",
			);
		},
	);
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
			vi.mocked(window.open).mockReturnValue(popup as unknown as Window);
			await click("Open Google sign-in");
			assertIsolatedPopup(privateUrl);
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
				vi.mocked(window.open).mockReturnValue(popup as unknown as Window);
				await click("Open Google sign-in");
				assertIsolatedPopup(privateUrl);
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
	it("isolates an explicit synchronous fallback without re-fetching private URLs", async () => {
		// Arrange
		vi.mocked(window.open).mockReturnValue(null);
		view = status({ operation: operation("awaiting_browser"), canLink: false });
		await show();
		// Act
		await click("Open Google sign-in");
		// Assert: a blocked fallback never navigates the Viewer or exposes its URL.
		expect(window.open).toHaveBeenCalledWith("about:blank", "_blank");
		expect(popup.location.replace).not.toHaveBeenCalled();
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
			assertIsolatedPopup(url);
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
				authority: "device_claim",
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
				authority: "device_claim",
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
