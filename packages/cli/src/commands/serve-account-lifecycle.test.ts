import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountContextReaderOptions, AppOptions } from "@codemem/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startForegroundViewer } from "./serve.js";
import type { ResolvedServeInvocation } from "./serve-invocation.js";

const mocks = vi.hoisted(() => {
	const calls: string[] = [];
	return {
		calls,
		config: {},
		store: {
			dbPath: "",
			deviceId: "fixture-device",
			actorId: "fixture-actor",
			actorDisplayName: "Fixture actor",
			hasCurrentIdentity: vi.fn(() => true),
			hasCurrentConfiguredIdentity: vi.fn(() => true),
			onIdentityChanged: vi.fn(() => vi.fn()),
		},
		contextReader: vi.fn(() => ({ error: "account_context_unavailable" as const })),
		createContext: vi.fn<(options: AccountContextReaderOptions) => unknown>(),
		createRegistry: vi.fn(),
		registryClose: vi.fn<() => Promise<void>>(),
		createApp: vi.fn<(options: AppOptions) => { fetch: () => void }>(),
		createSyncApp: vi.fn<(options: AppOptions) => { fetch: () => void }>(),
		getStore: vi.fn(),
		closeStore: vi.fn<() => Promise<void>>(),
		logError: vi.fn(),
		initDatabase: vi.fn(),
		readAtPath: vi.fn(),
		readConfig: vi.fn(),
		syncConfig: vi.fn(),
		spawn: vi.fn(),
		spawnSync: vi.fn(),
		unref: vi.fn(),
		sweeperStart: vi.fn(),
		sweeperStop: vi.fn(),
		inboxStart: vi.fn(),
		inboxStop: vi.fn(),
		serve:
			vi.fn<
				(
					options: { fetch: unknown; hostname: string; port: number },
					callback: (info: { address: string; port: number }) => void,
				) => unknown
			>(),
	};
});
vi.mock("node:fs", async (original) => ({
	...(await original<typeof import("node:fs")>()),
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => {
		throw new Error("Unexpected file read");
	}),
	writeFileSync: vi.fn(),
	rmSync: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn, spawnSync: mocks.spawnSync }));
vi.mock("@clack/prompts", () => ({
	intro: vi.fn(),
	outro: vi.fn(),
	log: { warn: vi.fn(), error: mocks.logError, info: vi.fn(), step: vi.fn(), success: vi.fn() },
}));
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	MemoryStore: class {
		constructor() {
			throw new Error("Unexpected real store construction");
		}
	},
	ObserverClient: class {},
	RawEventSweeper: class {
		start = mocks.sweeperStart;
		stop = mocks.sweeperStop;
	},
	initDatabase: mocks.initDatabase,
	readCodememConfigFile: mocks.readConfig,
	readCodememConfigFileAtPath: mocks.readAtPath,
	readCoordinatorSyncConfig: mocks.syncConfig,
	runSyncDaemon: vi.fn(() => {
		throw new Error("Unexpected sync daemon");
	}),
}));
vi.mock("@codemem/server", () => ({
	getStore: mocks.getStore,
	closeStore: mocks.closeStore,
	closeStoreAsync: mocks.closeStore,
	createApp: mocks.createApp,
	createSyncApp: mocks.createSyncApp,
	createAccountContextReader: mocks.createContext,
	createAccountLinkRegistry: mocks.createRegistry,
	createAccountRebindRunner: () => async () => ({ kind: "failed" }),
	resumeAccountRebind: async () => null,
	createViewerRawEventInbox: vi.fn(() => ({
		inbox: { start: mocks.inboxStart },
		stop: mocks.inboxStop,
	})),
	reconcileConfiguredCoordinatorEnrollment: vi.fn(),
}));
vi.mock("@hono/node-server", () => ({ serve: mocks.serve }));

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const HOME = "/fixture/account-lifecycle-home";
const DB = join(HOME, "running.sqlite");
const registry = { close: mocks.registryClose };
const signals = new Map<string, () => void>();
const exits: unknown[] = [];
let exited = deferred();
const listeners: Array<{ close: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }> = [];

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	for (const key of [
		"CODEMEM_CONFIG",
		"CODEMEM_KEYS_DIR",
		"CODEMEM_RUNTIME_ROOT",
		"CODEMEM_WORKSPACE_ID",
		"CODEMEM_DB",
	])
		vi.stubEnv(key, undefined);
	vi.stubEnv("HOME", HOME);
	mocks.calls.length = 0;
	exits.length = 0;
	listeners.length = 0;
	signals.clear();
	exited = deferred();
	mocks.store.dbPath = DB;
	mocks.store.actorId = "fixture-actor";
	mocks.store.deviceId = "fixture-device";
	mocks.registryClose.mockImplementation(async () => {
		mocks.calls.push("registry");
	});
	mocks.getStore.mockImplementation(() => {
		if (process.env.CODEMEM_DB !== DB) throw new Error("Unexpected default database access");
		return mocks.store;
	});
	mocks.closeStore.mockImplementation(async () => {
		mocks.calls.push("store");
	});
	mocks.initDatabase.mockImplementation((path) => {
		if (path !== DB) throw new Error("Unexpected database initialization");
		return { path };
	});
	mocks.createContext.mockReturnValue(mocks.contextReader);
	mocks.createRegistry.mockReturnValue(registry);
	mocks.createApp.mockReturnValue({ fetch: vi.fn() });
	mocks.createSyncApp.mockReturnValue({ fetch: vi.fn() });
	mocks.readConfig.mockReturnValue(mocks.config);
	mocks.readAtPath.mockReturnValue(mocks.config);
	mocks.syncConfig.mockReturnValue({ syncEnabled: false, syncHost: "127.0.0.1", syncPort: 7442 });
	mocks.spawn.mockReturnValue({ unref: mocks.unref });
	mocks.spawnSync.mockImplementation(() => {
		throw new Error("Unexpected subprocess inspection");
	});
	mocks.serve.mockImplementation(() => {
		const index = listeners.length;
		const listener = {
			on: vi.fn(),
			close: vi.fn((done: () => void) => {
				mocks.calls.push(`listener:${index}`);
				done();
			}),
		};
		listeners.push(listener);
		return listener;
	});
	vi.mocked(existsSync).mockReturnValue(false);
	vi.mocked(readFileSync)
		.mockReset()
		.mockImplementation(() => {
			throw new Error("Unexpected file read");
		});
	const on = process.on.bind(process);
	vi.spyOn(process, "on").mockImplementation((event, listener) => {
		if (event === "SIGINT" || event === "SIGTERM") signals.set(event, listener as () => void);
		else on(event, listener);
		return process;
	});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		exits.push(code);
		exited.resolve();
		return undefined as never;
	});
	vi.spyOn(process, "kill").mockImplementation(() => {
		throw new Error("Unexpected process signal");
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network request");
		}),
	);
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});
function invocation(overrides: Partial<ResolvedServeInvocation> = {}): ResolvedServeInvocation {
	return {
		mode: "start",
		dbPath: DB,
		configPath: null,
		host: "127.0.0.1",
		port: 7441,
		background: false,
		...overrides,
	};
}
function options() {
	const app = mocks.createApp.mock.calls[0]?.[0];
	const context = mocks.createContext.mock.calls[0]?.[0];
	if (!app?.accountLink || !context) throw new Error("Missing actual foreground options");
	return { app, account: app.accountLink, context };
}
function listening(index = 0, port = 7441) {
	const callback = mocks.serve.mock.calls[index]?.[1];
	if (!callback) throw new Error("Missing actual listener callback");
	callback({ address: "127.0.0.1", port });
}
async function shutdown(signal = "SIGTERM") {
	const callback = signals.get(signal);
	if (!callback) throw new Error("Missing actual shutdown callback");
	callback();
	await exited.promise;
}

describe("foreground account profile and listener wiring", () => {
	it.each([
		["default", undefined, undefined, join(HOME, ".config/codemem/config.json")],
		[
			"runtime",
			"CODEMEM_RUNTIME_ROOT",
			join(HOME, "runtime"),
			join(HOME, "runtime/config/codemem.json"),
		],
		[
			"workspace",
			"CODEMEM_WORKSPACE_ID",
			"workspace-a",
			join(HOME, ".codemem/workspaces/workspace-a/config/codemem.json"),
		],
		["explicit", "CODEMEM_CONFIG", join(HOME, "selected.json"), join(HOME, "selected.json")],
	] as const)(
		"captures %s config and default keys from the running foreground profile",
		async (_name, key, value, expectedPath) => {
			// Arrange: preserve the real config/key path resolvers, but never read a profile or keys.
			if (key) vi.stubEnv(key, value);
			vi.mocked(existsSync).mockImplementation((path) => String(path) === expectedPath);
			await startForegroundViewer(invocation()); // Act
			const f = options();
			expect(f.context.configPath).toBe(expectedPath); // Assert
			expect(f.context.keysDir).toBe(join(HOME, ".config/codemem/keys"));
			expect(f.context.getProfile()).toEqual({
				dbPath: DB,
				deviceId: "fixture-device",
				identityId: "fixture-actor",
				identityLabel: "Fixture actor",
			});
			mocks.store.actorId = "changed-actor";
			expect(f.context.getProfile()?.identityId).toBe("changed-actor");
			vi.stubEnv("CODEMEM_CONFIG", join(HOME, "later.json"));
			vi.stubEnv("CODEMEM_KEYS_DIR", join(HOME, "later-keys"));
			f.context.readConfig();
			expect(mocks.readAtPath).toHaveBeenLastCalledWith(expectedPath);
			expect(mocks.createRegistry).toHaveBeenCalledWith({
				readContext: mocks.contextReader,
				rebind: expect.any(Function),
			});
			expect(f.account.registry).toBe(registry);
			expect(f.app.storeFactory?.()).toBe(mocks.store);
			expect(mocks.initDatabase).toHaveBeenCalledWith(DB);
			expect(readFileSync).not.toHaveBeenCalled();
			await shutdown();
		},
	);
	it("prefers the CLI config and trims the explicit keys directory", async () => {
		const configPath = join(HOME, "cli.json"); // Arrange
		vi.stubEnv("CODEMEM_CONFIG", join(HOME, "environment.json"));
		vi.stubEnv("CODEMEM_KEYS_DIR", `  ${HOME}/selected-keys  `);
		await startForegroundViewer(invocation({ configPath })); // Act
		const f = options();
		expect(f.context.configPath).toBe(configPath); // Assert
		expect(f.context.keysDir).toBe(join(HOME, "selected-keys"));
		f.context.readConfig();
		expect(mocks.readAtPath).toHaveBeenLastCalledWith(configPath);
		expect(readFileSync).not.toHaveBeenCalled();
		await shutdown();
	});
	it.each(["127.0.0.1", "0.0.0.0", "::"])(
		"keeps %s and learns the actual ephemeral port only after listening",
		async (host) => {
			const input = invocation({ host, port: 0 }); // Arrange
			await startForegroundViewer(input); // Act
			const f = options();
			expect(f.account.getListenerAddress()).toBeNull(); // Assert
			expect(mocks.serve.mock.calls[0]?.[0]).toMatchObject({ hostname: host, port: 0 });
			listening(0, 49152);
			expect(f.account.getListenerAddress()).toEqual({ host, port: 49152 });
			expect(mocks.spawn).toHaveBeenCalledOnce();
			expect(writeFileSync).toHaveBeenCalledWith(
				join(HOME, "viewer.pid"),
				expect.any(String),
				"utf-8",
			);
			await shutdown();
		},
	);
});

describe("foreground viewer PID ownership cleanup", () => {
	it("preserves an existing foreign viewer PID record after a bind failure", async () => {
		// Arrange: this startup never reaches the callback that writes its own PID.
		const pidPath = join(HOME, "viewer.pid");
		vi.mocked(existsSync).mockImplementation((path) => String(path) === pidPath);
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({ pid: process.pid + 1, host: "127.0.0.1", port: 7441 }),
		);
		await startForegroundViewer(invocation());
		const errorHandler = listeners[0]?.on.mock.calls.find(([event]) => event === "error")?.[1];
		if (!errorHandler) throw new Error("Missing actual listener error callback");

		// Act: deliver the listener failure without binding a real socket.
		errorHandler(Object.assign(new Error("Address in use"), { code: "EADDRINUSE" }));
		await exited.promise;

		// Assert: failed startup cannot remove the running viewer's ownership record.
		expect(writeFileSync).not.toHaveBeenCalled();
		expect(rmSync).not.toHaveBeenCalledWith(pidPath);
		expect(exits).toEqual([1]);
	});
	it.each(["own", "replaced"] as const)(
		"removes only its own viewer PID record during graceful shutdown (%s record)",
		async (owner) => {
			// Arrange: listen successfully, then optionally replace the ownership record.
			const pidPath = join(HOME, "viewer.pid");
			await startForegroundViewer(invocation());
			listening();
			const writtenRecord = String(vi.mocked(writeFileSync).mock.calls[0]?.[1]);
			const record = JSON.parse(writtenRecord);
			vi.mocked(existsSync).mockImplementation((path) => String(path) === pidPath);
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({ ...record, pid: owner === "own" ? process.pid : process.pid + 1 }),
			);

			// Act
			await shutdown();

			// Assert: cleanup checks current ownership, not whether startup once wrote the file.
			expect(record.pid).toBe(process.pid);
			if (owner === "own") expect(rmSync).toHaveBeenCalledWith(pidPath);
			else expect(rmSync).not.toHaveBeenCalledWith(pidPath);
			expect(exits).toEqual([0]);
		},
	);
	it.each(["own", "replaced"] as const)(
		"removes only its own viewer PID record at the forced shutdown deadline (%s record)",
		async (owner) => {
			// Arrange: stall registry cleanup so only the 30-second safety timer can exit.
			const closing = deferred();
			mocks.registryClose.mockReturnValue(closing.promise);
			const pidPath = join(HOME, "viewer.pid");
			await startForegroundViewer(invocation());
			listening();
			vi.mocked(existsSync).mockImplementation((path) => String(path) === pidPath);
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: 7441 }),
			);
			const requestShutdown = signals.get("SIGTERM");
			if (!requestShutdown) throw new Error("Missing actual shutdown callback");

			// Act: another viewer may replace the file while graceful cleanup is stalled.
			requestShutdown();
			vi.mocked(readFileSync).mockReturnValue(
				JSON.stringify({
					pid: owner === "own" ? process.pid : process.pid + 1,
					host: "127.0.0.1",
					port: 7441,
				}),
			);
			await vi.advanceTimersByTimeAsync(29_999);
			const exitsBeforeDeadline = [...exits];
			await vi.advanceTimersByTimeAsync(1);
			const forcedExits = [...exits];
			const forcedRemovals = [...vi.mocked(rmSync).mock.calls];
			closing.resolve();
			await vi.advanceTimersByTimeAsync(0);

			// Assert: force-exit preserves replacement ownership and still cleans its own file.
			expect(exitsBeforeDeadline).toEqual([]);
			expect(forcedExits).toEqual([1]);
			expect(forcedRemovals.some(([path]) => path === pidPath)).toBe(owner === "own");
		},
	);
});

describe("foreground account shutdown wiring", () => {
	it("reports store-drain rejection and exits with failure after awaiting the close promise", async () => {
		// Arrange: rejection happens only after shutdown reaches the final owned store drain.
		const closing = deferred();
		const closeEntered = deferred();
		const failure = new Error("fixture async store close failed");
		mocks.closeStore.mockImplementation(() => {
			mocks.calls.push("store");
			closeEntered.resolve();
			return closing.promise;
		});
		await startForegroundViewer(invocation());
		const requestShutdown = signals.get("SIGTERM");
		if (!requestShutdown) throw new Error("Missing actual shutdown callback");

		// Act: no actual signal or process exit is used, and the force-exit timer never advances.
		requestShutdown();
		await closeEntered.promise;
		const exitsWhileClosing = [...exits];
		closing.reject(failure);
		await vi.advanceTimersByTimeAsync(0);

		// Assert: a failed graceful drain must not skip process exit or become success.
		expect(exitsWhileClosing).toEqual([]);
		expect(mocks.calls).toEqual(["registry", "listener:0", "store"]);
		expect(mocks.closeStore).toHaveBeenCalledOnce();
		expect(mocks.logError).toHaveBeenCalledExactlyOnceWith(failure.message);
		expect(exits).toEqual([1]);
	});
	it("waits for asynchronous store drain before reporting process exit", async () => {
		// Arrange: the shared close spy represents the server's asynchronous close API.
		const closing = deferred();
		mocks.closeStore.mockImplementation(() => {
			mocks.calls.push("store");
			return closing.promise;
		});
		await startForegroundViewer(invocation());

		// Act: drain promise reactions without advancing the forced-exit safety timer.
		const finished = shutdown();
		await vi.advanceTimersByTimeAsync(0);
		const exitsBeforeStoreDrained = [...exits];
		closing.resolve();
		await finished;

		// Assert: release the fixture promise even on RED, then verify the owner awaited it.
		expect(exitsBeforeStoreDrained).toEqual([]);
		expect(mocks.closeStore).toHaveBeenCalledOnce();
		expect(mocks.calls.at(-1)).toBe("store");
		expect(exits).toEqual([0]);
	});
	it.each(["SIGTERM", "SIGINT"])(
		"waits for registry cleanup before draining either listener on %s",
		async (signal) => {
			const closing = deferred(); // Arrange
			mocks.registryClose.mockImplementation(() => {
				mocks.calls.push("registry");
				return closing.promise;
			});
			mocks.syncConfig.mockReturnValue({ syncEnabled: true, syncHost: "0.0.0.0", syncPort: 7442 });
			await startForegroundViewer(invocation());
			listening(0, 7442);
			listening(1, 7441);
			const finished = shutdown(signal); // Act
			// Assert: pending account cleanup blocks listener, worker, PID and store cleanup.
			expect(mocks.calls).toEqual(["registry"]);
			expect(mocks.closeStore).not.toHaveBeenCalled();
			expect(mocks.inboxStop).not.toHaveBeenCalled();
			expect(mocks.sweeperStop).not.toHaveBeenCalled();
			expect(rmSync).not.toHaveBeenCalled();
			expect(exits).toEqual([]);
			closing.resolve();
			await finished;
			expect(mocks.calls).toEqual(["registry", "listener:0", "listener:1", "store"]);
			expect(mocks.inboxStop).toHaveBeenCalledOnce();
			expect(mocks.sweeperStop).toHaveBeenCalledOnce();
			expect(exits).toEqual([0]);
		},
	);
	it("closes the registry and viewer when sync is disabled and listening never completed", async () => {
		await startForegroundViewer(invocation()); // Arrange
		await shutdown(); // Act
		expect(mocks.calls).toEqual(["registry", "listener:0", "store"]); // Assert
		expect(mocks.createSyncApp).not.toHaveBeenCalled();
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(exits).toEqual([0]);
	});
});
