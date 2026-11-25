import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as proof from "../../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import { generateDeviceKey } from "../../../cloudflare-coordinator-worker/test/device-rejoin-ceremony-fixture.js";
import { createCoordinatorApp } from "../../../core/src/coordinator-api.js";
import type { AuthLinkStatement } from "../../../core/src/coordinator-auth-link.js";
import { setupStore } from "../../../core/src/coordinator-auth-store-test-fixtures.js";
import { confirmationScope as scope } from "../../../core/src/coordinator-device-rejoin-confirmation-test-harness.js";
import { signedFinalize } from "../../../core/src/coordinator-device-rejoin-finalize-test-harness.js";
import { ed25519KeyId } from "../../../core/src/coordinator-ed25519-key-id.js";
import { readCoordinatorSyncConfig } from "../../../core/src/coordinator-sync-config.js";
import { connect } from "../../../core/src/db.js";
import { MemoryStore } from "../../../core/src/store.js";
import { verifySignature } from "../../../core/src/sync-auth.js";
import { createApp } from "../index.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});
const localPath = "/api/sync/devices/rejoin-events";

function localViewer() {
	const keysDir = mkdtempSync(join(tmpdir(), "codemem-rejoin-event-viewer-"));
	cleanups.push(() => rmSync(keysDir, { recursive: true, force: true }));
	const key = generateDeviceKey();
	writeFileSync(
		join(keysDir, "device.key"),
		key.privateKey.export({ format: "pem", type: "pkcs8" }),
		{
			mode: 0o600,
		},
	);
	vi.stubEnv("CODEMEM_KEYS_DIR", keysDir);
	vi.stubEnv("CODEMEM_DEVICE_ID", "");
	const dbPath = join(keysDir, "viewer.sqlite");
	const db = connect(dbPath);
	db.prepare("INSERT INTO sync_device VALUES ('observer', ?, ?, 'then')").run(
		key.publicKey,
		key.fingerprint,
	);
	db.close();
	const store = new MemoryStore(dbPath);
	cleanups.push(() => store.close());
	const config = readCoordinatorSyncConfig({
		sync_coordinator_url: scope.origin,
		sync_coordinator_groups: ["archived-extra", "group-a"],
	});
	const app = createApp({ storeFactory: () => store, readCoordinatorConfig: () => config });
	return { app, key, config };
}

async function coordinator(observer: ReturnType<typeof localViewer>["key"]) {
	const clock = vi.spyOn(Date, "now").mockReturnValue(scope.now);
	const { db, store } = setupStore("SQLite", { authClock: () => Date.now() });
	cleanups.push(() => db.close());
	vi.spyOn(store, "close").mockResolvedValue(undefined);
	const browserConfig = {
		enabled: true,
		coordinatorId: scope.coordinatorId,
		issuer: scope.issuer,
		revision: scope.authConfigRevision,
		redirectUri: scope.redirectUri,
	};
	const api = createCoordinatorApp({
		storeFactory: () => store,
		runtime: { adminSecret: () => null, now: () => new Date(Date.now()).toISOString() },
		requestVerifier: (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		browserAuth: {
			kind: "ready",
			auth: { storeConfig: browserConfig, register: () => {} },
			storeFactory: () => store,
			clientKey: () => "fixture-address",
		},
	});
	const finalize = await signedFinalize({
		proof,
		first: async <T>({ sql, values }: AuthLinkStatement) =>
			(db.prepare(sql).get(...values) as T | undefined) ?? null,
		run: async (sql, ...values) => db.prepare(sql).run(...values),
		changed: async ({ sql, values }) => db.prepare(sql).run(...values).changes,
	});
	await store.enrollDevice("group-a", { deviceId: "observer", ...observer });
	const finalized = await api.request(
		`${scope.origin}/v1/auth/rejoin-attempts/${scope.attemptId}/finalize`,
		{
			method: "POST",
			body: JSON.stringify({
				device_id: finalize.deviceId,
				completion: finalize.completion,
				signature: finalize.signature,
			}),
		},
	);
	expect(finalized.status).toBe(200);
	clock.mockReturnValue(scope.now + 8 * 86_400_000);
	return { api, db };
}

it("reads a missed rejoin through mounted Viewer and signed coordinator routes and resumes at the shown cursor", async () => {
	const f = localViewer();
	const remote = await coordinator(f.key);
	const paths: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const url = new URL(String(input));
			expect(url.origin).toBe(scope.origin);
			expect(new Headers(init?.headers).has("x-codemem-coordinator-admin")).toBe(false);
			paths.push(url.search);
			return remote.api.request(url.href, init);
		}),
	);
	const unbound = await f.app.request(localPath);
	expect(unbound.status).toBe(200);
	expect(await unbound.json()).toMatchObject({ items: [], nextCursor: null });
	expect(paths).toEqual(["?group_id=archived-extra", "?group_id=group-a"]);
	remote.db
		.prepare(`INSERT INTO coordinator_device_ownership_bindings
			(device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
			VALUES ('observer',?,'identity-a',?,'viewer-binding','owner_enrollment','fixture','then')`)
		.run(await ed25519KeyId(f.key.publicKey), scope.coordinatorId);
	const response = await f.app.request(localPath);
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	const page = await response.json<{ scope: string; nextCursor: string }>();
	expect(page).toMatchObject({
		localDeviceId: "observer",
		nextCursor: scope.attemptId,
		items: [
			{
				eventId: scope.attemptId,
				deviceId: "removed",
				groupIds: ["group-a"],
				finalizedAtMs: scope.now,
			},
		],
	});
	const resumed = await f.app.request(`${localPath}?scope=${page.scope}&after=${page.nextCursor}`);
	expect(await resumed.json()).toEqual({
		scope: page.scope,
		localDeviceId: "observer",
		items: [],
		nextCursor: scope.attemptId,
	});
	expect(paths.at(-1)).toBe(`?group_id=group-a&after=${scope.attemptId}`);
	const otherProfile = await f.app.request(`${localPath}?scope=${"a".repeat(64)}&after=foreign`);
	expect(await otherProfile.json()).toEqual(page);
	expect(paths.at(-1)).toBe("?group_id=group-a");
	expect((await f.app.request(`${localPath}?group_id=unsafe`)).status).toBe(400);
});

it("does not forward a continuation or publish a page after the Viewer profile changes", async () => {
	const f = localViewer();
	const fetch = vi.fn<typeof globalThis.fetch>(async () => {
		f.config.syncCoordinatorUrl = "https://other.example.test";
		return new Response(null, { status: 403 });
	});
	vi.stubGlobal("fetch", fetch);
	const response = await f.app.request(localPath);
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: "events_unavailable" });
	expect(fetch).toHaveBeenCalledOnce();
});
