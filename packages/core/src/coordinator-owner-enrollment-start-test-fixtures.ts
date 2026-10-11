import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { issueBrowserCookie } from "./coordinator-browser-credential.js";
import {
	type BrowserCsrfKey,
	importBrowserCsrfKey,
	issueBrowserCsrfToken,
} from "./coordinator-browser-csrf.js";
import { COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL } from "./coordinator-owner-enrollment-commit.js";
import { commitPendingKey } from "./coordinator-owner-enrollment-commit-test-fixtures.js";

export const ORIGIN = "https://app.example.test";
export const config = {
	enabled: true,
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.google.com",
	redirectUri: `${ORIGIN}/auth/callback`,
	revision: "a".repeat(64),
	clientId: "test-client",
	clientSecret: "test-secret",
};
export const ATTEMPTS = "coordinator_owner_enrollment_attempts";
export const TRANSACTIONS = "coordinator_auth_browser_transactions";
export const hash = (value: string | Uint8Array) =>
	createHash("sha256").update(value).digest("hex");
export const proof = () => randomBytes(32).toString("base64url");

// Actual SQLite transactions model the atomic batch contract, not mocked SQL success.
export function nativeBackend(db: Database.Database, beforeBatch?: () => void): AuthLinkBackend {
	const run = (s: AuthLinkStatement) => db.prepare(s.sql).run(...s.values).changes;
	return {
		first: async <T>(s: AuthLinkStatement) =>
			(db.prepare(s.sql).get(...s.values) as T | undefined) ?? null,
		run: async (s) => db.transaction(() => run(s)).immediate(),
		batch: async (statements) => {
			beforeBatch?.();
			db.transaction(() => {
				for (const s of statements) run(s);
			}).immediate();
		},
	};
}

// Both SELECT snapshots complete before either connection may commit; no sleeps.
export function pairedReadBackends(fixture: OwnerStartFixture): AuthLinkBackend[] {
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	let reads = 0;
	return [fixture.backend, nativeBackend(fixture.second)].map((backend) => ({
		...backend,
		first: async <T>(statement: AuthLinkStatement) => {
			const row = await backend.first<T>(statement);
			if (++reads <= 2) {
				if (reads === 2) release();
				await ready;
			}
			return row;
		},
	}));
}

export interface OwnerStartFixture {
	db: Database.Database;
	second: Database.Database;
	key: ReturnType<typeof commitPendingKey>;
	backend: AuthLinkBackend;
	rows(table: string): Record<string, unknown>[];
	snapshot(): Record<string, unknown>[][];
	close(): void;
}
export function ownerStartFixture(): OwnerStartFixture {
	const directory = mkdtempSync(join(tmpdir(), "owner-start-test-"));
	const path = join(directory, "test.sqlite");
	const { db } = setupStore("SQLite", { databasePath: path, authClock: () => NOW });
	db.exec(COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL);
	const second = new Database(path);
	const key = commitPendingKey();
	const rows = (table: string) =>
		db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[];
	return {
		db,
		second,
		key,
		rows,
		backend: nativeBackend(db),
		snapshot: () =>
			[
				ATTEMPTS,
				TRANSACTIONS,
				"coordinator_device_ownership_bindings",
				"enrolled_devices",
				"groups",
				"coordinator_identity_group_grants",
				"coordinator_owner_enrollment_audit_log",
				"coordinator_auth_account_links",
				"coordinator_auth_sessions",
			].map(rows),
		close: () => {
			second.close();
			db.close();
			rmSync(directory, { recursive: true });
		},
	};
}

export interface BrowserForm {
	csrfKey: BrowserCsrfKey;
	cookie: Awaited<ReturnType<typeof issueBrowserCookie>>;
	fields: Record<string, string>;
	request(changes?: { cookie?: string; origin?: string; fields?: Record<string, string> }): Request;
}
export async function browserForm(attemptId: string, startCode: string): Promise<BrowserForm> {
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const cookie = await issueBrowserCookie("start");
	const csrf = await issueBrowserCsrfToken(csrfKey, cookie.secret, "start", {
		publicOrigin: ORIGIN,
		store: config,
	});
	const fields = { csrf, attempt_id: attemptId, start_code: startCode };
	return {
		csrfKey,
		cookie,
		fields,
		request: (
			changes: { cookie?: string; origin?: string; fields?: Record<string, string> } = {},
		) =>
			new Request(`${ORIGIN}/auth/owner/start`, {
				method: "POST",
				headers: {
					origin: changes.origin ?? ORIGIN,
					cookie: changes.cookie ?? cookie.setCookie.split(";")[0] ?? "",
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams(changes.fields ?? fields),
			}),
	};
}

// Existing account authority only: no enrollment or historical controller device is seeded.
export function seedOwnerCallbackAuthority(f: OwnerStartFixture): void {
	f.db
		.prepare(`INSERT INTO coordinator_auth_account_links
 (coordinator_id,link_id,issuer,subject,identity_id,attempt_id,controller_attestation_id,auth_config_revision,created_at_ms)
 VALUES (?,?,?,?,?,?,?,?,?)`)
		.run(
			config.coordinatorId,
			"link-a",
			config.issuer,
			"fixture-subject",
			"identity-a",
			"historical-attempt",
			"historical-controller",
			"b".repeat(64),
			NOW - 1000,
		);
	for (const [group, revision, archived, revoked] of [
		["group-b", 3, false, false],
		["group-a", 2, false, false],
		["group-archived", 4, true, false],
		["group-revoked", 5, false, true],
	] as const) {
		f.db
			.prepare("INSERT INTO groups (group_id,created_at,archived_at) VALUES (?,?,?)")
			.run(group, new Date(NOW).toISOString(), archived ? new Date(NOW).toISOString() : null);
		f.db
			.prepare(`INSERT INTO coordinator_identity_group_grants
 (coordinator_id,identity_id,group_id,status,revision,source_kind,source_receipt_id,created_at,revoked_at)
 VALUES (?,? ,?,?,?,'controller_attestation','historical-receipt',?,?)`)
			.run(
				config.coordinatorId,
				"identity-a",
				group,
				revoked ? "revoked" : "active",
				revision,
				new Date(NOW).toISOString(),
				revoked ? new Date(NOW).toISOString() : null,
			);
	}
}

// Catch new sessions, receipts, profile, TeamProject grants and all other authority writes.
export function ownerCallbackAuthority(f: OwnerStartFixture): unknown[] {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return tables
		.filter(({ name }) => name !== ATTEMPTS && name !== TRANSACTIONS)
		.map(({ name }) => [name, f.rows(name)]);
}
