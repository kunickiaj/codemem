import * as core from "@codemem/core";
import {
	createRelayPeerClient,
	type RelayPeerClient,
	type SyncPeerReachabilityResolver,
	type SyncReachabilityOptions,
} from "@codemem/core/internal/relay-runtime";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";

vi.mock("@codemem/core", async (importOriginal) => ({
	...(await importOriginal<typeof import("@codemem/core")>()),
	readCoordinatorSyncConfig: vi.fn(() => ({ syncEnabled: true })),
	runSyncPass: vi.fn(),
}));

vi.mock("@codemem/core/internal/relay-runtime", async (importOriginal) => ({
	...(await importOriginal<typeof import("@codemem/core/internal/relay-runtime")>()),
	createRelayPeerClient: vi.fn(() => {
		throw new Error("Manual sync must reuse the existing relay client");
	}),
}));

// Supply static HTML without requiring a UI build or writing fixture files.
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const isFixture = (path: unknown) => String(path) === "/manual-sync-test-assets/index.html";
	return {
		...fs,
		existsSync: (path: Parameters<typeof fs.existsSync>[0]) =>
			isFixture(path) || fs.existsSync(path),
		readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
			if (isFixture(args[0])) return "<!doctype html><title>Manual sync test</title>";
			return fs.readFileSync(...args);
		},
	};
});

const result = { ok: true, opsIn: 2, opsOut: 1, addressErrors: [] };
const runSyncPass = vi.mocked(core.runSyncPass);
let db: Database.Database;

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("CODEMEM_VIEWER_STATIC_DIR", "/manual-sync-test-assets");
	vi.stubEnv("CODEMEM_KEYS_DIR", "/manual-sync-test-keys");
	db = new Database(":memory:");
	core.initTestSchema(db);
	db.prepare(
		"INSERT INTO sync_peers(peer_device_id, name, pinned_fingerprint, addresses_json, created_at) VALUES (?, ?, ?, ?, ?)",
	).run("peer-a", "Peer A", "synthetic-fingerprint", '["https://peer-a.invalid"]', "2026-01-01");
	runSyncPass.mockResolvedValue(result);
});

afterEach(() => {
	db.close();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function fixture(syncReachability?: SyncPeerReachabilityResolver) {
	const scanner = { scan: vi.fn() };
	const store = { db, dbPath: "manual-sync.sqlite", scanner } as unknown as core.MemoryStore;
	const app = createApp({ storeFactory: () => store, syncReachability });
	// Hono's default error handler would print the synthetic resolver exception.
	app.onError(() => new Response("request_failed", { status: 500 }));
	return {
		store,
		run: (body: object = {}) =>
			app.request("/api/sync/run", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
	};
}

function resolver(route?: SyncReachabilityOptions, signal?: AbortSignal) {
	return { forPeer: vi.fn(() => route), clients: vi.fn(() => []), signal };
}

function passRoute(index = 0) {
	return runSyncPass.mock.calls[index]?.[2]?.reachability;
}

describe("manual sync reachability", () => {
	it("threads the app's per-peer route into the pass and reuses its relay client", async () => {
		// Arrange: this client already belongs to the running viewer.
		const relay = { connect: vi.fn(), close: vi.fn() } as unknown as RelayPeerClient;
		const route = { scopeId: "space-a", logicalOrigin: "https://relay.invalid", relay };
		const routes = resolver(route);
		const f = fixture(routes);

		// Act.
		const response = await f.run({ peer_device_id: "peer-a" });

		// Assert: app -> routes -> pass preserves the authorized route and signing context.
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			items: [{ peer_device_id: "peer-a", ...result, skipped_out: null }],
		});
		expect(routes.forPeer).toHaveBeenCalledExactlyOnceWith(db, "peer-a");
		expect(runSyncPass).toHaveBeenCalledExactlyOnceWith(db, "peer-a", {
			keysDir: "/manual-sync-test-keys",
			dbPath: f.store.dbPath,
			scanner: f.store.scanner,
			reachability: { ...route, deadlineMs: undefined, signal: undefined },
		});
		expect(passRoute()?.relay).toBe(relay);
		expect(routes.clients).not.toHaveBeenCalled();
		expect(createRelayPeerClient).not.toHaveBeenCalled();
		expect(relay.connect).not.toHaveBeenCalled();
		expect(relay.close).not.toHaveBeenCalled();
	});

	it("resolves each peer separately and leaves an unavailable route direct-only", async () => {
		// Arrange.
		db.prepare("INSERT INTO sync_peers(peer_device_id, created_at) VALUES (?, ?)").run(
			"peer-b",
			"2026-01-01",
		);
		const route = { scopeId: "space-a", logicalOrigin: "https://relay.invalid" };
		const routes = resolver(route);
		routes.forPeer.mockImplementation((_db?: core.Database, peerId?: string) =>
			peerId === "peer-a" ? route : undefined,
		);
		const f = fixture(routes);

		// Act.
		const response = await f.run();

		// Assert: a previous peer's route must never carry over.
		expect(response.status).toBe(200);
		expect(routes.forPeer.mock.calls).toEqual([
			[db, "peer-a"],
			[db, "peer-b"],
		]);
		expect(passRoute()).toMatchObject(route);
		expect(runSyncPass.mock.calls[1]).toEqual([
			db,
			"peer-b",
			expect.objectContaining({ reachability: undefined }),
		]);
	});

	it("runs direct-only when the viewer has no resolver", async () => {
		// Arrange.
		const f = fixture();

		// Act.
		const response = await f.run();

		// Assert.
		expect(response.status).toBe(200);
		expect(runSyncPass).toHaveBeenCalledOnce();
		expect(passRoute()).toBeUndefined();
		expect(createRelayPeerClient).not.toHaveBeenCalled();
	});

	it("clears an old absolute deadline on every manual retry without mutating the route", async () => {
		// Arrange: expired one-shot deadlines must not disable a new manual pass.
		const route = Object.freeze({
			scopeId: "space-a",
			logicalOrigin: "https://relay.invalid",
			deadlineMs: -1,
		});
		const routes = resolver(route);
		const f = fixture(routes);

		// Act.
		const first = await f.run();
		const second = await f.run();

		// Assert.
		expect([first.status, second.status]).toEqual([200, 200]);
		expect(routes.forPeer).toHaveBeenCalledTimes(2);
		expect(passRoute()?.deadlineMs).toBeUndefined();
		expect(passRoute(1)?.deadlineMs).toBeUndefined();
		expect(passRoute(1)).not.toBe(passRoute());
		expect(route.deadlineMs).toBe(-1);
	});
});

describe("manual sync cancellation", () => {
	it.each(["resolver", "route"] as const)(
		"cancels a combined pass when the %s signal aborts",
		async (source) => {
			// Arrange.
			const owner = new AbortController();
			const peer = new AbortController();
			const route = {
				scopeId: "space-a",
				logicalOrigin: "https://relay.invalid",
				signal: peer.signal,
			};
			const f = fixture(resolver(route, owner.signal));

			// Act.
			const response = await f.run();
			const signal = passRoute()?.signal;
			const activeBeforeAbort = signal?.aborted === false;
			const reason = new Error(`${source} cancelled`);
			const controller = source === "resolver" ? owner : peer;
			controller.abort(reason);

			// Assert: either lifecycle cancels the pass, without aborting the other owner.
			expect(response.status).toBe(200);
			expect(activeBeforeAbort).toBe(true);
			expect(signal?.aborted).toBe(true);
			expect(signal?.reason).toBe(reason);
			expect(source === "resolver" ? peer.signal.aborted : owner.signal.aborted).toBe(false);
		},
	);

	it.each(["resolver", "route"] as const)(
		"preserves cancellation when only the %s signal exists and is already aborted",
		async (source) => {
			// Arrange.
			const controller = new AbortController();
			controller.abort("already-cancelled");
			const route = {
				scopeId: "space-a",
				logicalOrigin: "https://relay.invalid",
				signal: source === "route" ? controller.signal : undefined,
			};
			const f = fixture(resolver(route, source === "resolver" ? controller.signal : undefined));

			// Act.
			const response = await f.run();

			// Assert.
			expect(response.status).toBe(200);
			expect(passRoute()?.signal?.aborted).toBe(true);
			expect(passRoute()?.signal?.reason).toBe("already-cancelled");
		},
	);
});

describe("manual sync resolver failures", () => {
	it("does not resolve or run a pass for an unknown requested peer", async () => {
		// Arrange.
		const routes = resolver();
		const f = fixture(routes);

		// Act.
		const response = await f.run({ peer_device_id: "unknown-peer" });

		// Assert.
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ items: [] });
		expect(routes.forPeer).not.toHaveBeenCalled();
		expect(runSyncPass).not.toHaveBeenCalled();
	});

	it("falls back to direct sync when route resolution throws, matching daemon ticks", async () => {
		// Arrange: a local relay resolver failure must not prevent direct sync.
		vi.spyOn(console, "error").mockImplementation(() => {});
		const routes = resolver();
		routes.forPeer.mockImplementation(() => {
			throw new Error("synthetic route unavailable");
		});
		const f = fixture(routes);

		// Act.
		const response = await f.run({ peer_device_id: "peer-a" });

		// Assert: same fallback contract as sync-daemon.ts resolvePeerRoute.
		expect(response.status).toBe(200);
		expect(runSyncPass).toHaveBeenCalledExactlyOnceWith(
			db,
			"peer-a",
			expect.objectContaining({ reachability: undefined }),
		);
	});
});
