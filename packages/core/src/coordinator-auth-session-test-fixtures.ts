import { expect } from "vitest";
import {
	advance,
	authorize,
	backendTest,
	browserHash,
	type LinkFixture,
} from "./coordinator-auth-link-test-fixtures.js";

export { backendTest, browserHash };
export type SessionTest = ReturnType<typeof backendTest>;
export const SESSION_TTL = 28_800_000;
export const REDEEM_WINDOW = 120_000;
export const credentialHash = "e".repeat(64);
export const freshBrowserHash = "f".repeat(64);
export const otherCredentialHash = "1".repeat(64);
export const SESSION_TABLES = [
	"coordinator_auth_session_receipts",
	"coordinator_auth_sessions",
] as const;

export async function linked(f: LinkFixture) {
	await authorize(f);
	await advance(f, "finalized");
}

export function redeemInput() {
	return { attemptId: "attempt-a", browserTransactionHash: browserHash, credentialHash };
}

export function signInInput(f: LinkFixture) {
	return {
		browserTransactionHash: freshBrowserHash,
		credentialHash,
		account: { issuer: f.cfg.issuer, subject: "opaque-subject-a" },
	};
}

export function sessionRows(f: LinkFixture) {
	return SESSION_TABLES.map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
}

// Capture fixture-owned data: sessions must not create device or controller grants.
export function grants(f: LinkFixture) {
	return [
		"groups",
		"enrolled_devices",
		"coordinator_auth_controller_attestations",
		"coordinator_auth_account_links",
		"coordinator_auth_link_audit_log",
	].map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
}

export function linkId(f: LinkFixture): string {
	return (
		f.db.prepare("SELECT link_id FROM coordinator_auth_account_links").get() as { link_id: string }
	).link_id;
}

export function expectIssued(result: unknown, f: LinkFixture) {
	expect(result).toEqual({
		kind: "issued",
		session: {
			sessionId: expect.any(String),
			identityId: "identity-a",
			linkId: linkId(f),
			account: { issuer: f.cfg.issuer, subject: "opaque-subject-a" },
			expiresAtMs: f.now + SESSION_TTL,
		},
	});
}

export function revokeLinkRow(f: LinkFixture) {
	f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms = ?").run(f.now);
}
