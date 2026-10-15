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
		transport.mockResolvedValueOnce(
			response({ version: 1, current: true, operation: operation() }),
		);
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
			expect(flow.message).toContain("Check status");
			expect(flow.message).not.toContain("private-url-details");
		},
	);
});
