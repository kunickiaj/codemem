import { describe, expect } from "vitest";
import {
	advance,
	attempt,
	expectRejected,
	finalize,
	type LinkFixture,
	snapshot,
} from "./coordinator-auth-link-test-fixtures.js";
import {
	backendTest,
	credentialHash,
	grants,
	linked,
	linkId,
	otherCredentialHash,
	redeemInput,
	revokeLinkRow,
	SESSION_TTL,
	type SessionTest,
	sessionRows,
	signInInput,
} from "./coordinator-auth-session-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";

function changeReadAuthority(f: LinkFixture, change: string) {
	const actions: Record<string, () => void> = {
		expired: () => {
			f.now += SESSION_TTL;
		},
		"session-revoked": () => {
			f.db.prepare("UPDATE coordinator_auth_sessions SET revoked_at_ms = ?").run(f.now);
		},
		"link-revoked": () => revokeLinkRow(f),
		"link-identity": () => {
			f.db
				.prepare("UPDATE coordinator_auth_account_links SET identity_id = ?")
				.run("other-identity");
		},
		"link-subject": () => {
			f.db.prepare("UPDATE coordinator_auth_account_links SET subject = ?").run("other-subject");
		},
		"link-missing": () => {
			f.db.exec("DELETE FROM coordinator_auth_account_links");
		},
	};
	actions[change]?.();
}

function registerRead(test: SessionTest) {
	test("reads only server metadata without renewing expiry or mutating storage", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		const issued = await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		const before = sessionRows(f);
		f.now += SESSION_TTL - 1;
		// Act
		const result = await f.store.readAuthSession(credentialHash, f.cfg);
		// Assert
		if (issued.kind !== "issued") throw new Error("fixture_session_not_issued");
		expect(result).toEqual(issued.session);
		expect(sessionRows(f)).toEqual(before);
	});
	test.for([
		"unknown",
		"namespace",
		"revision",
		"issuer",
		"disabled",
		"expired",
		"session-revoked",
		"link-revoked",
		"link-identity",
		"link-subject",
		"link-missing",
	] as const)("read uniformly denies %s without mutation", async (change, { fixture: f }) => {
		// Arrange
		await linked(f);
		await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		const cfg = { ...f.cfg };
		if (change === "namespace") cfg.coordinatorId = "other-coordinator";
		if (change === "revision") cfg.revision = "2".repeat(64);
		if (change === "issuer") cfg.issuer = "https://other.example.test";
		if (change === "disabled") cfg.enabled = false;
		changeReadAuthority(f, change);
		const before = sessionRows(f);
		// Act
		const result = await f.store.readAuthSession(
			change === "unknown" ? otherCredentialHash : credentialHash,
			cfg,
		);
		// Assert
		expect(result).toBeNull();
		expect(sessionRows(f)).toEqual(before);
	});
}

function registerLogout(test: SessionTest) {
	test("logout is idempotent, preserves first revocation time and does not revoke another session or link", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.redeemAuthLinkSession(redeemInput(), f.cfg);
		await f.store.signInWithAuthAccount(
			{ ...signInInput(f), credentialHash: otherCredentialHash },
			f.cfg,
		);
		const before = grants(f);
		const attemptRows = snapshot(f)[0];
		const revokedAt = f.now;
		// Act
		const first = await f.store.signOutAuthSession(credentialHash, {
			coordinatorId: f.cfg.coordinatorId,
		});
		f.now += 1_000;
		const retry = await f.store.signOutAuthSession(credentialHash, {
			coordinatorId: f.cfg.coordinatorId,
		});
		const old = await f.store.readAuthSession(credentialHash, f.cfg);
		const other = await f.store.readAuthSession(otherCredentialHash, f.cfg);
		// Assert
		expect(first).toEqual({ kind: "signed_out" });
		expect(retry).toEqual(first);
		expect(old).toBeNull();
		expect(other).not.toBeNull();
		expect(
			f.db
				.prepare("SELECT revoked_at_ms FROM coordinator_auth_sessions WHERE credential_hash = ?")
				.get(credentialHash),
		).toEqual({ revoked_at_ms: revokedAt });
		expect(grants(f)).toEqual(before);
		expect(snapshot(f)[0]).toEqual(attemptRows);
	});
	test.for(["unknown", "wrong-namespace", "disabled"] as const)(
		"logout handles %s uniformly and touches only its scope",
		async (change, { fixture: f }) => {
			// Arrange
			await linked(f);
			await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
			const before = sessionRows(f);
			if (change === "disabled") f.cfg.enabled = false;
			// Act
			const result = await f.store.signOutAuthSession(
				change === "unknown" ? otherCredentialHash : credentialHash,
				{ coordinatorId: change === "wrong-namespace" ? "other" : f.cfg.coordinatorId },
			);
			// Assert
			expect(result).toEqual({ kind: "signed_out" });
			if (change === "disabled") {
				expect(
					await f.store.readAuthSession(credentialHash, { ...f.cfg, enabled: true }),
				).toBeNull();
				return;
			}
			expect(sessionRows(f)).toEqual(before);
		},
	);
}

function registerRevoke(test: SessionTest) {
	test("trusted link revocation denies all sessions and future sign-in with one timestamped audit", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.redeemAuthLinkSession(redeemInput(), f.cfg);
		await f.store.signInWithAuthAccount(
			{ ...signInInput(f), credentialHash: otherCredentialHash },
			f.cfg,
		);
		const deviceGrants = grants(f).slice(0, 3);
		const id = linkId(f);
		const revokedAt = f.now;
		// Act
		const first = await f.store.revokeAuthAccountLink(
			{ linkId: id },
			{ coordinatorId: f.cfg.coordinatorId },
		);
		f.now += 1_000;
		const retry = await f.store.revokeAuthAccountLink(
			{ linkId: id },
			{ coordinatorId: f.cfg.coordinatorId },
		);
		const sessions = await Promise.all([
			f.store.readAuthSession(credentialHash, f.cfg),
			f.store.readAuthSession(otherCredentialHash, f.cfg),
		]);
		const signIn = await f.store.signInWithAuthAccount(
			{ ...signInInput(f), browserTransactionHash: "4".repeat(64), credentialHash: "5".repeat(64) },
			f.cfg,
		);
		// Assert
		expect(first).toEqual({ kind: "revoked" });
		expect(retry).toEqual(first);
		expect(sessions).toEqual([null, null]);
		expectRejected(signIn, "account_not_linked");
		expect(f.db.prepare("SELECT revoked_at_ms FROM coordinator_auth_account_links").get()).toEqual({
			revoked_at_ms: revokedAt,
		});
		expect(
			f.db
				.prepare(
					"SELECT action, created_at_ms FROM coordinator_auth_link_audit_log WHERE action = 'link_revoked'",
				)
				.all(),
		).toEqual([{ action: "link_revoked", created_at_ms: revokedAt }]);
		expect(grants(f).slice(0, 3)).toEqual(deviceGrants);
	});
	test.for(["missing", "wrong-namespace"] as const)(
		"link revocation rejects %s without changes",
		async (change, { fixture: f }) => {
			// Arrange
			await linked(f);
			const before = snapshot(f);
			// Act
			const result = await f.store.revokeAuthAccountLink(
				{ linkId: change === "missing" ? "missing" : linkId(f) },
				{ coordinatorId: change === "wrong-namespace" ? "other" : f.cfg.coordinatorId },
			);
			// Assert
			expectRejected(result, "link_unavailable");
			expect(snapshot(f)).toEqual(before);
		},
	);
	test("audit failure rolls back link revocation so the session remains readable", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		const before = snapshot(f);
		f.db.exec(
			"CREATE TRIGGER fixture_revoke_fault BEFORE INSERT ON coordinator_auth_link_audit_log WHEN NEW.action = 'link_revoked' BEGIN SELECT RAISE(ABORT, 'fixture-private-backend-detail'); END",
		);
		// Act
		const result = f.store.revokeAuthAccountLink(
			{ linkId: linkId(f) },
			{ coordinatorId: f.cfg.coordinatorId },
		);
		// Assert
		await expect(result).rejects.toThrow(/^auth_session_persistence_error$/);
		expect(snapshot(f)).toEqual(before);
		expect(await f.store.readAuthSession(credentialHash, f.cfg)).not.toBeNull();
	});
	test("revoked account tombstone still blocks a new account-link finalization", async ({
		fixture: f,
	}) => {
		// Arrange
		await linked(f);
		await f.store.revokeAuthAccountLink(
			{ linkId: linkId(f) },
			{ coordinatorId: f.cfg.coordinatorId },
		);
		await advance(
			f,
			"oidc_verified",
			attempt({ attemptId: "attempt-b", runtimeVerifierHash: "6".repeat(64) }),
			"7".repeat(64),
		);
		const confirmed = await f.store.confirmAuthLinkAttempt(
			{
				attemptId: "attempt-b",
				browserTransactionHash: "7".repeat(64),
				completionSecretHash: "8".repeat(64),
			},
			f.cfg,
		);
		expect(confirmed.kind).toBe("applied");
		// Act
		const result = await f.store.finalizeAuthLinkAttempt(
			finalize({
				attemptId: "attempt-b",
				runtimeVerifierHash: "6".repeat(64),
				completionSecretHash: "8".repeat(64),
			}),
			f.cfg,
		);
		const rows = f.db.prepare("SELECT * FROM coordinator_auth_account_links").all();
		// Assert
		expectRejected(result, "link_conflict");
		expect(rows).toHaveLength(1);
		expect(f.db.prepare("SELECT revoked_at_ms FROM coordinator_auth_account_links").get()).toEqual({
			revoked_at_ms: f.now,
		});
	});
}

function registerAuditGap(test: SessionTest) {
	test("missing creation audit leaves revocation effective but reports incomplete persistence on every retry", async ({
		fixture: f,
	}) => {
		// Arrange: corrupt only this fixture's creation audit, never restore active access.
		await linked(f);
		const issued = await f.store.signInWithAuthAccount(signInInput(f), f.cfg);
		expect(issued.kind).toBe("issued");
		expect(await f.store.readAuthSession(credentialHash, f.cfg)).not.toBeNull();
		const id = linkId(f);
		const scope = { coordinatorId: f.cfg.coordinatorId };
		f.db
			.prepare(
				"DELETE FROM coordinator_auth_link_audit_log WHERE coordinator_id = ? AND link_id = ? AND action = 'link_created'",
			)
			.run(scope.coordinatorId, id);
		const auditRows = () =>
			f.db
				.prepare(
					"SELECT * FROM coordinator_auth_link_audit_log WHERE coordinator_id = ? AND link_id = ?",
				)
				.all(scope.coordinatorId, id);
		const beforeAudit = auditRows();
		const revokedAt = f.now;
		// Act: the thrown result cannot imply that the committed revocation was rolled back.
		const first = await f.store
			.revokeAuthAccountLink({ linkId: id }, scope)
			.catch((error: unknown) => error);
		const afterFirst = f.db
			.prepare(
				"SELECT revoked_at_ms FROM coordinator_auth_account_links WHERE coordinator_id = ? AND link_id = ?",
			)
			.get(scope.coordinatorId, id);
		const session = await f.store.readAuthSession(credentialHash, f.cfg);
		const signIn = await f.store.signInWithAuthAccount(
			{ ...signInInput(f), browserTransactionHash: "4".repeat(64), credentialHash: "5".repeat(64) },
			f.cfg,
		);
		f.now += 1_000;
		const retry = await f.store
			.revokeAuthAccountLink({ linkId: id }, scope)
			.catch((error: unknown) => error);
		// Assert
		expect(first).toEqual(new Error("auth_session_persistence_incomplete"));
		expect(retry).toEqual(new Error("auth_session_persistence_incomplete"));
		expect(afterFirst).toEqual({ revoked_at_ms: revokedAt });
		expect(
			f.db
				.prepare(
					"SELECT revoked_at_ms FROM coordinator_auth_account_links WHERE coordinator_id = ? AND link_id = ?",
				)
				.get(scope.coordinatorId, id),
		).toEqual(afterFirst);
		expect(session).toBeNull();
		expect(await f.store.readAuthSession(credentialHash, f.cfg)).toBeNull();
		expectRejected(signIn, "account_not_linked");
		expect(beforeAudit).toEqual([]);
		expect(auditRows()).toEqual(beforeAudit);
	});
}

function registerBackend(backend: Backend) {
	const test = backendTest(backend);
	registerRead(test);
	registerLogout(test);
	registerRevoke(test);
	registerAuditGap(test);
}
describe.each(["SQLite", "D1"] as const)(
	"%s auth-session lifecycle (D1 is SQLite-backed)",
	registerBackend,
);
