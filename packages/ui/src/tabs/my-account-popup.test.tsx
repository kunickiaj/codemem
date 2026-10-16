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
	if (fault === "not current") current = false;
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

describe("Viewer-owned Google popup completion", () => {
	it("retains the isolated popup until its own success and a fresh matching linked status", async () => {
		// Arrange
		await launch();
		expect(popup.opener).toBeNull();
		expect(popup.location.replace).toHaveBeenCalledWith(privateUrl);
		const fresh = deferred<Response>();
		transport.mockImplementation(async (url) => {
			if (String(url).includes("link-status")) return fresh.promise;
			return response({ version: 1, operation: operation("succeeded"), current: true });
		});
		// Act: operation success alone cannot close the popup.
		await tick();
		// Assert
		expect(popup.close).not.toHaveBeenCalled();
		// Act: only the completed fresh status authorizes closing it.
		fresh.resolve(response(linked()));
		await settle();
		// Assert
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
		// Arrange
		await launch();
		configureFailure(fault);
		// Act
		await tick();
		// Assert
		expect(popup.close).not.toHaveBeenCalled();
		expect(popup.opener).toBeNull();
	});

	it("retains a click-opened fallback handle and closes it after verified completion", async () => {
		// Arrange
		vi.mocked(window.open).mockReturnValueOnce(null);
		await launch();
		expect(popup.location.replace).not.toHaveBeenCalled();
		// Act
		await click("Open Google sign-in");
		// Assert: reserve blank, isolate, then navigate the validated URL.
		expect(window.open).toHaveBeenLastCalledWith("about:blank", "_blank");
		expect(popup.opener).toBeNull();
		expect(popup.location.replace).toHaveBeenCalledWith(privateUrl);
		// Act
		polled = operation("succeeded");
		view = linked();
		await tick();
		// Assert
		expect(popup.close).toHaveBeenCalledTimes(1);
	});
});
