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
let mount: HTMLDivElement;
let view: AccountView;
let polled: AccountOperation;
let current: boolean;
let pollError: boolean;
let popup: {
	opener: unknown;
	closed: boolean;
	close: ReturnType<typeof vi.fn>;
	location: { replace: ReturnType<typeof vi.fn> };
};

async function click(label: string) {
	const button = [...mount.querySelectorAll("button")].find((node) => node.textContent === label);
	if (!button) throw new Error(`Missing button: ${label}`);
	await act(async () => button.click());
	await settle();
}
async function launch() {
	await act(async () => render(<MyAccount />, mount));
	await settle();
	await click("Link Google account");
}
function linked(overrides: Partial<AccountView> = {}): AccountView {
	return status({
		canLink: false,
		remote: {
			kind: "status",
			coordinatorId: "coordinator-one",
			identityId: "identity-one",
			authority: "device_claim",
			identityMatches: true,
			state: "linked",
			account: { email: "ada@example.test" },
		},
		...overrides,
	});
}

function configureFailure(fault: string): void {
	polled = operation("succeeded");
	view = linked();
	if (fault === "unlinked") view = status();
	if (fault === "identity mismatch") {
		view = linked({
			remote: {
				...status().remote,
				kind: "status",
				coordinatorId: "coordinator-one",
				identityId: "identity-other",
				authority: "device_claim",
				state: "linked",
				account: null,
				identityMatches: false,
			},
		});
	}
	if (fault === "different context") view = linked({ contextId: "context-other" });
	if (fault === "different group")
		view = linked({ selectedGroupId: "group-other", groups: ["group-other"] });
	if (fault === "outcome unknown") polled = operation("outcome_unknown");
	if (fault === "poll error") pollError = true;
	if (fault === "not current") {
		current = false;
		view = linked({ contextId: "context-other", selectedGroupId: "group-other" });
	}
	if (fault === "different operation") polled = { ...polled, operationId: "op-other" };
	if (fault === "linked without operation success") polled = operation("awaiting_browser");
	if (fault === "fresh status failure") {
		transport.mockImplementation(async (url) => {
			if (String(url).includes("link-status")) throw new Error("temporary status failure");
			return response({ version: 1, operation: polled, current: true });
		});
	}
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	view = status();
	polled = operation("awaiting_browser");
	current = true;
	pollError = false;
	mount = document.createElement("div");
	document.body.append(mount);
	popup = { opener: {}, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
	vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
	vi.stubGlobal(
		"fetch",
		transport.mockReset().mockImplementation(async (url, options) => {
			if (url === "/api/account/session")
				return response({ version: 1, csrfToken: "fixture-token" });
			if (String(url).includes("link-status")) return response(view);
			if (String(url).endsWith("browser-url")) return response({ version: 1, url: privateUrl });
			if (options?.method === "POST")
				return response({ version: 1, operation: operation("awaiting_browser"), current: true });
			if (pollError) throw new Error("temporary poll failure");
			return response({ version: 1, operation: polled, current });
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

describe("Viewer-owned previous-context Google popup completion", () => {
	it.each(
		["poll", "stale poll", "expired poll", "cancel", "status"].flatMap((mode) =>
			["linked", "unlinked", "operationId", "contextId", "groupId"].map((outcome) => ({
				mode,
				outcome,
			})),
		),
	)(
		"retains previous-context $mode success until fresh original $outcome status",
		async ({ mode, outcome }) => {
			await launch();
			current = false;
			view = linked({ contextId: "context-other", selectedGroupId: "group-other" });
			if (mode !== "stale poll") {
				await tick();
				expect(mount.textContent).toContain("Cancel previous link");
			}
			polled = operation("succeeded");
			if (["operationId", "contextId", "groupId"].includes(outcome))
				polled = { ...polled, [outcome]: "other" };
			transport.mockImplementation(async (url) =>
				String(url).includes("link-status")
					? response(view)
					: response({ version: 1, operation: polled, current: false }),
			);
			if (mode === "expired poll") vi.setSystemTime(new Date("2026-01-01T00:05:01Z"));
			if (mode === "cancel") await click("Cancel previous link");
			else if (mode === "status" || mode === "expired poll") await click("Check status");
			else await tick();
			expect(popup.close).not.toHaveBeenCalled();
			view = outcome === "unlinked" ? status() : linked();
			if (mode === "status") view = { ...view, operation: polled };
			await click("Check status");
			expect(popup.close).toHaveBeenCalledTimes(outcome === "linked" ? 1 : 0);
		},
	);
});

describe("Viewer-owned Google popup completion", () => {
	it("retries a blocked fallback without starting or delivering another link", async () => {
		vi.mocked(window.open).mockReturnValueOnce(null).mockReturnValueOnce(null);
		await launch();
		const requests = transport.mock.calls.length;
		await click("Open Google sign-in");
		expect(mount.textContent).toContain("Open Google sign-in");
		expect(popup.location.replace).not.toHaveBeenCalled();
		await click("Open Google sign-in");
		expect(popup.location.replace).toHaveBeenCalledExactlyOnceWith(privateUrl);
		expect(popup.opener).toBeNull();
		expect(transport.mock.calls).toHaveLength(requests);
	});

	it.each(["linked", "unlinked"])(
		"verifies fresh %s status after cancellation races with success",
		async (state) => {
			await launch();
			const fresh = deferred<Response>();
			transport.mockImplementation(async (url) => {
				if (String(url).includes("link-status")) return fresh.promise;
				return response({ version: 1, operation: operation("succeeded"), current: true });
			});
			await click("Cancel linking");
			expect(popup.close).not.toHaveBeenCalled();
			fresh.resolve(response(state === "linked" ? linked() : status()));
			await settle();
			expect(popup.close).toHaveBeenCalledTimes(state === "linked" ? 1 : 0);
		},
	);

	it("retains the isolated popup until its own success and a fresh matching linked status", async () => {
		await launch();
		expect(popup.opener).toBeNull();
		expect(popup.location.replace).toHaveBeenCalledWith(privateUrl);
		const fresh = deferred<Response>();
		transport.mockImplementation(async (url) => {
			if (String(url).includes("link-status")) return fresh.promise;
			return response({ version: 1, operation: operation("succeeded"), current: true });
		});
		await tick();
		expect(popup.close).not.toHaveBeenCalled();
		fresh.resolve(response(linked()));
		await settle();
		expect(popup.close).toHaveBeenCalledTimes(1);
		expect(popup.opener).toBeNull();
	});

	it.each([
		"unlinked",
		"identity mismatch",
		"different context",
		"different group",
		"outcome unknown",
		"poll error",
		"not current",
		"different operation",
		"linked without operation success",
		"fresh status failure",
	])("does not close a launched popup after %s", async (fault) => {
		await launch();
		configureFailure(fault);
		await tick();
		expect(popup.close).not.toHaveBeenCalled();
		expect(popup.opener).toBeNull();
	});

	it("retains a click-opened fallback handle and closes it after verified completion", async () => {
		vi.mocked(window.open).mockReturnValueOnce(null);
		await launch();
		expect(popup.location.replace).not.toHaveBeenCalled();
		await click("Open Google sign-in");
		expect(window.open).toHaveBeenLastCalledWith("about:blank", "_blank");
		expect(popup.opener).toBeNull();
		expect(popup.location.replace).toHaveBeenCalledWith(privateUrl);
		polled = operation("succeeded");
		view = linked();
		await tick();
		expect(popup.close).toHaveBeenCalledTimes(1);
	});
});
