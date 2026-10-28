import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountOperation, AccountView } from "../lib/api/account";
import { MyAccount } from "./my-account";
import { operation, response, settle, status } from "./my-account-test-utils";
import { ownerAccount } from "./owner-recovery-test-utils";

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

	it.each([
		["switch_pending", "Restart the Viewer to check again"],
		["bind_unconfirmed", "Restart the Viewer, then check status."],
	] as const)(
		"tells the person to restart after an unclear outcome (%s)",
		async (failure, text) => {
			// Arrange
			view = status({
				canSignIn: true,
				operation: signInOperation({
					state: "outcome_unknown",
					failure,
					finishedAt: "2026-01-01T00:01:00Z",
				}),
			});
			// Act
			await show();
			// Assert
			expect(summary()).toContain(text);
		},
	);
});

describe("My Account sign-in on a device linked elsewhere", () => {
	it("offers sign-in so this device can manage its own linked account", async () => {
		// Arrange: this Identity is linked, but this device has no proof of its own.
		view = status({
			canSignIn: true,
			canLink: false,
			managementActions: { refresh: false, disconnect: false },
			remote: {
				kind: "status",
				coordinatorId: "coordinator-one",
				identityId: "identity-one",
				authority: "device_claim",
				identityMatches: true,
				state: "linked",
				account: null,
			},
		});
		await show();
		const before = summary();
		// Act
		await act(async () => {
			button("Sign in with Google")?.click();
		});
		await settle();
		// Assert
		expect(before).toBe(
			"Linked on another device. Sign in with Google to refresh or unlink it here too.",
		);
		const start = transport.mock.calls.find(([url]) => String(url).endsWith("link-operations"));
		expect(JSON.parse(String(start?.[1]?.body))).toMatchObject({ intent: "sign_in" });
	});
});

describe("My Account sign-in from the owner-only state", () => {
	it.each([true, false])(
		"dispatches recovered-owner null authority only when sign-in is allowed (%s)",
		async (allowed) => {
			// Arrange: owner evidence contains no Google profile and the ordinary actor still needs review.
			const owner = ownerAccount();
			view = {
				...owner,
				operation: null,
				canSignIn: allowed,
				canLink: false,
				ownerProjection: {
					...owner.ownerProjection,
					status: { ...owner.ownerProjection.status, profile: {} },
				},
				...(allowed
					? {
							signIn: {
								contextId: "own-recovered-context",
								coordinatorId: "coordinator-one",
								authority: null,
							},
						}
					: {}),
			};
			transport.mockImplementation(async (url) => {
				if (url === "/api/account/session") return response({ version: 1, csrfToken: "token" });
				if (String(url).includes("link-status")) return response(view);
				if (String(url).endsWith("browser-url")) return response({ version: 1, url: rebindUrl });
				return response({
					version: 1,
					operation: signInOperation({
						contextId: "own-recovered-context",
						state: "awaiting_browser",
						browserUrlAvailable: true,
					}),
					current: true,
				});
			});
			await show();
			// Act
			await act(async () => {
				button("Sign in with Google")?.click();
			});
			await settle();
			// Assert: the display context and withheld owner account must never become dispatch authority.
			const starts = transport.mock.calls.filter(([url]) =>
				String(url).endsWith("link-operations"),
			);
			if (allowed) {
				expect(starts).toHaveLength(1);
				expect(JSON.parse(String(starts[0][1]?.body))).toEqual({
					intent: "sign_in",
					groupId: owner.selectedGroupId,
					contextId: "own-recovered-context",
					coordinatorId: "coordinator-one",
					authority: null,
				});
				expect(popup.location.replace).toHaveBeenCalledWith(rebindUrl);
			} else {
				expect(starts).toHaveLength(0);
				expect(window.open).not.toHaveBeenCalled();
			}
			expect(mount.textContent).not.toContain("owner-a@example.test");
			expect(button("Link Google account")).toBeUndefined();
		},
	);

	it("opens Google for a sign-in that starts from this device's own Identity", async () => {
		// Arrange: this device runs as B; the coordinator confirmed A as the account owner.
		const owner = ownerAccount();
		const { operationContextId: _unused, ...withoutOperation } = owner;
		view = {
			...withoutOperation,
			operation: null,
			accountOwner: { ...owner.accountOwner, displayName: "Owner A" },
			canSignIn: true,
			signIn: {
				contextId: "own-context",
				coordinatorId: "coordinator-b",
				authority: "device_claim",
			},
		} as AccountView;
		const started = signInOperation({
			contextId: "own-context",
			groupId: owner.selectedGroupId ?? "",
			state: "awaiting_browser",
			browserUrlAvailable: true,
		});
		transport.mockImplementation(async (url) => {
			if (url === "/api/account/session") return response({ version: 1, csrfToken: "token" });
			if (String(url).includes("link-status")) return response(view);
			if (String(url).endsWith("browser-url")) return response({ version: 1, url: rebindUrl });
			return response({ version: 1, operation: started, current: true });
		});
		await show();
		const offer = summary();
		// Act
		await act(async () => {
			button("Sign in with Google")?.click();
		});
		await settle();
		// Assert
		expect(offer).toContain("Sign in with owner-a@example.test to switch this device to Owner A.");
		const start = transport.mock.calls.find(([url]) => String(url).endsWith("link-operations"));
		expect(JSON.parse(String(start?.[1]?.body))).toMatchObject({
			intent: "sign_in",
			contextId: "own-context",
			coordinatorId: "coordinator-b",
		});
		expect(popup.location.replace).toHaveBeenCalledWith(rebindUrl);
		expect(popup.close).not.toHaveBeenCalled();
	});
});
