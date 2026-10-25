import { join } from "node:path";
import type { AccountContextReaderOptions, AppOptions } from "@codemem/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startForegroundViewer } from "./serve.js";
import type { ResolvedServeInvocation } from "./serve-invocation.js";

type RecoveryOptions = {
	readContext: unknown;
	registry: unknown;
	readAdminSecret: () => string | null | undefined;
};
const mocks = vi.hoisted(() => ({
	store: {
		dbPath: "/fixture/recovery/running.sqlite",
		deviceId: "fixture-device",
		actorId: "fixture-actor",
		actorDisplayName: "Fixture actor",
		hasCurrentIdentity: vi.fn(() => true),
		hasCurrentConfiguredIdentity: vi.fn(() => true),
		onIdentityChanged: vi.fn(() => vi.fn()),
	},
	context: vi.fn(() => ({ error: "account_context_unavailable" as const })),
	createContext: vi.fn<(options: AccountContextReaderOptions) => unknown>(),
	createRegistry: vi.fn(),
	createRecovery: vi.fn<(options: RecoveryOptions) => unknown>(),
	registryClose: vi.fn<() => Promise<void>>(),
	recoveryClose: vi.fn<() => Promise<void>>(),
	createApp: vi.fn<(options: AppOptions) => { fetch: () => void }>(),
	readAtPath: vi.fn(),
	readDefault: vi.fn(),
	closeStore: vi.fn(),
	logs: vi.fn(),
	listenerClose: vi.fn(),
	serve: vi.fn(),
}));
vi.mock("node:fs", async (original) => ({
	...(await original<typeof import("node:fs")>()),
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => {
		throw new Error("Unexpected profile file read");
	}),
	writeFileSync: vi.fn(),
	rmSync: vi.fn(),
}));
vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => {
		throw new Error("Unexpected subprocess");
	}),
	spawnSync: vi.fn(() => {
		throw new Error("Unexpected process inspection");
	}),
}));
vi.mock("@clack/prompts", () => ({
	intro: mocks.logs,
	outro: mocks.logs,
	log: {
		warn: mocks.logs,
		error: mocks.logs,
		info: mocks.logs,
		step: mocks.logs,
		success: mocks.logs,
	},
}));
vi.mock("@codemem/core", async (original) => ({
	...(await original<typeof import("@codemem/core")>()),
	MemoryStore: class {
		constructor() {
			throw new Error("Unexpected real store");
		}
	},
	ObserverClient: class {},
	RawEventSweeper: class {
		start = vi.fn();
		stop = vi.fn();
	},
	initDatabase: vi.fn((path) => ({ path })),
	readCodememConfigFile: mocks.readDefault,
	readCodememConfigFileAtPath: mocks.readAtPath,
	readCoordinatorSyncConfig: vi.fn(() => ({
		syncEnabled: false,
		syncHost: "127.0.0.1",
		syncPort: 7442,
	})),
	runSyncDaemon: vi.fn(() => {
		throw new Error("Unexpected sync daemon");
	}),
}));
vi.mock("@codemem/server", () => ({
	getStore: () => mocks.store,
	closeStore: mocks.closeStore,
	closeStoreAsync: async () => mocks.closeStore(),
	createApp: mocks.createApp,
	createSyncApp: vi.fn(),
	createAccountContextReader: mocks.createContext,
	createAccountLinkRegistry: mocks.createRegistry,
	createAccountOwnerRecoveryService: mocks.createRecovery,
	createViewerRawEventInbox: vi.fn(() => ({ inbox: { start: vi.fn() }, stop: vi.fn() })),
	reconcileConfiguredCoordinatorEnrollment: vi.fn(),
}));
vi.mock("@hono/node-server", () => ({ serve: mocks.serve }));

const HOME = "/fixture/recovery";
const CONFIG = join(HOME, "selected.json");
const registry = { close: mocks.registryClose };
const recovery = { close: mocks.recoveryClose };
const signals = new Map<string, () => void>();
let finishExit: () => void;
let exited: Promise<void>;
function invocation(): ResolvedServeInvocation {
	return {
		mode: "start",
		dbPath: mocks.store.dbPath,
		configPath: CONFIG,
		host: "127.0.0.1",
		port: 7441,
		background: false,
	};
}
function composed() {
	const options = mocks.createRecovery.mock.calls[0]?.[0];
	if (!options)
		throw new Error(
			"Missing owner-recovery factory composition from the normal @codemem/server entry",
		);
	return options;
}
async function shutdown(signal = "SIGTERM") {
	const callback = signals.get(signal);
	if (!callback) throw new Error("Missing actual foreground shutdown callback");
	callback();
	await exited;
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	for (const key of [
		"CODEMEM_CONFIG",
		"CODEMEM_KEYS_DIR",
		"CODEMEM_RUNTIME_ROOT",
		"CODEMEM_WORKSPACE_ID",
		"CODEMEM_DB",
		"CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET",
	])
		vi.stubEnv(key, undefined);
	vi.stubEnv("HOME", HOME);
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Network forbidden");
		}),
	);
	signals.clear();
	exited = new Promise<void>((resolve) => {
		finishExit = resolve;
	});
	mocks.readDefault.mockReturnValue({ sync_coordinator_admin_secret: "synthetic-wrong-default" });
	mocks.readAtPath.mockImplementation((path) =>
		path === CONFIG
			? { sync_coordinator_admin_secret: "synthetic-selected-secret" }
			: { sync_coordinator_admin_secret: "synthetic-wrong-profile" },
	);
	mocks.createContext.mockReturnValue(mocks.context);
	mocks.createRegistry.mockReturnValue(registry);
	mocks.createRecovery.mockReturnValue(recovery);
	mocks.registryClose.mockResolvedValue();
	mocks.recoveryClose.mockResolvedValue();
	mocks.createApp.mockReturnValue({ fetch: vi.fn() });
	mocks.serve.mockImplementation(() => ({
		on: vi.fn(),
		close: mocks.listenerClose.mockImplementation((done: () => void) => done()),
	}));
	const on = process.on.bind(process);
	vi.spyOn(process, "on").mockImplementation((event, listener) => {
		if (event === "SIGINT" || event === "SIGTERM") signals.set(event, listener as () => void);
		else on(event, listener);
		return process;
	});
	vi.spyOn(process, "exit").mockImplementation(() => {
		finishExit();
		return undefined as never;
	});
	vi.spyOn(process, "kill").mockImplementation(() => {
		throw new Error("Unexpected process signal");
	});
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

it("composes recovery with the same trusted context reader and registry, exposing only the service capability", async () => {
	// Arrange
	const input = invocation();
	// Act
	await startForegroundViewer(input);
	// Assert
	const options = composed();
	expect(options.readContext).toBe(mocks.context);
	expect(options.registry).toBe(registry);
	expect(mocks.createRegistry).toHaveBeenCalledWith({ readContext: mocks.context });
	expect(mocks.createApp.mock.calls[0]?.[0].accountLink).toMatchObject({
		readContext: mocks.context,
		registry,
		ownerRecovery: recovery,
	});
	expect(options.readAdminSecret).toBeTypeOf("function");
	expect(options).not.toHaveProperty("adminSecret");
	expect(JSON.stringify(options)).not.toMatch(/synthetic-/);
	expect(JSON.stringify(mocks.createApp.mock.calls)).not.toContain("synthetic-selected-secret");
	expect(JSON.stringify(mocks.logs.mock.calls)).not.toMatch(/synthetic-.*secret/);
	await shutdown();
});

it("reads the current environment secret before the exact selected-config fallback", async () => {
	// Arrange
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "synthetic-env-first");
	await startForegroundViewer(invocation());
	const options = composed();
	// Act
	const first = options.readAdminSecret();
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", "synthetic-env-rotated");
	const rotated = options.readAdminSecret();
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", undefined);
	const fallback = options.readAdminSecret();
	// Assert
	expect(first).toBe("synthetic-env-first");
	expect(rotated).toBe("synthetic-env-rotated");
	expect(fallback).toBe("synthetic-selected-secret");
	expect(mocks.readAtPath).toHaveBeenLastCalledWith(CONFIG);
	expect(JSON.stringify(mocks.createApp.mock.calls)).not.toMatch(/synthetic-/);
	expect(JSON.stringify(mocks.logs.mock.calls)).not.toMatch(/synthetic-/);
	await shutdown();
});

it("captures the selected config path but rereads its current secret, never a changed global default", async () => {
	// Arrange
	await startForegroundViewer(invocation());
	const options = composed();
	vi.stubEnv("CODEMEM_CONFIG", join(HOME, "wrong-profile.json"));
	mocks.readAtPath.mockImplementation((path) =>
		path === CONFIG
			? { sync_coordinator_admin_secret: "synthetic-current-selected" }
			: { sync_coordinator_admin_secret: "synthetic-wrong-profile" },
	);
	// Act
	const secret = options.readAdminSecret();
	const context = mocks.createContext.mock.calls[0]?.[0];
	context?.readConfig();
	// Assert
	expect(secret).toBe("synthetic-current-selected");
	expect(context?.configPath).toBe(CONFIG);
	expect(mocks.readAtPath.mock.calls.every(([path]) => path === CONFIG)).toBe(true);
	expect(mocks.readDefault).not.toHaveBeenCalled();
	await shutdown();
});

it.each([undefined, ""])(
	"keeps missing selected credentials (%s) in request mode instead of using another profile",
	async (secret) => {
		// Arrange
		mocks.readAtPath.mockReturnValue({ sync_coordinator_admin_secret: secret });
		// Act
		await startForegroundViewer(invocation());
		const value = composed().readAdminSecret();
		// Assert
		expect(value == null || value === "").toBe(true);
		expect(mocks.readDefault).not.toHaveBeenCalled();
		expect(JSON.stringify(mocks.createApp.mock.calls)).not.toContain("synthetic-wrong-default");
		await shutdown();
	},
);

it.each(["SIGTERM", "SIGINT"])(
	"waits for recovery close before closing the registry, listener and store on %s",
	async (signal) => {
		// Arrange: a pending recovery close represents outstanding proof/publication work.
		let finish!: () => void;
		mocks.recoveryClose.mockReturnValue(
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
		);
		await startForegroundViewer(invocation());
		// Act
		const pending = shutdown(signal);
		// Assert
		try {
			expect(mocks.recoveryClose).toHaveBeenCalledOnce();
			expect(mocks.registryClose).not.toHaveBeenCalled();
			expect(mocks.listenerClose).not.toHaveBeenCalled();
			expect(mocks.closeStore).not.toHaveBeenCalled();
		} finally {
			finish();
			await pending;
		}
		expect(mocks.registryClose).toHaveBeenCalledOnce();
		expect(mocks.listenerClose).toHaveBeenCalledOnce();
		expect(mocks.closeStore).toHaveBeenCalledOnce();
	},
);
