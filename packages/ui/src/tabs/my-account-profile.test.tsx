import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AccountView } from "../lib/api/account";
import { MyAccount } from "./my-account";
import { operation, response, settle, status } from "./my-account-test-utils";

const pictureUrl = "https://lh3.googleusercontent.com/a/photo";
const account = { displayName: "Example Test Person", email: "person@example.test", pictureUrl };
let mount: HTMLDivElement;
let view: AccountView;
beforeEach(() => {
	vi.useFakeTimers();
	mount = document.createElement("div");
	document.body.append(mount);
	view = status({
		unlinkTarget: "current-link",
		canLink: false,
		remote: {
			kind: "status",
			coordinatorId: "coordinator-one",
			identityId: "identity-one",
			authority: "device_claim",
			identityMatches: true,
			state: "linked",
			account,
		},
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url) => {
			if (url === "/api/account/session") return response({ csrfToken: "fixture-token" });
			if (String(url).startsWith("/api/account/link-status")) return response(view);
			throw new Error("Unexpected request");
		}),
	);
});
afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
async function show() {
	await act(async () => render(<MyAccount />, mount));
	await settle();
}
function setAccount(
	value: NonNullable<Extract<AccountView["remote"], { kind: "status" }>["account"]>,
) {
	if (view.remote.kind === "status") view.remote.account = value;
}

it("renders verified profile text and a lazy anonymous no-referrer photo", async () => {
	// Arrange
	setAccount(account);
	// Act
	await show();
	// Assert
	expect(mount.querySelector(".my-account-profile")?.textContent).toContain(account.displayName);
	expect(mount.textContent).toContain(
		"This Google account is linked to the local Codemem Identity.",
	);
	expect(mount.textContent).toContain(`${account.email} · Verified email`);
	const image = mount.querySelector("img");
	for (const [key, value] of Object.entries({
		src: pictureUrl,
		alt: "",
		loading: "lazy",
		referrerpolicy: "no-referrer",
		crossorigin: "anonymous",
	})) {
		expect(image?.getAttribute(key)).toBe(value);
	}
	expect(image?.hasAttribute("onerror")).toBe(false);
});

it("hides unlink without the new signed target capability while retaining refresh", async () => {
	view.managementActions = { refresh: true, disconnect: true };
	delete view.unlinkTarget;
	await show();
	expect(mount.textContent).toContain("Refresh profile");
	expect(mount.textContent).not.toContain("Unlink Google account");
});
it("confirms once locally, cancels without requests, and sends the captured target without a popup", async () => {
	view.managementActions = { refresh: true, disconnect: true };
	const posts: Record<string, unknown>[] = [];
	const open = vi.spyOn(window, "open").mockReturnValue(null);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url, init) => {
			if (url === "/api/account/session") return response({ csrfToken: "fixture-token" });
			if (String(url).startsWith("/api/account/link-status")) return response(view);
			posts.push(JSON.parse(String(init?.body)));
			return response({
				version: 1,
				operation: { ...operation("starting"), intent: "disconnect" },
			});
		}),
	);
	await show();
	const trigger = [...mount.querySelectorAll("button")].find(
		(button) => button.textContent === "Unlink Google account",
	);
	await act(async () => trigger?.click());
	expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
		"Unlink Google account?",
	);
	expect(posts).toEqual([]);
	await act(async () =>
		[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
			.find((button) => button.textContent === "Cancel")
			?.click(),
	);
	expect(posts).toEqual([]);
	await act(async () => trigger?.click());
	await act(async () =>
		[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
			.find((button) => button.textContent === "Unlink account")
			?.click(),
	);
	await settle();
	expect(posts).toMatchObject([{ intent: "disconnect", expectedLinkId: "current-link" }]);
	expect(open).not.toHaveBeenCalled();
	open.mockRestore();
});

it.each([null, "starting", "outcome_unknown"] as const)(
	"explains a linked account blocked by another context (%s) without leaking its operation",
	async (state) => {
		view.blockedReason = "operation_active";
		view.managementActions = { refresh: true, disconnect: true };
		if (state)
			view.operation = {
				...operation(state),
				contextId: "private-other-context",
				groupId: "private-other-group",
				operationId: "private-other-operation",
			};
		await show();
		expect(mount.textContent).toContain("Another account operation is in progress in this Viewer.");
		expect(mount.querySelector(".my-account-profile")?.textContent).toContain(account.displayName);
		expect(mount.querySelector("details")).not.toBeNull();
		expect(mount.textContent).not.toContain("private-other");
		const actions = [...mount.querySelectorAll("button")].filter((button) =>
			["Refresh profile", "Unlink Google account"].includes(button.textContent ?? ""),
		);
		expect(actions).toHaveLength(2);
		expect(actions.every((button) => button.disabled)).toBe(true);
	},
);

it.each([
	["refresh", "failed"],
	["refresh", "cancelled"],
	["disconnect", "failed"],
	["disconnect", "cancelled"],
] as const)(
	"shows the %s %s outcome while linked and keeps retry actions enabled",
	async (intent, state) => {
		view.operation = { ...operation(state), intent };
		view.managementActions = { refresh: true, disconnect: true };
		await show();
		const subject = intent === "refresh" ? "Refresh" : "Unlinking";
		expect(mount.querySelector('[role="status"]')?.textContent).toBe(
			state === "failed"
				? `${subject} did not finish. Check status before trying again.`
				: "Cancellation was reported. Check status to confirm the account state.",
		);
		const actions = [...mount.querySelectorAll("button")].filter((button) =>
			["Refresh profile", "Unlink Google account"].includes(button.textContent ?? ""),
		);
		expect(actions).toHaveLength(2);
		expect(actions.every((button) => !button.disabled)).toBe(true);
	},
);

it.each([
	"http://lh3.googleusercontent.com/a/photo",
	"data:image/png;base64,AA==",
	"https://user:pass@lh3.googleusercontent.com/a/photo",
	"https://lh3.googleusercontent.com:8443/a/photo",
	"https://lh3.googleusercontent.com.evil.test/a/photo",
	"https://images.example.test/a/photo",
])("omits unsafe photo %s without hiding verified text", async (url) => {
	// Arrange
	setAccount({ ...account, pictureUrl: url });
	// Act
	await show();
	// Assert
	expect(mount.querySelector("img")).toBeNull();
	expect(mount.querySelector(".my-account-avatar")?.textContent).toBe("EP");
	expect(mount.textContent).toContain(account.email);
});

it.each([
	[{ displayName: "Example Person" }, "Example Person", "EP"],
	[{ email: "person@example.test" }, "Google account", "G"],
	[{}, "Google account", "G"],
] as const)("supports older profile shape %j", async (value, label, initials) => {
	// Arrange
	setAccount(value);
	// Act
	await show();
	// Assert
	expect(mount.querySelector(".my-account-profile strong")?.textContent).toBe(label);
	expect(mount.querySelector(".my-account-avatar")?.textContent).toBe(initials);
	expect(mount.querySelector("img")).toBeNull();
});

it.each(["revoked", "mismatch", "context_changed"])(
	"hides all profile data for %s",
	async (state) => {
		// Arrange
		if (view.remote.kind === "status") {
			if (state === "revoked") view.remote.state = "revoked";
			if (state === "mismatch") view.remote.identityMatches = false;
		}
		if (state === "context_changed") view.remote = { kind: "unavailable", code: state };
		// Act
		await show();
		// Assert
		expect(mount.querySelector(".my-account-profile")).toBeNull();
		expect(mount.innerHTML).not.toContain(pictureUrl);
		expect(mount.textContent).not.toContain(account.email);
	},
);

it("falls back after image failure and treats profile markup as text", async () => {
	// Arrange
	const displayName = '<img src=x onerror="alert(1)">';
	setAccount({ ...account, displayName });
	await show();
	// Act
	await act(async () => {
		mount.querySelector("img")?.dispatchEvent(new Event("error"));
	});
	// Assert
	expect(mount.querySelector("img")).toBeNull();
	expect(mount.querySelector(".my-account-profile strong")?.textContent).toBe(displayName);
	expect(mount.querySelector("[onerror]")).toBeNull();
});
