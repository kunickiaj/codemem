import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountView } from "./account";

let api: typeof import("./account");
const transport = vi.fn<typeof fetch>();
const checkedStatus = {
	kind: "status",
	state: "unlinked",
	authority: "controller_attestation",
	coordinatorId: "coordinator-fixture",
	identityId: "identity-fixture",
	identityMatches: true,
	account: null,
} satisfies Extract<AccountView["remote"], { kind: "status" }>;
const checked = {
	authority: checkedStatus.authority,
	coordinatorId: checkedStatus.coordinatorId,
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(async () => {
	vi.resetModules();
	api = await import("./account");
	vi.stubGlobal("fetch", transport.mockReset());
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("account transport safety", () => {
	it("bootstraps a memory-only token and uses relative, encoded, no-store requests", async () => {
		// Arrange: storage must never receive the session token or operation identifiers.
		const storage = vi.spyOn(Storage.prototype, "setItem");
		transport
			.mockResolvedValueOnce(reply({ version: 1, csrfToken: "fixture-token" }))
			.mockResolvedValueOnce(reply({ version: 1 }));
		// Act
		await api.getAccountStatus("group/?&");
		// Assert
		expect(transport.mock.calls.map(([url]) => url)).toEqual([
			"/api/account/session",
			"/api/account/link-status?group_id=group%2F%3F%26",
		]);
		expect(transport.mock.calls[1][1]).toMatchObject({
			credentials: "same-origin",
			cache: "no-store",
			redirect: "error",
			headers: { "X-Codemem-Account-Csrf": "fixture-token" },
		});
		expect(transport.mock.calls[0][1]).toMatchObject({ redirect: "error" });
		expect(storage).not.toHaveBeenCalled();
	});
	it.each(["", null, 42])(
		"rejects invalid session token %s before sending an operation",
		async (csrfToken) => {
			// Arrange
			transport.mockResolvedValueOnce(reply({ version: 1, csrfToken }));
			// Act
			const result = api.startAccountLink("group", "context", checked);
			// Assert
			await expect(result).rejects.toMatchObject({ code: "invalid_response" });
			expect(transport).toHaveBeenCalledTimes(1);
		},
	);
	it("rejects a JSON null session without sending the operation", async () => {
		// Arrange
		transport.mockResolvedValueOnce(reply(null));
		// Act
		const result = api.startAccountLink("group", "context", checked);
		// Assert
		await expect(result).rejects.toMatchObject({
			code: "invalid_response",
			message: "invalid_response",
		});
		expect(transport).toHaveBeenCalledTimes(1);
	});
	it("serializes start inputs as JSON and keeps operation IDs within fixed routes", async () => {
		// Arrange
		transport.mockImplementation(async () => reply({ version: 1, csrfToken: "fixture-token" }));
		// Act
		await api.startAccountLink('group"', "context", checked);
		await api.getAccountOperation("id/?");
		await api.getAccountBrowserUrl("id/?");
		await api.cancelAccountLink("id/?");
		// Assert
		expect(transport.mock.calls[1]).toEqual([
			"/api/account/link-operations",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					groupId: 'group"',
					contextId: "context",
					authority: checkedStatus.authority,
					coordinatorId: checkedStatus.coordinatorId,
				}),
			}),
		]);
		expect(
			transport.mock.calls.slice(2).map(([url, options]) => [url, options?.method, options?.body]),
		).toEqual([
			["/api/account/link-operations/id%2F%3F", "GET", undefined],
			["/api/account/link-operations/id%2F%3F/browser-url", "POST", "{}"],
			["/api/account/link-operations/id%2F%3F/cancel", "POST", "{}"],
		]);
	});
	it("refreshes a preauthorization CSRF denial once with a fresh token", async () => {
		// Arrange
		transport
			.mockResolvedValueOnce(reply({ csrfToken: "old" }))
			.mockResolvedValueOnce(reply({ error: "account_csrf_invalid" }, 403))
			.mockResolvedValueOnce(reply({ csrfToken: "new" }))
			.mockResolvedValueOnce(reply({ version: 1 }));
		// Act
		await api.startAccountLink("group", "context", checked);
		// Assert
		expect(transport).toHaveBeenCalledTimes(4);
		expect(transport.mock.calls[3][1]?.headers).toMatchObject({ "X-Codemem-Account-Csrf": "new" });
	});
	it.each([
		{ failure: "network", expected: { message: "lost reply" }, callCount: 2 },
		{ failure: "denied", expected: { status: 403, code: "request_failed" }, callCount: 2 },
		{
			failure: "csrf-again",
			expected: { status: 403, code: "account_csrf_invalid" },
			callCount: 4,
		},
		{ failure: "server", expected: { status: 500, code: "account_csrf_invalid" }, callCount: 2 },
	])("does not replay a start after $failure", async ({ failure, expected, callCount }) => {
		// Arrange
		transport.mockResolvedValueOnce(reply({ csrfToken: "old" }));
		if (failure === "network") transport.mockRejectedValueOnce(new Error("lost reply"));
		if (failure === "denied") transport.mockResolvedValueOnce(reply({ error: "not_allowed" }, 403));
		if (failure === "server")
			transport.mockResolvedValueOnce(reply({ error: "account_csrf_invalid" }, 500));
		if (failure === "csrf-again")
			transport
				.mockResolvedValueOnce(reply({ error: "account_csrf_invalid" }, 403))
				.mockResolvedValueOnce(reply({ csrfToken: "new" }))
				.mockResolvedValueOnce(reply({ error: "account_csrf_invalid" }, 403));
		// Act
		const result = api.startAccountLink("group", "context", checked);
		// Assert
		await expect(result).rejects.toMatchObject(expected);
		expect(transport).toHaveBeenCalledTimes(callCount);
	});
	it.each([
		["https://coordinator.example/auth/link/start?code=fixture", true],
		["http://coordinator.example/auth/link/start", false],
		["https://other.example/auth/link/start", false],
		["https://coordinator.example/other", false],
		["https://user:pass@coordinator.example/auth/link/start", false],
		["https://coordinator.example/auth/link/start#private", false],
		["/auth/link/start", false],
		["javascript:alert(1)", false],
		["https://coordinator.example:444/auth/link/start", false],
		["https://coordinator.example/auth/link/start/", false],
		["https://coordinator.example.evil.test/auth/link/start", false],
	])("validates protected URL %s", (url, expected) => {
		// Arrange
		const origin = "https://coordinator.example";
		// Act
		const actual = api.validAccountBrowserUrl(url, origin);
		// Assert
		expect(actual).toBe(expected);
	});
});

describe("account session lifetime and failures", () => {
	it("reuses the token in memory, but bootstraps again after a module reload", async () => {
		// Arrange
		const readStorage = vi.spyOn(Storage.prototype, "getItem");
		const writeStorage = vi.spyOn(Storage.prototype, "setItem");
		transport.mockImplementation(async (url) => {
			if (url === "/api/account/session")
				return reply({ version: 1, csrfToken: "private-fixture" });
			return reply({ version: 1 });
		});
		// Act
		await api.getAccountStatus();
		await api.getAccountStatus();
		vi.resetModules();
		const reloaded = await import("./account");
		await reloaded.getAccountStatus();
		// Assert
		expect(transport.mock.calls.filter(([url]) => url === "/api/account/session")).toHaveLength(2);
		expect(readStorage).not.toHaveBeenCalled();
		expect(writeStorage).not.toHaveBeenCalled();
		expect(transport.mock.calls.every(([url]) => !String(url).includes("private-fixture"))).toBe(
			true,
		);
	});
	it("forwards the same abort signal through bootstrap and the protected request", async () => {
		// Arrange
		const controller = new AbortController();
		transport.mockImplementation(async () => reply({ version: 1, csrfToken: "fixture" }));
		// Act
		await api.getAccountStatus(undefined, controller.signal);
		// Assert
		expect(transport.mock.calls.map(([, options]) => options?.signal)).toEqual([
			controller.signal,
			controller.signal,
		]);
	});
	it.each([401, 503])(
		"does not send an operation when session bootstrap returns %s",
		async (status) => {
			// Arrange
			transport.mockResolvedValueOnce(reply({ error: "private-server-details" }, status));
			// Act
			const result = api.startAccountLink("group", "context", checked);
			// Assert
			await expect(result).rejects.toMatchObject({ status, code: "session_unavailable" });
			expect(transport).toHaveBeenCalledTimes(1);
		},
	);
	it("stops when CSRF refresh fails instead of replaying the operation", async () => {
		// Arrange
		transport
			.mockResolvedValueOnce(reply({ csrfToken: "old" }))
			.mockResolvedValueOnce(reply({ error: "account_csrf_invalid" }, 403))
			.mockResolvedValueOnce(reply({ error: "unavailable" }, 503));
		// Act
		const result = api.startAccountLink("group", "context", checked);
		// Assert
		await expect(result).rejects.toMatchObject({ code: "session_unavailable" });
		expect(transport).toHaveBeenCalledTimes(3);
	});
	it("preserves an active-operation conflict without fetching or adopting its ID", async () => {
		// Arrange
		transport
			.mockResolvedValueOnce(reply({ csrfToken: "fixture" }))
			.mockResolvedValueOnce(
				reply({ error: "account_link_in_progress", operationId: "active-id" }, 409),
			);
		// Act
		const result = api.startAccountLink("group", "context", checked);
		// Assert
		await expect(result).rejects.toMatchObject({
			status: 409,
			code: "account_link_in_progress",
			operationId: "active-id",
		});
		expect(transport).toHaveBeenCalledTimes(2);
	});
	it.each(["status", "poll", "browser-url", "cancel"])(
		"does not retry a %s network failure",
		async (action) => {
			// Arrange
			transport
				.mockResolvedValueOnce(reply({ csrfToken: "fixture" }))
				.mockRejectedValueOnce(new TypeError("network unavailable"));
			const requests = {
				status: () => api.getAccountStatus(),
				poll: () => api.getAccountOperation("op-one"),
				"browser-url": () => api.getAccountBrowserUrl("op-one"),
				cancel: () => api.cancelAccountLink("op-one"),
			};
			// Act
			const result = requests[action as keyof typeof requests]();
			// Assert
			await expect(result).rejects.toThrow("network unavailable");
			expect(transport).toHaveBeenCalledTimes(2);
		},
	);
	it("returns a safe fallback code when an error response is not JSON", async () => {
		// Arrange
		transport
			.mockResolvedValueOnce(reply({ csrfToken: "fixture" }))
			.mockResolvedValueOnce(new Response("private-proxy-details", { status: 502 }));
		// Act
		const result = api.cancelAccountLink("op-one");
		// Assert
		await expect(result).rejects.toMatchObject({ status: 502, code: "request_failed" });
	});
});

describe("account error redaction", () => {
	it.each([
		[403, "account_local_viewer_required"],
		[503, "account_context_unavailable"],
	])("preserves known session denial %s %s for actionable guidance", async (status, code) => {
		// Arrange
		transport.mockResolvedValueOnce(reply({ error: code }, status));
		// Act
		const result = api.startAccountLink("group", "context", checked);
		// Assert
		await expect(result).rejects.toMatchObject({ status, code, message: code });
		expect(transport).toHaveBeenCalledTimes(1);
	});
	it.each([
		"https://coordinator.example/auth/link/start?code=private-fixture",
		{ private: "fixture" },
		42,
		null,
	])("replaces unknown or non-string error %j with fixed safe codes", async (error) => {
		// Arrange
		const body = { error, operationId: "https://coordinator.example/private-fixture" };
		transport.mockResolvedValueOnce(reply(body, 403));
		// Act
		const sessionFailure = api.getAccountStatus();
		// Assert
		await expect(sessionFailure).rejects.toMatchObject({
			code: "session_unavailable",
			message: "session_unavailable",
			operationId: undefined,
		});
		// Arrange / Act: a successful bootstrap must not make a later error body trusted.
		transport
			.mockResolvedValueOnce(reply({ csrfToken: "fixture-token" }))
			.mockResolvedValueOnce(reply(body, 409));
		const requestFailure = api.startAccountLink("group", "context", checked);
		// Assert
		await expect(requestFailure).rejects.toMatchObject({
			code: "request_failed",
			message: "request_failed",
			operationId: undefined,
		});
	});
	it.each([
		42,
		{ private: "fixture" },
		"",
		"x".repeat(1024),
		"https://coordinator.example/private-fixture",
		"op?private=fixture",
	])("does not expose invalid conflict operation identifier %j", async (operationId) => {
		// Arrange
		transport
			.mockResolvedValueOnce(reply({ csrfToken: "fixture-token" }))
			.mockResolvedValueOnce(reply({ error: "account_link_in_progress", operationId }, 409));
		// Act
		const result = api.startAccountLink("group", "context", checked);
		// Assert
		await expect(result).rejects.toMatchObject({
			code: "account_link_in_progress",
			message: "account_link_in_progress",
			operationId: undefined,
		});
	});
	it.each([200, 503])("redacts malformed session JSON at HTTP %s", async (status) => {
		// Arrange
		transport.mockResolvedValueOnce(new Response("private-parser-details", { status }));
		// Act
		const result = api.getAccountStatus();
		// Assert
		const code = status === 200 ? "invalid_response" : "session_unavailable";
		await expect(result).rejects.toMatchObject({ code, message: code, operationId: undefined });
		expect(transport).toHaveBeenCalledTimes(1);
	});
});

describe("account concurrent refresh and configured browser origins", () => {
	it("snapshots each refreshed token when another denial clears the shared memo before retry", async () => {
		// Arrange: prime the module token as if both GETs predate a Viewer restart.
		transport
			.mockResolvedValueOnce(reply({ csrfToken: "old" }))
			.mockResolvedValueOnce(reply({ version: 1 }));
		await api.getAccountStatus("prime");
		transport.mockReset();
		const laterDenial = deferred<unknown>();
		const laterSession = deferred<Response>();
		const firstRetried = deferred<void>();
		const denial = { error: "account_csrf_invalid" };
		const blockedDenial = reply(denial, 403);
		// Control the caught JSON promise so C's handler resumes in the exact race window.
		const denialJson = Promise.resolve(denial);
		vi.spyOn(denialJson, "catch").mockReturnValue(laterDenial.promise);
		vi.spyOn(blockedDenial, "clone").mockReturnValue({
			json: () => denialJson,
		} as Response);
		const refreshedPayload = {
			get csrfToken() {
				// Queue C's denial handler before A resumes its await session().
				// C clears the shared memo while its own session is still pending.
				laterDenial.resolve(denial);
				return "new";
			},
		};
		const firstSession = reply({});
		vi.spyOn(firstSession, "json").mockResolvedValue(refreshedPayload);
		transport
			.mockResolvedValueOnce(reply(denial, 403))
			.mockResolvedValueOnce(blockedDenial)
			.mockResolvedValueOnce(firstSession)
			.mockImplementationOnce(() => laterSession.promise)
			.mockImplementationOnce(async () => {
				firstRetried.resolve();
				return reply({ version: 1 });
			})
			.mockResolvedValueOnce(reply({ version: 1 }));
		// Act: C may finish refreshing only after A has actually sent its retry.
		const first = api.getAccountStatus("a");
		const concurrent = api.getAccountOperation("c");
		await firstRetried.promise;
		laterSession.resolve(reply({ csrfToken: "new" }));
		await Promise.all([first, concurrent]);
		// Assert: reading the cleared shared memo would send [a, ""] in the third slot.
		const headers = transport.mock.calls
			.filter(([url]) => url !== "/api/account/session")
			.map(([url, options]) => [
				String(url).includes("group_id=a") ? "a" : "c",
				new Headers(options?.headers).get("X-Codemem-Account-Csrf"),
			]);
		expect(headers).toEqual([
			["a", "old"],
			["c", "old"],
			["a", "new"],
			["c", "new"],
		]);
		expect(transport.mock.calls.filter(([url]) => url === "/api/account/session")).toHaveLength(2);
	});
	it.each([
		["http://127.0.0.1:8787", "http://127.0.0.1:8787", true],
		["http://[::1]:8787", "http://[::1]:8787", true],
		["http://localhost:8787", "http://localhost:8787", false],
		["http://coordinator.example", "http://coordinator.example", false],
		["http://127.0.0.1:8787", "http://127.0.0.1:8788", false],
		["http://127.0.0.1:8787", "http://[::1]:8787", false],
	])("validates configured HTTP origin %s against URL origin %s", (origin, urlOrigin, expected) => {
		// Arrange
		const url = `${urlOrigin}/auth/link/start?code=fixture`;
		// Act
		const actual = api.validAccountBrowserUrl(url, origin);
		// Assert
		expect(actual).toBe(expected);
	});
});
