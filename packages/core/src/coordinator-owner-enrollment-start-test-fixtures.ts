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
