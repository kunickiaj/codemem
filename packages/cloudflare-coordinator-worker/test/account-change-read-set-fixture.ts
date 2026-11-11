import {
	changeFixture,
	config,
	hash,
	input,
} from "./account-change-fixture.js";
import type { AuthLinkBackend } from "../../core/src/coordinator-auth-link.js";
import { setupStore, sqliteD1 } from "../../core/src/coordinator-auth-store-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "../../core/src/coordinator-ed25519-key-id-compat.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "../../core/src/coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "../../core/src/recipient-policy-identifiers.js";

export { config, hash, input };
export type ChangeAuthority = "device_claim" | "controller_attestation";

/**
 * The account-change fixture on better-sqlite3 with a raw backend, as the existing
 * account-change tests build it. `beforeNextBatch` runs once, just before the next batch:
 * after a step's reads and decision, before its write.
 */
export async function accountChangeFixture(authority: ChangeAuthority = "device_claim") {
	const base = setupStore("SQLite", { authClock: () => 1791028800000 });
	const db = sqliteD1(base.db);
	const batch = db.batch?.bind(db);
	if (!batch) throw new Error("fixture batch unavailable");
	const hooks: { beforeNextBatch?: () => void } = {};
	const backend: AuthLinkBackend = {
		first: ({ sql, values }) =>
			db
				.prepare(sql)
				.bind(...values)
				.first(),
		all: async <T>({ sql, values }: { sql: string; values: unknown[] }) =>
			base.db.prepare(sql).all(...values) as T[],
		run: async ({ sql, values }) => base.db.prepare(sql).run(...values).changes,
		batch: async (statements) => {
			const hook = hooks.beforeNextBatch;
			hooks.beforeNextBatch = undefined;
			hook?.();
			return batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values)));
		},
	};
	const f = await changeFixture(base.store, backend, authority);
	const keyId = (await ed25519KeyIdForRevocation(input.signer.publicKey)) as string;
	const exec = (sql: string, ...values: unknown[]) => base.db.prepare(sql).run(...values);
	const rows = (sql: string) => base.db.prepare(sql).all() as Record<string, unknown>[];
	const linkId = () =>
		String(rows("SELECT link_id FROM coordinator_auth_account_links")[0]?.link_id);
	return {
		...base,
		...f,
		backend,
		hooks,
		keyId,
		exec,
		rows,
		linkId,
		close: () => base.store.close(),
	};
}
export type AccountChangeFixture = Awaited<ReturnType<typeof accountChangeFixture>>;

/** Inserts a row from named columns. */
export function insertRow(f: AccountChangeFixture, table: string, row: Record<string, unknown>) {
	const columns = Object.keys(row);
	f.exec(
		`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		...Object.values(row),
	);
}

/** A current legacy Team assignment that includes this device under its Identity. */
export function assignLegacyTeam(f: AccountChangeFixture): void {
	const candidateRef = legacyTeamCandidateId(config.coordinatorId, input.signer.groupId);
	const manifest = normalizeCoordinatorLegacyTeamCompletionManifest({
		version: 1,
		coordinator_id: config.coordinatorId,
		candidate_ref: candidateRef,
		candidate_digest: "a".repeat(64),
		team_id: "team-a",
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: input.identityId, role: "member" }],
		device_decisions: [
			{
				device_id: input.signer.deviceId,
				key_fingerprint: input.signer.fingerprint,
				enabled: true,
				identity_id: input.identityId,
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: "2026-10-01T00:00:00.000Z",
	});
	insertRow(f, "coordinator_legacy_team_completions", {
		group_id: input.signer.groupId,
		candidate_ref: candidateRef,
		manifest_version: 1,
		manifest_json: canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest),
		completed_at: manifest.completed_at,
		created_at: manifest.completed_at,
	});
}

/** A link of another Identity, without creation records. */
export function insertForeignLink(f: AccountChangeFixture): void {
	f.exec(`INSERT INTO coordinator_auth_account_links(coordinator_id,link_id,issuer,subject,identity_id,attempt_id,auth_config_revision,created_at_ms,authority_kind,device_claim_id)
 SELECT coordinator_id,'foreign-link',issuer,'foreign-subject','foreign-identity','foreign-attempt',auth_config_revision,1,'device_claim','foreign-claim' FROM coordinator_auth_account_links`);
}

/** A raw revoked history row for the link's Identity; the test drops the archive triggers. */
export function insertRevokedHistory(f: AccountChangeFixture): void {
	const triggers = f.rows(
		"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='coordinator_auth_account_connection_history'",
	);
	for (const { name } of triggers) f.exec(`DROP TRIGGER "${String(name)}"`);
	insertRow(f, "coordinator_auth_account_connection_history", {
		coordinator_id: config.coordinatorId,
		link_id: "old-link",
		issuer: config.issuer,
		subject: "old-subject",
		identity_id: input.identityId,
		attempt_id: "old-attempt",
		controller_attestation_id: "old-controller",
		auth_config_revision: config.revision,
		created_at_ms: 1,
		revoked_at_ms: 2,
		authority_kind: "controller_attestation",
		device_claim_id: null,
		original_rowid: 999,
		ended_at_ms: 3,
		end_attempt_id: "old-end",
	});
}
