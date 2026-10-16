import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountView } from "../lib/api/account";
import { useMyAccount } from "./my-account-flow";
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
let view: AccountView;
let mount: HTMLDivElement;
let flow: ReturnType<typeof useMyAccount>;
let renders: { group: string | undefined; operationId: string | undefined }[];
function FlowProbe() {
	flow = useMyAccount();
	renders.push({ group: flow.group, operationId: flow.operation?.operationId });
	return null;
}
const probe = async () => {
	await act(async () => {
		render(<FlowProbe />, mount);
	});
	await settle();
};
const chooseGroup = async (groupId: string) => {
	await act(async () => {
		flow.selectGroup(groupId);
	});
	await settle();
};
const calls = (suffix: string) =>
	transport.mock.calls.filter(([url]) => String(url).endsWith(suffix));
beforeEach(() => {
	vi.useFakeTimers();
	view = status();
	renders = [];
	mount = document.createElement("div");
	document.body.append(mount);
	vi.spyOn(window, "open").mockReturnValue(null);
	vi.stubGlobal(
		"fetch",
		transport.mockReset().mockImplementation(async (url) => {
			if (url === "/api/account/session")
				return response({ version: 1, csrfToken: "fixture-token" });
			if (String(url).includes("link-status")) return response(view);
			if (String(url).endsWith("browser-url")) return response({ version: 1, url: privateUrl });
			return response({ version: 1, operation: operation(), current: true });
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

describe("My Account conflict transport recovery", () => {
	it("recovers an active conflict from status after a transient operation GET failure", async () => {
		await probe();
		view = status({ operation: operation("awaiting_browser"), canLink: false });
		transport
			.mockResolvedValueOnce(
				response({ error: "account_link_in_progress", operationId: "op-one" }, 409),
			)
			.mockRejectedValueOnce(new TypeError("private-operation-failure"));
		await act(async () => {
			await flow.link();
		});
		await settle();
		expect(flow.operation).toEqual(view.operation);
		expect(flow.fallback).toBe(true);
		expect(flow.busy).toBe(false);
		expect(calls("browser-url")).toHaveLength(1);
		expect(flow.message).not.toContain("private-operation-failure");
		await tick();
		expect(calls("/op-one")).toHaveLength(2);
		await act(async () => {
			await flow.cancel();
		});
		expect(calls("/cancel")).toHaveLength(1);
		expect(calls("link-operations")).toHaveLength(1);
	});
	it.each(["context", "group"] as const)(
		"rejects a wrong-%s status operation after a transient conflict GET failure",
		async (mismatch) => {
			await probe();
			const candidate = operation("awaiting_browser");
			if (mismatch === "context") candidate.contextId = "other-context";
			else candidate.groupId = "other-group";
			view = status({ operation: candidate, canLink: false });
			transport
				.mockResolvedValueOnce(
					response({ error: "account_link_in_progress", operationId: "op-one" }, 409),
				)
				.mockRejectedValueOnce(new TypeError("private-operation-failure"));
			await act(async () => {
				await flow.link();
			});
			await settle();
			await tick();
			expect(flow.operation).toBeNull();
			expect(flow.fallback).toBe(false);
			expect(calls("browser-url")).toHaveLength(0);
			expect(calls("/op-one")).toHaveLength(1);
			expect(calls("link-operations")).toHaveLength(1);
			expect(flow.message).not.toContain("private-operation-failure");
		},
	);
});

describe("My Account stale work and conflict safety", () => {
	it.each(["matching", "not-current", "wrong-context", "wrong-group", "finished"])(
		"validates a conflicting operation before adopting: %s",
		async (mode) => {
			// Arrange
			await probe();
			const candidate = operation(mode === "finished" ? "succeeded" : "starting");
			if (mode === "wrong-context") candidate.contextId = "old-context";
			if (mode === "wrong-group") candidate.groupId = "other-group";
			view = status({ operation: candidate, canLink: false });
			view.checkedAt = "2026-01-01T00:01:00Z";
			transport.mockImplementation(async (url, options) => {
				if (String(url).endsWith("link-operations") && options?.method === "POST")
					return response({ error: "account_link_in_progress", operationId: "op-one" }, 409);
				if (String(url).endsWith("/op-one"))
					return response({ version: 1, current: mode !== "not-current", operation: candidate });
				return response(view);
			});
			// Act
			await act(async () => {
				await flow.link();
			});
			await settle();
			// Assert: the conflict response alone is never authority to resume a job.
			expect(calls("/op-one")).toHaveLength(1);
			if (mode === "matching") expect(flow.operation?.operationId).toBe("op-one");
			else expect(flow.operation).toBeNull();
			if (mode === "finished") {
				expect(flow.view?.checkedAt).toBe(view.checkedAt);
				expect(flow.message).not.toContain("in progress");
				expect(calls("link-operations")).toHaveLength(1);
			}
		},
	);
	it("opens one popup and starts one operation for same-tick link requests", async () => {
		// Arrange
		await probe();
		const startResponse = deferred<Response>();
		transport.mockImplementationOnce(() => startResponse.promise);
		// Act: both calls precede the state rerender.
		await act(async () => {
			const first = flow.link();
			const second = flow.link();
			startResponse.resolve(response({ version: 1, operation: operation() }));
			await Promise.all([first, second]);
		});
		// Assert
		expect(window.open).toHaveBeenCalledTimes(1);
		expect(calls("link-operations")).toHaveLength(1);
	});
	it("lets the newest group status win even when the old fetch ignores abort", async () => {
		// Arrange
		const late = deferred<Response>();
		transport.mockImplementationOnce(() => late.promise);
		await probe();
		view = status({ contextId: "context-two", selectedGroupId: "group-two" });
		// Act
		await chooseGroup("group-two");
		await act(async () => {
			late.resolve(response(status()));
		});
		// Assert
		expect(flow.view?.contextId).toBe("context-two");
		expect(flow.view?.selectedGroupId).toBe("group-two");
	});
	it("clears the cached private URL when the selected group changes", async () => {
		// Arrange
		view = status({ operation: operation("awaiting_browser"), canLink: false });
		await probe();
		expect(flow.fallback).toBe(true);
		view = status({ contextId: "context-two", selectedGroupId: "group-two" });
		// Act
		await chooseGroup("group-two");
		act(() => flow.openFallback());
		// Assert
		expect(window.open).not.toHaveBeenCalled();
		expect(flow.fallback).toBe(false);
	});
	it("discards a late old-job result after changing context", async () => {
		// Arrange
		view = status({ operation: operation(), canLink: false });
		await probe();
		const late = deferred<Response>();
		transport.mockImplementationOnce(() => late.promise);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		view = status({ contextId: "context-two", selectedGroupId: "group-two" });
		// Act
		await chooseGroup("group-two");
		await act(async () => {
			late.resolve(response({ version: 1, current: true, operation: operation("succeeded") }));
		});
		// Assert
		expect(flow.view?.contextId).toBe("context-two");
		expect(flow.operation).toBeNull();
		expect(calls("link-status?group_id=group-two")).toHaveLength(1);
	});
});

describe("My Account polling generation and local cleanup", () => {
	it("rejects an old timer fired after group selection but before effect cleanup", async () => {
		// Arrange
		const timers = vi.spyOn(window, "setTimeout");
		view = status({ operation: operation(), canLink: false });
		await probe();
		const callback = timers.mock.calls.find(([, delay]) => delay === 1000)?.[0];
		if (typeof callback !== "function") throw new Error("Missing operation timer");
		view = status({ contextId: "context-two", selectedGroupId: "group-two" });
		// Act: retain the old callback even though cleanup will later clear its timer.
		await act(async () => {
			flow.selectGroup("group-two");
			callback();
			await vi.advanceTimersByTimeAsync(0);
		});
		await settle();
		// Assert: even a transient render must not attach the old operation to the new group.
		expect(calls("/op-one")).toHaveLength(1);
		expect(
			renders.filter((entry) => entry.group === "group-two").every((entry) => !entry.operationId),
		).toBe(true);
		expect(flow.view?.contextId).toBe("context-two");
		expect(flow.operation).toBeNull();
	});
	it("ignores late status replies and aborts only local work on unmount", async () => {
		// Arrange
		await probe();
		const late = deferred<Response>();
		transport.mockImplementationOnce(() => late.promise);
		// Act
		act(() => {
			void flow.refresh();
		});
		const signal = transport.mock.calls.at(-1)?.[1]?.signal;
		act(() => render(null, mount));
		const renderCount = renders.length;
		await act(async () => {
			late.resolve(response(status()));
		});
		await tick();
		// Assert
		expect(signal?.aborted).toBe(true);
		expect(renders).toHaveLength(renderCount);
		expect(calls("/cancel")).toHaveLength(0);
	});
});

describe("My Account cancellation and terminal privacy", () => {
	it("sends one cancellation for two calls before rerender without aborting it", async () => {
		view = status({ operation: operation(), canLink: false });
		await probe();
		const pending = deferred<Response>();
		transport.mockImplementationOnce(() => pending.promise);
		await act(async () => {
			const first = flow.cancel();
			const second = flow.cancel();
			await second;
			expect(calls("/cancel")).toHaveLength(1);
			expect(calls("/cancel")[0]?.[1]?.signal?.aborted).toBe(false);
			pending.resolve(response({ version: 1, operation: operation() }));
			await first;
		});
		expect(flow.busy).toBe(false);
	});
	it("does not let an old cancellation release a newer generation's cancellation", async () => {
		view = status({ operation: operation(), canLink: false });
		await probe();
		const old = deferred<Response>();
		transport.mockImplementationOnce(() => old.promise);
		let first!: Promise<void>;
		act(() => {
			first = flow.cancel();
		});
		await act(async () => {
			await flow.refresh();
		});
		await settle();
		const pending = deferred<Response>();
		transport.mockImplementationOnce(() => pending.promise);
		let current!: Promise<void>;
		act(() => {
			current = flow.cancel();
		});
		await act(async () => {
			old.resolve(response({ version: 1, operation: operation() }));
			await first;
			await flow.cancel();
		});
		expect(flow.busy).toBe(true);
		expect(calls("/cancel")).toHaveLength(2);
		expect(calls("/cancel")[1]?.[1]?.signal?.aborted).toBe(false);
		await act(async () => {
			pending.resolve(response({ version: 1, operation: operation() }));
			await current;
		});
		expect(flow.busy).toBe(false);
	});
	it("does not duplicate a pending cancellation and redacts a lost cancellation reply", async () => {
		// Arrange
		view = status({ operation: operation(), canLink: false });
		await probe();
		const pending = deferred<Response>();
		transport.mockImplementationOnce(() => pending.promise);
		// Act
		act(() => {
			void flow.cancel();
		});
		await act(async () => {
			await flow.cancel();
		});
		await act(async () => {
			pending.resolve(response({ error: "private-cancel-details" }, 503));
		});
		await settle();
		// Assert
		expect(calls("/cancel")).toHaveLength(1);
		expect(flow.message).toContain("could not be confirmed");
		expect(flow.message).not.toContain("private-cancel-details");
	});
	it.each(["succeeded", "failed", "cancelled", "outcome_unknown"] as const)(
		"clears a cached browser URL and stops polling on %s",
		async (state) => {
			// Arrange
			view = status({ operation: operation("awaiting_browser"), canLink: false });
			await probe();
			const terminal = { ...operation(state), browserUrlAvailable: false, failure: null };
			transport.mockResolvedValueOnce(response({ version: 1, current: true, operation: terminal }));
			view = status({ operation: terminal, canLink: false });
			// Act
			await tick();
			act(() => flow.openFallback());
			await tick();
			// Assert
			expect(window.open).not.toHaveBeenCalled();
			expect(flow.fallback).toBe(false);
			expect(flow.operation).toEqual(terminal);
			expect(calls("/op-one")).toHaveLength(1);
			expect(calls("browser-url")).toHaveLength(1);
		},
	);
});

describe("My Account verified status precedence", () => {
	it.each(["outcome_unknown", "failed", "cancelled"] as const)(
		"resolves retained %s when fresh status verifies this Identity's linked account",
		async (state) => {
			// Arrange: registry TTL may retain a terminal record after verified completion.
			view = status({
				canLink: false,
				operation: operation(state),
				remote: {
					kind: "status",
					coordinatorId: "coordinator-one",
					identityId: "identity-one",
					authority: "device_claim",
					identityMatches: true,
					state: "linked",
					account: { email: "verified@example.test" },
				},
			});
			// Act
			await probe();
			// Assert: only authoritative matching status resolves uncertainty, not a popup/cookie.
			expect(flow.view?.remote).toEqual(view.remote);
			expect(flow.operation).toBeNull();
			expect(flow.message).toBe("");
			expect(transport.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(
				0,
			);
		},
	);
});

describe("My Account pending request cleanup", () => {
	it.each(["start", "adopt", "cancel"])(
		"aborts pending %s on unmount without cancelling the backend job",
		async (mode) => {
			// Arrange
			if (mode === "cancel") view = status({ operation: operation(), canLink: false });
			await probe();
			const blank = { opener: {}, closed: false, close: vi.fn() };
			vi.mocked(window.open).mockReturnValue(blank as unknown as Window);
			const pending = deferred<Response>();
			if (mode === "adopt")
				transport.mockResolvedValueOnce(
					response(
						{
							error: "account_link_in_progress",
							operationId: "op-one",
						},
						409,
					),
				);
			transport.mockImplementationOnce(() => pending.promise);
			// Act
			let action!: Promise<void>;
			act(() => {
				action = mode === "cancel" ? flow.cancel() : flow.link();
			});
			await settle();
			const signal = transport.mock.calls.at(-1)?.[1]?.signal;
			act(() => render(null, mount));
			await act(async () => {
				pending.resolve(response({ version: 1, operation: operation(), current: true }));
				await action;
			});
			await settle();
			// Assert: explicit Cancel contributes one request; teardown never adds another.
			expect(signal?.aborted).toBe(true);
			expect(calls("/cancel")).toHaveLength(mode === "cancel" ? 1 : 0);
			if (mode === "start") expect(blank.close).toHaveBeenCalled();
		},
	);
});

describe("My Account uncertain transport recovery", () => {
	it("keeps an old-context cancellation handle through drift and an unavailable refresh", async () => {
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		view = status({ operation: operation("awaiting_browser"), canLink: false });
		await probe();
		transport
			.mockResolvedValueOnce(response({ operation: operation("awaiting_browser"), current: false }))
			.mockRejectedValueOnce(new TypeError("offline"));
		await tick();
		expect(flow.operation).toBeNull();
		expect(flow.pendingOperation?.operationId).toBe("op-one");
		expect(flow.fallback).toBe(false);
		view = status({ contextId: "context-two", selectedGroupId: "group-two", canLink: false });
		await act(async () => {
			await flow.refresh();
		});
		await settle();
		expect(flow.view?.contextId).toBe("context-two");
		expect(flow.operation).toBeNull();
		expect(calls("/cancel")).toHaveLength(0);
		transport.mockRejectedValueOnce(new TypeError("lost cancel"));
		await act(async () => {
			await Promise.all([flow.cancelPrevious(), flow.cancelPrevious()]);
		});
		expect(calls("/cancel")).toHaveLength(1);
		expect(flow.pendingOperation?.operationId).toBe("op-one");
		expect(calls("browser-url")).toHaveLength(1);
	});
	it.each(["terminal", "missing"])(
		"clears a previous handle only after confirmed %s",
		async (mode) => {
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			view = status({ operation: operation(), canLink: false });
			await probe();
			transport.mockResolvedValueOnce(response({ operation: operation(), current: false }));
			view = status({ contextId: "context-two", selectedGroupId: "group-two" });
			await tick();
			expect(flow.pendingOperation?.operationId).toBe("op-one");
			transport.mockResolvedValueOnce(
				mode === "terminal"
					? response({ operation: operation("cancelled"), current: false })
					: response({ error: "account_operation_not_found" }, 404),
			);
			await tick();
			expect(flow.pendingOperation).toBeNull();
			expect(flow.operation).toBeNull();
			expect(calls("/cancel")).toHaveLength(0);
		},
	);
});

describe("My Account configuration recovery", () => {
	it("recovers a removed selected group once, including no groups then a different configuration", async () => {
		await probe();
		await chooseGroup("group-one");
		transport.mockResolvedValueOnce(response({ error: "account_group_not_configured" }, 400));
		view = status({ groups: [], selectedGroupId: null, contextId: null, canLink: false });
		await act(async () => {
			await flow.refresh();
		});
		await settle();
		expect(flow.group).toBeUndefined();
		expect(flow.view?.groups).toEqual([]);
		view = status({
			groups: ["new-group"],
			selectedGroupId: "new-group",
			contextId: "new-context",
		});
		await act(async () => {
			await flow.refresh();
		});
		await settle();
		expect(flow.view?.contextId).toBe("new-context");
		expect(calls("link-status?group_id=group-one")).toHaveLength(2);
		expect(calls("link-status")).toHaveLength(3);
		expect(calls("link-operations")).toHaveLength(0);
	});
	it("pins default-group recovery to its generation and never retries absent defaults recursively", async () => {
		await probe();
		await chooseGroup("group-one");
		const late = deferred<Response>();
		transport
			.mockResolvedValueOnce(response({ error: "account_group_not_configured" }, 400))
			.mockImplementationOnce(() => late.promise);
		let recovery!: Promise<void>;
		act(() => {
			recovery = flow.refresh();
		});
		await settle();
		view = status({ contextId: "new-context", selectedGroupId: "group-two" });
		await chooseGroup("group-two");
		await act(async () => {
			late.resolve(response(status()));
			await recovery;
		});
		expect(flow.view?.contextId).toBe("new-context");
		transport
			.mockResolvedValueOnce(response({ error: "account_group_not_configured" }, 400))
			.mockResolvedValueOnce(response({ error: "account_group_not_configured" }, 400));
		await act(async () => {
			await flow.refresh();
		});
		await tick();
		expect(flow.view).toBeNull();
		expect(calls("link-status")).toHaveLength(3);
	});
});

describe("My Account previous-context outcomes", () => {
	const previousOutcomeCases = [
		[
			"drift-poll",
			"succeeded",
			"The earlier link finished for its original Identity. Check status there to confirm.",
		],
		[
			"pending-poll",
			"succeeded",
			"The earlier link finished for its original Identity. Check status there to confirm.",
		],
		[
			"drift-cancel",
			"succeeded",
			"The earlier link finished for its original Identity. Check status there to confirm.",
		],
		[
			"previous-cancel",
			"succeeded",
			"The earlier link finished for its original Identity. Check status there to confirm.",
		],
		["previous-cancel", "cancelled", "The earlier link was cancelled."],
		["previous-cancel", "failed", "The earlier link failed for its original Identity."],
		[
			"previous-cancel",
			"outcome_unknown",
			"We couldn’t confirm how the earlier link ended. Check status for its original Identity.",
		],
	] as const;
	it.each(
		previousOutcomeCases.flatMap((testCase) => [
			[...testCase, 200] as const,
			[...testCase, 503] as const,
		]),
	)(
		"retains the original Identity's outcome after %s reports %s with notice %s and status %s",
		async (path, state, notice, statusCode) => {
			// Arrange: the terminal reply must precede the fresh status success or failure.
			vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
			view = status({ operation: operation(), canLink: false });
			await probe();
			view = status({
				contextId: "new-context",
				selectedGroupId: "new-group",
				canLink: false,
				remote: {
					kind: "status",
					coordinatorId: "coordinator-one",
					identityId: "new-identity",
					authority: "device_claim",
					state: "linked",
					identityMatches: true,
					account: { email: "new@example.test" },
				},
			});
			if (path === "pending-poll" || path === "previous-cancel") {
				transport.mockResolvedValueOnce(response({ operation: operation(), current: false }));
				await tick();
				expect(flow.pendingOperation?.operationId).toBe("op-one");
			}
			const terminal = operation(state);
			if (path === "drift-cancel") terminal.contextId = "earlier-context";
			transport.mockResolvedValueOnce(response({ operation: terminal, current: false }));
			if (statusCode === 503)
				transport.mockResolvedValueOnce(
					response({ error: "account_internal_error", detail: privateUrl }, 503),
				);
			// Act
			if (path === "drift-cancel")
				await act(async () => {
					await flow.cancel();
				});
			else if (path === "previous-cancel")
				await act(async () => {
					await flow.cancelPrevious();
				});
			else await tick();
			await settle();
			await tick();
			// Assert: a failed status check cannot erase the confirmed earlier outcome.
			expect(flow.pendingOperation).toBeNull();
			expect(flow.operation).toBeNull();
			if (statusCode === 503) {
				expect(flow.view).toBeNull();
				expect(flow.message).toBe(
					`${notice} Account status is unavailable right now. Check status again later.`,
				);
			} else {
				expect(flow.view).toEqual(view);
				expect(flow.message).toBe(notice);
			}
			expect(flow.message).not.toContain(privateUrl);
			expect(flow.message).not.toContain("new@example.test");
			expect(calls("browser-url")).toHaveLength(0);
			expect(calls("/cancel")).toHaveLength(path.endsWith("cancel") ? 1 : 0);
			expect(calls("link-operations")).toHaveLength(0);
		},
	);
});

describe("My Account transient polling continuity", () => {
	it("requires fresh current status after recovery and never delivers a URL from an uncertain operation", async () => {
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		view = status({ operation: operation(), canLink: false });
		await probe();
		transport.mockRejectedValueOnce(new TypeError("offline"));
		await tick();
		transport.mockResolvedValueOnce(
			response({ operation: operation("awaiting_browser"), current: true }),
		);
		view = status({ operation: operation("awaiting_browser"), canLink: false });
		await tick();
		expect(flow.pendingOperation).toBeNull();
		expect(flow.operation?.state).toBe("awaiting_browser");
		expect(flow.view).toEqual(view);
		expect(calls("link-status")).toHaveLength(2);
		expect(calls("browser-url")).toHaveLength(0);
		expect(flow.fallback).toBe(false);
		expect(window.open).not.toHaveBeenCalled();
	});
	it("retries transient polls after an uncertain cancellation without replaying capabilities", async () => {
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		view = status({ operation: operation("awaiting_browser"), canLink: false });
		await probe();
		transport.mockRejectedValueOnce(new TypeError("lost cancel"));
		await act(async () => {
			await flow.cancel();
		});
		transport.mockResolvedValueOnce(response({ error: "account_internal_error" }, 503));
		await tick();
		expect(flow.view).toBeNull();
		expect(flow.pendingOperation?.operationId).toBe("op-one");
		transport.mockRejectedValueOnce(new TypeError("offline"));
		await tick();
		transport.mockResolvedValueOnce(response({ operation: operation("succeeded"), current: true }));
		view = status();
		await tick();
		expect(calls("/op-one")).toHaveLength(3);
		expect(flow.pendingOperation).toBeNull();
		expect(flow.view).toEqual(view);
		expect(calls("browser-url")).toHaveLength(1);
		expect(calls("/cancel")).toHaveLength(1);
		expect(calls("link-operations")).toHaveLength(0);
	});
	it("stops automatic retries at the operation deadline without discarding cancellation", async () => {
		vi.setSystemTime(new Date("2026-01-01T00:04:59Z"));
		view = status({ operation: operation(), canLink: false });
		await probe();
		transport.mockRejectedValueOnce(new TypeError("offline"));
		await tick();
		await tick();
		expect(calls("/op-one")).toHaveLength(1);
		expect(flow.pendingOperation?.operationId).toBe("op-one");
		expect(flow.busy).toBe(false);
	});
});

describe("My Account expired previous-operation manual recovery", () => {
	const notice =
		"The earlier link finished for its original Identity. Check status there to confirm.";
	const retainExpiredPrevious = async () => {
		vi.setSystemTime(new Date("2026-01-01T00:04:59Z"));
		view = status({ operation: operation(), canLink: false });
		await probe();
		view = status({
			contextId: "new-context",
			selectedGroupId: "new-group",
			canLink: false,
			remote: {
				kind: "status",
				coordinatorId: "coordinator-one",
				identityId: "new-identity",
				authority: "device_claim",
				state: "linked",
				identityMatches: true,
				account: { email: "new@example.test" },
			},
		});
		transport.mockResolvedValueOnce(response({ operation: operation(), current: false }));
		await tick();
		await tick();
		expect(flow.pendingOperation?.operationId).toBe("op-one");
		expect(calls("/op-one")).toHaveLength(1);
	};
	const expectReadOnly = () => {
		expect(transport.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(
			0,
		);
		expect(calls("browser-url")).toHaveLength(0);
		expect(window.open).not.toHaveBeenCalled();
		expect(flow.operation).toBeNull();
		expect(flow.fallback).toBe(false);
	};
	it.each([200, 503])(
		"checks the expired old ID once and retains its success notice when current status returns %s",
		async (statusCode) => {
			// Arrange: a linked new Identity must not hide the original Identity's outcome.
			await retainExpiredPrevious();
			transport.mockImplementation(async (url) => {
				if (String(url).endsWith("/op-one"))
					return response({ operation: operation("succeeded"), current: false });
				return statusCode === 200
					? response(view)
					: response({ error: "account_internal_error", detail: privateUrl }, 503);
			});
			// Act: this is the public Check status handler, not a cancellation or timer.
			await act(async () => {
				await flow.refresh();
			});
			await tick();
			// Assert
			expect(calls("/op-one")).toHaveLength(2);
			expect(flow.pendingOperation).toBeNull();
			expect(flow.view).toEqual(statusCode === 200 ? view : null);
			expect(flow.message).toBe(
				statusCode === 200
					? notice
					: `${notice} Account status is unavailable right now. Check status again later.`,
			);
			expect(flow.message).not.toContain(privateUrl);
			expect(flow.message).not.toContain("new@example.test");
			expectReadOnly();
		},
	);
	it.each(["active", "missing", "unavailable"] as const)(
		"handles an expired manual operation read that is %s without restarting automatic retries",
		async (outcome) => {
			// Arrange
			await retainExpiredPrevious();
			transport.mockImplementation(async (url) => {
				if (!String(url).endsWith("/op-one")) return response(view);
				if (outcome === "missing") return response({ error: "account_operation_not_found" }, 404);
				if (outcome === "unavailable")
					return response({ error: "account_internal_error", detail: privateUrl }, 503);
				return response({ operation: operation("awaiting_browser"), current: false });
			});
			// Act
			await act(async () => {
				await flow.refresh();
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(10_000);
			});
			// Assert: only a terminal reply or confirmed absence releases the old handle.
			expect(calls("/op-one")).toHaveLength(2);
			if (outcome === "missing") expect(flow.pendingOperation).toBeNull();
			else expect(flow.pendingOperation?.operationId).toBe("op-one");
			expect(flow.view).toEqual(view);
			expect(flow.busy).toBe(false);
			if (outcome === "unavailable") expect(flow.message).toContain("Check status");
			expect(flow.message).not.toContain(privateUrl);
			expectReadOnly();
		},
	);
	it("ignores a late expired-operation success after a group change supersedes the manual read", async () => {
		// Arrange: the transport deliberately ignores abort to test generation checks.
		await retainExpiredPrevious();
		const late = deferred<Response>();
		transport.mockImplementation(async (url) => {
			if (String(url).endsWith("/op-one")) return late.promise;
			return response(view);
		});
		let check!: Promise<void>;
		act(() => {
			check = flow.refresh();
		});
		await settle();
		// Act
		view = status({ contextId: "third-context", selectedGroupId: "third-group" });
		await chooseGroup("third-group");
		await act(async () => {
			late.resolve(response({ operation: operation("succeeded"), current: false }));
			await check;
		});
		await tick();
		// Assert: the superseded success cannot clear the handle or label the new view.
		expect(calls("/op-one")).toHaveLength(2);
		expect(flow.pendingOperation?.operationId).toBe("op-one");
		expect(flow.view).toEqual(view);
		expect(flow.message).not.toContain("earlier link finished");
		expectReadOnly();
	});
});

describe("My Account uncertain transport privacy", () => {
	it("does not let a late previous cancellation clear or unlock a newer cancellation", async () => {
		view = status({ operation: operation(), canLink: false });
		await probe();
		transport.mockRejectedValueOnce(new TypeError("offline"));
		await tick();
		const old = deferred<Response>();
		transport.mockImplementationOnce(() => old.promise);
		let first!: Promise<void>;
		act(() => {
			first = flow.cancelPrevious();
		});
		view = status({ contextId: "context-two", selectedGroupId: "group-two" });
		await chooseGroup("group-two");
		const newer = deferred<Response>();
		transport.mockImplementationOnce(() => newer.promise);
		let second!: Promise<void>;
		act(() => {
			second = flow.cancelPrevious();
		});
		await act(async () => {
			old.resolve(response({ operation: operation("cancelled") }));
			await first;
			await flow.cancelPrevious();
		});
		expect(flow.busy).toBe(true);
		expect(flow.pendingOperation?.operationId).toBe("op-one");
		expect(calls("/cancel")).toHaveLength(2);
		expect(calls("/cancel")[1]?.[1]?.signal?.aborted).toBe(false);
		expect(flow.view?.contextId).toBe("context-two");
		await act(async () => {
			newer.resolve(response({ operation: operation("cancelled") }));
			await second;
		});
		expect(flow.pendingOperation).toBeNull();
	});
	it("removes the private browser capability and stale eligibility after a poll failure", async () => {
		// Arrange
		await probe();
		transport.mockResolvedValueOnce(
			response({ version: 1, operation: operation("awaiting_browser") }, 202),
		);
		await act(async () => {
			await flow.link();
		});
		await settle();
		expect(flow.fallback).toBe(true);
		transport.mockRejectedValueOnce(new TypeError("private-poll-details"));
		// Act
		await tick();
		act(() => flow.openFallback());
		await act(async () => {
			await flow.link();
		});
		// Assert: old unlinked status cannot authorize another start or cached browser URL.
		expect(flow.view).toBeNull();
		expect(flow.operation).toBeNull();
		expect(flow.pendingOperation?.operationId).toBe("op-one");
		expect(flow.fallback).toBe(false);
		expect(vi.mocked(window.open).mock.calls).toEqual([["about:blank", "_blank"]]);
		expect(calls("link-operations")).toHaveLength(1);
		expect(calls("link-status")).toHaveLength(1);
		expect(flow.message).toContain("Check status");
		expect(flow.message).not.toContain("private-poll-details");
		// Act / Assert: only a fresh manual status check restores the current account view.
		view = status();
		await act(async () => {
			await flow.refresh();
		});
		await settle();
		expect(flow.view?.canLink).toBe(true);
		expect(calls("link-status")).toHaveLength(2);
	});
	it("recovers a lost start reply through fresh status without replaying the POST", async () => {
		// Arrange
		await probe();
		view = status({ operation: operation(), canLink: false });
		transport.mockRejectedValueOnce(new TypeError("lost-private-reply"));
		// Act
		await act(async () => {
			await flow.link();
		});
		await settle();
		// Assert
		expect(calls("link-operations")).toHaveLength(1);
		expect(calls("link-status")).toHaveLength(1);
		expect(
			transport.mock.calls.filter(([url]) => String(url).includes("link-status")),
		).toHaveLength(2);
		expect(flow.operation?.operationId).toBe("op-one");
		expect(flow.busy).toBe(false);
		expect(flow.message).not.toContain("lost-private-reply");
	});
});

describe("My Account cancellation supersedes local delivery", () => {
	it("keeps cancellation pending when replacing the operation aborts an old poll", async () => {
		// Arrange
		view = status({ operation: operation("awaiting_browser"), canLink: false });
		await probe();
		transport.mockImplementationOnce(
			(_url, options) =>
				new Promise<Response>((_resolve, reject) => {
					options?.signal?.addEventListener(
						"abort",
						() => reject(new DOMException("Aborted", "AbortError")),
						{ once: true },
					);
				}),
		);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		const oldSignal = calls("/op-one")[0]?.[1]?.signal;
		const pending = { ...operation("awaiting_browser"), browserUrlAvailable: false };
		transport.mockResolvedValueOnce(response({ version: 1, operation: pending }));
		// Act
		await act(async () => {
			await flow.cancel();
		});
		await settle();
		// Assert: intentional aborts are not evidence of an unknown network outcome.
		expect(oldSignal?.aborted).toBe(true);
		expect(flow.view).toEqual(view);
		expect(flow.operation).toEqual(pending);
		expect(flow.message).toContain("Cancellation is pending");
		expect(calls("/cancel")).toHaveLength(1);
	});
	it("discards a late private URL while cancellation is still awaiting its reply", async () => {
		// Arrange
		await probe();
		const popup = { opener: {}, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
		vi.mocked(window.open).mockReturnValue(popup as unknown as Window);
		const url = deferred<Response>();
		const cancel = deferred<Response>();
		transport
			.mockResolvedValueOnce(response({ version: 1, operation: operation("awaiting_browser") }))
			.mockImplementationOnce(() => url.promise);
		await act(async () => {
			await flow.link();
		});
		await settle();
		transport.mockImplementationOnce(() => cancel.promise);
		// Act: ignore local aborts in this fetch stub to exercise late successful delivery.
		let cancellation!: Promise<void>;
		act(() => {
			cancellation = flow.cancel();
		});
		url.resolve(response({ version: 1, url: privateUrl }));
		await settle();
		act(() => flow.openFallback());
		// Assert before the backend has acknowledged cancellation.
		expect(flow.view).toEqual(view);
		expect(flow.operation?.state).toBe("awaiting_browser");
		expect(flow.message).toContain("Requesting cancellation");
		expect(flow.fallback).toBe(false);
		expect(popup.close).toHaveBeenCalled();
		expect(popup.location.replace).not.toHaveBeenCalled();
		expect(vi.mocked(window.open).mock.calls).toEqual([["about:blank", "_blank"]]);
		expect(calls("/cancel")).toHaveLength(1);
		await act(async () => {
			cancel.resolve(
				response({
					version: 1,
					operation: { ...operation("awaiting_browser"), browserUrlAvailable: false },
				}),
			);
			await cancellation;
		});
		await settle();
		expect(flow.message).toContain("Cancellation is pending");
	});
});

describe("My Account reserved blank cleanup", () => {
	it.each(["fetch-error", "invalid-url"])(
		"closes only the reserved blank after %s",
		async (failure) => {
			// Arrange
			await probe();
			const popup = { opener: {}, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
			vi.mocked(window.open).mockReturnValue(popup as unknown as Window);
			transport.mockResolvedValueOnce(
				response({ version: 1, operation: operation("awaiting_browser") }),
			);
			if (failure === "fetch-error")
				transport.mockRejectedValueOnce(new Error("private-url-details"));
			else
				transport.mockResolvedValueOnce(
					response({ version: 1, url: "https://other.example/auth/link/start" }),
				);
			// Act
			await act(async () => {
				await flow.link();
			});
			await settle();
			// Assert
			expect(popup.close).toHaveBeenCalledTimes(1);
			expect(popup.location.replace).not.toHaveBeenCalled();
			expect(flow.fallback).toBe(false);
			expect(flow.message).toBe(
				"Google sign-in could not be opened. Cancel linking, or wait for status to update.",
			);
			expect(flow.message).not.toContain("private-url-details");
		},
	);
});
