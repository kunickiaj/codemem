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
		closeStore: vi.fn(),
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
	log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), step: vi.fn(), success: vi.fn() },
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
	createApp: mocks.createApp,
	createSyncApp: mocks.createSyncApp,
	createAccountContextReader: mocks.createContext,
	createAccountLinkRegistry: mocks.createRegistry,
	createViewerRawEventInbox: vi.fn(() => ({
		inbox: { start: mocks.inboxStart },
		stop: mocks.inboxStop,
	})),
	reconcileConfiguredCoordinatorEnrollment: vi.fn(),
}));
vi.mock("@hono/node-server", () => ({ serve: mocks.serve }));

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((yes) => {
		resolve = yes;
	});
	return { promise, resolve };
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
	mocks.closeStore.mockImplementation(() => {
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
			expect(mocks.createRegistry).toHaveBeenCalledWith({ readContext: mocks.contextReader });
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

describe("foreground account shutdown wiring", () => {
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
