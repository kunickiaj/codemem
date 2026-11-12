// Revokes the same historical account link twice on identical fixtures: once with the
// ported statements, whose completion check is three plain statements, and once with the
// statements as they were at 075d46647, whose check was one nested statement. Each
// condition of a complete revocation is flipped either before the revoking batch or after
// it, for both link authorities. The batch outcome and rows, and the completion verdict,
// must agree.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NOW } from "../../cloudflare-coordinator-worker/test/account-change-fixture.js";
import {
	config,
	historicalRevokeFixture,
} from "../../cloudflare-coordinator-worker/test/account-historical-revoke-fixture.js";
import {
	historicalRevocationChecks,
	historicalRevocationStatements,
} from "./coordinator-account-historical-revoke.js";
import {
	originalHistoricalRevocationReadSql,
	originalHistoricalRevocationStatements,
} from "./coordinator-account-historical-revoke-original-sql-test-fixtures.js";
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

type Authority = "controller_attestation" | "device_claim";
type Stage = "batch" | "verdict";
type Change = (f: Fixture, links: { a: string; b: string }) => void;
const AUDIT = "coordinator_auth_link_audit_log";
const TABLES = [
	"coordinator_auth_account_links",
	"coordinator_auth_account_connection_history",
	AUDIT,
	"coordinator_auth_sessions",
];

/** Every condition the completion check reads: receipts, provenance, revocation, sessions. */
const CHANGES: Record<string, Change> = {
	none: () => undefined,
	"requested birth audit": (f, { a }) =>
		f.db
			.prepare(`UPDATE ${AUDIT} SET identity_id='forged' WHERE link_id=? AND action='link_created'`)
			.run(a),
	"current birth audit": (f, { b }) =>
		f.db
			.prepare(`UPDATE ${AUDIT} SET identity_id='forged' WHERE link_id=? AND action='link_created'`)
			.run(b),
	"current birth attempt": (f, { b }) =>
		f.db
			.prepare(
				"UPDATE coordinator_auth_link_attempts SET account_subject='changed' WHERE link_id=?",
			)
			.run(b),
	"current revoke receipt deleted": (f, { b }) =>
		f.db.prepare(`DELETE FROM ${AUDIT} WHERE link_id=? AND action='link_revoked'`).run(b),
	"current revoke receipt time": (f, { b }) =>
		f.db
			.prepare(
				`UPDATE ${AUDIT} SET created_at_ms=created_at_ms+1 WHERE link_id=? AND action='link_revoked'`,
			)
			.run(b),
	"requested revoke receipt deleted": (f, { a }) =>
		f.db.prepare(`DELETE FROM ${AUDIT} WHERE link_id=? AND action='link_revoked'`).run(a),
	"current link unrevoked": (f, { b }) =>
		f.db
			.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms=NULL WHERE link_id=?")
			.run(b),
	"live session": (f, { b }) => liveSession(f, b),
	// The batch's own session revocation silently does nothing, so only the session check
	// can see the session stay live.
	"session kept live by a trigger": (f, { b }) => {
		liveSession(f, b);
		f.db.exec(
			"CREATE TRIGGER fixture_keep_session_live BEFORE UPDATE OF revoked_at_ms ON coordinator_auth_sessions BEGIN SELECT RAISE(IGNORE); END",
		);
	},
	"unrelated identity's live link": (f, { b }) => {
		const columns = (
			f.db.prepare("PRAGMA table_info(coordinator_auth_account_links)").all() as { name: string }[]
		).map(({ name }) => name);
		// A copy of B with every unique identifier fresh, so the insert lands.
		const fresh: Record<string, string> = {
			link_id: "'unrelated-link'",
			identity_id: "'unrelated-identity'",
			subject: "'unrelated-subject'",
			attempt_id: "'unrelated-attempt'",
			device_claim_id: "CASE WHEN device_claim_id IS NULL THEN NULL ELSE 'unrelated-claim' END",
			revoked_at_ms: "NULL",
		};
		const select = columns.map((column) => fresh[column] ?? column);
		f.db
			.prepare(
				`INSERT INTO coordinator_auth_account_links (${columns.join(",")}) SELECT ${select.join(",")} FROM coordinator_auth_account_links WHERE link_id=?`,
			)
			.run(b);
	},
};

function liveSession(f: Fixture, link: string) {
	f.db
		.prepare(`INSERT INTO coordinator_auth_sessions (coordinator_id,session_id,credential_hash,
		browser_transaction_hash,link_id,identity_id,issuer,subject,auth_config_revision,created_at_ms,
		expires_at_ms,revoked_at_ms) SELECT coordinator_id,'raced-session',?,?,link_id,identity_id,issuer,
		subject,auth_config_revision,created_at_ms,created_at_ms+28800000,NULL
		FROM coordinator_auth_account_links WHERE link_id=?`)
		.run("e".repeat(64), "f".repeat(64), link);
}

async function revoked(authority: Authority) {
	// Identical fixtures need identical link IDs, so their rows compare exactly.
	let next = 0;
	vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(
		() => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
	);
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
	const f = await historicalRevokeFixture(base.store as D1CoordinatorStore, backend, authority);
	return { base, backend, links: { a: f.a, b: f.b }, sessions: f.sessions, clock: f.clock };
}

const rows = (f: Fixture) => TABLES.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
const tryChange = (change: Change, f: Fixture, links: { a: string; b: string }) => {
	try {
		change(f, links);
		return "changed";
	} catch (error) {
		// Reported, so a change that never lands fails its case instead of passing silently.
		return `refused: ${String(error)}`;
	}
};

/** The verdict of one completion check on the current rows. */
function verdict(f: Fixture, a: string, implementation: "ported" | "original") {
	if (implementation === "original")
		return (
			f.db.prepare(originalHistoricalRevocationReadSql()).get(config.coordinatorId, a) !== undefined
		);
	return historicalRevocationChecks(config.coordinatorId, a).every(
		({ sql, values }) => (f.db.prepare(sql).get(...values) as { ok: number }).ok === 1,
	);
}

async function answer(
	authority: Authority,
	change: Change,
	stage: Stage,
	implementation: "ported" | "original",
) {
	const { base: f, backend, links, clock } = await revoked(authority);
	const statements =
		implementation === "ported"
			? historicalRevocationStatements
			: originalHistoricalRevocationStatements;
	const reached: Stage[] = [];
	let applied = "";
	if (stage === "batch") {
		applied = tryChange(change, f, links);
		reached.push("batch");
	}
	const batch = await backend
		.batch(statements(config.coordinatorId, links.a, clock.now))
		.then(() => "committed")
		.catch(
			(error: unknown) =>
				`refused: ${String(error).includes("NOT NULL") ? "check" : String(error)}`,
		);
	if (stage === "verdict") {
		applied = tryChange(change, f, links);
		reached.push("verdict");
	}
	return { reached, applied, batch, verdict: verdict(f, links.a, implementation), rows: rows(f) };
}

for (const authority of ["controller_attestation", "device_claim"] as const)
	describe(`${authority} links: historical revocation equivalence`, () => {
		const cases = Object.entries(CHANGES).flatMap(([name, change]) =>
			(["batch", "verdict"] as const).map((stage) => [`${stage}: ${name}`, change, stage] as const),
		);
		it.each(cases)("%s", async (_name, change, stage) => {
			// Arrange, Act: the same change at the same stage for both statement sets.
			const original = await answer(authority, change, stage, "original");
			const ported = await answer(authority, change, stage, "ported");
			// Assert: both reached the stage, then committed or refused alike, left the same
			// rows, and reached the same completion verdict.
			expect(original.reached).toEqual([stage]);
			expect(original.applied).toBe("changed");
			expect(ported).toEqual(original);
		});
	});
