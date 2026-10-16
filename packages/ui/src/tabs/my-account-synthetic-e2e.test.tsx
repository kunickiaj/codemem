import { once } from "node:events";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { CoordinatorAccountLinkStatusRead, linkCoordinatorAccount } from "@codemem/core";
import { CoordinatorAccountLinkError } from "@codemem/core";
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountContextResult } from "../../../viewer-server/src/account/context";
import { createAccountGuard } from "../../../viewer-server/src/account/guard";
import { createAccountLinkRegistry } from "../../../viewer-server/src/account/link-registry";
import { accountOperationRoutes } from "../../../viewer-server/src/routes/account-operations";
import { accountStatusRoutes } from "../../../viewer-server/src/routes/account-status";
import type { RecipientPolicyIntentGraphV1 } from "../lib/api/sync";

// Synthetic end-to-end: production Sharing -> API client -> real loopback HTTP ->
// protected production router/registry. Only coordinator, profile and popup are fake.
// This does not exercise Google, a real browser popup, capture, or peer sync.
const PRIVATE = "https://coordinator.example.test/auth/link/start?request=synthetic-private";
const PATH = "/api/account/link-operations";
const requireServer = createRequire(
	resolve(import.meta.dirname, "../../../viewer-server/package.json"),
);
const { Hono } = requireServer("hono") as {
	Hono: new () => ReturnType<typeof createAccountGuard>["routes"];
};
const context = {
	contextId: "context-a",
	groupId: "group-a",
	deviceId: "device-a",
	fingerprint: "a".repeat(64),
	identityId: "identity-a",
	identityLabel: "Synthetic identity",
	deviceLabel: "Synthetic device",
	dbPath: "/synthetic/never-open.sqlite",
	keysDir: "/synthetic/never-open-keys",
	coordinatorUrl: "https://coordinator.example.test",
	fileIdentity: { dev: "1", ino: "2" },
};
const ready = {
	setup: "ready" as const,
	groups: [context.groupId],
	selectedGroupId: context.groupId,
	coordinator: { origin: context.coordinatorUrl },
	context,
};
const graph: RecipientPolicyIntentGraphV1 = {
	version: 1,
	identities: [],
	teams: [],
	teamMemberships: [],
	identityDevices: [],
	projectRecipients: [],
};
type RemoteState = "unlinked" | "linked" | "review_required" | "conflict" | "revoked";
function remote(state: RemoteState = "unlinked"): CoordinatorAccountLinkStatusRead {
	const subject = {
		version: 2 as const,
		coordinatorId: "coordinator-a",
		groupId: context.groupId,
		deviceId: context.deviceId,
		fingerprint: context.fingerprint,
	};
	if (state === "review_required" || state === "conflict")
		return {
			kind: "status",
			status: { ...subject, state, identityId: null, authority: null, account: null },
		};
	return {
		kind: "status",
		status: {
			...subject,
			identityId: context.identityId,
			authority: "device_claim",
			...(state === "linked"
				? { state, account: { displayName: "Synthetic person", email: "fake@example.test" } }
				: { state, account: null }),
		},
	};
}
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const finalResult = {
	coordinatorId: "coordinator-a",
	identityId: context.identityId,
	attemptId: "synthetic-attempt",
	state: "finalized" as const,
};
const cleanup: (() => Promise<unknown>)[] = [];
let mount: HTMLDivElement;
beforeEach(() => {
	vi.resetModules(); // Every client bootstraps its own in-memory CSRF token.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	mount = document.createElement("div");
	document.body.append(mount);
});
afterEach(async () => {
	try {
		act(() => render(null, mount));
		mount.remove();
		for (const close of cleanup.splice(0).reverse()) await close();
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	}
});
function button(name: string) {
	const node = [...mount.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent === name,
	);
	if (!node) throw new Error(`Missing synthetic E2E button: ${name}`);
	return node;
}
async function httpBridge(app: ReturnType<typeof createAccountGuard>["routes"]) {
	const server = createServer(async (req, res) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const body = Buffer.concat(chunks).toString();
			const response = await app.request(`http://${req.headers.host}${req.url}`, {
				method: req.method,
				headers: req.headers as Record<string, string>,
				...(body ? { body } : {}),
			});
			res.writeHead(response.status, Object.fromEntries(response.headers));
			res.end(await response.text());
		} catch {
			res.writeHead(500);
			res.end("Synthetic HTTP bridge failure");
		}
	});
	cleanup.push(async () => {
		const closed = new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		server.closeAllConnections();
		await closed;
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = (server.address() as AddressInfo).port;
	const origin = `http://127.0.0.1:${port}`;
	const seen: { path: string; method: string; headers: Headers; status: number; body: string }[] =
		[];
	const pending = new Set<Promise<Response>>();
	function send(path: string, init: RequestInit = {}) {
		// This is the simulated document origin. Never derive it from arbitrary input.
		const headers = new Headers(init.headers);
		if (!headers.has("Origin")) headers.set("Origin", origin);
		const response = new Promise<Response>((resolve, reject) => {
			const req = request(
				{
					hostname: "127.0.0.1",
					port,
					path,
					agent: false,
					method: init.method ?? "GET",
					headers: Object.fromEntries(headers),
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
					res.on("end", () => {
						const body = Buffer.concat(chunks).toString();
						seen.push({
							path,
							method: init.method ?? "GET",
							headers,
							status: res.statusCode ?? 500,
							body,
						});
						resolve(
							new Response(body, {
								status: res.statusCode,
								headers: res.headers as Record<string, string>,
							}),
						);
					});
				},
			);
			req.on("error", reject);
			if (init.signal?.aborted) req.destroy(new Error("Synthetic request aborted"));
			else
				init.signal?.addEventListener(
					"abort",
					() => req.destroy(new Error("Synthetic request aborted")),
					{ once: true },
				);
			req.end(init.body);
		});
		pending.add(response);
		void response.then(
			() => pending.delete(response),
			() => pending.delete(response),
		);
		return response;
	}
	return { port, origin, seen, pending, send };
}
async function fixture() {
	const readContext = vi.fn((_group?: string): AccountContextResult => structuredClone(ready));
	const readRemoteStatus = vi.fn(async (): Promise<CoordinatorAccountLinkStatusRead> => remote());
	const done = deferred<Awaited<ReturnType<typeof linkCoordinatorAccount>>>();
	const started = deferred<Parameters<typeof linkCoordinatorAccount>[0]>();
	let abortError: Error | null = new CoordinatorAccountLinkError("link_stopped");
	const link = vi.fn<typeof linkCoordinatorAccount>((options) => {
		started.resolve(options);
		options.signal?.addEventListener("abort", () => {
			if (abortError) done.reject(abortError);
		});
		options.onBrowserStart?.(PRIVATE);
		return done.promise;
	});
	const registry = createAccountLinkRegistry({ readContext, link });
	const address = { host: "127.0.0.1", port: 0 };
	const options = { getListenerAddress: () => address, readContext, readRemoteStatus, registry };
	// Same middleware and router order as registerAccountRoutes; no store is involved.
	const guard = createAccountGuard(options);
	const app = new Hono();
	app.use("*", guard.middleware);
	app.route("/", guard.routes);
	app.route("/", accountStatusRoutes(options));
	app.route("/", accountOperationRoutes(options));
	const { port, origin, seen, pending, send } = await httpBridge(app);
	address.port = port;
	cleanup.push(async () => {
		// Release even an intentionally uncooperative late-completion fixture.
		done.resolve(finalResult);
		await registry.close();
	});
	vi.stubGlobal(
		"fetch",
		vi.fn((input: string, init?: RequestInit) => {
			if (!input.startsWith("/api/account/"))
				throw new Error("Unexpected external network request");
			return send(input, init);
		}),
	);
	const storage = vi.spyOn(Storage.prototype, "setItem");
	const popup = { opener: {}, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
	const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
	async function drain() {
		// Drain actual socket completions plus Preact effects; no wall-clock sleeps.
		for (let turn = 0; turn < 8; turn++) {
			await act(async () => {
				await Promise.allSettled([...pending]);
				await vi.advanceTimersByTimeAsync(0);
			});
		}
	}
	async function show() {
		const { mountRecipientPolicySharing } = await import("./recipient-policy-sharing");
		await act(async () => mountRecipientPolicySharing(mount, [], graph));
		await drain();
	}
	async function click(name: string) {
		act(() => button(name).click());
		await drain();
	}
	async function poll() {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		await drain();
	}
	function noLeaks() {
		expect(mount.innerHTML).not.toContain(PRIVATE);
		expect(mount.innerHTML).not.toContain(context.dbPath);
		const session = seen.find((entry) => entry.path === "/api/account/session");
		if (session) expect(mount.innerHTML).not.toContain(JSON.parse(session.body).csrfToken);
		expect(storage).not.toHaveBeenCalled();
		expect(
			seen
				.filter((entry) => !entry.path.endsWith("/browser-url"))
				.map((entry) => entry.body)
				.join(""),
		).not.toContain(PRIVATE);
		expect(seen.map((entry) => entry.path).join("")).not.toContain("synthetic-private");
	}
	return {
		readContext,
		readRemoteStatus,
		done,
		started,
		link,
		registry,
		send,
		seen,
		origin,
		storage,
		popup,
		open,
		show,
		click,
		poll,
		drain,
		noLeaks,
		setAbortError(error: Error | null) {
			abortError = error;
		},
	};
}

describe("My Account synthetic end-to-end over protected loopback HTTP", () => {
	it("reads status without starting and hands off only after an authorized user gesture", async () => {
		// Arrange
		const f = await fixture();
		await f.show();
		expect(mount.textContent).toContain("No Google account is linked");
		expect(f.link).not.toHaveBeenCalled();
		expect(f.open).not.toHaveBeenCalled();
		expect(f.seen.map((entry) => entry.path)).toEqual([
			"/api/account/session",
			"/api/account/link-status",
		]);
		// Act
		await f.click("Link Google account");
		await f.poll();
		// Assert: the real CSRF bootstrap, start, registry and private POST delivery all ran.
		expect(f.link).toHaveBeenCalledOnce();
		expect(await f.started.promise).toMatchObject({
			dbPath: context.dbPath,
			expectedIdentityId: context.identityId,
			expectedAuthority: "device_claim",
		});
		expect(f.open).toHaveBeenCalledExactlyOnceWith("about:blank", "_blank");
		expect(f.popup.opener).toBeNull();
		expect(f.popup.location.replace).toHaveBeenCalledExactlyOnceWith(PRIVATE);
		expect(f.seen.find((entry) => entry.path === PATH)).toMatchObject({
			method: "POST",
			status: 202,
		});
		expect(f.seen.find((entry) => entry.path.endsWith("/browser-url"))).toMatchObject({
			method: "POST",
			status: 200,
		});
		f.noLeaks();
	});
	it("offers a URL-free fallback when popup reservation is blocked, then verifies success by status", async () => {
		// Arrange
		const f = await fixture();
		f.open.mockReturnValue(null);
		await f.show();
		// Act
		await f.click("Link Google account");
		await f.poll();
		expect(button("Open Google sign-in")).toBeTruthy();
		f.noLeaks();
		await f.click("Open Google sign-in");
		f.readRemoteStatus.mockResolvedValue(remote("linked"));
		f.done.resolve(finalResult);
		await f.poll();
		// Assert
		expect(f.open).toHaveBeenLastCalledWith(PRIVATE, "_blank", "noopener,noreferrer");
		expect(mount.textContent).toContain("fake@example.test");
		expect(button("Link Google account").disabled).toBe(true);
		expect(mount.textContent).not.toContain("Open Google sign-in");
		f.noLeaks();
	});
});

describe("My Account synthetic end-to-end terminal states and context lifetime", () => {
	it.each(["review_required", "conflict", "revoked"] as const)(
		"keeps %s read-only and Sharing navigable",
		async (state) => {
			// Arrange
			const f = await fixture();
			f.readRemoteStatus.mockResolvedValue(remote(state));
			// Act
			await f.show();
			await f.click("Check status");
			const tabs = [...mount.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
			act(() => tabs[1].click());
			// Assert
			expect(tabs[1].getAttribute("aria-selected")).toBe("true");
			expect(button("Link Google account").disabled).toBe(true);
			expect(mount.textContent).toContain(
				{
					review_required: "review-device-owner",
					conflict: "conflicting account link",
					revoked: "was revoked",
				}[state],
			);
			expect(f.link).not.toHaveBeenCalled();
			expect(f.open).not.toHaveBeenCalled();
			expect(f.seen.every((entry) => entry.method === "GET")).toBe(true);
			f.noLeaks();
		},
	);
	it.each(["cancelled", "outcome_unknown"] as const)(
		"shows %s without claiming a linked account",
		async (outcome) => {
			// Arrange
			const f = await fixture();
			if (outcome === "outcome_unknown")
				f.setAbortError(
					Object.assign(new CoordinatorAccountLinkError("cancellation_unconfirmed"), {
						cause: PRIVATE,
					}),
				);
			await f.show();
			await f.click("Link Google account");
			// Act
			await f.click("Cancel linking");
			await f.poll();
			// Assert
			expect((await f.started.promise).signal?.aborted).toBe(true);
			expect(mount.textContent).toContain(
				outcome === "cancelled"
					? "Cancellation was reported"
					: "couldn’t confirm whether linking finished",
			);
			expect(mount.textContent).not.toContain("fake@example.test");
			expect(f.seen.some((entry) => entry.path.endsWith("/cancel") && entry.status === 202)).toBe(
				true,
			);
			f.noLeaks();
		},
	);
	it("does not relabel a late old-context completion as the newly selected Identity", async () => {
		// Arrange: runtime deliberately ignores cancellation until explicitly completed.
		const f = await fixture();
		f.setAbortError(null);
		await f.show();
		await f.click("Link Google account");
		const old = f.registry.forContext(context.contextId);
		if (!old) throw new Error("Expected synthetic operation");
		f.readContext.mockReturnValue({
			...ready,
			context: {
				...context,
				contextId: "context-b",
				identityId: "identity-b",
				identityLabel: "New synthetic identity",
			},
		});
		f.readRemoteStatus.mockResolvedValue({ kind: "unavailable", code: "coordinator_unreachable" });
		// Act
		expect(button("Check status").disabled).toBe(true);
		await f.click("Check status");
		f.done.resolve(finalResult);
		await f.drain();
		await f.poll();
		// Assert
		expect(f.registry.get(old.operationId)).toMatchObject({
			contextId: "context-a",
			state: "succeeded",
		});
		expect(mount.textContent).toContain("New synthetic identity");
		expect(mount.textContent).toContain(
			"The earlier link finished for its original Identity. Check status there to confirm.",
		);
		expect(mount.textContent).not.toContain("fake@example.test");
		expect(button("Link Google account").disabled).toBe(true);
		expect(f.link).toHaveBeenCalledOnce();
		f.noLeaks();
	});
});

describe("My Account synthetic end-to-end request authority", () => {
	it.each(["foreign-origin", "foreign-port", "foreign-host", "missing-csrf"] as const)(
		"denies %s before runtime start or private URL delivery",
		async (attack) => {
			// Arrange: use the genuine client-bootstrap token, not a bypass token.
			const f = await fixture();
			await f.show();
			const token = f.seen
				.find((entry) => entry.path.includes("link-status"))
				?.headers.get("X-Codemem-Account-Csrf");
			if (!token) throw new Error("Expected real account session token");
			const headers = {
				Origin: f.origin,
				"X-Codemem-Account-Csrf": token,
				"Content-Type": "application/json",
			};
			if (attack === "foreign-origin") headers.Origin = "https://foreign.example.test";
			if (attack === "foreign-port") headers.Origin = "http://127.0.0.1:1";
			if (attack === "foreign-host") Object.assign(headers, { Host: "127.0.0.1:1" });
			if (attack === "missing-csrf") headers["X-Codemem-Account-Csrf"] = "";
			const reads = f.readContext.mock.calls.length;
			// Act
			const start = await f.send(PATH, {
				method: "POST",
				headers,
				body: JSON.stringify({
					groupId: context.groupId,
					contextId: context.contextId,
					authority: "device_claim",
					coordinatorId: "coordinator-a",
				}),
			});
			const delivery = await f.send(`${PATH}/00000000-0000-4000-8000-000000000000/browser-url`, {
				method: "POST",
				headers,
				body: "{}",
			});
			// Assert: Origin, exact Host port and CSRF are checked by production middleware.
			const expectedHeaders = Object.fromEntries(new Headers(headers));
			expect(f.seen.slice(-2).map((entry) => Object.fromEntries(entry.headers))).toEqual([
				expectedHeaders,
				expectedHeaders,
			]);
			for (const response of [start, delivery]) {
				expect(response.status).toBe(403);
				expect(response.headers.get("cache-control")).toBe("no-store");
				expect(response.headers.get("referrer-policy")).toBe("no-referrer");
				expect(
					[...response.headers.keys()].filter((key) => key.startsWith("access-control-")),
				).toEqual([]);
				const body = await response.text();
				expect(body).not.toContain(PRIVATE);
				expect(JSON.parse(body).error).toBe(
					{
						"foreign-origin": "account_request_rejected",
						"foreign-port": "account_request_rejected",
						"foreign-host": "account_request_rejected",
						"missing-csrf": "account_csrf_invalid",
					}[attack],
				);
			}
			expect(f.readContext).toHaveBeenCalledTimes(reads);
			expect(f.link).not.toHaveBeenCalled();
			// A real private URL exists now: the same hostile request still cannot retrieve it.
			const authorized = await f.send(PATH, {
				method: "POST",
				headers: {
					...headers,
					Origin: f.origin,
					Host: new URL(f.origin).host,
					"X-Codemem-Account-Csrf": token,
				},
				body: JSON.stringify({
					groupId: context.groupId,
					contextId: context.contextId,
					authority: "device_claim",
					coordinatorId: "coordinator-a",
				}),
			});
			expect(authorized.status).toBe(202);
			expect(f.seen.slice(-1).map((entry) => entry.headers.get("Origin"))).toEqual([f.origin]);
			const active = f.registry.forContext(context.contextId);
			if (!active) throw new Error("Expected authorized synthetic operation");
			const protectedDelivery = await f.send(`${PATH}/${active.operationId}/browser-url`, {
				method: "POST",
				headers,
				body: "{}",
			});
			expect(protectedDelivery.status).toBe(403);
			expect(f.seen.slice(-1).map((entry) => entry.headers.get("Origin"))).toEqual([
				headers.Origin,
			]);
			expect(await protectedDelivery.text()).not.toContain(PRIVATE);
			expect(f.link).toHaveBeenCalledOnce();
			f.noLeaks();
		},
	);
});
