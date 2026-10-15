import { CoordinatorAccountLinkError, type linkCoordinatorAccount } from "@codemem/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountContext, AccountContextResult } from "./context.js";
import { createAccountLinkRegistry } from "./link-registry.js";

const context: AccountContext = {
	contextId: "context-a",
	groupId: "group-a",
	coordinatorUrl: "https://coordinator.example.test",
	dbPath: "/fixture/never-open.sqlite",
	keysDir: "/fixture/never-open-keys",
	deviceId: "device-a",
	fingerprint: "a".repeat(64),
	identityId: "actor-a",
	fileIdentity: { dev: "1", ino: "2" },
};
const privateUrl = `${context.coordinatorUrl}/auth/link/start?proof=secret-probe`;
const result = {
	coordinatorId: "coordinator-a",
	identityId: "actor-a",
	attemptId: "private-attempt",
	state: "finalized" as const,
};
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function fixture(subject: AccountContext = context) {
	const pending = deferred<Awaited<ReturnType<typeof linkCoordinatorAccount>>>();
	const readContext = vi.fn(
		(): AccountContextResult => ({
			setup: "ready",
			groups: ["group-a", "group-b"],
			selectedGroupId: "group-a",
			coordinator: { origin: subject.coordinatorUrl },
			context: structuredClone(subject),
		}),
	);
	const link = vi.fn<typeof linkCoordinatorAccount>(() => pending.promise);
	const registry = createAccountLinkRegistry({ readContext, link });
	const start = () => {
		const started = registry.start({
			context: structuredClone(subject),
			expectedCoordinatorId: "coordinator-a",
		});
		if (!("operation" in started)) throw new Error("Expected operation fixture");
		return started.operation.operationId;
	};
	return { registry, readContext, link, pending, start };
}
async function settle() {
	await Promise.resolve();
	await Promise.resolve();
}
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("account link registry", () => {
	it("reserves one viewer-wide slot synchronously and passes the captured Core subject", async () => {
		const f = fixture(); // Arrange
		const id = f.start(); // Act
		const duplicate = f.registry.start({
			context: { ...context, groupId: "group-b" },
			expectedCoordinatorId: "coordinator-b",
		});
		await settle();
		// Assert: no CLI, key access, or real receiver is used.
		expect(duplicate).toEqual({ error: "account_link_in_progress", operationId: id });
		expect(f.link).toHaveBeenCalledTimes(1);
		expect(f.link).toHaveBeenCalledWith(
			expect.objectContaining({
				dbPath: context.dbPath,
				keysDir: context.keysDir,
				groupId: context.groupId,
				expectedIdentityId: context.identityId,
				expectedCoordinatorId: "coordinator-a",
				signal: expect.any(AbortSignal),
				assertCurrentContext: expect.any(Function),
			}),
		);
		expect(id).not.toBe(context.contextId);
		const operation = f.registry.get(id);
		expect(Date.parse(operation?.deadlineAt ?? "") - Date.parse(operation?.startedAt ?? "")).toBe(
			600_000,
		);
		f.pending.resolve(result);
		await settle();
		expect(f.registry.get(id)?.state).toBe("succeeded");
		expect(f.registry.hasActive()).toBe(false);
	});
	it("returns detached public snapshots and delivers a URL at most five times", async () => {
		const f = fixture(); // Arrange
		const id = f.start();
		await settle();
		f.link.mock.calls[0][0].onBrowserStart(privateUrl); // Act
		const operation = f.registry.get(id);
		// Assert: only browserUrl may return the capability, never a public snapshot.
		expect(operation).toEqual({
			operationId: id,
			groupId: context.groupId,
			contextId: context.contextId,
			state: "awaiting_browser",
			failure: null,
			browserUrlAvailable: true,
			startedAt: expect.any(String),
			deadlineAt: expect.any(String),
			finishedAt: null,
		});
		expect(JSON.stringify([operation, f.registry.forContext(context.contextId)])).not.toMatch(
			/secret-probe|never-open|private-attempt/,
		);
		if (operation) operation.state = "failed";
		expect(f.registry.get(id)?.state).toBe("awaiting_browser");
		for (let i = 0; i < 5; i++) expect(f.registry.browserUrl(id)).toBe(privateUrl);
		expect(f.registry.browserUrl(id)).toBeNull();
		expect(f.registry.get(id)?.browserUrlAvailable).toBe(false);
		expect(f.registry.get("unknown")).toBeNull();
		expect(f.registry.browserUrl("unknown")).toBeNull();
		f.pending.resolve(result);
		await settle();
		expect(f.registry.browserUrl(id)).toBeNull();
	});
	it.each([
		"https://evil.example.test/auth/link/start",
		`${context.coordinatorUrl}/other`,
		`http://coordinator.example.test/auth/link/start`,
		`${context.coordinatorUrl}/auth/link/start#proof`,
		"https://user:password@coordinator.example.test/auth/link/start",
	])("rejects unsafe browser capability %s", async (url) => {
		const f = fixture(); // Arrange
		const id = f.start();
		await settle();
		f.link.mock.calls[0][0].onBrowserStart(url); // Act
		f.pending.reject(new CoordinatorAccountLinkError("link_stopped"));
		await settle();
		expect(f.registry.browserUrl(id)).toBeNull(); // Assert
		expect(f.link.mock.calls[0][0].signal?.aborted).toBe(true);
		expect(f.registry.get(id)).toMatchObject({
			state: "failed",
			failure: "invalid_response",
			browserUrlAvailable: false,
		});
	});
});
describe("account link local coordinator", () => {
	it.each(["http://127.0.0.1:7442", "http://[::1]:7442"])(
		"delivers a same-origin capability for Core-validated local origin %s",
		async (coordinatorUrl) => {
			const f = fixture({ ...context, coordinatorUrl }); // Arrange
			const id = f.start();
			await settle();
			const options = f.link.mock.calls[0][0];
			const url = `${coordinatorUrl}/auth/link/start?proof=secret-probe`;
			options.onBrowserStart(url); // Act
			expect(f.registry.get(id)).toMatchObject({
				state: "awaiting_browser",
				browserUrlAvailable: true,
			}); // Assert
			expect(f.registry.browserUrl(id)).toBe(url);
			expect(options.signal?.aborted).toBe(false);
			f.pending.resolve(result);
			await settle();
			expect(f.registry.get(id)?.state).toBe("succeeded");
		},
	);
});
describe("account link context and cancellation", () => {
	it.each(["contextId", "identityId", "fileIdentity"] as const)(
		"rejects %s drift before starting Core",
		(field) => {
			const f = fixture(); // Arrange
			const fresh = structuredClone(context);
			if (field === "fileIdentity") fresh.fileIdentity.ino = "new";
			else fresh[field] = "new";
			f.readContext.mockReturnValue({
				setup: "ready",
				groups: ["group-a"],
				selectedGroupId: "group-a",
				coordinator: { origin: context.coordinatorUrl },
				context: fresh,
			});
			const started = f.registry.start({ context, expectedCoordinatorId: "coordinator-a" }); // Act
			expect(started).toEqual({ error: "account_context_changed" }); // Assert
			expect(f.link).not.toHaveBeenCalled();
			expect(f.registry.hasActive()).toBe(false);
		},
	);
	it("rejects a non-ready setup even when the captured context is unchanged", () => {
		const f = fixture(); // Arrange
		const ready = f.readContext();
		if ("error" in ready) throw new Error("Expected ready fixture");
		f.readContext.mockReturnValue({ ...ready, setup: "device_unavailable" });
		const started = f.registry.start({ context, expectedCoordinatorId: "coordinator-a" }); // Act
		expect(started).toEqual({ error: "account_context_changed" }); // Assert
		expect(f.link).not.toHaveBeenCalled();
		expect(f.registry.hasActive()).toBe(false);
	});
	it.each([
		["link_stopped", "failed", "context_changed"],
		["request_failed", "failed", "context_changed"],
		["cancellation_unconfirmed", "outcome_unknown", "cancellation_unconfirmed"],
	] as const)(
		"aborts stale URL delivery and maps Core cleanup %s to %s",
		async (code, state, failure) => {
			const f = fixture(); // Arrange
			const id = f.start();
			await settle();
			const options = f.link.mock.calls[0][0];
			options.onBrowserStart(privateUrl);
			expect(await options.assertCurrentContext?.()).toBe(true);
			f.readContext.mockReturnValue({ error: "account_context_unavailable" }); // Act
			expect(f.registry.browserUrl(id)).toBeNull(); // Assert
			expect(options.signal?.aborted).toBe(true);
			expect(await options.assertCurrentContext?.()).toBe(false);
			options.onBrowserStart(privateUrl);
			expect(f.registry.get(id)?.browserUrlAvailable).toBe(false);
			f.pending.reject(new CoordinatorAccountLinkError(code));
			await settle();
			expect(f.registry.get(id)).toMatchObject({ state, failure, browserUrlAvailable: false });
			expect(f.registry.hasActive()).toBe(false);
		},
	);
});
describe("account link cancellation", () => {
	it.each([
		["link_stopped", "cancelled"],
		["request_failed", "cancelled"],
		["cancellation_unconfirmed", "outcome_unknown"],
		["receiver_close_failed", "outcome_unknown"],
	] as const)("waits for Core close and maps %s to %s", async (code, state) => {
		const f = fixture(); // Arrange
		const id = f.start();
		await settle();
		const options = f.link.mock.calls[0][0];
		options.onBrowserStart(privateUrl);
		f.registry.cancel(id); // Act
		f.registry.cancel(id);
		options.onBrowserStart(privateUrl);
		// Assert: abort is not proof that the receiver has closed.
		expect(options.signal?.aborted).toBe(true);
		expect(f.registry.hasActive()).toBe(true);
		expect(f.registry.get(id)?.finishedAt).toBeNull();
		expect(f.registry.browserUrl(id)).toBeNull();
		f.pending.reject(new CoordinatorAccountLinkError(code));
		await settle();
		expect(f.registry.get(id)).toMatchObject({
			state,
			failure: code,
			browserUrlAvailable: false,
			finishedAt: expect.any(String),
		});
		expect(f.registry.cancel(id)?.state).toBe(state);
		expect(f.link).toHaveBeenCalledTimes(1);
	});
	it("does not change a completed success when cancelled again", async () => {
		const f = fixture(); // Arrange
		const id = f.start();
		await settle();
		f.pending.resolve(result);
		await settle();
		const before = f.registry.get(id);
		const cancelled = f.registry.cancel(id); // Act
		expect(cancelled).toEqual(before); // Assert
		expect(cancelled?.state).toBe("succeeded");
		expect(f.registry.cancel("unknown")).toBeNull();
	});
});
describe("account link shutdown outcomes", () => {
	it.each([
		["link_stopped", "cancelled"],
		["request_failed", "cancelled"],
		["cancellation_unconfirmed", "outcome_unknown"],
		["receiver_close_failed", "outcome_unknown"],
		[null, "succeeded"],
	] as const)("after Core enters, close maps %s to %s", async (code, state) => {
		const f = fixture(); // Arrange: Core must already be running, not queued.
		const id = f.start();
		await settle();
		expect(f.link).toHaveBeenCalledTimes(1);
		const options = f.link.mock.calls[0][0];
		const aborted = vi.fn();
		options.signal?.addEventListener("abort", aborted);
		options.onBrowserStart(privateUrl);
		const closed = f.registry.close(); // Act
		const closedAgain = f.registry.close();
		options.onBrowserStart(privateUrl);
		// Assert: close requests cancellation, but Core alone confirms the outcome.
		expect(options.signal?.aborted).toBe(true);
		expect(aborted).toHaveBeenCalledTimes(1);
		expect(f.registry.hasActive()).toBe(true);
		expect(f.registry.get(id)?.finishedAt).toBeNull();
		expect(f.registry.browserUrl(id)).toBeNull();
		expect(f.registry.start({ context, expectedCoordinatorId: "coordinator-a" })).toEqual({
			error: "account_shutting_down",
		});
		if (code) f.pending.reject(new CoordinatorAccountLinkError(code));
		else f.pending.resolve(result);
		await Promise.all([closed, closedAgain]);
		expect(f.registry.get(id)).toMatchObject({
			state,
			failure: code,
			browserUrlAvailable: false,
			finishedAt: expect.any(String),
		});
		expect(f.registry.hasActive()).toBe(false);
		expect(f.registry.browserUrl(id)).toBeNull();
		expect(JSON.stringify(f.registry.get(id))).not.toMatch(
			/secret-probe|never-open|private-attempt/,
		);
		expect(aborted).toHaveBeenCalledTimes(1);
	});
	it("cancels queued work when closed before Core enters", async () => {
		const f = fixture(); // Arrange
		const id = f.start();
		await f.registry.close(); // Act: no microtask has started Core yet.
		expect(f.link).not.toHaveBeenCalled(); // Assert
		expect(f.registry.get(id)).toMatchObject({
			state: "cancelled",
			failure: "link_stopped",
			browserUrlAvailable: false,
			finishedAt: expect.any(String),
		});
		expect(f.registry.hasActive()).toBe(false);
	});
});
describe("account link failures and lifecycle", () => {
	it.each([
		"invalid_options",
		"review_required",
		"link_conflict",
		"identity_mismatch",
		"device_unavailable",
	] as const)("maps known failure %s without URL exposure", async (code) => {
		const f = fixture(); // Arrange
		const id = f.start();
		await settle();
		f.link.mock.calls[0][0].onBrowserStart(privateUrl);
		f.pending.reject(new CoordinatorAccountLinkError(code)); // Act
		await settle();
		expect(f.registry.get(id)).toMatchObject({
			state: "failed",
			failure: code === "invalid_options" ? "configuration_invalid" : code,
			browserUrlAvailable: false,
		}); // Assert
		expect(f.registry.browserUrl(id)).toBeNull();
	});
	it("sanitizes unknown errors without logging their private cause", async () => {
		const f = fixture(); // Arrange
		const logged = [
			vi.spyOn(console, "error").mockImplementation(() => {}),
			vi.spyOn(console, "warn").mockImplementation(() => {}),
			vi.spyOn(console, "log").mockImplementation(() => {}),
		];
		const id = f.start();
		await settle();
		f.pending.reject(new Error(privateUrl)); // Act
		await settle();
		expect(f.registry.get(id)).toMatchObject({ state: "failed", failure: "request_failed" }); // Assert
		expect(JSON.stringify(f.registry.get(id))).not.toContain("secret-probe");
		for (const log of logged) expect(log).not.toHaveBeenCalled();
	});
	it("bounds shutdown at five seconds and ignores late callbacks and completion", async () => {
		vi.useFakeTimers(); // Arrange
		const f = fixture();
		const id = f.start();
		await settle();
		const options = f.link.mock.calls[0][0];
		options.onBrowserStart(privateUrl);
		const closed = f.registry.close(); // Act
		expect(options.signal?.aborted).toBe(true); // Assert
		expect(f.registry.start({ context, expectedCoordinatorId: "coordinator-a" })).toEqual({
			error: "account_shutting_down",
		});
		expect(f.registry.browserUrl(id)).toBeNull();
		await vi.advanceTimersByTimeAsync(4999);
		expect(f.registry.get(id)?.finishedAt).toBeNull();
		await vi.advanceTimersByTimeAsync(1);
		await closed;
		expect(f.registry.get(id)).toMatchObject({
			state: "outcome_unknown",
			failure: "cancellation_unconfirmed",
		});
		const terminal = f.registry.get(id);
		options.onBrowserStart(privateUrl);
		f.pending.resolve(result);
		await settle();
		expect(f.registry.get(id)).toEqual(terminal);
		expect(f.registry.browserUrl(id)).toBeNull();
		await f.registry.close();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("keeps only eight finished records, expires at fifteen minutes, and never evicts active work", async () => {
		vi.useFakeTimers(); // Arrange
		const f = fixture();
		f.link.mockResolvedValue(result);
		const ids: string[] = [];
		for (let i = 0; i < 9; i++) {
			ids.push(f.start());
			await settle();
		}
		f.link.mockImplementation(() => f.pending.promise);
		const active = f.start(); // Act
		await settle();
		expect(f.registry.get(ids[0])).toBeNull(); // Assert
		expect(f.registry.get(ids[1])?.state).toBe("succeeded");
		await vi.advanceTimersByTimeAsync(899_999);
		expect(f.registry.get(ids[1])).not.toBeNull();
		await vi.advanceTimersByTimeAsync(1);
		expect(f.registry.get(ids[1])).toBeNull();
		expect(f.registry.get(active)?.state).toBe("starting");
		expect(f.registry.hasActive()).toBe(true);
		f.pending.resolve(result);
		await settle();
	});
});
