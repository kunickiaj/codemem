import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildAuthHeaders,
	type CoordinatorAccountLinkStatusRead,
	connect,
	ensureDeviceIdentity,
	initTestSchema,
	loadPublicKey,
	MemoryStore,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadMemoriesPage } from "../../ui/src/lib/api/memories.js";
import { createAccountLinkRegistry } from "./account/link-registry.js";
import { createApp, createSyncApp } from "./index.js";

// Complements the UI/real-HTTP synthetic E2E: exercise actual application mounting,
// persistent memory writes/reads, and device-signed direct-sync routes together.
// No Google identity, coordinator request, default profile, or network is needed.
const ORIGIN = "http://127.0.0.1:7441";
const blockedStates = ["review_required", "conflict", "revoked", "unavailable"] as const;
type BlockedState = (typeof blockedStates)[number];
const closeResources: (() => void | Promise<void>)[] = [];

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.stubEnv("CODEMEM_DEVICE_ID", "");
	vi.stubEnv("CODEMEM_ACTOR_ID", "");
	vi.stubEnv("CODEMEM_ACTOR_DISPLAY_NAME", "Synthetic actor");
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	// The UI read client needs browser deadline timers, not a DOM or fake API.
	vi.stubGlobal("window", {
		setTimeout: globalThis.setTimeout,
		clearTimeout: globalThis.clearTimeout,
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected external network request");
		}),
	);
});
afterEach(async () => {
	try {
		for (const close of closeResources.splice(0).reverse()) await close();
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		vi.useRealTimers();
	}
});

function createStore() {
	// Fresh test-owned SQLite/key files only. Do not delete directories or inspect
	// existing profiles; the host's temporary-directory lifecycle owns these files.
	const directory = mkdtempSync(join(tmpdir(), "codemem-account-optional-test-"));
	const dbPath = join(directory, "memory.sqlite");
	const keysDir = join(directory, "keys");
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "absent-synthetic-config.json"));
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	const db = connect(dbPath);
	initTestSchema(db);
	const [deviceId] = ensureDeviceIdentity(db, { keysDir });
	db.close();
	const store = new MemoryStore(dbPath, { keysDir });
	closeResources.push(() => store.close());
	return { store, dbPath, keysDir, deviceId };
}

function createPeer(store: MemoryStore) {
	// Same pinned device-key fixture as createAuthenticatedSyncPeer in index.test.ts.
	const directory = mkdtempSync(join(tmpdir(), "codemem-account-optional-peer-"));
	const keysDir = join(directory, "keys");
	const db = connect(join(directory, "peer.sqlite"));
	closeResources.push(() => db.close());
	initTestSchema(db);
	const [deviceId] = ensureDeviceIdentity(db, { keysDir });
	const publicKey = loadPublicKey(keysDir);
	const row = db.prepare("SELECT fingerprint FROM sync_device LIMIT 1").get() as {
		fingerprint: string;
	};
	if (!publicKey || !row?.fingerprint) throw new Error("Missing synthetic peer identity");
	store.db
		.prepare(`INSERT INTO sync_peers(peer_device_id, pinned_fingerprint, public_key, created_at)
		VALUES (?, ?, ?, ?)`)
		.run(deviceId, row.fingerprint, publicKey, new Date().toISOString());
	return {
		deviceId,
		headers(url: string) {
			return buildAuthHeaders({
				deviceId,
				method: "GET",
				url,
				bodyBytes: Buffer.alloc(0),
				keysDir,
			});
		},
	};
}

function fixture(state: BlockedState) {
	const { store, dbPath, keysDir, deviceId } = createStore();
	const fingerprint = (
		store.db.prepare("SELECT fingerprint FROM sync_device LIMIT 1").get() as { fingerprint: string }
	).fingerprint;
	const context = {
		contextId: "synthetic-context",
		groupId: "synthetic-group",
		deviceId,
		fingerprint,
		identityId: store.actorId,
		dbPath,
		keysDir,
		coordinatorUrl: "https://coordinator.example.test",
		fileIdentity: { dev: "1", ino: "2" },
	};
	const readContext = vi.fn(() => ({
		setup: "ready" as const,
		groups: [context.groupId],
		selectedGroupId: context.groupId,
		coordinator: { origin: context.coordinatorUrl },
		context,
	}));
	const readRemoteStatus = vi.fn(async (): Promise<CoordinatorAccountLinkStatusRead> => {
		if (state === "unavailable") return { kind: "unavailable", code: "coordinator_unreachable" };
		return {
			kind: "status",
			status: {
				version: 1,
				coordinatorId: "synthetic-coordinator",
				groupId: context.groupId,
				deviceId,
				fingerprint,
				identityId: store.actorId,
				state,
				account: null,
			},
		};
	});
	const link = vi.fn(async () => {
		throw new Error("Blocked account must not start linking");
	});
	const registry = createAccountLinkRegistry({ readContext, link });
	closeResources.push(() => registry.close());
	const app = createApp({
		storeFactory: () => store,
		accountLink: {
			getListenerAddress: () => ({ host: "127.0.0.1", port: 7441 }),
			readContext,
			readRemoteStatus,
			registry,
		},
	});
	const syncApp = createSyncApp({ storeFactory: () => store });
	return { app, syncApp, store, context, readContext, readRemoteStatus, link };
}

async function accountHeaders(app: ReturnType<typeof createApp>) {
	const session = await app.request(`${ORIGIN}/api/account/session`, {
		headers: { Host: "127.0.0.1:7441", Origin: ORIGIN },
	});
	expect(session.status).toBe(200);
	const { csrfToken } = await session.json();
	return {
		Host: "127.0.0.1:7441",
		Origin: ORIGIN,
		"X-Codemem-Account-Csrf": csrfToken,
		"Content-Type": "application/json",
	};
}

describe("Google account state never gates unrelated application routes", () => {
	it.each(blockedStates)(
		"keeps real memory capture and UI reads usable while account is %s",
		async (state) => {
			// Arrange: mount the full production app and confirm its account routes are blocked.
			const f = fixture(state);
			const shell = await f.app.request("/");
			expect(shell.status).toBe(200);
			expect(shell.headers.get("content-type")).toContain("text/html");
			const headers = await accountHeaders(f.app);
			const status = await f.app.request(`${ORIGIN}/api/account/link-status`, { headers });
			expect(status.status).toBe(200);
			expect(await status.json()).toMatchObject({
				canLink: false,
				remote: state === "unavailable" ? { kind: "unavailable" } : { kind: "status", state },
			});
			const denied = await f.app.request(`${ORIGIN}/api/account/link-operations`, {
				method: "POST",
				headers,
				body: JSON.stringify({ groupId: f.context.groupId, contextId: f.context.contextId }),
			});
			expect(denied.status).toBe(state === "unavailable" ? 503 : 409);
			const accountReads = f.readRemoteStatus.mock.calls.length;
			const profileReads = f.readContext.mock.calls.length;
			// Act: normal capture requires neither an account token nor an account cookie.
			const saved = await f.app.request("/api/memories/remember", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					kind: "decision",
					title: "Synthetic capture",
					body: "Account-independent memory",
					project: "synthetic-project",
				}),
			});
			expect(saved.status, await saved.clone().text()).toBe(200);
			const { id } = await saved.json();
			vi.mocked(fetch).mockImplementation(async (input, init) => {
				if (typeof input !== "string" || !input.startsWith("/api/observations?"))
					throw new Error("Unexpected network request");
				return f.app.request(input, init);
			});
			const page = await loadMemoriesPage("synthetic-project");
			const unrelatedProject = await loadMemoriesPage("absent-synthetic-project");
			const invalid = await f.app.request("/api/memories/remember", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "decision", title: "", body: "Invalid capture" }),
			});
			// Assert: actual stored content is returned through the production UI API client.
			expect(page.items).toEqual(
				expect.arrayContaining([expect.objectContaining({ id, title: "Synthetic capture" })]),
			);
			expect(unrelatedProject.items).toEqual([]);
			expect(f.store.db.prepare("SELECT body_text FROM memory_items WHERE id = ?").get(id)).toEqual(
				{ body_text: "Account-independent memory" },
			);
			expect(invalid.status).toBe(400);
			expect(await invalid.json()).toEqual({ error: "title is required" });
			expect(f.store.db.prepare("SELECT COUNT(*) AS count FROM memory_items").get()).toEqual({
				count: 1,
			});
			expect(f.readRemoteStatus).toHaveBeenCalledTimes(accountReads);
			expect(f.readContext).toHaveBeenCalledTimes(profileReads);
			expect(f.link).not.toHaveBeenCalled();
		},
	);

	it.each(blockedStates)(
		"serves signed direct-sync protocol without Google while account is %s",
		async (state) => {
			// Arrange: real app + real store + real pinned peer keys, no Google account.
			const f = fixture(state);
			const headers = await accountHeaders(f.app);
			const blocked = await f.app.request(`${ORIGIN}/api/account/link-status`, { headers });
			expect(await blocked.json()).toMatchObject({ canLink: false });
			const peer = createPeer(f.store);
			const accountReads = f.readRemoteStatus.mock.calls.length;
			// Act: discover the current reset boundary through the real signed protocol.
			const statusUrl = "http://localhost/v1/status";
			const signedStatus = await f.syncApp.request(statusUrl, { headers: peer.headers(statusUrl) });
			expect(signedStatus.status).toBe(200);
			const peerStatus = await signedStatus.json();
			const query = new URLSearchParams({
				limit: "50",
				since: "",
				generation: String(peerStatus.sync_reset.generation),
				snapshot_id: peerStatus.sync_reset.snapshot_id,
			});
			if (peerStatus.sync_reset.baseline_cursor)
				query.set("baseline_cursor", peerStatus.sync_reset.baseline_cursor);
			const url = `http://localhost/v1/ops?${query}`;
			const unsigned = await f.syncApp.request(url);
			const signed = await f.syncApp.request(url, { headers: peer.headers(url) });
			const malformed = await f.syncApp.request(url, {
				headers: { ...peer.headers(url), "X-Opencode-Signature": "invalid" },
			});
			// Assert: actual sync protocol handlers accept device auth, not account credentials.
			expect(unsigned.status).toBe(401);
			expect(signed.status, await signed.clone().text()).toBe(200);
			expect(await signed.json()).toMatchObject({ reset_required: false, ops: expect.any(Array) });
			expect(signedStatus.status).toBe(200);
			expect(peerStatus).toHaveProperty("runtime_version");
			expect(malformed.status).toBe(401);
			expect(f.readRemoteStatus).toHaveBeenCalledTimes(accountReads);
			expect(f.link).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		},
	);
});
