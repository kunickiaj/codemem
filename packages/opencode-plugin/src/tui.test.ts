import { describe, expect, it, vi } from "vitest";
import { createCodememTuiPlugin } from "../tui.js";

function makeContext(
	options: {
		replay?: unknown[];
		drainPromise?: Promise<{ notices: unknown[] }>;
		drainError?: Error;
		subscribeError?: Error;
		toastError?: Error;
	} = {},
) {
	type Location = { directory: string; workspaceID?: string };
	let listener: ((event: { data: unknown; location?: Location }) => void) | undefined;
	const unsubscribe = vi.fn();
	const show = vi.fn(() => {
		if (options.toastError) throw options.toastError;
	});
	const drain = vi.fn(async (_input?: unknown, _request?: unknown) => {
		if (options.drainPromise) return options.drainPromise;
		if (options.drainError) throw options.drainError;
		return { notices: options.replay ?? [] };
	});
	const on = vi.fn(
		(_name: string, handler: (event: { data: unknown; location?: Location }) => void) => {
			if (options.subscribeError) throw options.subscribeError;
			listener = handler;
			return unsubscribe;
		},
	);
	return {
		context: {
			client: { rpc: vi.fn(() => ({ drain, events: { on } })) },
			location: { directory: "/repo" } as Location,
			ui: { toast: { show } },
		},
		drain,
		emit(data: unknown, location: Location = { directory: "/repo" }) {
			listener?.({ data, location });
		},
		on,
		show,
		unsubscribe,
	};
}

describe("OpenCode 2 TUI companion", () => {
	it("subscribes before replay and deduplicates notices from both paths", async () => {
		const notice = { id: "notice-1", message: "Context injected", variant: "success" };
		const fixture = makeContext({ replay: [notice] });
		fixture.drain.mockImplementationOnce(async () => {
			fixture.emit(notice);
			return { notices: [notice] };
		});

		const cleanup = await createCodememTuiPlugin().setup(fixture.context as never);

		expect(fixture.on.mock.invocationCallOrder[0]).toBeLessThan(
			fixture.drain.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		expect(fixture.show).toHaveBeenCalledOnce();
		expect(fixture.show).toHaveBeenCalledWith({
			title: "Codemem",
			message: "Context injected",
			variant: "success",
		});
		await cleanup?.();
		expect(fixture.unsubscribe).toHaveBeenCalledOnce();
	});

	it("continues after malformed notices and toast failures", async () => {
		const fixture = makeContext({ toastError: new Error("renderer unavailable") });
		await expect(createCodememTuiPlugin().setup(fixture.context as never)).resolves.toBeTypeOf(
			"function",
		);

		fixture.emit({ id: "", message: "invalid", variant: "warning" });
		fixture.emit({ id: "notice-1", message: "valid", variant: "error" });
		expect(fixture.show).toHaveBeenCalledOnce();
	});

	it("ignores live notices from another location", async () => {
		const fixture = makeContext();
		await createCodememTuiPlugin().setup(fixture.context as never);

		fixture.emit(
			{ id: "notice-1", message: "other checkout", variant: "info" },
			{ directory: "/other" },
		);
		expect(fixture.show).not.toHaveBeenCalled();
		expect(fixture.drain).toHaveBeenCalledWith(
			{},
			expect.objectContaining({
				location: { directory: "/repo" },
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("ignores live notices from another workspace in the same directory", async () => {
		const fixture = makeContext();
		fixture.context.location = { directory: "/repo", workspaceID: "workspace-1" };
		await createCodememTuiPlugin().setup(fixture.context as never);

		fixture.emit(
			{ id: "notice-1", message: "other workspace", variant: "info" },
			{ directory: "/repo", workspaceID: "workspace-2" },
		);
		expect(fixture.show).not.toHaveBeenCalled();
	});

	it("bounds stalled replay and aborts it during cleanup", async () => {
		const fixture = makeContext({ drainPromise: new Promise(() => {}) });
		const setup = createCodememTuiPlugin({ replayTimeoutMs: 5 } as never).setup(
			fixture.context as never,
		);

		const outcome = await Promise.race([
			Promise.resolve(setup).then((cleanup) => ({ kind: "setup" as const, cleanup })),
			new Promise<{ kind: "timeout" }>((resolve) =>
				setTimeout(() => resolve({ kind: "timeout" }), 100),
			),
		]);
		expect(outcome.kind).toBe("setup");
		if (outcome.kind !== "setup") return;
		const request = fixture.drain.mock.calls[0]?.[1] as { signal?: AbortSignal };
		expect(request.signal?.aborted).toBe(true);
		await outcome.cleanup?.();
		expect(fixture.unsubscribe).toHaveBeenCalledOnce();
	});

	it("remains dormant when server RPC operations are unavailable", async () => {
		const fixture = makeContext({
			drainError: new Error("server missing"),
			subscribeError: new Error("events missing"),
		});

		const cleanup = await createCodememTuiPlugin().setup(fixture.context as never);

		expect(fixture.show).not.toHaveBeenCalled();
		await cleanup?.();
	});
});
