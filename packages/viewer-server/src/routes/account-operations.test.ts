import type {
	CoordinatorAccountLinkStatusRead,
	changeCoordinatorAccount,
	linkCoordinatorAccount,
	readCoordinatorAccountChangeCapabilities,
} from "@codemem/core";
import { CoordinatorAccountLinkError } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountContextResult } from "../account/context.js";
import { createAccountLinkRegistry } from "../account/link-registry.js";
import type { AccountRebindRunner } from "../account/rebind.js";
import { createApp, createSyncApp } from "../index.js";

const ORIGIN = "http://127.0.0.1:7441";
const PATH = "/api/account/link-operations";
const PRIVATE = "https://coordinator.example.test/auth/link/start?request=private-fixture";
const context = {
	contextId: "context-a",
	groupId: "group-a",
	deviceId: "device-a",
	fingerprint: "a".repeat(64),
	identityId: "actor-a",
	dbPath: "/fixture/never-open.sqlite",
	keysDir: "/fixture/keys",
	configPath: "/fixture/config",
	coordinatorUrl: "https://coordinator.example.test",
	fileIdentity: { dev: "1", ino: "2" },
};
const ready = {
	setup: "ready" as const,
	groups: ["group-a"],
	selectedGroupId: "group-a",
	coordinator: { origin: context.coordinatorUrl },
	context,
};
function remote(
	state: "unlinked" | "linked" | "review_required" | "revoked" | "conflict" = "unlinked",
	patch: Partial<Extract<CoordinatorAccountLinkStatusRead, { kind: "status" }>["status"]> = {},
): CoordinatorAccountLinkStatusRead {
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
			state,
			account: null,
			...patch,
		} as Extract<CoordinatorAccountLinkStatusRead, { kind: "status" }>["status"],
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
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
	vi.restoreAllMocks();
});
async function fixture(registryOptions: { rebind?: AccountRebindRunner } = {}) {
	const readContext = vi.fn((_group?: string): AccountContextResult => structuredClone(ready));
	const readRemoteStatus = vi.fn(async (): Promise<CoordinatorAccountLinkStatusRead> => remote());
	const done = deferred<Awaited<ReturnType<typeof linkCoordinatorAccount>>>();
	const started = deferred<Parameters<typeof linkCoordinatorAccount>[0]>();
	const link = vi.fn<typeof linkCoordinatorAccount>((options) => {
		started.resolve(options);
		options.signal?.addEventListener("abort", () => done.reject(new Error("synthetic stopped")));
		return done.promise;
	});
	const change = vi.fn<typeof changeCoordinatorAccount>(async (options) => ({
		intent: options.intent,
		state: "completed",
		coordinatorId: "coordinator-a",
		identityId: context.identityId,
		attemptId: "private-change",
	}));
	const readRemoteCapabilities = vi.fn<typeof readCoordinatorAccountChangeCapabilities>(
		async () => ({ kind: "unsupported" }),
	);
	const registry = createAccountLinkRegistry({ readContext, link, change, ...registryOptions });
	cleanups.push(() => registry.close());
	const storeFactory = vi.fn(() => {
		throw new Error("HTTP account routes must not open a store");
	});
	const address = { host: "127.0.0.1", port: 7441 };
	const app = createApp({
		storeFactory,
		accountLink: {
			getListenerAddress: () => address,
			readContext,
			readRemoteStatus,
			readRemoteCapabilities,
			registry,
		},
	});
	const session = await app.request(`${ORIGIN}/api/account/session`, {
		headers: { Host: "127.0.0.1:7441" },
	});
	const { csrfToken } = await session.json();
	const headers = {
		Host: "127.0.0.1:7441",
		Origin: ORIGIN,
		"X-Codemem-Account-Csrf": csrfToken,
		"Content-Type": "application/json; charset=utf-8",
	};
	const request = (
		path = PATH,
		method = "POST",
		body: string | undefined = JSON.stringify({
			groupId: context.groupId,
			contextId: context.contextId,
			authority: "device_claim",
			coordinatorId: "coordinator-a",
		}),
		extra = {},
	) =>
		app.request(`${ORIGIN}${path}`, {
			method,
			headers: { ...headers, ...extra },
			body: method === "GET" ? undefined : body,
		});
	const start = async () => {
		const response = await request();
		expect(response.status).toBe(202);
		const body = await response.json();
		return body.operation.operationId as string;
	};
	return {
		app,
		request,
		start,
		headers,
		readContext,
		readRemoteStatus,
		readRemoteCapabilities,
		change,
		registry,
		link,
		done,
		started,
		storeFactory,
		address,
	};
}
function privateResponse(response: Response) {
	expect(response.headers.get("Cache-Control")).toBe("no-store");
	expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	expect([...response.headers.keys()].filter((key) => key.startsWith("access-control-"))).toEqual(
		[],
	);
}

describe("account management HTTP contract", () => {
	it("keeps an unknown device-unlink outcome globally busy past its deadline without a browser handoff", async () => {
		const f = await fixture();
		f.readRemoteStatus.mockResolvedValue(remote("linked"));
		f.readRemoteCapabilities.mockResolvedValue({
			kind: "capabilities",
			coordinatorId: "coordinator-a",
			actions: { refresh: true, disconnect: true },
			unlinkTarget: "current-link",
		});
		f.change.mockRejectedValue(new CoordinatorAccountLinkError("cancellation_unconfirmed"));
		const body = JSON.stringify({
			groupId: context.groupId,
			contextId: context.contextId,
			coordinatorId: "coordinator-a",
			authority: "device_claim",
			intent: "disconnect",
			expectedLinkId: "current-link",
		});
		const { operation } = await (await f.request(PATH, "POST", body)).json();
		await vi.waitFor(() =>
			expect(f.registry.get(operation.operationId)?.state).toBe("outcome_unknown"),
		);
		vi.spyOn(Date, "now").mockReturnValue(Date.parse(operation.deadlineAt) + 1000000);
		expect(f.registry.hasActive()).toBe(true);
		expect(f.registry.browserUrl(operation.operationId)).toBeNull();
		expect((await f.request(PATH, "POST", body)).status).toBe(409);
		expect(f.change).toHaveBeenCalledOnce();
	});
	it.each(["wrong intent", "unknown outcome"])(
		"does not report success or automatically retry after %s",
		async (mode) => {
			const f = await fixture();
			f.readRemoteStatus.mockResolvedValue(remote("linked"));
			f.readRemoteCapabilities.mockResolvedValue({
				kind: "capabilities",
				coordinatorId: "coordinator-a",
				actions: { refresh: true, disconnect: true },
				unlinkTarget: "current-link",
			});
			if (mode === "unknown outcome")
				f.change.mockRejectedValue(new CoordinatorAccountLinkError("cancellation_unconfirmed"));
			else
				f.change.mockResolvedValue({
					intent: "disconnect",
					state: "completed",
					identityId: context.identityId,
					coordinatorId: "coordinator-a",
					attemptId: "private-change",
				});
			const body = JSON.stringify({
				groupId: context.groupId,
				contextId: context.contextId,
				coordinatorId: "coordinator-a",
				authority: "device_claim",
				intent: "refresh",
			});
			const { operation } = await (await f.request(PATH, "POST", body)).json();
			const state = mode === "unknown outcome" ? "outcome_unknown" : "failed";
			await vi.waitFor(() => expect(f.registry.get(operation.operationId)?.state).toBe(state));
			if (mode === "unknown outcome") {
				expect((await f.request(PATH, "POST", body)).status).toBe(409);
				expect(f.change).toHaveBeenCalledTimes(1);
			}
		},
	);
});
describe("account management capability checks", () => {
	it.each(["refresh", "disconnect"] as const)(
		"starts %s from revalidated capabilities and can start again after retained success",
		async (intent) => {
			const f = await fixture();
			f.readRemoteStatus.mockResolvedValue(remote("linked"));
			f.readRemoteCapabilities.mockResolvedValue({
				kind: "capabilities",
				coordinatorId: "coordinator-a",
				actions: { refresh: true, disconnect: true },
				unlinkTarget: "current-link",
			});
			const body = JSON.stringify({
				groupId: context.groupId,
				contextId: context.contextId,
				coordinatorId: "coordinator-a",
				authority: "controller_attestation",
				intent,
				expectedLinkId: "current-link",
			});
			for (let index = 0; index < 2; index++) {
				const response = await f.request(PATH, "POST", body);
				expect(response.status).toBe(202);
				const { operation } = await response.json();
				await vi.waitFor(() =>
					expect(f.registry.get(operation.operationId)?.state).toBe("succeeded"),
				);
				expect(f.registry.get(operation.operationId)?.intent).toBe(intent);
			}
			expect(f.change).toHaveBeenCalledTimes(2);
			expect(f.change.mock.calls[0][0]).toMatchObject({
				intent,
				expectedCoordinatorId: "coordinator-a",
				expectedIdentityId: context.identityId,
				signal: expect.any(AbortSignal),
				assertCurrentContext: expect.any(Function),
			});
			expect(f.change.mock.calls[0][0]).not.toHaveProperty("expectedAuthority");
			if (intent === "disconnect")
				expect(f.change.mock.calls[0][0].expectedLinkId).toBe("current-link");
			expect(f.link).not.toHaveBeenCalled();
		},
	);
	it.each([
		"denied",
		"unsupported",
		"coordinator changed",
		"context changed",
		"identity mismatch",
		"legacy coordinator",
		"target changed",
	])("does not execute stale UI capabilities: %s", async (mode) => {
		const f = await fixture();
		const allowed = mode !== "denied";
		const unlinkCapability =
			mode === "legacy coordinator"
				? {}
				: { unlinkTarget: mode === "target changed" ? "new-link" : "current-link" };
		f.readRemoteStatus.mockResolvedValue(
			remote("linked", mode === "identity mismatch" ? { identityId: "other" } : {}),
		);
		f.readRemoteCapabilities.mockImplementation(async () => {
			if (mode === "context changed")
				f.readContext.mockReturnValue({ ...ready, context: { ...context, identityId: "other" } });
			if (mode === "unsupported") return { kind: "unsupported" };
			return {
				kind: "capabilities",
				coordinatorId: mode === "coordinator changed" ? "other" : "coordinator-a",
				actions: { refresh: allowed, disconnect: allowed },
				...unlinkCapability,
			};
		});
		const response = await f.request(
			PATH,
			"POST",
			JSON.stringify({
				groupId: context.groupId,
				contextId: context.contextId,
				coordinatorId: "coordinator-a",
				authority: "device_claim",
				intent: "disconnect",
				expectedLinkId: "current-link",
			}),
		);
		expect(response.status).toBe(409);
		expect(f.change).not.toHaveBeenCalled();
		expect(f.link).not.toHaveBeenCalled();
	});
	it.each([null, "unlink", "", false, 1])(
		"rejects invalid intent %j rather than connecting",
		async (intent) => {
			const f = await fixture();
			const response = await f.request(
				PATH,
				"POST",
				JSON.stringify({
					groupId: context.groupId,
					contextId: context.contextId,
					coordinatorId: "coordinator-a",
					authority: "device_claim",
					intent,
				}),
			);
			expect(response.status).toBe(400);
			expect(f.readRemoteStatus).not.toHaveBeenCalled();
			expect(f.link).not.toHaveBeenCalled();
			expect(f.change).not.toHaveBeenCalled();
		},
	);
});
describe("account operation HTTP contract", () => {
	it("starts with the trusted profile and delivers the private URL only through the POST endpoint", async () => {
		const f = await fixture(); // Arrange
		const id = await f.start(); // Act
		const options = await f.started.promise;
		options.onBrowserStart?.(PRIVATE);
		const denied = await f.request(`${PATH}/${id}/browser-url`, "POST", "{}", {
			"X-Codemem-Account-Csrf": "",
		});
		const result = await f.request(`${PATH}/${id}`, "GET");
		const status = await f.request("/api/account/link-status", "GET");
		const delivery = await f.request(`${PATH}/${id}/browser-url`, "POST", "{}");
		// Assert: URLs, paths and callback details never enter public snapshots.
		expect(id).toMatch(/^[a-f0-9-]{36}$/);
		expect(options).toMatchObject({
			dbPath: context.dbPath,
			keysDir: context.keysDir,
			expectedIdentityId: context.identityId,
			expectedAuthority: "device_claim",
			expectedCoordinatorId: "coordinator-a",
		});
		const snapshot = await result.text();
		expect(snapshot).not.toContain(PRIVATE);
		expect(JSON.parse(snapshot)).toMatchObject({
			version: 1,
			current: true,
			operation: { operationId: id, state: "awaiting_browser", browserUrlAvailable: true },
		});
		const publicText = await status.text();
		expect(publicText).not.toContain(PRIVATE);
		expect(publicText).not.toContain(context.dbPath);
		expect(JSON.parse(publicText)).toMatchObject({
			canLink: false,
			blockedReason: "operation_active",
			operation: { operationId: id },
		});
		expect(delivery.status).toBe(200);
		expect(denied.status).toBe(403);
		expect(await delivery.json()).toEqual({ version: 1, url: PRIVATE });
		for (const response of [result, status, delivery]) privateResponse(response);
		expect(f.storeFactory).not.toHaveBeenCalled();
	});
	it("serializes starts even when both fresh remote checks finish together", async () => {
		const f = await fixture(); // Arrange
		const gate = deferred<CoordinatorAccountLinkStatusRead>();
		const both = deferred<void>();
		f.readRemoteStatus.mockImplementation(() => {
			if (f.readRemoteStatus.mock.calls.length === 2) both.resolve();
			return gate.promise;
		});
		const pending = [f.request(), f.request()]; // Act
		await both.promise;
		gate.resolve(remote());
		const responses = await Promise.all(pending);
		// Assert
		expect(responses.map((r) => r.status).sort()).toEqual([202, 409]);
		const bodies = await Promise.all(responses.map((r) => r.json()));
		const winner = bodies.find((b) => b.operation)?.operation;
		expect(bodies.find((b) => b.error)).toEqual({
			error: "account_link_in_progress",
			operationId: winner.operationId,
		});
		expect(f.link).toHaveBeenCalledOnce();
	});
});
describe("account start authority and lifecycle races", () => {
	it.each([
		"dbPath",
		"keysDir",
		"configPath",
		"coordinatorUrl",
		"deviceId",
		"fingerprint",
		"identityId",
		"fileIdentity.dev",
		"fileIdentity.ino",
	] as const)("rejects reused contextId with final %s authority drift", async (field) => {
		const f = await fixture();
		const changed = structuredClone(ready);
		if (field === "fileIdentity.dev") changed.context.fileIdentity.dev = "new";
		else if (field === "fileIdentity.ino") changed.context.fileIdentity.ino = "new";
		else changed.context[field] = "new";
		let reads = 0;
		f.readContext.mockImplementation(() => (++reads <= 3 ? structuredClone(ready) : changed));
		const response = await f.request();
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "account_context_changed" });
		expect(f.link).not.toHaveBeenCalled();
		expect(f.registry.forContext(context.contextId)).toBeNull();
	});
	it.each(["before-status", "mutated-reader-result"])(
		"retains the captured authority through %s drift with a reused contextId",
		async (when) => {
			const f = await fixture();
			const shared = structuredClone(ready);
			let reads = 0;
			f.readContext.mockImplementation(() => {
				reads++;
				if (reads === (when === "before-status" ? 2 : 4))
					shared.context.keysDir = "/fixture/new-keys";
				return shared;
			});
			const response = await f.request();
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "account_context_changed" });
			expect(f.link).not.toHaveBeenCalled();
			expect(f.registry.forContext(context.contextId)).toBeNull();
		},
	);
	it.each(["same", "other"])(
		"rejects delayed unlinked eligibility after the %s registry owner succeeds",
		async (ownership) => {
			const f = await fixture();
			const owner = ownership === "same" ? f : await fixture();
			const id = await owner.start();
			await owner.started.promise;
			const reading = deferred<void>();
			const delayed = deferred<CoordinatorAccountLinkStatusRead>();
			const stale = remote(); // Produced while A is active, before its successful finalization.
			f.readRemoteStatus.mockImplementationOnce(() => {
				reading.resolve();
				return delayed.promise;
			});
			const pending = f.request();
			await reading.promise;
			owner.done.resolve({
				coordinatorId: "coordinator-a",
				identityId: "actor-a",
				attemptId: "fixture",
				state: "finalized",
			});
			await owner.done.promise;
			for (let i = 0; i < 8; i++) await Promise.resolve();
			expect(owner.registry.get(id)?.state).toBe("succeeded");
			expect(f.registry.hasActive()).toBe(false);
			delayed.resolve(stale);
			const response = await pending;
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "account_context_changed" });
			expect(f.link).toHaveBeenCalledTimes(ownership === "same" ? 1 : 0);
			if (ownership === "other") expect(f.registry.get(id)).toBeNull();
			f.readRemoteStatus.mockResolvedValue(remote("linked"));
			const fresh = await f.request();
			expect(await fresh.json()).toEqual({
				error: "account_link_not_allowed",
				blockedReason: "already_linked",
			});
		},
	);
});
describe("account start eligibility", () => {
	it("rejects a changed authority instead of falling back to controller linking", async () => {
		const f = await fixture(); // Arrange: the displayed device eligibility changed.
		f.readRemoteStatus.mockResolvedValue(
			remote("unlinked", { authority: "controller_attestation" }),
		);
		const response = await f.request(); // Act
		expect(response.status).toBe(409); // Assert
		expect(await response.json()).toEqual({ error: "account_context_changed" });
		expect(f.link).not.toHaveBeenCalled();
		expect(f.registry.forContext(context.contextId)).toBeNull();
	});
	it.each([
		["review_required", remote("review_required"), "link_not_allowed"],
		["revoked", remote("revoked"), "link_not_allowed"],
		["linked", remote("linked"), "link_not_allowed"],
		["conflict", remote("conflict"), "link_not_allowed"],
		["identity", remote("unlinked", { identityId: "other" }), "link_not_allowed"],
		["groupId", remote("unlinked", { groupId: "other" }), "context_changed"],
		["deviceId", remote("unlinked", { deviceId: "other" }), "context_changed"],
		["fingerprint", remote("unlinked", { fingerprint: "other" }), "context_changed"],
		["unsupported", { kind: "unsupported" }, "link_not_allowed"],
		["unavailable", { kind: "unavailable", code: "coordinator_unreachable" }, "status_unavailable"],
	] as const)(
		"never starts from ineligible or unavailable status %s",
		async (kind, value, error) => {
			const f = await fixture(); // Arrange
			f.readRemoteStatus.mockResolvedValue(value);
			const response = await f.request(); // Act
			// Assert
			expect(response.status).toBe(kind === "unavailable" ? 503 : 409);
			expect((await response.json()).error).toBe(`account_${error}`);
			expect(f.link).not.toHaveBeenCalled();
			privateResponse(response);
		},
	);
	it.each(["unknown-group", "stale-context", "during-remote"])(
		"rejects %s without creating a job",
		async (kind) => {
			const f = await fixture(); // Arrange
			if (kind === "unknown-group")
				f.readContext.mockReturnValue({ error: "account_group_not_configured" });
			if (kind === "stale-context")
				f.readContext.mockReturnValue({ ...ready, context: { ...context, contextId: "new" } });
			if (kind === "during-remote")
				f.readRemoteStatus.mockImplementation(async () => {
					f.readContext.mockReturnValue({ ...ready, context: { ...context, contextId: "new" } });
					return remote();
				});
			const response = await f.request(); // Act
			expect(response.status).toBe(kind === "unknown-group" ? 400 : 409); // Assert
			expect((await response.json()).error).toBe(
				kind === "unknown-group" ? "account_group_not_configured" : "account_context_changed",
			);
			expect(f.link).not.toHaveBeenCalled();
		},
	);
	it.each(["contextId", "configPath", "fileIdentity"] as const)(
		"refuses URL delivery after fresh %s drift without relabeling the old operation",
		async (field) => {
			const f = await fixture(); // Arrange
			const id = await f.start();
			const core = await f.started.promise;
			core.onBrowserStart?.(PRIVATE);
			const changed = structuredClone(ready);
			if (field === "fileIdentity") changed.context.fileIdentity.ino = "new";
			else changed.context[field] = "new";
			f.readContext.mockReturnValue(changed);
			const delivery = await f.request(`${PATH}/${id}/browser-url`, "POST", "{}"); // Act
			await f.done.promise.catch(() => {});
			const snapshot = await f.request(`${PATH}/${id}`, "GET");
			// Assert
			expect(delivery.status).toBe(409);
			expect(core.signal?.aborted).toBe(true);
			expect(await delivery.text()).not.toContain(PRIVATE);
			expect(await snapshot.json()).toMatchObject({
				...(field === "contextId" ? { current: false } : {}),
				operation: { contextId: context.contextId, state: "failed", failure: "context_changed" },
			});
			privateResponse(delivery);
		},
	);
});
describe("account start cancellation during status read", () => {
	it("does not create an operation when the request aborts during a successful remote status read", async () => {
		const f = await fixture(); // Arrange
		const controller = new AbortController();
		const start = vi.spyOn(f.registry, "start");
		f.readRemoteStatus.mockImplementation(async () => {
			controller.abort();
			return remote();
		});
		const response = await f.app.request(
			new Request(`${ORIGIN}${PATH}`, {
				method: "POST",
				headers: f.headers,
				signal: controller.signal,
				body: JSON.stringify({
					groupId: context.groupId,
					contextId: context.contextId,
					authority: "device_claim",
					coordinatorId: "coordinator-a",
				}),
			}),
		); // Act
		expect(response.status).toBe(400); // Assert
		expect(await response.json()).toEqual({ error: "account_invalid_request" });
		expect(start).not.toHaveBeenCalled();
		expect(f.link).not.toHaveBeenCalled();
		expect(f.registry.hasActive()).toBe(false);
		privateResponse(response);
	});
});
describe("account operation status and cancellation", () => {
	it("reports an unknown cleanup result without exposing the core error cause", async () => {
		const f = await fixture(); // Arrange
		const id = await f.start();
		await f.started.promise;
		f.done.reject(new CoordinatorAccountLinkError("cancellation_unconfirmed", PRIVATE));
		await f.done.promise.catch(() => {});
		const response = await f.request(`${PATH}/${id}/cancel`, "POST", "{}"); // Act
		const text = await response.text();
		expect(response.status).toBe(200); // Assert
		expect(JSON.parse(text)).toMatchObject({
			operation: { state: "outcome_unknown", failure: "cancellation_unconfirmed" },
		});
		expect(text).not.toContain(PRIVATE);
	});
	it("blocks another context without embedding its operation, then uses fresh signed status after completion", async () => {
		const f = await fixture(); // Arrange
		const id = await f.start();
		await f.started.promise;
		f.readContext.mockReturnValue({
			...ready,
			context: { ...context, contextId: "context-b", groupId: "group-b" },
		});
		f.readRemoteStatus.mockResolvedValue(remote("unlinked", { groupId: "group-b" }));
		const elsewhere = await f.request("/api/account/link-status", "GET"); // Act
		f.readContext.mockReturnValue(ready);
		f.done.reject(new Error("synthetic failure"));
		await f.done.promise.catch(() => {});
		f.readRemoteStatus.mockResolvedValue(remote("linked"));
		const finished = await f.request("/api/account/link-status", "GET");
		// Assert
		expect(await elsewhere.json()).toMatchObject({
			canLink: false,
			blockedReason: "operation_active",
			operation: null,
			remote: { kind: "status", state: "unlinked" },
		});
		expect(await finished.json()).toMatchObject({
			canLink: false,
			blockedReason: "already_linked",
			operation: { operationId: id, state: "failed" },
		});
	});
	it("cancels old-context work idempotently", async () => {
		const f = await fixture(); // Arrange
		const id = await f.start();
		await f.started.promise;
		f.readContext.mockReturnValue({ ...ready, context: { ...context, contextId: "new" } });
		const first = await f.request(`${PATH}/${id}/cancel`, "POST", "{}"); // Act
		await f.done.promise.catch(() => {});
		const second = await f.request(`${PATH}/${id}/cancel`, "POST", "{}");
		// Assert
		expect(first.status).toBe(202);
		expect(second.status).toBe(200);
		expect(await second.json()).toMatchObject({
			version: 1,
			operation: { operationId: id, state: "cancelled" },
		});
	});
});

describe("account operation request boundary", () => {
	it("aborts a stalled body without waiting for an uncooperative stream cancellation", async () => {
		const f = await fixture(); // Arrange
		const pulling = deferred<void>();
		const controller = new AbortController();
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const stream = new ReadableStream<Uint8Array>({
			pull() {
				pulling.resolve();
				return new Promise<void>(() => {});
			},
			cancel,
		});
		const pending = f.app.request(
			new Request(`${ORIGIN}${PATH}`, {
				method: "POST",
				headers: f.headers,
				body: stream,
				signal: controller.signal,
				duplex: "half",
			} as RequestInit),
		); // Act
		await pulling.promise;
		controller.abort();
		const response = await pending;
		expect(response.status).toBe(400); // Assert
		expect(cancel).toHaveBeenCalledOnce();
		expect(stream.locked).toBe(false);
		expect(f.readContext).not.toHaveBeenCalled();
		privateResponse(response);
	});
	it.each([1024, 1025])(
		"enforces the streamed byte limit at %i bytes without Content-Length",
		async (size) => {
			const f = await fixture(); // Arrange
			const json = JSON.stringify({
				groupId: context.groupId,
				contextId: context.contextId,
				authority: "device_claim",
				coordinatorId: "coordinator-a",
			});
			const bytes = new TextEncoder().encode(json.padEnd(size));
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes.subarray(0, 512));
					controller.enqueue(bytes.subarray(512));
					controller.close();
				},
			});
			const response = await f.app.request(
				new Request(`${ORIGIN}${PATH}`, {
					method: "POST",
					headers: f.headers,
					body: stream,
					duplex: "half",
				} as RequestInit),
			); // Act
			expect(response.status).toBe(size === 1024 ? 202 : 400); // Assert
			expect(f.link).toHaveBeenCalledTimes(size === 1024 ? 1 : 0);
		},
	);
	it.each(["GET", "browser-url", "cancel"])(
		"returns 404 for unknown %s operation",
		async (action) => {
			const f = await fixture(); // Arrange
			const path = `${PATH}/00000000-0000-4000-8000-000000000000`;
			const response = await f.request(
				action === "GET" ? path : `${path}/${action}`,
				action === "GET" ? "GET" : "POST",
				"{}",
			); // Act
			expect(response.status).toBe(404); // Assert
			privateResponse(response);
		},
	);
	it.each([
		"null",
		"[]",
		"{}",
		'{"groupId":1,"contextId":"context-a"}',
		'{"groupId":"group-a","contextId":null}',
		'{"groupId":"group-a","contextId":"context-a","dbPath":"arbitrary"}',
		"{",
		" ".repeat(1025),
	])("rejects invalid start body %s", async (body) => {
		const f = await fixture(); // Arrange
		const response = await f.request(PATH, "POST", body); // Act
		expect(response.status).toBe(400); // Assert
		expect(f.readContext).not.toHaveBeenCalled();
		expect(f.link).not.toHaveBeenCalled();
	});
	it.each([
		[PATH, "POST", "{}", { "Content-Type": "text/plain" }],
		[`${PATH}?unused=1`, "POST", "{}", {}],
		[`${PATH}/unknown?unused=1`, "GET", undefined, {}],
		[`${PATH}/unknown`, "GET", undefined, { "Content-Length": "1" }],
		[`${PATH}/unknown/cancel`, "POST", '{"extra":1}', {}],
		[`${PATH}/unknown/browser-url`, "POST", "[]", {}],
	] as const)("rejects invalid framing %s %s", async (path, method, body, headers) => {
		const f = await fixture(); // Arrange
		const response = await f.request(path, method, body, headers); // Act
		expect(response.status).toBe(400); // Assert
		expect(f.readContext).not.toHaveBeenCalled();
		privateResponse(response);
	});
});
describe("account operation origin and availability", () => {
	it.each([
		{ Origin: "https://foreign.example.test" },
		{ Origin: "http://127.0.0.1:7442" },
		{ Host: "127.0.0.1:7442" },
		{ "X-Codemem-Account-Csrf": "" },
		{ "Sec-Fetch-Site": "cross-site" },
	])("rejects untrusted request before reading its body %j", async (headers) => {
		const f = await fixture(); // Arrange
		const request = new Request(`${ORIGIN}${PATH}`, {
			method: "POST",
			headers: { ...f.headers, ...headers },
			body: "{}",
		});
		if (!request.body) throw new Error("Expected fixture body");
		const bodyRead = vi.spyOn(request.body, "getReader");
		const response = await f.app.request(request); // Act
		expect(response.status).toBe(403); // Assert
		expect(bodyRead).not.toHaveBeenCalled();
		expect(f.readContext).not.toHaveBeenCalled();
		expect(f.readRemoteStatus).not.toHaveBeenCalled();
		expect(f.link).not.toHaveBeenCalled();
		privateResponse(response);
	});
	it("rejects OPTIONS and network-exposed listeners before account work", async () => {
		const f = await fixture(); // Arrange
		const options = await f.request(PATH, "OPTIONS", undefined); // Act
		f.address.host = "0.0.0.0";
		const exposed = await f.request();
		expect(options.status).toBe(403); // Assert
		expect(exposed.status).toBe(403);
		expect(f.readContext).not.toHaveBeenCalled();
	});
	it("hides arbitrary thrown causes from responses and logs", async () => {
		const f = await fixture(); // Arrange
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		f.readContext.mockImplementation(() => {
			throw new Error(PRIVATE);
		});
		const response = await f.request(); // Act
		expect(response.status).toBe(500); // Assert
		expect(await response.text()).not.toContain(PRIVATE);
		expect(logged).not.toHaveBeenCalled();
		privateResponse(response);
	});
	it("does not enable operation routes in session-only or sync-only applications", async () => {
		const f = await fixture(); // Arrange
		const sessionOnly = createApp({ accountLink: { getListenerAddress: () => f.address } });
		const session = await sessionOnly.request(`${ORIGIN}/api/account/session`, {
			headers: f.headers,
		});
		const token = (await session.json()).csrfToken;
		const disabled = await sessionOnly.request(`${ORIGIN}${PATH}`, {
			method: "POST",
			headers: { ...f.headers, "X-Codemem-Account-Csrf": token },
			body: "{}",
		}); // Act
		const sync = await createSyncApp().request(`${ORIGIN}${PATH}`, { method: "POST", body: "{}" });
		expect(disabled.status).toBe(404); // Assert
		expect(sync.status).toBe(404);
	});
});

describe("sign in with Google", () => {
	const signIn = JSON.stringify({
		groupId: context.groupId,
		contextId: context.contextId,
		authority: "device_claim",
		coordinatorId: "coordinator-a",
		intent: "sign_in",
	});

	const rebind: AccountRebindRunner = async () => ({ kind: "failed" });

	it.each(["connect", "refresh", "disconnect", undefined])(
		"rejects explicit null authority for %s without dispatching a runner",
		async (intent) => {
			// Arrange: null authority is a sign-in-only request shape, even with otherwise valid CSRF.
			const runner = vi.fn(rebind);
			const f = await fixture({ rebind: runner });
			const body = {
				...JSON.parse(signIn),
				intent,
				authority: null,
				...(intent === "disconnect" ? { expectedLinkId: "current-link" } : {}),
			};
			// Act
			const response = await f.request(PATH, "POST", JSON.stringify(body));
			// Assert
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "account_invalid_request" });
			expect(runner).not.toHaveBeenCalled();
			expect(f.link).not.toHaveBeenCalled();
			expect(f.change).not.toHaveBeenCalled();
		},
	);

	it.each(["unknown", undefined, {}, 0])(
		"rejects invalid sign-in authority %s",
		async (authority) => {
			// Arrange
			const runner = vi.fn(rebind);
			const f = await fixture({ rebind: runner });
			// Act
			const response = await f.request(
				PATH,
				"POST",
				JSON.stringify({ ...JSON.parse(signIn), authority }),
			);
			// Assert
			expect(response.status).toBe(400);
			expect(runner).not.toHaveBeenCalled();
			expect(f.link).not.toHaveBeenCalled();
		},
	);

	it.each(["review_required", "conflict"] as const)(
		"refuses null authority in %s without a verified linked owner",
		async (state) => {
			// Arrange
			const runner = vi.fn(rebind);
			const f = await fixture({ rebind: runner });
			f.readRemoteStatus.mockResolvedValue(remote(state));
			// Act
			const response = await f.request(
				PATH,
				"POST",
				JSON.stringify({ ...JSON.parse(signIn), authority: null }),
			);
			// Assert
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ error: "account_link_not_allowed" });
			expect(runner).not.toHaveBeenCalled();
			expect(f.link).not.toHaveBeenCalled();
		},
	);

	it("starts when this device's Identity has no Google link", async () => {
		// Arrange
		const f = await fixture({ rebind });
		// Act
		const response = await f.request(PATH, "POST", signIn);
		// Assert
		expect(response.status).toBe(202);
		expect((await response.json()).operation).toMatchObject({ intent: "sign_in" });
	});

	it("starts a self-bind when this Identity is linked on another device", async () => {
		// Arrange: the coordinator withholds the profile, so this device has no proof of its own.
		const f = await fixture({ rebind });
		f.readRemoteStatus.mockResolvedValue(remote("linked"));
		// Act
		const response = await f.request(PATH, "POST", signIn);
		// Assert
		expect(response.status).toBe(202);
	});

	it("is not offered once this device holds the Identity's link", async () => {
		// Arrange
		const f = await fixture({ rebind });
		f.readRemoteStatus.mockResolvedValue(
			remote("linked", { account: { email: "person@example.test" } }),
		);
		// Act
		const response = await f.request(PATH, "POST", signIn);
		// Assert
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: "account_link_not_allowed" });
	});

	it("is not offered by a Viewer without sign-in", async () => {
		// Arrange
		const f = await fixture();
		// Act
		const response = await f.request(PATH, "POST", signIn);
		// Assert
		expect(response.status).toBe(409);
	});
});
