// Historical revocation writes every effect in one batch, then three checks in the same
// batch confirm each effect took hold. A trigger that silently drops one effect must make
// its check refuse the whole batch, and the three checks must each name their own effect.
import { afterEach, expect, it, vi } from "vitest";
import { NOW } from "../../cloudflare-coordinator-worker/test/account-change-fixture.js";
import {
	config,
	historicalRevokeFixture,
} from "../../cloudflare-coordinator-worker/test/account-historical-revoke-fixture.js";
import { historicalRevocationChecks } from "./coordinator-account-historical-revoke.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { type Fixture, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import type { D1CoordinatorStore } from "./d1-coordinator-store.js";

const open: Fixture[] = [];
afterEach(async () => {
	for (const f of open.splice(0)) {
		await f.store.close();
		if (f.db.open) f.db.close();
	}
	vi.restoreAllMocks();
});

const TABLES = [
	"coordinator_auth_account_links",
	"coordinator_auth_account_connection_history",
	"coordinator_auth_link_audit_log",
	"coordinator_auth_sessions",
];

/** A historical link A, its Identity's current link B, and a live session of that Identity. */
async function fixture() {
	const base = setupStore("D1", { authClock: () => NOW });
	open.push(base);
	const backend: AuthLinkBackend = {
		first: async <T>({ sql, values }: AuthLinkStatement) =>
			(base.db.prepare(sql).get(...values) as T | undefined) ?? null,
		run: async ({ sql, values }) => base.db.prepare(sql).run(...values).changes,
		batch: async (statements) =>
			base.db
				.transaction(() =>
					statements.map(({ sql, values }) => base.db.prepare(sql).run(...values).changes),
				)
				.immediate(),
	};
	const f = await historicalRevokeFixture(base.store as D1CoordinatorStore, backend);
	base.db
		.prepare(`INSERT INTO coordinator_auth_sessions (coordinator_id,session_id,credential_hash,
		browser_transaction_hash,link_id,identity_id,issuer,subject,auth_config_revision,created_at_ms,
		expires_at_ms,revoked_at_ms) SELECT coordinator_id,'live-session',?,?,link_id,identity_id,issuer,
		subject,auth_config_revision,created_at_ms,created_at_ms+28800000,NULL
		FROM coordinator_auth_account_links WHERE link_id=?`)
		.run("e".repeat(64), "f".repeat(64), f.b);
	const snapshot = () => TABLES.map((table) => base.db.prepare(`SELECT * FROM ${table}`).all());
	const checks = () =>
		historicalRevocationChecks(config.coordinatorId, f.a).map(
			({ sql, values }) => (base.db.prepare(sql).get(...values) as { ok: number }).ok,
		);
	return { ...f, db: base.db, snapshot, checks };
}

// Each fault drops one effect without an error. The check it defeats is named. A trigger
// on the history table would make the connection schema unsupported, so the requested
// row's own revocation is covered through its receipt.
const FAULTS = {
	"requested receipt (first check)": (a: string) =>
		`CREATE TRIGGER fixture_fault BEFORE INSERT ON coordinator_auth_link_audit_log WHEN NEW.action='link_revoked' AND NEW.link_id='${a}' BEGIN SELECT RAISE(IGNORE); END`,
	"current receipt (second check)": (_a: string, b: string) =>
		`CREATE TRIGGER fixture_fault BEFORE INSERT ON coordinator_auth_link_audit_log WHEN NEW.action='link_revoked' AND NEW.link_id='${b}' BEGIN SELECT RAISE(IGNORE); END`,
	"session revocation (third check)": () =>
		"CREATE TRIGGER fixture_fault BEFORE UPDATE OF revoked_at_ms ON coordinator_auth_sessions BEGIN SELECT RAISE(IGNORE); END",
} as const;

it.each(Object.keys(FAULTS) as (keyof typeof FAULTS)[])(
	"a dropped %s refuses the whole revocation",
	async (fault) => {
		// Arrange
		const f = await fixture();
		f.db.exec(FAULTS[fault](f.a, f.b));
		const before = f.snapshot();
		// Act
		const revoke = f.sessions.revokeAuthAccountLink({ linkId: f.a }, config);
		// Assert: no effect survives, not even those the trigger allowed.
		await expect(revoke).rejects.toThrow(/^auth_session_persistence_error$/);
		expect(f.snapshot()).toEqual(before);
	},
);

it("names each unfinished effect in its own check", async () => {
	// Arrange: a complete revocation.
	const f = await fixture();
	expect(await f.sessions.revokeAuthAccountLink({ linkId: f.a }, config)).toEqual({
		kind: "revoked",
	});
	const unrevoke = (sql: string, ...values: string[]) => f.db.prepare(sql).run(...values);
	// Act, Assert: each undone effect fails only the check that confirms it.
	expect(f.checks()).toEqual([1, 1, 1]);
	unrevoke(
		"UPDATE coordinator_auth_sessions SET revoked_at_ms=NULL WHERE session_id='live-session'",
	);
	expect(f.checks()).toEqual([1, 1, 0]);
	unrevoke("UPDATE coordinator_auth_account_links SET revoked_at_ms=NULL WHERE link_id=?", f.b);
	expect(f.checks()).toEqual([1, 0, 0]);
	unrevoke(
		"DELETE FROM coordinator_auth_link_audit_log WHERE action='link_revoked' AND link_id=?",
		f.a,
	);
	expect(f.checks()).toEqual([0, 0, 0]);
});
