import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import { coordinatorImportInviteAction } from "../../../core/src/coordinator-actions.js";
import { createCoordinatorApp } from "../../../core/src/coordinator-api.js";
import { setupStore } from "../../../core/src/coordinator-auth-store-test-fixtures.js";
import {
	LIFT_NOW,
	liftTables,
} from "../../../core/src/coordinator-invitation-lift-test-harness.js";
import { encodeInvitePayload } from "../../../core/src/coordinator-invites.js";
import { projectInvite } from "../../../core/src/coordinator-project-revocation-test-harness.js";
import { readCoordinatorSyncConfig } from "../../../core/src/coordinator-sync-config.js";
import { connect } from "../../../core/src/db.js";
import { verifiedLocalKeyId } from "../../../core/src/device-retirement.js";
import { initDatabase } from "../../../core/src/maintenance/init-vacuum.js";
import { ensureMemoryRetirementDeliverySchema } from "../../../core/src/memory-retirement-delivery-schema.js";
import { ensurePeerRemovalCheckState } from "../../../core/src/peer-removal-check-state.js";
import { verifySignature } from "../../../core/src/sync-auth.js";
import { ensureDeviceIdentity, loadPublicKey } from "../../../core/src/sync-identity.js";
import { confirmAndBlockRemovedDevice } from "../../../ui/src/tabs/device-block-confirmation";
import { confirmAndCommitDeviceRemoval } from "../../../ui/src/tabs/device-removal-confirmation";
import { deviceRemovalCommitRoutes } from "./device-removal-commit.js";
import { deviceRemovalReviewRoutes } from "./device-removal-review.js";

vi.mock("../../../ui/src/tabs/sync/sync-dialogs", () => ({
	openSyncConfirmDialog: () => {
		throw new Error("Synthetic confirmation must be explicit");
	},
}));

const coordinatorOrigin = "https://coordinator.example.test";
const viewerOrigin = "http://localhost:7337";
const adminSecret = "synthetic-project-client-admin";
const groupId = "project-client-group";
const cleanups: (() => void)[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function localIdentity(directory: string, name: string) {
	const dbPath = join(directory, `${name}.sqlite`);
	const keysDir = join(directory, `${name}-keys`);
	initDatabase(dbPath);
	const db = connect(dbPath);
	cleanups.push(() => db.close());
	const [deviceId, fingerprint] = ensureDeviceIdentity(db, { keysDir });
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new Error("Fixture public key missing");
	return { dbPath, keysDir, db, deviceId, fingerprint, publicKey };
}

async function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "codemem-project-client-lifecycle-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.spyOn(Date, "now").mockReturnValue(Date.parse(LIFT_NOW));
	const configPath = join(directory, "client-config.json");
	writeFileSync(configPath, "{}\n");
	vi.stubEnv("CODEMEM_CONFIG", configPath);
	const client = localIdentity(directory, "client");
	const viewerLocal = localIdentity(directory, "viewer");
	ensureMemoryRetirementDeliverySchema(viewerLocal.db);
	ensurePeerRemovalCheckState(viewerLocal.db);
	viewerLocal.db
		.prepare(`INSERT INTO sync_peers
			(peer_device_id, public_key, pinned_fingerprint, created_at) VALUES (?, ?, ?, ?)`)
		.run(client.deviceId, client.publicKey, client.fingerprint, LIFT_NOW);
	viewerLocal.db
		.prepare(`INSERT INTO replication_cursors
			(peer_device_id, last_applied_cursor, updated_at) VALUES (?, 'fixture-cursor', ?)`)
		.run(client.deviceId, LIFT_NOW);
	const { store, db } = setupStore("SQLite", { authClock: () => Date.parse(LIFT_NOW) });
	cleanups.push(() => db.close());
	vi.spyOn(store, "close").mockResolvedValue();
	await store.createGroup(groupId);
	await store.enrollDevice(groupId, client);
	const verifier = vi.fn((input: Parameters<typeof verifySignature>[0]) => verifySignature(input));
	const coordinator = createCoordinatorApp({
		storeFactory: () => store,
		runtime: { adminSecret: () => adminSecret, now: () => LIFT_NOW },
		requestVerifier: (input) => verifier({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		deviceRevocation: { coordinatorId: "synthetic-project-client-coordinator" },
	});
	const config = {
		...readCoordinatorSyncConfig({}),
		syncCoordinatorUrl: coordinatorOrigin,
		syncCoordinatorAdminSecret: adminSecret,
	};
	const readCoordinatorConfig = () => config;
	const refresh = vi.fn(async () => {});
	const viewer = new Hono()
		.route(
			"/",
			deviceRemovalReviewRoutes({
				readCoordinatorConfig,
				localIdentity: () => ({
					deviceId: viewerLocal.deviceId,
					keyId: verifiedLocalKeyId(viewerLocal.db, viewerLocal.deviceId),
				}),
			}),
		)
		.route(
			"/",
			deviceRemovalCommitRoutes({
				readCoordinatorConfig,
				getStore: () => viewerLocal,
				createDeviceRemovalRefreshHooks: () => ({
					waitForRefresh: async () => {},
					refresh,
				}),
			}),
		);
	const { joins, browserPaths } = installTransport(coordinator, viewer);
	const post = (path: string, body: unknown) =>
		coordinator.request(path, {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-Codemem-Coordinator-Admin": adminSecret },
			body: JSON.stringify(body),
		});
	const snapshot = () =>
		liftTables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
	const issue = (operationId: string) => issueProject({ store, db, client }, operationId);
	const importInvite = (inviteValue: string) =>
		coordinatorImportInviteAction({
			inviteValue,
			dbPath: client.dbPath,
			keysDir: client.keysDir,
			configPath,
			recipientActorId: "recipient-identity",
			recipientDisplayName: "Recipient",
			deviceDisplayName: "Travel laptop",
		});
	const target = { deviceId: client.deviceId, displayName: "Travel laptop" };
	const remove = (approved = true) =>
		confirmAndCommitDeviceRemoval(target, { confirm: async () => approved });
	return {
		client,
		viewerLocal,
		db,
		store,
		post,
		issue,
		importInvite,
		remove,
		snapshot,
		joins,
		verifier,
		browserPaths,
		refresh,
		configPath,
		target,
	};
}

async function issueProject(
	f: {
		store: ReturnType<typeof setupStore>["store"];
		db: ReturnType<typeof connect>;
		client: ReturnType<typeof localIdentity>;
	},
	operationId: string,
) {
	const { invite } = await projectInvite(
		{
			store: f.store,
			input: { ...f.client, groupId, actorId: "synthetic-operator" },
			exec: async (sql, ...values) => {
				f.db.prepare(sql).run(...values);
			},
			rows: async (table) => {
				if (!liftTables.includes(table)) throw new Error("Unknown fixture table");
				return f.db.prepare(`SELECT * FROM ${table}`).all();
			},
		},
		operationId,
	);
	return {
		invite,
		value: encodeInvitePayload({
			v: 1,
			kind: "coordinator_team_invite",
			coordinator_url: coordinatorOrigin,
			group_id: groupId,
			policy: "auto_admit",
			token: invite.token,
			expires_at: invite.expires_at,
			operation_id: operationId,
		}),
	};
}

function installTransport(coordinator: ReturnType<typeof createCoordinatorApp>, viewer: Hono) {
	const joins: { status: number; body: unknown; signature: string | null }[] = [];
	const browserPaths: string[] = [];
	// No fallback to native fetch: every HTTP request stays inside these two Hono apps.
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input), viewerOrigin);
			const request = new Request(url, init);
			if (url.origin === viewerOrigin) {
				expect(url.pathname).toMatch(/^\/api\/sync\/devices\/[^/]+\/remove(?:\/preview)?$/u);
				browserPaths.push(url.pathname);
				return viewer.request(request);
			}
			expect(url.origin).toBe(coordinatorOrigin);
			expect(url.pathname).toMatch(
				/^\/v1\/(?:join|admin\/(?:groups|devices)(?:\/removal-preview|\/removal)?)$/u,
			);
			const response = await coordinator.request(request);
			if (url.pathname === "/v1/join") {
				joins.push({
					status: response.status,
					body: await response.clone().json(),
					signature: request.headers.get("X-Opencode-Signature"),
				});
			}
			return response;
		}),
	);
	vi.stubGlobal("window", { setTimeout, clearTimeout });
	return { joins, browserPaths };
}

it("imports a fresh Project through the real signed client after Viewer Remove, then refuses it after permanent Block", async () => {
	// Arrange: the client retains its actual identity, key files, and local database across removal.
	const f = await fixture();
	const stale = await f.issue(`share_${"a".repeat(40)}`);

	// Act: use the actual Viewer confirmation and review/commit routes.
	const removed = await f.remove();
	const beforeStale = f.snapshot();
	const staleImport = f.importInvite(stale.value);

	// Assert: a pre-removal invitation cannot restore admission or consume retained authority.
	expect(removed).toMatchObject({ state: "removed", local_cleanup: "applied" });
	await expect(staleImport).rejects.toThrow("Invite import failed (403).");
	expect(f.joins.at(-1)).toMatchObject({ status: 403, body: { error: "device_removed" } });
	expect(f.snapshot()).toEqual(beforeStale);
	expect(f.viewerLocal.db.prepare("SELECT * FROM sync_peers").all()).toEqual([]);
	expect(f.viewerLocal.db.prepare("SELECT * FROM replication_cursors").all()).toEqual([]);

	// Arrange: issue fresh authority after the removal high-water mark.
	const fresh = await f.issue(`share_${"b".repeat(40)}`);
	// Act
	const imported = await f.importInvite(fresh.value);
	// Assert: real signature verification, coordinator enrollment, and client persistence all succeeded.
	expect(imported).toMatchObject({ setup_state: "pending_inviter", sync_enabled: true });
	expect(f.joins.at(-1)).toMatchObject({ status: 200, body: { ok: true, group_id: groupId } });
	expect(await f.store.getEnrollment(groupId, f.client.deviceId)).not.toBeNull();
	expect(f.db.prepare("SELECT lifted_by_invite_id FROM coordinator_device_removals").all()).toEqual(
		[{ lifted_by_invite_id: fresh.invite.invite_id }],
	);
	expect(f.client.db.prepare("SELECT public_key FROM sync_device").pluck().get()).toBe(
		f.client.publicKey,
	);
	expect(
		f.client.db.prepare("SELECT pending_bootstrap_grant_id FROM sync_peers").pluck().get(),
	).toEqual(expect.any(String));
	expect(JSON.parse(readFileSync(f.configPath, "utf8"))).toMatchObject({
		sync_enabled: true,
		sync_coordinator_url: coordinatorOrigin,
	});

	// Arrange: remove again, issue a fresh invitation, then review permanent Block separately.
	expect(await f.remove()).toMatchObject({ state: "removed" });
	const blockedInvite = await f.issue(`share_${"c".repeat(40)}`);
	const blocked = await confirmAndBlockRemovedDevice(
		{ ...f.target, groupId },
		{
			preview: async () => {
				const response = await f.post("/v1/admin/devices/revoke-preview", {
					group_id: groupId,
					device_id: f.client.deviceId,
				});
				expect(response.status).toBe(200);
				return response.json();
			},
			confirm: async () => true,
			commit: async (preview) => {
				const response = await f.post("/v1/admin/devices/revoke", {
					group_id: groupId,
					device_id: f.client.deviceId,
					expected_digest: preview.expected_digest,
				});
				expect(response.status).toBe(200);
				return response.json();
			},
		},
	);
	const beforeBlocked = f.snapshot();
	const configBeforeBlocked = readFileSync(f.configPath, "utf8");
	// Act
	const blockedImport = f.importInvite(blockedInvite.value);
	// Assert: even a fresh, correctly signed client import cannot undo permanent Block.
	expect(blocked).toMatchObject({ state: "revoked" });
	await expect(blockedImport).rejects.toThrow("Invite import failed (403).");
	expect(f.joins.at(-1)).toMatchObject({ status: 403, body: { error: "device_revoked" } });
	expect(f.snapshot()).toEqual(beforeBlocked);
	expect(readFileSync(f.configPath, "utf8")).toBe(configBeforeBlocked);
	expect(await f.store.getEnrollment(groupId, f.client.deviceId, true)).toBeNull();
	expect(f.joins).toHaveLength(3);
	for (const join of f.joins) expect(join.signature).toMatch(/^v2:/u);
	expect(f.verifier).toHaveBeenCalledTimes(3);
	for (const result of f.verifier.mock.results) expect(await result.value).toBe(true);
	expect(f.refresh).toHaveBeenCalledTimes(2);
	expect(f.browserPaths).toEqual([
		`/api/sync/devices/${f.client.deviceId}/remove/preview`,
		`/api/sync/devices/${f.client.deviceId}/remove`,
		`/api/sync/devices/${f.client.deviceId}/remove/preview`,
		`/api/sync/devices/${f.client.deviceId}/remove`,
	]);
});

it("canceling the actual Viewer removal confirmation preserves enrollment and the local pairing", async () => {
	// Arrange
	const f = await fixture();
	const before = f.snapshot();
	const paired = f.viewerLocal.db.prepare("SELECT * FROM sync_peers").all();
	// Act
	const result = await f.remove(false);
	// Assert
	expect(result).toBeNull();
	expect(f.snapshot()).toEqual(before);
	expect(f.viewerLocal.db.prepare("SELECT * FROM sync_peers").all()).toEqual(paired);
	expect(f.browserPaths).toEqual([`/api/sync/devices/${f.client.deviceId}/remove/preview`]);
	expect(f.refresh).not.toHaveBeenCalled();
	expect(f.joins).toEqual([]);
});
