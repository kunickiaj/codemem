import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	store: { closeAsync: vi.fn(), db: { close: vi.fn() } },
	server: {
		server: { onclose: undefined as (() => void) | undefined },
		close: vi.fn(),
		connect: vi.fn(),
	},
	viewer: vi.fn(),
	serve: vi.fn(),
	create: vi.fn(),
	transport: { onclose: undefined as (() => void) | undefined },
}));

vi.mock("@codemem/core", () => ({
	resolveDbPath: () => ":memory:",
	MemoryStore: class {
		closeAsync = mocks.store.closeAsync;
		db = mocks.store.db;
	},
}));
vi.mock("@modelcontextprotocol/server/stdio", () => ({
	serveStdio: mocks.serve,
	StdioServerTransport: class {
		get onclose() {
			return mocks.transport.onclose;
		}
		set onclose(callback: (() => void) | undefined) {
			mocks.transport.onclose = callback;
		}
	},
}));
vi.mock("./server.js", () => ({ createCodememMcpServer: mocks.create }));
vi.mock("./stdio-viewer.js", () => ({ ensureViewer: mocks.viewer }));

type Callback = (error?: Error) => void;
const signals = new Map<string, Callback>();
const stdin = new Map<string, Callback>();
let drain: ReturnType<typeof Promise.withResolvers<void>>;
let stop: ReturnType<typeof Promise.withResolvers<void>>;
let entered: ReturnType<typeof Promise.withResolvers<void>>;
let exited: ReturnType<typeof Promise.withResolvers<number | undefined>>;
let reportError: (error: Error) => void;

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers();
	vi.clearAllMocks();
	signals.clear();
	stdin.clear();
	drain = Promise.withResolvers<void>();
	stop = Promise.withResolvers<void>();
	stop.resolve();
	entered = Promise.withResolvers<void>();
	exited = Promise.withResolvers<number | undefined>();
	mocks.server.server.onclose = undefined;
	mocks.transport.onclose = undefined;
	mocks.create.mockReturnValue(mocks.server);
	mocks.serve.mockImplementation((factory, options) => {
		factory();
		reportError = options.onerror;
		return mocks.server;
	});
	mocks.viewer.mockResolvedValue(undefined);
	mocks.server.connect.mockResolvedValue(undefined);
	mocks.server.close.mockImplementation(async () => {
		// Closing the SDK handle may synchronously close its transport during shutdown.
		mocks.transport.onclose?.();
	});
	mocks.store.closeAsync.mockImplementation(() => {
		entered.resolve();
		return drain.promise;
	});
	const originalOn = process.on.bind(process);
	vi.spyOn(process, "on").mockImplementation((event, listener) => {
		if (event === "SIGINT" || event === "SIGTERM") {
			signals.set(event, listener as Callback);
			return process;
		}
		return originalOn(event, listener);
	});
	const originalOnce = process.stdin.once.bind(process.stdin);
	vi.spyOn(process.stdin, "once").mockImplementation((event: string, listener: Callback) => {
		if (event === "end" || event === "error") {
			stdin.set(event, listener as Callback);
			return process.stdin;
		}
		return originalOnce(event, listener);
	});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		exited.resolve(typeof code === "number" ? code : undefined);
		return undefined as never;
	});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("test forbids network"));
});

afterEach(async () => {
	try {
		// Release the fake uncancelable embedding before restoring the real process.exit.
		stop.resolve();
		drain.resolve();
		await vi.advanceTimersByTimeAsync(0);
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	}
});

async function start(): Promise<void> {
	await import("./stdio.js");
	expect(mocks.serve).toHaveBeenCalledOnce();
}

function trigger(source: "end" | "onclose" | "SIGTERM" | "SIGINT" | "error"): void {
	if (source === "onclose") {
		expect(mocks.transport.onclose).toBeTypeOf("function");
		mocks.transport.onclose?.();
		return;
	}
	const handler = stdin.get(source) ?? signals.get(source);
	expect(handler).toBeTypeOf("function");
	handler?.(source === "error" ? new Error("stdin failed") : undefined);
}

it("does not close the shared store when a discovery probe instance is discarded", async () => {
	await start();
	const factory = mocks.serve.mock.calls[0]?.[0] as () => typeof mocks.server;
	await factory().close();
	expect(mocks.create).toHaveBeenCalledTimes(2);
	expect(mocks.store.closeAsync).not.toHaveBeenCalled();
	expect(process.exit).not.toHaveBeenCalled();
});

it.each(["end", "error", "onclose", "SIGTERM"] as const)(
	"forces exit after 30 seconds of pending store drain following %s without closing SQLite",
	async (source) => {
		// Arrange
		await start();
		const timeout = vi.spyOn(globalThis, "setTimeout");

		// Act
		trigger(source);
		await entered.promise;
		await vi.advanceTimersByTimeAsync(29_999);

		// Assert: the deadline must not race SQLite against an admitted embedding.
		expect(process.exit).not.toHaveBeenCalled();
		expect(mocks.store.db.close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
		expect(mocks.server.close).toHaveBeenCalledOnce();
		expect(mocks.store.closeAsync).toHaveBeenCalledOnce();
		expect(mocks.store.db.close).not.toHaveBeenCalled();
		const deadlines = timeout.mock.calls.flatMap((args, index) => {
			if (args[1] !== 30_000) return [];
			return [timeout.mock.results[index]?.value as NodeJS.Timeout];
		});
		expect(deadlines).toHaveLength(1);
		expect(deadlines[0]?.hasRef()).toBe(false);
	},
);

it("drains once across concurrent signals and recursive protocol close, clears its deadline, and exits successfully", async () => {
	// Arrange
	await start();
	const order: string[] = [];
	const stopping = Promise.withResolvers<void>();
	stop = Promise.withResolvers<void>();
	mocks.server.close.mockImplementation(async () => {
		order.push("server");
		mocks.transport.onclose?.();
		stopping.resolve();
		await stop.promise;
	});
	mocks.store.closeAsync.mockImplementation(() => {
		order.push("store");
		entered.resolve();
		return drain.promise;
	});

	// Act
	trigger("SIGTERM");
	trigger("SIGINT");
	trigger("end");
	trigger("onclose");
	await stopping.promise;
	expect(mocks.store.closeAsync).not.toHaveBeenCalled();
	stop.resolve();
	await entered.promise;
	expect(vi.getTimerCount()).toBe(1);
	drain.resolve();
	await exited.promise;
	await vi.advanceTimersByTimeAsync(60_000);

	// Assert
	expect(order).toEqual(["server", "store"]);
	expect(mocks.server.close).toHaveBeenCalledOnce();
	expect(mocks.store.closeAsync).toHaveBeenCalledOnce();
	expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
	expect(vi.getTimerCount()).toBe(0);
	expect(mocks.store.db.close).not.toHaveBeenCalled();
});

it("preserves a failure exit code when stdin fails during an already pending graceful shutdown", async () => {
	// Arrange
	await start();

	// Act
	trigger("end");
	await entered.promise;
	trigger("error");
	drain.resolve();
	await exited.promise;
	await vi.advanceTimersByTimeAsync(60_000);

	// Assert
	expect(mocks.server.close).toHaveBeenCalledOnce();
	expect(mocks.store.closeAsync).toHaveBeenCalledOnce();
	expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
	expect(vi.getTimerCount()).toBe(0);
});

it("exits with failure when store cleanup rejects and clears the forced-exit deadline", async () => {
	// Arrange
	await start();

	// Act
	trigger("SIGINT");
	await entered.promise;
	drain.reject(new Error("store cleanup failed"));
	await exited.promise;
	await vi.advanceTimersByTimeAsync(60_000);

	// Assert
	expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
	expect(mocks.store.closeAsync).toHaveBeenCalledOnce();
	expect(mocks.store.db.close).not.toHaveBeenCalled();
	expect(vi.getTimerCount()).toBe(0);
});

it("reports SDK parsing errors without terminating a usable connection", async () => {
	// Arrange
	const failure = new Error("transport startup failed");

	// Act
	await start();
	reportError(failure);
	expect(mocks.store.closeAsync).not.toHaveBeenCalled();
	expect(process.exit).not.toHaveBeenCalled();
	trigger("end");
	await entered.promise;
	expect(process.exit).not.toHaveBeenCalled();
	drain.resolve();
	await exited.promise;
	await vi.advanceTimersByTimeAsync(60_000);

	// Assert
	expect(console.error).toHaveBeenCalledExactlyOnceWith("codemem MCP server failed:", failure);
	expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
	expect(mocks.server.close).toHaveBeenCalledOnce();
	expect(mocks.store.closeAsync).toHaveBeenCalledOnce();
	expect(vi.getTimerCount()).toBe(0);
});

it("drains the store and exits with failure when the SDK serving entry throws at startup", async () => {
	const failure = new Error("startup failed");
	mocks.serve.mockImplementation(() => {
		throw failure;
	});
	await start();
	await entered.promise;
	drain.resolve();
	await exited.promise;
	expect(console.error).toHaveBeenCalledWith("codemem MCP server failed to start:", failure);
	expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
	expect(mocks.server.close).not.toHaveBeenCalled();
	expect(mocks.store.closeAsync).toHaveBeenCalledOnce();
});
