import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import {
	input,
	seedEnrollmentSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import {
	ACCOUNT_CONNECTION_STORAGE_STATEMENTS,
	CONNECTION_ALLOCATE_ORDER_SQL,
	CONNECTION_ARCHIVED_CURRENT_MATCH_SQL,
	CONNECTION_ASSERT_ONE_WRITE_SQL,
	CONNECTION_BIRTH_COLUMNS,
	CONNECTION_DISCONNECTED_HEAD_SQL,
	CONNECTION_NOT_REVOKED_SQL,
	CONNECTION_RESERVATIONS_SQL,
	CONNECTION_SIGNIN_ORDER_SQL,
} from "./coordinator-account-connection-storage.js";
import { browserConfig, materials } from "./coordinator-auth-browser-transaction-test-fixtures.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { authDeviceClaimProvenanceSql } from "./coordinator-auth-link-provenance.js";
import {
	attempt,
	backendTest,
	completionHash,
	finalize,
	type LinkFixture,
} from "./coordinator-auth-link-test-fixtures.js";
import { AUTH_SCHEMA_READINESS_SQL } from "./coordinator-auth-schema.js";
import { sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";

const current = "coordinator_auth_account_links";
const history = "coordinator_auth_account_connection_history";
const orders = "coordinator_auth_account_connection_orders";
const columns = CONNECTION_BIRTH_COLUMNS.join(",");
const statement = (sql: string, values: AuthLinkStatement["values"] = []): AuthLinkStatement => ({
	sql,
	values,
});
const assertOne = statement(CONNECTION_ASSERT_ONE_WRITE_SQL);
// Raw test execution is intentional: production V2's backend correctly refuses
// this unmounted schema after the additional claim-history trigger is installed.
const backend = (f: LinkFixture) => {
	const db = sqliteD1(f.db);
	const batch = db.batch?.bind(db);
	if (!batch) throw new Error("fixture atomic batch unavailable");
	return {
		batch: (statements: AuthLinkStatement[]) =>
			batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values))),
	};
};
const rows = (f: LinkFixture, table = history) => f.db.prepare(`SELECT * FROM ${table}`).all();

// Real V2 producer, with trusted OIDC test metadata, before the old-writer fence.
async function firstLink(f: LinkFixture) {
	f.db.exec(seedEnrollmentSql);
	const request = attempt({
		authority: { kind: "device_claim", identityId: input.identityId },
		signer: input.signer,
		browserStartHash: "e".repeat(64),
	});
	expect(await f.store.createAuthLinkAttempt(request, f.cfg)).toMatchObject({ kind: "created" });
	const start = {
		...materials(),
		purpose: "link" as const,
		attemptId: request.attemptId,
		browserStartHash: request.browserStartHash,
	};
	expect(await f.store.startAuthBrowserTransaction(start, browserConfig)).toMatchObject({
		kind: "started",
	});
	const bound = await f.store.resolveAuthLinkBrowserTransaction(
		{ attemptId: start.attemptId, binderHash: start.binderHash },
		browserConfig,
	);
	if (!bound) throw new Error("fixture browser not bound");
	expect(
		await f.store.consumeAuthBrowserTransaction(
			{ stateHash: start.stateHash, binderHash: start.binderHash },
			browserConfig,
		),
	).toMatchObject({ kind: "consumed" });
	const pins = { attemptId: request.attemptId, ...bound };
	expect(
		await f.store.recordAuthLinkOidcVerified(
			{ ...pins, account: { issuer: f.cfg.issuer, subject: "A" } },
			f.cfg,
		),
	).toMatchObject({ kind: "applied" });
	expect(
		await f.store.confirmAuthLinkAttempt({ ...pins, completionSecretHash: completionHash }, f.cfg),
	).toMatchObject({ kind: "applied" });
	expect(
		await f.store.finalizeAuthLinkAttempt(
			finalize({ signer: input.signer, fingerprint: input.signer.fingerprint }),
			f.cfg,
		),
	).toMatchObject({ kind: "applied" });
	expect(
		f.db
			.prepare(`SELECT ${authDeviceClaimProvenanceSql({ link: "l" })} AS valid FROM ${current} l`)
			.get(),
	).toEqual({ valid: 1 });
	const birth = f.db.prepare(`SELECT rowid AS original_rowid,* FROM ${current}`).get() as Record<
		string,
		string | number | null
	>;
	for (const sql of ACCOUNT_CONNECTION_STORAGE_STATEMENTS) f.db.exec(sql);
	return birth;
}

// Fixture-only MOVE composition: a real finalized V2 birth is NOT management
// authorization. No unlink API or completed disconnect intent exists in this leaf.
function move(f: LinkFixture, id: string, end: string): AuthLinkStatement[] {
	return [
		statement(
			`INSERT INTO ${history} (${columns},original_rowid,ended_at_ms,end_attempt_id)
   SELECT ${CONNECTION_BIRTH_COLUMNS.map((c) => `l.${c}`).join(",")},l.rowid,?,?
   FROM ${current} l WHERE l.coordinator_id = ? AND l.link_id = ?
   AND EXISTS (SELECT 1 FROM coordinator_auth_link_attempts a WHERE a.coordinator_id = l.coordinator_id AND a.link_id = l.link_id AND a.attempt_id = l.attempt_id AND a.state = 'finalized')`,
			[f.now, end, f.cfg.coordinatorId, id],
		),
		assertOne,
		statement(
			`DELETE FROM ${current} AS c WHERE coordinator_id = ? AND link_id = ? AND EXISTS (SELECT 1 FROM ${history} h WHERE h.coordinator_id = ? AND h.link_id = ? AND h.end_attempt_id = ? AND ${CONNECTION_ARCHIVED_CURRENT_MATCH_SQL})`,
			[f.cfg.coordinatorId, id, f.cfg.coordinatorId, id, end],
		),
		assertOne,
	];
}

// Seeded reconnect feasibility, not proof-bearing production finalization.
function reconnect(
	f: LinkFixture,
	prior: string,
	id: string,
	subject: string,
): AuthLinkStatement[] {
	const select = CONNECTION_BIRTH_COLUMNS.map((c) => {
		if (c === "link_id" || c === "subject" || c === "attempt_id") return "?";
		return `h.${c}`;
	}).join(",");
	return [
		statement(
			`INSERT INTO ${current} (${columns}) SELECT ${select} FROM (${CONNECTION_DISCONNECTED_HEAD_SQL}) h`,
			[id, subject, id, f.cfg.coordinatorId, prior],
		),
		assertOne,
		statement(
			`UPDATE ${history} SET successor_link_id = ? WHERE coordinator_id = ? AND link_id = ? AND successor_link_id IS NULL`,
			[id, f.cfg.coordinatorId, prior],
		),
		assertOne,
	];
}

for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	test(`${kind} rejects rowid and disconnected-head REPLACE collisions without losing history`, async ({
		fixture: f,
	}) => {
		const birth = await firstLink(f);
		await backend(f).batch(move(f, String(birth.link_id), "end-A"));
		await backend(f).batch(reconnect(f, String(birth.link_id), "B", "B"));
		const before = rows(f);
		const archive = (rowid: string) =>
			`INSERT OR REPLACE INTO ${history} (rowid,${columns},original_rowid,ended_at_ms,end_attempt_id) SELECT ${rowid},${columns},rowid,${f.now},'end-B' FROM ${current}`;
		expect(() => f.db.exec(archive(`(SELECT rowid FROM ${history})`))).toThrow(
			/connection_archive_source_invalid/,
		);
		for (const rowid of ["-2", "-1", "0"])
			expect(() => f.db.exec(archive(rowid))).toThrow(/connection_archive_source_invalid/);
		expect(rows(f)).toEqual(before);
		// Normal auto-rowid archive is valid after the previous head has a successor.
		f.db.exec(
			`INSERT INTO ${history} (${columns},original_rowid,ended_at_ms,end_attempt_id) SELECT ${columns},rowid,${f.now},'end-B' FROM ${current}`,
		);
		f.db.exec(
			`CREATE UNIQUE INDEX connection_history_head ON ${history}(coordinator_id,identity_id) WHERE successor_link_id IS NULL`,
		);
		const both = rows(f);
		// An independent current birth with the same identity must not evict B's head.
		f.db.exec(`DELETE FROM ${current}`);
		f.db.exec(
			`INSERT INTO ${current} (${columns}) SELECT ${CONNECTION_BIRTH_COLUMNS.map((c) => (c === "link_id" || c === "attempt_id" ? "'C'" : c)).join(",")} FROM ${history} WHERE link_id='B'`,
		);
		expect(() => f.db.exec(archive("99").replace("'end-B'", "'end-C'"))).toThrow(
			/connection_archive_source_invalid/,
		);
		expect(() => f.db.exec(`UPDATE OR REPLACE ${history} SET rowid=99`)).toThrow(
			/connection_history_immutable/,
		);
		expect(rows(f)).toEqual(both);
	});
	test(`${kind} archives every raw birth field and rowid, invalidates old link joins, retains proof`, async ({
		fixture: f,
	}) => {
		const birth = await firstLink(f);
		const claims = rows(f, "coordinator_auth_device_claims");
		const oldJoin = () =>
			f.db
				.prepare(
					`SELECT l.link_id FROM coordinator_auth_link_attempts a JOIN ${current} l ON l.coordinator_id = a.coordinator_id AND l.link_id = a.link_id`,
				)
				.all();
		expect(oldJoin()).toHaveLength(1);
		await backend(f).batch(move(f, String(birth.link_id), "fixture-end"));
		expect(rows(f)).toEqual([
			{ ...birth, ended_at_ms: f.now, end_attempt_id: "fixture-end", successor_link_id: null },
		]);
		expect(rows(f, "coordinator_auth_device_claims")).toEqual(claims);
		expect(oldJoin()).toEqual([]);
		expect(rows(f, current)).toEqual([]);
	});

	test(`${kind} rolls back archive faults and rejects zero-row MOVE rather than reporting success`, async ({
		fixture: f,
	}) => {
		const birth = await firstLink(f);
		const writes = move(f, String(birth.link_id), "fixture-end");
		await expect(
			backend(f).batch([
				...writes.slice(0, 2),
				statement("INSERT INTO coordinator_auth_account_connection_orders DEFAULT VALUES"),
				...writes.slice(2),
			]),
		).rejects.toThrow();
		expect(rows(f)).toEqual([]);
		expect(rows(f, current)).toHaveLength(1);
		await expect(
			backend(f).batch([
				...writes.slice(0, 2),
				statement(`UPDATE ${current} SET subject = 'changed-after-archive'`),
				...writes.slice(2),
			]),
		).rejects.toThrow();
		expect(rows(f, current)).toMatchObject([{ subject: birth.subject }]);
		expect(rows(f)).toEqual([]);
		await expect(backend(f).batch(move(f, "missing", "missing-end"))).rejects.toThrow();
		expect(rows(f)).toEqual([]);
	});

	test(`${kind} keeps A reservation/genesis through A-B-A, rejects stale CAS and ID reuse`, async ({
		fixture: f,
	}) => {
		const birth = await firstLink(f);
		await backend(f).batch(move(f, String(birth.link_id), "end-A"));
		const theft = CONNECTION_BIRTH_COLUMNS.map((c) => {
			if (c === "identity_id") return "'other-identity'";
			if (c === "link_id") return "'thief'";
			return c;
		}).join(",");
		expect(() =>
			f.db.exec(`INSERT INTO ${current} (${columns}) SELECT ${theft} FROM ${history}`),
		).toThrow(/connection_reserved_or_revoked/);
		await backend(f).batch(reconnect(f, String(birth.link_id), "B-id", "B"));
		// Later generations here are seeded SQL, not V2-authorized reconnects.
		f.db
			.prepare(
				`INSERT INTO ${history} (${columns},original_rowid,ended_at_ms,end_attempt_id) SELECT ${columns},rowid,?,'end-B' FROM ${current}`,
			)
			.run(f.now);
		f.db.prepare(`DELETE FROM ${current}`).run();
		await expect(
			backend(f).batch(reconnect(f, String(birth.link_id), "stale", "C")),
		).rejects.toThrow();
		await backend(f).batch(reconnect(f, "B-id", "A-new", "A"));
		expect(rows(f, current)).toMatchObject([
			{ link_id: "A-new", subject: "A", device_claim_id: birth.device_claim_id },
		]);
		expect(rows(f)).toMatchObject([
			{ link_id: birth.link_id, subject: "A", successor_link_id: "B-id" },
			{ link_id: "B-id", successor_link_id: "A-new" },
		]);
		expect(
			f.db.prepare(`SELECT * FROM (${CONNECTION_RESERVATIONS_SQL}) WHERE subject = 'A'`).all(),
		).toHaveLength(2);
		f.db.prepare(`DELETE FROM ${current}`).run();
		await expect(
			backend(f).batch(reconnect(f, "B-id", String(birth.link_id), "A")),
		).rejects.toThrow();
	});

	test(`${kind} historical revocation blocks active B and reconnect; history rejects replace/delete/rewrite`, async ({
		fixture: f,
	}) => {
		const birth = await firstLink(f);
		await backend(f).batch(move(f, String(birth.link_id), "end-A"));
		await backend(f).batch(reconnect(f, String(birth.link_id), "B", "B"));
		f.db.prepare(`UPDATE ${history} SET revoked_at_ms = ?`).run(f.now);
		expect(
			f.db.prepare(`SELECT 1 FROM ${current} l WHERE ${CONNECTION_NOT_REVOKED_SQL}`).all(),
		).toEqual([]);
		const writes = [
			`UPDATE ${history} SET subject = 'changed'`,
			`DELETE FROM ${history}`,
			`INSERT OR REPLACE INTO ${history} SELECT * FROM ${history}`,
			`UPDATE ${history} SET revoked_at_ms = NULL`,
		];
		for (const sql of writes) expect(() => f.db.exec(sql)).toThrow();
		f.db.prepare(`DELETE FROM ${current}`).run();
		await expect(backend(f).batch(reconnect(f, String(birth.link_id), "C", "C"))).rejects.toThrow();
	});

	test(`${kind} allocates persistent exact orders atomically and fails overflow without mutation`, async ({
		fixture: f,
	}) => {
		await firstLink(f);
		f.db.prepare(`INSERT INTO ${orders} VALUES (?,0)`).run(f.cfg.coordinatorId);
		const allocation = [statement(CONNECTION_ALLOCATE_ORDER_SQL, [f.cfg.coordinatorId]), assertOne];
		await backend(f).batch(allocation);
		f.db.exec("DELETE FROM coordinator_auth_browser_transactions");
		await expect(
			backend(f).batch([...allocation, statement(`INSERT INTO ${orders} DEFAULT VALUES`)]),
		).rejects.toThrow();
		expect(rows(f, orders)).toEqual([{ coordinator_id: f.cfg.coordinatorId, last_order: 1 }]);
		// Fixture boundary seed: do not add a production counter-reset path.
		f.db.exec("DROP TRIGGER account_connection_order_update");
		f.db.prepare(`UPDATE ${orders} SET last_order = ?`).run(Number.MAX_SAFE_INTEGER);
		f.db.exec(
			ACCOUNT_CONNECTION_STORAGE_STATEMENTS.find((sql) =>
				sql.startsWith("CREATE TRIGGER account_connection_order_update"),
			) as string,
		);
		await expect(backend(f).batch(allocation)).rejects.toThrow(/CHECK constraint failed/);
		expect(rows(f, orders)).toEqual([
			{ coordinator_id: f.cfg.coordinatorId, last_order: Number.MAX_SAFE_INTEGER },
		]);
		await expect(
			backend(f).batch([statement(CONNECTION_ALLOCATE_ORDER_SQL, ["missing"]), assertOne]),
		).rejects.toThrow();
	});

	test(`${kind} meaningful claim-history fence keeps old readiness at nine after old initializer replay`, async ({
		fixture: f,
	}) => {
		const birth = await firstLink(f);
		expect(f.db.prepare(AUTH_SCHEMA_READINESS_SQL).get()).toEqual({ ready: 9 });
		await backend(f).batch(move(f, String(birth.link_id), "end-A"));
		// Invoke the actual old initializer on this same database, not a copied DDL simulation.
		mkdirSync(".tmp", { recursive: true });
		const dir = mkdtempSync(join(".tmp", "connection-storage-"));
		try {
			const path = join(dir, "fixture.sqlite");
			await f.db.backup(path);
			const reopened = new BetterSqliteCoordinatorStore(path);
			try {
				expect(reopened.db.prepare(AUTH_SCHEMA_READINESS_SQL).get()).toEqual({ ready: 9 });
				expect(() =>
					reopened.db.exec(
						`INSERT INTO coordinator_auth_device_claims SELECT * FROM coordinator_auth_device_claims`,
					),
				).toThrow(/connection_claim_history_reserved/);
			} finally {
				await reopened.close();
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test(`${kind} order fragment is per-link and exempts only the exact link ceremony`, async ({
		fixture: f,
	}) => {
		await firstLink(f);
		// Future migration-owned columns exist only in this isolated fixture.
		f.db.exec(
			`ALTER TABLE ${current} ADD COLUMN signin_floor INTEGER; ALTER TABLE coordinator_auth_browser_transactions ADD COLUMN start_order INTEGER`,
		);
		f.db.exec(
			`UPDATE ${current} SET signin_floor = 2; UPDATE coordinator_auth_browser_transactions SET start_order = 1`,
		);
		const eligible = () =>
			f.db
				.prepare(
					`SELECT l.link_id FROM ${current} l JOIN coordinator_auth_browser_transactions b ON ${CONNECTION_SIGNIN_ORDER_SQL}`,
				)
				.all();
		expect(eligible()).toHaveLength(1); // Exact own link ceremony, despite earlier order.
		f.db
			.prepare("UPDATE coordinator_auth_browser_transactions SET browser_transaction_hash = ?")
			.run("f".repeat(64));
		expect(eligible()).toEqual([]); // Same attempt alone is not the winning ceremony.
		f.db.exec("UPDATE coordinator_auth_browser_transactions SET attempt_id = 'other'");
		expect(eligible()).toEqual([]);
		f.db.exec(
			"UPDATE coordinator_auth_browser_transactions SET start_order = 3, purpose = 'signin', attempt_id = NULL",
		);
		expect(eligible()).toHaveLength(1);
		f.db.exec("UPDATE coordinator_auth_browser_transactions SET start_order = NULL");
		expect(eligible()).toEqual([]);
		f.db
			.prepare(
				`INSERT INTO ${current} (${columns},signin_floor) VALUES (?,'unrelated','issuer-B','B','other-identity','other-birth','controller',?,0,NULL,'controller_attestation',NULL,0)`,
			)
			.run(f.cfg.coordinatorId, f.cfg.revision);
		f.db.prepare(`UPDATE ${current} SET issuer = ? WHERE link_id = 'unrelated'`).run(f.cfg.issuer);
		f.db.exec("UPDATE coordinator_auth_browser_transactions SET start_order = 1");
		expect(eligible()).toEqual([{ link_id: "unrelated" }]);
	});
}
