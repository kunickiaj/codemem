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
const fixtures: ReturnType<typeof fixture>[] = [];
function fixture(
	subject: AccountContext = context,
	expectedCoordinatorId = "coordinator-a",
	createRegistry = createAccountLinkRegistry,
) {
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
	const registry = createRegistry({ readContext, link });
	const start = () => {
		const started = registry.start({
			context: structuredClone(subject),
			expectedCoordinatorId,
			expectedAuthority: "device_claim",
		});
		if (!("operation" in started)) throw new Error("Expected operation fixture");
		return started.operation.operationId;
	};
	const f = { registry, readContext, link, pending, start };
	fixtures.push(f);
	return f;
}
async function settle() {
	// Drain Core completion, promise adoption, and the owner's final release.
	for (let i = 0; i < 8; i++) await Promise.resolve();
}
afterEach(async () => {
	const owned = fixtures.splice(0);
	// Settle fake Core work even when shutdown already ended its public record.
	for (const f of owned) f.pending.resolve(result);
	await settle();
	await Promise.all(owned.map((f) => f.registry.close()));
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("account link runtime-wide ownership", () => {
	it.each(["same", "different"])(
		"serializes factories across groups with %s profiles without sharing authority",
		async (profile) => {
			// Arrange: each factory reads and links only its own captured subject.
			const first = fixture();
			const subject = {
				...context,
				contextId: "context-b",
				groupId: "group-b",
				coordinatorUrl: "https://second.example.test",
			};
			if (profile === "different") {
				subject.dbPath = "/fixture/second.sqlite";
				subject.keysDir = "/fixture/second-keys";
			}
			const second = fixture(subject, "coordinator-b");
			const firstId = first.start();
			// Act: the slot must be reserved before the Core microtask starts.
			const blocked = second.registry.start({
				context: subject,
				expectedCoordinatorId: "coordinator-b",
				expectedAuthority: "device_claim",
			});
			await settle();
			first.link.mock.calls[0][0].onBrowserStart(privateUrl);
			// Assert: only busy state crosses factory boundaries, not an ID or capability.
			expect(blocked).toEqual({ error: "account_link_in_progress" });
			expect(second.registry.hasActive()).toBe(true);
			expect(first.link).toHaveBeenCalledOnce();
			expect(second.link).not.toHaveBeenCalled();
			expect(second.registry.get(firstId)).toBeNull();
			expect(second.registry.forContext(context.contextId)).toBeNull();
			expect(second.registry.browserUrl(firstId)).toBeNull();
			expect(second.registry.cancel(firstId)).toBeNull();
			expect(first.registry.browserUrl(firstId)).toBe(privateUrl);
			first.pending.resolve(result);
			await settle();
			expect(second.registry.hasActive()).toBe(false);
			const secondId = second.start();
			await settle();
			const options = second.link.mock.calls[0][0];
			expect(options).toMatchObject({
				dbPath: subject.dbPath,
				keysDir: subject.keysDir,
				groupId: subject.groupId,
				coordinatorUrl: subject.coordinatorUrl,
				expectedIdentityId: subject.identityId,
				expectedAuthority: "device_claim",
				expectedCoordinatorId: "coordinator-b",
			});
			expect(await options.assertCurrentContext?.()).toBe(true);
			expect(second.readContext).toHaveBeenCalledWith("group-b");
			const secondUrl = `${subject.coordinatorUrl}/auth/link/start?proof=second-only`;
			options.onBrowserStart(secondUrl);
			expect(second.registry.browserUrl(secondId)).toBe(secondUrl);
			expect(first.registry.get(secondId)).toBeNull();
			expect(first.registry.forContext(subject.contextId)).toBeNull();
			expect(first.registry.browserUrl(secondId)).toBeNull();
		},
	);
	it.each([
		"link_stopped",
		"request_failed",
		"cancellation_unconfirmed",
		"receiver_close_failed",
	] as const)(
		"releases cancelled Core work only after %s settles and ignores old-owner callbacks",
		async (code) => {
			// Arrange
			const first = fixture();
			const second = fixture();
			const firstId = first.start();
			await settle();
			const oldOptions = first.link.mock.calls[0][0];
			// Act
			first.registry.cancel(firstId);
			expect(
				second.registry.start({
					context,
					expectedCoordinatorId: "coordinator-a",
					expectedAuthority: "device_claim",
				}),
			).toEqual({
				error: "account_link_in_progress",
			});
			first.pending.reject(new CoordinatorAccountLinkError(code));
			await settle();
			const secondId = second.start();
			await settle();
			second.link.mock.calls[0][0].onBrowserStart(privateUrl);
			oldOptions.onBrowserStart(`${context.coordinatorUrl}/auth/link/start?proof=old-owner`);
			await first.registry.close();
			// Assert: finishing/closing the previous owner cannot free its successor's slot.
			expect(second.registry.hasActive()).toBe(true);
			expect(first.registry.get(firstId)?.state).toBe(
				code === "link_stopped" || code === "request_failed" ? "cancelled" : "outcome_unknown",
			);
			expect(first.registry.browserUrl(firstId)).toBeNull();
			expect(second.registry.browserUrl(secondId)).toBe(privateUrl);
			const third = fixture();
			expect(
				third.registry.start({
					context,
					expectedCoordinatorId: "coordinator-a",
					expectedAuthority: "device_claim",
				}),
			).toEqual({
				error: "account_link_in_progress",
			});
			expect(third.link).not.toHaveBeenCalled();
		},
	);
});
describe("account link runtime-wide shutdown", () => {
	it("releases a failed operation after Core rejects without requiring cancellation", async () => {
		// Arrange
		const first = fixture();
		const second = fixture();
		const id = first.start();
		await settle();
		// Act
		first.pending.reject(new CoordinatorAccountLinkError("request_failed"));
		await settle();
		second.start();
		await settle();
		// Assert
		expect(first.registry.get(id)?.state).toBe("failed");
		expect(second.link).toHaveBeenCalledOnce();
	});
	it("keeps other factories busy after shutdown times out until underlying Core settles", async () => {
		// Arrange
		vi.useFakeTimers();
		const first = fixture();
		const second = fixture();
		const id = first.start();
		await settle();
		const options = first.link.mock.calls[0][0];
		// Act: public shutdown is not evidence that the receiver stopped.
		const closed = first.registry.close();
		await vi.advanceTimersByTimeAsync(5000);
		await closed;
		options.onBrowserStart(privateUrl);
		// Assert
		expect(first.registry.get(id)?.state).toBe("outcome_unknown");
		expect(first.registry.browserUrl(id)).toBeNull();
		expect(second.registry.hasActive()).toBe(true);
		expect(
			second.registry.start({
				context,
				expectedCoordinatorId: "coordinator-a",
				expectedAuthority: "device_claim",
			}),
		).toEqual({
			error: "account_link_in_progress",
		});
		expect(second.link).not.toHaveBeenCalled();
		first.pending.resolve(result);
		await settle();
		expect(second.registry.hasActive()).toBe(false);
		const secondId = second.start();
		await settle();
		options.onBrowserStart(privateUrl);
		expect(second.link).toHaveBeenCalledOnce();
		expect(second.registry.browserUrl(secondId)).toBeNull();
		expect(first.registry.get(id)?.state).toBe("outcome_unknown");
	});
	it.each(["cancel", "close"])(
		"releases %s before the Core microtask without invoking Core",
		async (action) => {
			// Arrange
			const first = fixture();
			const second = fixture();
			const id = first.start();
			// Act
			if (action === "cancel") first.registry.cancel(id);
			else void first.registry.close();
			expect(
				second.registry.start({
					context,
					expectedCoordinatorId: "coordinator-a",
					expectedAuthority: "device_claim",
				}),
			).toEqual({
				error: "account_link_in_progress",
			});
			await settle();
			second.start();
			await settle();
			// Assert
			expect(first.link).not.toHaveBeenCalled();
			expect(first.registry.get(id)?.state).toBe("cancelled");
			expect(second.link).toHaveBeenCalledOnce();
		},
	);
});

describe("account link runtime module and callback isolation", () => {
	it("shares only the busy slot across independently loaded module copies", async () => {
		// Arrange: keep the statically imported factory's Core work pending.
		const first = fixture();
		const id = first.start();
		await settle();
		first.link.mock.calls[0][0].onBrowserStart(privateUrl);
		vi.resetModules();
		const reloaded = await import("./link-registry.js");
		const second = fixture(context, "coordinator-a", reloaded.createAccountLinkRegistry);
		const expectedLifecycleToken = second.registry.lifecycleToken();
		// Act
		const blocked = second.registry.start({
			context,
			expectedCoordinatorId: "coordinator-a",
			expectedAuthority: "device_claim",
		});
		await settle();
		// Assert: prove this is a second module, not a cached factory reference.
		expect(reloaded.createAccountLinkRegistry).not.toBe(createAccountLinkRegistry);
		expect(blocked).toEqual({ error: "account_link_in_progress" });
		expect(second.registry.hasActive()).toBe(true);
		expect(second.link).not.toHaveBeenCalled();
		expect(second.registry.get(id)).toBeNull();
		expect(second.registry.browserUrl(id)).toBeNull();
		first.pending.resolve(result);
		await settle();
		expect(
			second.registry.start({
				context,
				expectedCoordinatorId: "coordinator-a",
				expectedLifecycleToken,
				expectedAuthority: "device_claim",
			}),
		).toEqual({ error: "account_context_changed" });
		expect(second.registry.forContext(context.contextId)).toBeNull();
		second.start();
		await settle();
		expect(second.link).toHaveBeenCalledOnce();
	});
	it("rechecks ownership when a context reader starts another registry synchronously", async () => {
		// Arrange: only the first validation reenters; later reads stay ordinary.
		const outer = fixture();
		const inner = fixture({ ...context, contextId: "context-inner", groupId: "group-b" });
		const ready = outer.readContext();
		outer.readContext.mockImplementationOnce(() => {
			inner.start();
			return ready;
		});
		// Act
		const blocked = outer.registry.start({
			context,
			expectedCoordinatorId: "coordinator-a",
			expectedAuthority: "device_claim",
		});
		await settle();
		// Assert: the callback's owner wins; the outer start creates no local record.
		expect(blocked).toEqual({ error: "account_link_in_progress" });
		expect(outer.link).not.toHaveBeenCalled();
		expect(outer.registry.forContext(context.contextId)).toBeNull();
		expect(inner.link).toHaveBeenCalledOnce();
		expect(inner.link.mock.calls[0][0].groupId).toBe("group-b");
		inner.pending.resolve(result);
		await settle();
		outer.start();
		await settle();
		expect(outer.link).toHaveBeenCalledOnce();
	});
});

describe("account link registry", () => {
	it("rejects eligibility captured before another owner starts and finishes, then accepts a fresh token", async () => {
		const first = fixture();
		const second = fixture();
		const expectedLifecycleToken = second.registry.lifecycleToken();
		first.start();
		await settle();
		first.pending.resolve(result);
		await settle();
		expect(
			second.registry.start({
				context,
				expectedCoordinatorId: "coordinator-a",
				expectedLifecycleToken,
				expectedAuthority: "device_claim",
			}),
		).toEqual({ error: "account_context_changed" });
		expect(second.link).not.toHaveBeenCalled();
		expect(second.registry.forContext(context.contextId)).toBeNull();
		const fresh = second.registry.start({
			context,
			expectedCoordinatorId: "coordinator-a",
			expectedLifecycleToken: second.registry.lifecycleToken(),
			expectedAuthority: "device_claim",
		});
		expect(fresh).toHaveProperty("operation");
		await settle();
		expect(second.link).toHaveBeenCalledOnce();
	});
	it("reserves one viewer-wide slot synchronously and passes the captured Core subject", async () => {
		const f = fixture(); // Arrange
		const id = f.start(); // Act
		const duplicate = f.registry.start({
			context: { ...context, groupId: "group-b" },
			expectedCoordinatorId: "coordinator-b",
			expectedAuthority: "device_claim",
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
				expectedAuthority: "device_claim",
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
});
describe("account link private capability snapshots", () => {
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
			const started = f.registry.start({
				context,
				expectedCoordinatorId: "coordinator-a",
				expectedAuthority: "device_claim",
			}); // Act
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
		const started = f.registry.start({
			context,
			expectedCoordinatorId: "coordinator-a",
			expectedAuthority: "device_claim",
		}); // Act
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
		expect(
			f.registry.start({
				context,
				expectedCoordinatorId: "coordinator-a",
				expectedAuthority: "device_claim",
			}),
		).toEqual({
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
		expect(
			f.registry.start({
				context,
				expectedCoordinatorId: "coordinator-a",
				expectedAuthority: "device_claim",
			}),
		).toEqual({
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
