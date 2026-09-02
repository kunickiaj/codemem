import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildAuthHeaders,
	COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES,
	connect,
	connectCoordinator,
	deterministicPolicyTeamId,
	ensureDeviceIdentity,
	initTestSchema,
	legacyTeamCandidateId,
	loadPublicKey,
	recipientPolicyDigest,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type D1PreparedStatementLike,
} from "../../core/src/internal/cloudflare-coordinator.js";
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
			DROP TABLE IF EXISTS coordinator_legacy_team_completions;
			DROP TABLE IF EXISTS coordinator_scope_membership_effect_receipts;
			DROP TABLE IF EXISTS coordinator_scope_membership_audit_log;
			DROP TABLE IF EXISTS coordinator_scope_memberships;
			DROP TABLE IF EXISTS coordinator_scopes;
			DROP TABLE IF EXISTS coordinator_reciprocal_approvals;
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

	it("migration 0010 preserves audit history and adds immutable effect receipts", () => {
		db.exec("DROP TABLE coordinator_scope_membership_effect_receipts");
		db.exec("DROP INDEX idx_coordinator_scope_membership_audit_effect");
		db.exec("ALTER TABLE coordinator_scope_membership_audit_log RENAME TO audit_with_effect");
		db.exec(`
			CREATE TABLE coordinator_scope_membership_audit_log (
				event_id INTEGER PRIMARY KEY AUTOINCREMENT,
				action TEXT NOT NULL,
				scope_id TEXT NOT NULL,
				device_id TEXT NOT NULL,
				role TEXT,
				status TEXT NOT NULL,
				membership_epoch INTEGER NOT NULL,
				previous_role TEXT,
				previous_status TEXT,
				previous_membership_epoch INTEGER,
				coordinator_id TEXT,
				group_id TEXT,
				actor_type TEXT,
				actor_id TEXT,
				manifest_hash TEXT,
				created_at TEXT NOT NULL
			);
			INSERT INTO coordinator_scope_membership_audit_log(
				action, scope_id, device_id, status, membership_epoch, created_at
			) VALUES ('grant', 'scope-a', 'device-a', 'active', 1, '2026-07-21T00:00:00Z');
			DROP TABLE audit_with_effect;
		`);
		const migration = readFileSync(
			join(import.meta.dirname, "../migrations/0010_add_scope_membership_effect_receipts.sql"),
			"utf8",
		);

		db.exec(migration);

		expect(
			db.prepare("SELECT action, effect_id FROM coordinator_scope_membership_audit_log").get(),
		).toEqual({ action: "grant", effect_id: null });
		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_scope_membership_effect_receipts'",
				)
				.pluck()
				.get(),
		).toBe("coordinator_scope_membership_effect_receipts");
	});

	it("migration 0014 adds immutable legacy Team completion storage", () => {
		db.exec("DROP TABLE coordinator_legacy_team_completions");
		const migration = readFileSync(
			join(import.meta.dirname, "../migrations/0014_add_legacy_team_completions.sql"),
			"utf8",
		);

		db.exec(migration);

		expect(
			db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coordinator_legacy_team_completions'",
				)
				.pluck()
				.get(),
		).toBe("coordinator_legacy_team_completions");
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

	it("migration 0007 preserves legacy invites while adding project-intent columns", () => {
		db.exec("DROP TABLE coordinator_invites");
		db.exec(`
			CREATE TABLE coordinator_invites (
				invite_id TEXT PRIMARY KEY,
				group_id TEXT NOT NULL,
				token TEXT NOT NULL UNIQUE,
				policy TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				created_at TEXT NOT NULL,
				created_by TEXT,
				team_name_snapshot TEXT,
				revoked_at TEXT
			);
			INSERT INTO coordinator_invites(
				invite_id, group_id, token, policy, expires_at, created_at
			) VALUES (
				'legacy-invite', 'g1', 'legacy-token', 'auto_admit',
				'2099-01-01T00:00:00Z', '2026-03-28T00:00:00Z'
			);
		`);
		const migration = readFileSync(
			join(import.meta.dirname, "../migrations/0007_add_invite_project_intent_reference.sql"),
			"utf8",
		);

		db.exec(migration);

		expect(
			db
				.prepare(
					`SELECT invite_id, token, operation_id, reviewed_project_set_digest
					 FROM coordinator_invites WHERE invite_id = 'legacy-invite'`,
				)
				.get(),
		).toEqual({
			invite_id: "legacy-invite",
			token: "legacy-token",
			operation_id: null,
			reviewed_project_set_digest: null,
		});
	});

	it("migration 0008 preserves legacy invites while adding atomic binding columns", () => {
		db.exec(`
			DROP TABLE coordinator_invites;
			CREATE TABLE coordinator_invites (
				invite_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
				policy TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
				created_by TEXT, team_name_snapshot TEXT, revoked_at TEXT, operation_id TEXT,
				reviewed_project_set_digest TEXT
			);
			INSERT INTO coordinator_invites(invite_id, group_id, token, policy, expires_at, created_at)
			VALUES ('legacy-invite', 'g1', 'legacy-token', 'auto_admit', '2099-01-01T00:00:00Z',
				'2026-03-28T00:00:00Z');
		`);
		const migration = readFileSync(
			join(import.meta.dirname, "../migrations/0008_add_project_invite_acceptance.sql"),
			"utf8",
		);
		db.exec(migration);
		expect(
			db
				.prepare(
					`SELECT invite_id, token, token_digest, consumed_at, bound_device_id,
						recipient_actor_id, trust_state
					 FROM coordinator_invites WHERE invite_id = 'legacy-invite'`,
				)
				.get(),
		).toEqual({
			invite_id: "legacy-invite",
			token: "legacy-token",
			token_digest: null,
			consumed_at: null,
			bound_device_id: null,
			recipient_actor_id: null,
			trust_state: null,
		});
	});

	it("migration 0009 classifies existing invites and adds recipient invitation metadata", () => {
		db.exec(`
			DROP TABLE coordinator_invites;
			CREATE TABLE coordinator_invites (
				invite_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
				policy TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL,
				created_by TEXT, team_name_snapshot TEXT, revoked_at TEXT, operation_id TEXT
			);
			INSERT INTO coordinator_invites(invite_id, group_id, token, policy, expires_at, created_at, operation_id)
			VALUES
				('legacy-invite', 'g1', 'legacy-token', 'auto_admit', '2099-01-01T00:00:00Z',
					'2026-03-28T00:00:00Z', NULL),
				('project-invite', 'g1', 'project-token', 'auto_admit', '2099-01-01T00:00:00Z',
					'2026-03-28T00:00:00Z', 'share_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		`);
		const migration = readFileSync(
			join(import.meta.dirname, "../migrations/0009_add_recipient_invite_kinds.sql"),
			"utf8",
		);
		db.exec(migration);

		expect(
			db
				.prepare(`SELECT invite_id, invite_kind, policy_team_id, target_identity_id,
					reviewed_preview_digest FROM coordinator_invites ORDER BY invite_id`)
				.all(),
		).toEqual([
			{
				invite_id: "legacy-invite",
				invite_kind: "legacy_enrollment",
				policy_team_id: null,
				target_identity_id: null,
				reviewed_preview_digest: null,
			},
			{
				invite_id: "project-invite",
				invite_kind: "project_share",
				policy_team_id: null,
				target_identity_id: null,
				reviewed_preview_digest: null,
			},
		]);
	});

	it("migration 0011 adds nullable reviewed intent without changing existing invitations", () => {
		db.exec(`
			DROP TABLE coordinator_invites;
			CREATE TABLE coordinator_invites (
				invite_id TEXT PRIMARY KEY,
				group_id TEXT NOT NULL,
				token TEXT NOT NULL UNIQUE,
				policy TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			INSERT INTO coordinator_invites(invite_id, group_id, token, policy, expires_at, created_at)
			VALUES ('legacy-invite', 'g1', 'legacy-token', 'auto_admit', '2099-01-01T00:00:00Z',
				'2026-03-28T00:00:00Z');
		`);
		const migration = readFileSync(
			join(import.meta.dirname, "../migrations/0011_add_recipient_reviewed_intent.sql"),
			"utf8",
		);

		db.exec(migration);

		expect(
			db.prepare("SELECT invite_id, reviewed_intent_json FROM coordinator_invites").get(),
		).toEqual({ invite_id: "legacy-invite", reviewed_intent_json: null });
	});

	it("migration 0012 adds nullable enrollment identity binding and preserves existing rows", () => {
		// Arrange
		db.exec(`
			DROP TABLE enrolled_devices;
			CREATE TABLE enrolled_devices (
				group_id TEXT NOT NULL,
				device_id TEXT NOT NULL,
				public_key TEXT NOT NULL,
				fingerprint TEXT NOT NULL,
				display_name TEXT,
				enabled INTEGER NOT NULL DEFAULT 1,
				created_at TEXT NOT NULL,
				PRIMARY KEY (group_id, device_id)
			);
			INSERT INTO enrolled_devices(
				group_id, device_id, public_key, fingerprint, display_name, enabled, created_at
			) VALUES (
				'g1', 'legacy-device', 'legacy-key', 'legacy-fingerprint', 'Legacy device', 1,
				'2026-07-24T00:00:00Z'
			);
		`);
		const migration = readFileSync(
			join(import.meta.dirname, "../migrations/0012_add_enrolled_device_identity.sql"),
			"utf8",
		);

		// Act
		db.exec(migration);

		// Assert
		const columns = db.prepare("PRAGMA table_info(enrolled_devices)").all() as Array<{
			name: string;
		}>;
		expect(columns.map((column) => column.name)).toContain("identity_id");
		expect(
			db
				.prepare(
					"SELECT device_id, identity_id FROM enrolled_devices WHERE device_id = 'legacy-device'",
				)
				.get(),
		).toEqual({ device_id: "legacy-device", identity_id: null });
	});

	it("migration 0013 adds nullable assigned Team identity and preserves existing invitations", () => {
		// Arrange
		db.exec(`
			DROP TABLE coordinator_invites;
			CREATE TABLE coordinator_invites (
				invite_id TEXT PRIMARY KEY,
				group_id TEXT NOT NULL,
				token TEXT NOT NULL UNIQUE,
				policy TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				created_at TEXT NOT NULL,
				invite_kind TEXT,
				policy_team_id TEXT
			);
			INSERT INTO coordinator_invites(
				invite_id, group_id, token, policy, expires_at, created_at, invite_kind, policy_team_id
			) VALUES (
				'legacy-team-invite', 'g1', 'legacy-team-token', 'auto_admit',
				'2099-01-01T00:00:00Z', '2026-07-24T00:00:00Z', 'team_member', 'policy-team-1'
			);
		`);
		const migration = readFileSync(
			join(import.meta.dirname, "../migrations/0013_add_invite_assigned_identity.sql"),
			"utf8",
		);

		// Act
		db.exec(migration);

		// Assert
		const columns = db.prepare("PRAGMA table_info(coordinator_invites)").all() as Array<{
			name: string;
		}>;
		expect(columns.map((column) => column.name)).toContain("assigned_identity_id");
		expect(
			db
				.prepare(
					"SELECT invite_id, invite_kind, policy_team_id, assigned_identity_id FROM coordinator_invites",
				)
				.get(),
		).toEqual({
			invite_id: "legacy-team-invite",
			invite_kind: "team_member",
			policy_team_id: "policy-team-1",
			assigned_identity_id: null,
		});
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
					public_key: "pk1",
					fingerprint: "fp1",
					identity_id: null,
					display_name: "Laptop",
					enabled: 1,
					created_at: expect.any(String),
				},
			],
		});
	});

	it("persists and replays immutable legacy Team completions through Worker and D1", async () => {
		const worker = createCloudflareCoordinatorWorker();
		const env = {
			COORDINATOR_DB: d1db,
			CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret",
		};
		const adminHeaders = {
			"Content-Type": "application/json",
			"X-Codemem-Coordinator-Admin": "test-secret",
		};
		const createGroup = await worker.fetch(
			new Request("https://coord.example.test/v1/admin/groups", {
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify({ group_id: "g1", display_name: "Team Alpha" }),
			}),
			env,
		);
		expect(createGroup.status).toBe(200);
		expect(await createGroup.json()).toEqual({
			ok: true,
			group: expect.objectContaining({ group_id: "g1" }),
		});
		const candidateRef = legacyTeamCandidateId("coord-a", "g1");
		const manifest = {
			version: 1,
			coordinator_id: "coord-a",
			candidate_ref: candidateRef,
			candidate_digest: "a".repeat(64),
			team_id: deterministicPolicyTeamId(candidateRef),
			team_digest: "b".repeat(64),
			source_digest: "c".repeat(64),
			finish_digest: "d".repeat(64),
			access_delta_digest: "e".repeat(64),
			team: {
				display_name: "Core Team",
				policy_revision: "f".repeat(64),
				device_eligibility_mode: "reviewed_allowlist",
			},
			memberships: [{ identity_id: "identity-a", role: "member" }],
			device_decisions: [
				{
					device_id: "device-a",
					key_fingerprint: "1".repeat(64),
					enabled: true,
					identity_id: "identity-a",
					decision: "included",
				},
			],
			project_mappings: [],
			project_recipients: [],
			completed_at: "2026-09-01T00:00:00.000Z",
		};
		const store = new D1CoordinatorStore(d1db);
		await store.enrollDevice("g1", {
			deviceId: "device-a",
			fingerprint: "1".repeat(64),
			publicKey: "device-a-public-key",
		});
		await store.close();
		const request = () =>
			new Request("https://coord.example.test/v1/admin/legacy-team-completions", {
				method: "POST",
				headers: adminHeaders,
				body: JSON.stringify({ group_id: "g1", manifest }),
			});

		const created = await worker.fetch(request(), env);
		const replay = await worker.fetch(request(), env);

		expect(created.status).toBe(201);
		expect(await created.json()).toEqual({ ok: true, status: "created", manifest });
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({ ok: true, status: "existing", manifest });
	});

	it("round-trips a maximum-size legacy Team completion through Worker D1", async () => {
		const worker = createCloudflareCoordinatorWorker();
		const env = {
			COORDINATOR_DB: d1db,
			CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret",
		};
		const headers = {
			"Content-Type": "application/json",
			"X-Codemem-Coordinator-Admin": "test-secret",
		};
		await worker.fetch(
			new Request("https://coord.example.test/v1/admin/groups", {
				method: "POST",
				headers,
				body: JSON.stringify({ group_id: "large-group" }),
			}),
			env,
		);
		const boundedId = (prefix: string, index: number) =>
			`${prefix}-${String(index).padStart(3, "0")}`.padEnd(256, "x");
		const coordinatorId = "coord-large";
		const candidateRef = legacyTeamCandidateId(coordinatorId, "large-group");
		const teamId = deterministicPolicyTeamId(candidateRef);
		const memberships = Array.from({ length: 500 }, (_, index) => ({
			identity_id: boundedId("identity", index),
			role: "member",
		}));
		const projectMappings = Array.from({ length: 500 }, (_, index) => {
			const projectRef = recipientPolicyDigest("legacy-team-project-ref-v1", [
				candidateRef,
				boundedId("project", index),
			]);
			return {
				project_ref: projectRef,
				resolved_project_ref: recipientPolicyDigest("legacy-team-resolved-project-ref-v1", [
					projectRef,
					boundedId("resolved", index),
				]),
				scope_id: boundedId("scope", index),
			};
		});
		const insertScope = db.prepare(`INSERT INTO coordinator_scopes(
			scope_id, label, kind, authority_type, coordinator_id, group_id,
			manifest_issuer_device_id, membership_epoch, manifest_hash, status, created_at, updated_at
		) VALUES (?, ?, 'managed_project', 'coordinator', ?, 'large-group', NULL, 0, NULL, 'active', ?, ?)`);
		for (const mapping of projectMappings) {
			insertScope.run(
				mapping.scope_id,
				mapping.scope_id,
				coordinatorId,
				"2026-09-01T00:00:00.000Z",
				"2026-09-01T00:00:00.000Z",
			);
		}
		const manifest = {
			version: 1,
			coordinator_id: coordinatorId,
			candidate_ref: candidateRef,
			candidate_digest: "a".repeat(64),
			team_id: teamId,
			team_digest: "b".repeat(64),
			source_digest: "c".repeat(64),
			finish_digest: "d".repeat(64),
			access_delta_digest: "e".repeat(64),
			team: {
				display_name: "Large Team",
				policy_revision: "f".repeat(64),
				device_eligibility_mode: "reviewed_allowlist",
			},
			memberships,
			device_decisions: memberships.map((membership, index) => ({
				device_id: boundedId("device", index),
				key_fingerprint: index.toString(16).padStart(64, "0"),
				enabled: true,
				identity_id: membership.identity_id,
				decision: "included",
			})),
			project_mappings: projectMappings,
			project_recipients: projectMappings.map((mapping) => ({
				resolved_project_ref: mapping.resolved_project_ref,
				team_id: teamId,
			})),
			completed_at: "2026-09-01T00:00:00.000Z",
		};
		const enrollDevice = db.prepare(`INSERT INTO enrolled_devices(
			group_id, device_id, public_key, fingerprint, enabled, created_at
		) VALUES ('large-group', ?, ?, ?, 1, ?)`);
		for (const decision of manifest.device_decisions) {
			enrollDevice.run(
				decision.device_id,
				`${decision.device_id}-public-key`,
				decision.key_fingerprint,
				manifest.completed_at,
			);
		}

		const created = await worker.fetch(
			new Request("https://coord.example.test/v1/admin/legacy-team-completions", {
				method: "POST",
				headers,
				body: JSON.stringify({ group_id: "large-group", manifest }),
			}),
			env,
		);
		expect(created.status).toBe(201);

		const fetched = await worker.fetch(
			new Request(
				`https://coord.example.test/v1/admin/legacy-team-completions?group_id=large-group&candidate_ref=${manifest.candidate_ref}`,
				{ headers },
			),
			env,
		);
		expect(fetched.status).toBe(200);
		const body = (await fetched.json()) as { manifest: typeof manifest };
		expect(body.manifest.device_decisions).toHaveLength(500);
		expect(body.manifest.project_mappings).toHaveLength(500);

		const listed = await worker.fetch(
			new Request("https://coord.example.test/v1/admin/legacy-team-completions/query", {
				method: "POST",
				headers,
				body: JSON.stringify({ group_ids: ["large-group"] }),
			}),
			env,
		);
		expect(listed.status).toBe(200);
		const listedBody = (await listed.json()) as {
			items: Array<{ manifest: typeof manifest }>;
		};
		expect(listedBody.items).toHaveLength(1);
		expect(listedBody.items[0]?.manifest.device_decisions).toHaveLength(500);
		expect(listedBody.items[0]?.manifest.project_mappings).toHaveLength(500);
	});

	it("fails closed on an oversized stored completion in the Worker D1 list path", async () => {
		db.prepare("INSERT INTO groups(group_id, display_name, created_at) VALUES (?, NULL, ?)").run(
			"oversized-group",
			"2026-09-01T00:00:00.000Z",
		);
		db.prepare(`INSERT INTO coordinator_legacy_team_completions(
			group_id, candidate_ref, manifest_version, manifest_json, completed_at, created_at
		) VALUES (?, ?, 1, ?, ?, ?)`).run(
			"oversized-group",
			"legacy-team-candidate:cccccccccccccccccccccccccccccccc",
			"x".repeat(COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES + 1),
			"2026-09-01T00:00:00.000Z",
			"2026-09-01T00:00:00.000Z",
		);
		const worker = createCloudflareCoordinatorWorker();
		const response = await worker.fetch(
			new Request("https://coord.example.test/v1/admin/legacy-team-completions/query", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Codemem-Coordinator-Admin": "test-secret",
				},
				body: JSON.stringify({ group_ids: ["oversized-group"] }),
			}),
			{
				COORDINATOR_DB: d1db,
				CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret",
			},
		);

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "completion_results_too_large" });
	});

	it("rejects oversized presence bodies before auth processing", async () => {
		const worker = createCloudflareCoordinatorWorker({
			now: () => "2026-03-28T00:00:00Z",
		});
		const hugeBody = JSON.stringify({
			group_id: "g1",
			addresses: ["http://127.0.0.1:7337"],
			padding: "x".repeat(70_000),
		});
		const res = await worker.fetch(
			new Request("https://coord.example.test/v1/presence", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: hugeBody,
			}),
			{ COORDINATOR_DB: d1db, CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret" },
		);
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "body_too_large" });
	});

	it("accepts the legacy v2 canonical request and rejects v3 in its signature slot", async () => {
		// Arrange
		const identityDb = connect(join(tmpDir, "signature-invariance.sqlite"));
		const keysDir = join(tmpDir, "signature-invariance-keys");
		try {
			initTestSchema(identityDb);
			const [deviceId, fingerprint] = ensureDeviceIdentity(identityDb, { keysDir });
			const publicKey = loadPublicKey(keysDir);
			if (!publicKey) throw new Error("expected device public key");

			const store = new D1CoordinatorStore(d1db);
			await store.createGroup("g1", "Team One");
			await store.enrollDevice("g1", { deviceId, fingerprint, publicKey });
			await store.close();

			const worker = createCloudflareCoordinatorWorker();
			const body = JSON.stringify({
				group_id: "g1",
				fingerprint,
				addresses: ["http://127.0.0.1:7337"],
				ttl_s: 180,
			});
			const headers = buildAuthHeaders({
				deviceId,
				method: "POST",
				url: "https://coord.example.test/v1/presence",
				bodyBytes: Buffer.from(body),
				keysDir,
				timestamp: String(Math.floor(Date.now() / 1000)),
				nonce: "worker-coordinator-v2-fixture",
			});
			const env = {
				COORDINATOR_DB: d1db,
				CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: "test-secret",
			};

			// Act
			const accepted = await worker.fetch(
				new Request("https://coord.example.test/v1/presence", {
					method: "POST",
					headers: { ...headers, "Content-Type": "application/json" },
					body,
				}),
				env,
			);
			const rejected = await worker.fetch(
				new Request("https://coord.example.test/v1/presence", {
					method: "POST",
					headers: {
						...headers,
						"Content-Type": "application/json",
						"X-Opencode-Signature": headers["X-Opencode-Signature"].replace(/^v2:/u, "v3:"),
					},
					body,
				}),
				env,
			);

			// Assert
			expect(accepted.status).toBe(200);
			expect(rejected.status).toBe(401);
			expect(await rejected.json()).toEqual({ error: "invalid_signature" });
		} finally {
			identityDb.close();
		}
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
			const publicKey = loadPublicKey(keysDir);
			if (!publicKey) throw new Error("expected public key after ensureDeviceIdentity");
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
