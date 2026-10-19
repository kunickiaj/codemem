import { afterEach, expect, it, vi } from "vitest";
import { NOW } from "../../cloudflare-coordinator-worker/test/account-change-fixture.js";
import {
	config,
	historicalRevokeFixture,
} from "../../cloudflare-coordinator-worker/test/account-historical-revoke-fixture.js";
import { ownerRevokeJourney } from "../../cloudflare-coordinator-worker/test/account-owner-revoke-journey.js";
import { AuthAccountProfileOperations } from "./coordinator-auth-account-profile.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { AuthSessionOperations } from "./coordinator-auth-session.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL } from "./coordinator-owner-enrollment-commit.js";
import { commitPendingKey } from "./coordinator-owner-enrollment-commit-test-fixtures.js";
import type { D1CoordinatorStore } from "./d1-coordinator-store.js";

afterEach(() => vi.restoreAllMocks());
async function fixture(
	authority: "controller_attestation" | "device_claim" = "controller_attestation",
) {
	const base = setupStore("D1", { authClock: () => NOW });
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
	try {
		const f = await historicalRevokeFixture(base.store as D1CoordinatorStore, backend, authority);
		await backend.run({ sql: COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL, values: [] });
		const rows = (table: string) =>
			base.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
		const ownership = () =>
			[
				"enrolled_devices",
				"coordinator_device_ownership_bindings",
				"coordinator_identity_group_grants",
				"coordinator_owner_enrollment_audit_log",
			].map(rows);
		const snapshot = () =>
			[
				"coordinator_auth_account_links",
				"coordinator_auth_account_connection_history",
				"coordinator_auth_link_audit_log",
				"coordinator_auth_sessions",
			].map(rows);
		return {
			...base,
			...f,
			rows,
			ownership,
			snapshot,
			close: async () => {
				await base.store.close();
				if (base.db.open) base.db.close();
			},
		};
	} catch (error) {
		await base.store.close();
		if (base.db.open) base.db.close();
		throw error;
	}
}

function seedDisplayRows(f: Awaited<ReturnType<typeof fixture>>) {
	f.db.exec(`INSERT INTO coordinator_auth_account_profiles (coordinator_id,link_id,display_name,source_session_id,source_signed_in_at_ms)
 SELECT coordinator_id,link_id,'Private display','display-session',created_at_ms FROM coordinator_auth_account_links`);
	f.db.exec(`INSERT INTO coordinator_auth_link_profiles (coordinator_id,attempt_id,issuer,subject,auth_config_revision,browser_transaction_hash,link_id,verified_at_ms,display_name)
 SELECT l.coordinator_id,l.attempt_id,l.issuer,l.subject,l.auth_config_revision,a.browser_transaction_hash,l.link_id,l.created_at_ms,'Private display'
 FROM coordinator_auth_account_links l JOIN coordinator_auth_link_attempts a ON a.coordinator_id=l.coordinator_id AND a.attempt_id=l.attempt_id`);
	for (const table of ["coordinator_auth_account_profiles", "coordinator_auth_link_profiles"]) {
		const columns = (f.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
			(c) => c.name,
		);
		f.db.exec(
			`INSERT INTO ${table} SELECT ${columns.map((c) => (c === "coordinator_id" ? "'unrelated-coordinator'" : c)).join(",")} FROM ${table}`,
		);
	}
}
it("historical A cleanup removes only revoked current C display rows after A-B-C", async () => {
	const f = await fixture();
	try {
		await f.unlink(2, "account-B");
		const c = await f.link(3, "account-C");
		seedDisplayRows(f);
		const profiles = new AuthAccountProfileOperations(f.backend, () => f.clock.now);
		const clear = (linkId: string) => profiles.clearRevokedAuthAccountProfile({ linkId }, config);
		for (const linkId of ["unknown", f.a, f.b, c])
			expect(await clear(linkId)).toEqual({ kind: "cleared", deletedCount: 0 });
		expect(await f.sessions.revokeAuthAccountLink({ linkId: f.a }, config)).toEqual({
			kind: "revoked",
		});
		const before = f.snapshot();
		f.db
			.prepare(
				"UPDATE coordinator_auth_link_audit_log SET identity_id='forged' WHERE link_id=? AND action='link_created'",
			)
			.run(f.a);
		expect(await clear(f.a)).toEqual({ kind: "cleared", deletedCount: 0 });
		f.db
			.prepare(
				"UPDATE coordinator_auth_link_audit_log SET identity_id=(SELECT identity_id FROM coordinator_auth_account_connection_history WHERE link_id=?) WHERE link_id=? AND action='link_created'",
			)
			.run(f.a, f.a);
		expect(await clear(f.a)).toEqual({ kind: "cleared", deletedCount: 2 });
		for (const table of ["coordinator_auth_account_profiles", "coordinator_auth_link_profiles"]) {
			expect(f.rows(table)).toMatchObject([{ coordinator_id: "unrelated-coordinator" }]);
			expect(f.rows(table)).toHaveLength(1);
		}
		expect(await clear(f.a)).toEqual({ kind: "cleared", deletedCount: 0 });
		expect(f.snapshot()).toEqual(before);
	} finally {
		await f.close();
	}
});

it("failed optional profile cleanup never undoes historical revocation", async () => {
	const f = await fixture();
	try {
		expect(await f.sessions.revokeAuthAccountLink({ linkId: f.a }, config)).toEqual({
			kind: "revoked",
		});
		const revoked = f.snapshot();
		f.db.exec("DROP TABLE coordinator_auth_account_profiles");
		await expect(
			new AuthAccountProfileOperations(f.backend).clearRevokedAuthAccountProfile(
				{ linkId: f.a },
				config,
			),
		).rejects.toThrow();
		expect(f.snapshot()).toEqual(revoked);
	} finally {
		await f.close();
	}
});

it.each(["current", "historical"] as const)(
	"%s admin revocation remains permanent after clock rollback before link birth",
	async (target) => {
		const f = await fixture();
		try {
			f.clock.now = NOW - 1000;
			const linkId = target === "current" ? f.b : f.a;
			expect(await f.sessions.revokeAuthAccountLink({ linkId }, config)).toEqual({
				kind: "revoked",
			});
			const current = f.rows("coordinator_auth_account_links")[0];
			expect(current?.revoked_at_ms).toBe(f.clock.now);
			expect(Number(current?.created_at_ms)).toBeGreaterThan(f.clock.now);
			if (target === "historical")
				expect(
					f.rows("coordinator_auth_account_connection_history").find((h) => h.link_id === f.a)
						?.revoked_at_ms,
				).toBe(f.clock.now);
			expect(
				f
					.rows("coordinator_auth_link_audit_log")
					.filter((a) => a.action === "link_revoked")
					.every((a) => a.created_at_ms === f.clock.now),
			).toBe(true);
			const snapshot = f.snapshot();
			f.clock.now = NOW + 1000;
			expect(await f.sessions.revokeAuthAccountLink({ linkId }, config)).toEqual({
				kind: "revoked",
			});
			expect(f.snapshot()).toEqual(snapshot);
		} finally {
			await f.close();
		}
	},
);

it.each(["controller_attestation", "device_claim"] as const)(
	"%s historical revocation marks the new A and audits both births without removing device access",
	async (authority) => {
		const f = await fixture(authority);
		try {
			await f.unlink(2, "account-B");
			const active = await f.link(3, "account-A");
			const before = f.ownership().slice(0, 3);
			f.clock.now += 100;
			expect(await f.sessions.revokeAuthAccountLink({ linkId: f.a }, config)).toEqual({
				kind: "revoked",
			});
			expect(f.rows("coordinator_auth_account_links")).toMatchObject([
				{ link_id: active, revoked_at_ms: f.clock.now },
			]);
			expect(
				f.rows("coordinator_auth_account_connection_history").find((h) => h.link_id === f.a),
			).toMatchObject({ revoked_at_ms: f.clock.now });
			expect(
				f.rows("coordinator_auth_link_audit_log").filter((a) => a.action === "link_revoked"),
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ link_id: f.a, created_at_ms: f.clock.now }),
					expect.objectContaining({ link_id: active, created_at_ms: f.clock.now }),
				]),
			);
			expect(f.ownership().slice(0, 3)).toEqual(before);
			const committed = f.snapshot();
			f.clock.now += 100;
			f.db.exec(
				"CREATE TRIGGER fixture_no_duplicate_audit BEFORE INSERT ON coordinator_auth_link_audit_log WHEN NEW.action='link_revoked' BEGIN SELECT RAISE(ABORT,'duplicate insertion'); END",
			);
			expect(await f.sessions.revokeAuthAccountLink({ linkId: f.a }, config)).toEqual({
				kind: "revoked",
			});
			expect(f.snapshot()).toEqual(committed);
		} finally {
			await f.close();
		}
	},
);

it.each(["ignored_current", "ignored_audit", "failed_audit"])(
	"%s cannot leave a partial barrier or false revocation receipt",
	async (fault) => {
		const f = await fixture();
		try {
			const before = f.snapshot();
			if (fault === "ignored_current")
				f.db.exec(
					"CREATE TRIGGER fixture_revoke_fault BEFORE UPDATE OF revoked_at_ms ON coordinator_auth_account_links BEGIN SELECT RAISE(IGNORE); END",
				);
			else
				f.db.exec(
					`CREATE TRIGGER fixture_revoke_fault BEFORE INSERT ON coordinator_auth_link_audit_log WHEN NEW.action='link_revoked' BEGIN SELECT RAISE(${fault === "ignored_audit" ? "IGNORE" : "ABORT,'injected'"}); END`,
				);
			await expect(f.sessions.revokeAuthAccountLink({ linkId: f.a }, config)).rejects.toThrow(
				/^auth_session_persistence_error$/,
			);
			expect(f.snapshot()).toEqual(before);
		} finally {
			await f.close();
		}
	},
);

it("unknown IDs do nothing and a failed post-commit read never reports success or rewrites the first receipt", async () => {
	const f = await fixture();
	try {
		const before = f.snapshot();
		expect(await f.sessions.revokeAuthAccountLink({ linkId: "unknown" }, config)).toEqual({
			kind: "rejected",
			error: "link_unavailable",
		});
		expect(f.snapshot()).toEqual(before);
		const failing = new AuthSessionOperations(
			{
				...f.backend,
				first: async <T>(s: AuthLinkStatement) => {
					if (s.sql.startsWith("/* historical_revocation_complete */"))
						throw new Error("private read failure");
					return f.backend.first<T>(s);
				},
			},
			() => f.clock.now,
		);
		await expect(failing.revokeAuthAccountLink({ linkId: f.a }, config)).rejects.toThrow(
			/^auth_session_persistence_error$/,
		);
		expect(f.rows("coordinator_auth_account_links")).toMatchObject([
			{ link_id: f.b, revoked_at_ms: f.clock.now },
		]);
		const committed = f.snapshot();
		f.clock.now += 100;
		expect(await f.sessions.revokeAuthAccountLink({ linkId: f.a }, config)).toEqual({
			kind: "revoked",
		});
		expect(f.snapshot()).toEqual(committed);
	} finally {
		await f.close();
	}
});

it("real owner callback, confirmation and winning commit all reject B after historical A is revoked", async () => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live network forbidden"));
	const f = await fixture();
	try {
		const callback = await ownerRevokeJourney(f.backend, commitPendingKey(), 1, f.clock);
		const confirm = await ownerRevokeJourney(f.backend, commitPendingKey(), 2, f.clock),
			verified = await confirm.verified();
		const commit = await ownerRevokeJourney(f.backend, commitPendingKey(), 3, f.clock),
			verifiedCommit = await commit.verified(),
			completion = await commit.confirmed(verifiedCommit);
		const before = f.ownership();
		expect(await f.sessions.revokeAuthAccountLink({ linkId: f.a }, config)).toEqual({
			kind: "revoked",
		});
		expect(await callback.api.verifyCallback(callback.callbackRequest())).toMatchObject({
			kind: "rejected",
		});
		expect(
			await confirm.api.confirm(
				verified.request(),
				"browser-2",
				verified.result.confirmation.confirmationHash,
			),
		).toMatchObject({ kind: "rejected" });
		expect(await commit.api.finalize(completion)).toMatchObject({ kind: "rejected" });
		expect(f.ownership()).toEqual(before);
		expect(
			f.rows("coordinator_owner_enrollment_attempts").every((a) => a.state !== "finalized"),
		).toBe(true);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		await f.close();
	}
});
