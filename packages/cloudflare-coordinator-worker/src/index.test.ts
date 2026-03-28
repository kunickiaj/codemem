import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectCoordinator } from "../../core/src/better-sqlite-coordinator-store.js";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "../../core/src/d1-coordinator-store.js";
import { connect } from "../../core/src/db.js";
import { buildAuthHeaders } from "../../core/src/sync-auth.js";
import { ensureDeviceIdentity, loadPublicKey } from "../../core/src/sync-identity.js";
import { initTestSchema } from "../../core/src/test-utils.js";
import { createCloudflareCoordinatorWorker } from "./index.js";

type SqliteDatabase = ReturnType<typeof connectCoordinator>;
type SqliteStatement = {
	get: (...values: unknown[]) => unknown;
	run: (...values: unknown[]) => { changes: number };
	all: (...values: unknown[]) => unknown[];
	raw: (value: boolean) => { all: (...values: unknown[]) => unknown[] };
};

class SqliteD1Statement implements D1PreparedStatementLike {
	private bound: unknown[] = [];

	constructor(private readonly statement: SqliteStatement) {}

	bind(...values: unknown[]): D1PreparedStatementLike {
		this.bound = values;
		return this;
	}

	async first<T = unknown>(): Promise<T | null> {
		return (this.statement.get(...this.bound) as T | undefined) ?? null;
	}

	async run(): Promise<unknown> {
		const result = this.statement.run(...this.bound);
		return { meta: { changes: result.changes } };
	}

	executeRunSync(): unknown {
		const result = this.statement.run(...this.bound);
		return { meta: { changes: result.changes } };
	}

	async all<T = unknown>(): Promise<{ results?: T[] }> {
		return { results: this.statement.all(...this.bound) as T[] };
	}

	async raw<T = unknown>(): Promise<T[]> {
		return this.statement.raw(true).all(...this.bound) as T[];
	}
}

class SqliteD1Database implements D1DatabaseLike {
	constructor(private readonly db: SqliteDatabase) {}

	prepare(query: string): D1PreparedStatementLike {
		return new SqliteD1Statement(this.db.prepare(query) as unknown as SqliteStatement);
	}

	async batch(statements: D1PreparedStatementLike[]): Promise<unknown[]> {
		return this.db.transaction(() => {
			const results: unknown[] = [];
			for (const statement of statements) {
				if (!(statement instanceof SqliteD1Statement)) {
					throw new Error("Unsupported D1 statement test double.");
				}
				results.push(statement.executeRunSync());
			}
			return results;
		})();
	}
}

describe("createCloudflareCoordinatorWorker", () => {
	let tmpDir: string;
	let db: SqliteDatabase;
	let d1db: D1DatabaseLike;
	let schemaSql: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "cloudflare-coord-worker-test-"));
		db = connectCoordinator(join(tmpDir, "coordinator.sqlite"));
		db.exec(`
			DROP TABLE IF EXISTS coordinator_join_requests;
			DROP TABLE IF EXISTS coordinator_invites;
			DROP TABLE IF EXISTS request_nonces;
			DROP TABLE IF EXISTS presence_records;
			DROP TABLE IF EXISTS enrolled_devices;
			DROP TABLE IF EXISTS groups;
		`);
		schemaSql = readFileSync(join(import.meta.dirname, "../schema.sql"), "utf8");
		db.exec(schemaSql);
		d1db = new SqliteD1Database(db);
	});

	afterEach(() => {
		db.close();
		rmSync(tmpDir, { recursive: true, force: true });
	});

	it("returns missing_d1_binding when the worker env is incomplete", async () => {
		const worker = createCloudflareCoordinatorWorker();
		const res = await worker.fetch(
			new Request("https://coord.example.test/v1/peers?group_id=g1"),
			{},
		);
		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({ error: "missing_d1_binding" });
	});

	it("serves coordinator admin data through the worker entrypoint", async () => {
		const store = new D1CoordinatorStore(d1db);
		await store.createGroup("g1", "Team Alpha");
		await store.enrollDevice("g1", {
			deviceId: "d1",
			fingerprint: "fp1",
			publicKey: "pk1",
			displayName: "Laptop",
		});
		await store.close();

		const worker = createCloudflareCoordinatorWorker({
			now: () => "2026-03-28T00:00:00Z",
		});

		const res = await worker.fetch(
			new Request("https://coord.example.test/v1/admin/devices?group_id=g1", {
				headers: { "X-Codemem-Coordinator-Admin": "test-secret" },
			}),
			{ COORDINATOR_DB: d1db, CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret" },
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			items: [
				{
					group_id: "g1",
					device_id: "d1",
					fingerprint: "fp1",
					display_name: "Laptop",
					enabled: 1,
					created_at: expect.any(String),
				},
			],
		});
	});

	it("supports invite, join approval, signed presence, and signed peer lookup through the worker entrypoint", async () => {
		const worker = createCloudflareCoordinatorWorker({
			now: () => "2026-03-28T00:00:00Z",
		});
		const adminStore = new D1CoordinatorStore(d1db);
		await adminStore.createGroup("g1", "Team Alpha");

		function createIdentity(name: string) {
			const dbPath = join(tmpDir, `${name}.sqlite`);
			const keysDir = join(tmpDir, `${name}-keys`);
			const localDb = connect(dbPath);
			initTestSchema(localDb);
			const [deviceId, fingerprint] = ensureDeviceIdentity(localDb, { keysDir });
			const publicKey = loadPublicKey(keysDir)!;
			return { localDb, keysDir, deviceId, fingerprint, publicKey };
		}

		const inviter = createIdentity("inviter");
		const joiner = createIdentity("joiner");
		const peer = createIdentity("peer");
		try {
			await adminStore.enrollDevice("g1", {
				deviceId: peer.deviceId,
				fingerprint: peer.fingerprint,
				publicKey: peer.publicKey,
				displayName: "Peer Device",
			});

			const inviteRes = await worker.fetch(
				new Request("https://coord.example.test/v1/admin/invites", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"X-Codemem-Coordinator-Admin": "test-secret",
					},
					body: JSON.stringify({
						group_id: "g1",
						policy: "approval_required",
						expires_at: "2099-01-01T00:00:00Z",
						coordinator_url: "https://coord.example.test",
					}),
				}),
				{ COORDINATOR_DB: d1db, CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret" },
			);
			expect(inviteRes.status).toBe(200);
			const inviteJson = (await inviteRes.json()) as { payload: { token: string } };

			const joinRes = await worker.fetch(
				new Request("https://coord.example.test/v1/join", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						token: inviteJson.payload.token,
						device_id: joiner.deviceId,
						public_key: joiner.publicKey,
						fingerprint: joiner.fingerprint,
						display_name: "Joiner Device",
					}),
				}),
				{ COORDINATOR_DB: d1db, CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret" },
			);
			expect(joinRes.status).toBe(200);
			const joinJson = (await joinRes.json()) as { request_id: string; status: string };
			expect(joinJson.status).toBe("pending");

			const approveRes = await worker.fetch(
				new Request("https://coord.example.test/v1/admin/join-requests/approve", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"X-Codemem-Coordinator-Admin": "test-secret",
					},
					body: JSON.stringify({ request_id: joinJson.request_id, reviewed_by: inviter.deviceId }),
				}),
				{ COORDINATOR_DB: d1db, CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret" },
			);
			expect(approveRes.status).toBe(200);

			const peerPresenceBody = JSON.stringify({
				group_id: "g1",
				fingerprint: peer.fingerprint,
				addresses: ["http://10.0.0.5:7337"],
				ttl_s: 180,
			});
			const peerPresenceReq = new Request("https://coord.example.test/v1/presence", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...buildAuthHeaders({
						deviceId: peer.deviceId,
						method: "POST",
						url: "https://coord.example.test/v1/presence",
						bodyBytes: Buffer.from(peerPresenceBody),
						keysDir: peer.keysDir,
					}),
				},
				body: peerPresenceBody,
			});
			expect(
				await worker.fetch(peerPresenceReq, {
					COORDINATOR_DB: d1db,
					CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret",
				}),
			).toHaveProperty("status", 200);

			const joinerPresenceBody = JSON.stringify({
				group_id: "g1",
				fingerprint: joiner.fingerprint,
				addresses: ["http://10.0.0.6:7337"],
				ttl_s: 180,
			});
			const joinerPresenceReq = new Request("https://coord.example.test/v1/presence", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...buildAuthHeaders({
						deviceId: joiner.deviceId,
						method: "POST",
						url: "https://coord.example.test/v1/presence",
						bodyBytes: Buffer.from(joinerPresenceBody),
						keysDir: joiner.keysDir,
					}),
				},
				body: joinerPresenceBody,
			});
			expect(
				await worker.fetch(joinerPresenceReq, {
					COORDINATOR_DB: d1db,
					CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret",
				}),
			).toHaveProperty("status", 200);

			const peersReq = new Request("https://coord.example.test/v1/peers?group_id=g1", {
				method: "GET",
				headers: {
					...buildAuthHeaders({
						deviceId: joiner.deviceId,
						method: "GET",
						url: "https://coord.example.test/v1/peers?group_id=g1",
						bodyBytes: Buffer.from(""),
						keysDir: joiner.keysDir,
					}),
				},
			});
			const peersRes = await worker.fetch(peersReq, {
				COORDINATOR_DB: d1db,
				CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret",
			});
			expect(peersRes.status).toBe(200);
			const peersJson = (await peersRes.json()) as { items: Array<Record<string, unknown>> };
			expect(peersJson.items).toEqual([
				expect.objectContaining({
					device_id: peer.deviceId,
					fingerprint: peer.fingerprint,
					stale: false,
					addresses: ["http://10.0.0.5:7337"],
				}),
			]);
		} finally {
			inviter.localDb.close();
			joiner.localDb.close();
			peer.localDb.close();
		}
	});
});
