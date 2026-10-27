import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountOperation, AccountView } from "../lib/api/account";
import { MyAccount } from "./my-account";
import { operation, response, settle, status } from "./my-account-test-utils";

const transport = vi.fn<typeof fetch>();
const rebindUrl = "https://coordinator.example/auth/rebind/start?attempt_id=a&start_code=b";
let view: AccountView;
let mount: HTMLDivElement;
let popup: {
	opener: unknown;
	close: ReturnType<typeof vi.fn>;
	location: { replace: ReturnType<typeof vi.fn> };
};

const buttons = () => [...mount.querySelectorAll<HTMLButtonElement>("button")];
const button = (name: string) => buttons().find((node) => node.textContent === name);
const summary = () => mount.querySelector("#my-account-summary")?.textContent ?? "";
const signInOperation = (patch: Partial<AccountOperation> = {}): AccountOperation => ({
	...operation("starting"),
	intent: "sign_in",
	...patch,
});
async function show() {
	await act(async () => {
		render(<MyAccount />, mount);
	});
	await settle();
}

beforeEach(() => {
	vi.useFakeTimers();
	view = status({ canSignIn: true });
	mount = document.createElement("div");
	document.body.append(mount);
	popup = { opener: {}, close: vi.fn(), location: { replace: vi.fn() } };
	vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
	vi.stubGlobal(
		"fetch",
		transport.mockReset().mockImplementation(async (url) => {
			if (url === "/api/account/session") return response({ version: 1, csrfToken: "token" });
			if (String(url).includes("link-status")) return response(view);
			if (String(url).endsWith("browser-url")) return response({ version: 1, url: rebindUrl });
			return response({ version: 1, operation: signInOperation(), current: true });
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

describe("My Account sign-in", () => {
	it("starts a sign-in from one 'Sign in with Google' button", async () => {
		// Arrange
		await show();
		// Act
		await act(async () => {
			button("Sign in with Google")?.click();
		});
		await settle();
		// Assert
		expect(button("Link Google account")).toBeUndefined();
		const start = transport.mock.calls.find(([url]) => String(url).endsWith("link-operations"));
		expect(JSON.parse(String(start?.[1]?.body))).toMatchObject({ intent: "sign_in" });
	});

	it("offers linking to a device that already switched once", async () => {
		// Arrange
		view = status({
			canSignIn: true,
			operation: signInOperation({
				state: "failed",
				failure: "device_already_bound",
				finishedAt: "2026-01-01T00:01:00Z",
			}),
		});
		// Act
		await show();
		// Assert
		expect(summary()).toContain("You can still link a Google account");
		expect(button("Link this account")?.disabled).toBe(false);
	});

	it("offers linking when the coordinator can't switch this device", async () => {
		// Arrange
		view = status({
			canSignIn: true,
			operation: signInOperation({
				state: "failed",
				failure: "sign_in_unavailable",
				finishedAt: "2026-01-01T00:01:00Z",
			}),
		});
		// Act
		await show();
		// Assert
		expect(summary()).toContain("Link a Google account to its current Identity instead");
		expect(button("Link this account")?.disabled).toBe(false);
	});

	it("offers to link the account when sign-in finds it isn't linked yet", async () => {
		// Arrange
		view = status({
			canSignIn: true,
			operation: signInOperation({
				state: "failed",
				failure: "account_not_linked",
				finishedAt: "2026-01-01T00:01:00Z",
			}),
		});
		// Act
		await show();
		// Assert
		expect(summary()).toContain("isn’t linked to an Identity yet");
		expect(button("Link this account")?.disabled).toBe(false);
	});

	it.each([
		["daily_limit", "today’s limit"],
		["current_identity_linked", "Unlink it first"],
	] as const)("names what to do after a %s refusal", async (failure, copy) => {
		// Arrange
		view = status({
			canSignIn: true,
			operation: signInOperation({ state: "failed", failure, finishedAt: "2026-01-01T00:01:00Z" }),
		});
		// Act
		await show();
		// Assert
		expect(summary()).toContain(copy);
		expect(button("Link this account")).toBeUndefined();
	});

	it("tells the person to restart when the switch may be pending", async () => {
		// Arrange
		view = status({
			canSignIn: true,
			operation: signInOperation({
				state: "outcome_unknown",
				failure: "switch_pending",
				finishedAt: "2026-01-01T00:01:00Z",
			}),
		});
		// Act
		await show();
		// Assert
		expect(summary()).toContain("Restart the Viewer to check again");
	});
});
