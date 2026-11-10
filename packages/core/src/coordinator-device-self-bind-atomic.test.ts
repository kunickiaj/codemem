import { afterEach, describe, expect, it } from "vitest";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import type { DeviceRebindAttempt } from "./coordinator-device-rebind-proof.js";
import { selfBindFixture } from "./coordinator-device-self-bind-test-fixtures.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0)) await fn();
});
type Fixture = Awaited<ReturnType<typeof selfBindFixture>>;
function assertUnbound(f: Fixture) {
	expect(f.db.prepare("SELECT * FROM coordinator_device_ownership_bindings").all()).toEqual([]);
	expect(f.db.prepare("SELECT * FROM coordinator_device_rebind_audit_log").all()).toEqual([]);
	expect(
		f.db
			.prepare(
				"SELECT identity_id FROM enrolled_devices WHERE device_id='device-a' ORDER BY group_id",
			)
			.all(),
	).toEqual([{ identity_id: null }, { identity_id: f.identityId }]);
}
async function prepared(kind: "SQLite" | "D1") {
	const f = await selfBindFixture(kind, "peer");
	close.push(f.close);
	const s = f.steps();
	expect(await s.start()).toMatchObject({ kind: "started" });
	expect(await s.claim()).toMatchObject({ kind: "browser_claimed" });
	expect(await s.verify()).toMatchObject({ kind: "verified" });
	const result = await s.confirm();
	if (result?.kind !== "confirmed") throw new Error(JSON.stringify(result));
	return {
		...f,
		final: f.finalizedInput(
			f.db.prepare("SELECT * FROM coordinator_device_rebind_attempts").get() as DeviceRebindAttempt,
			result.completionSecret,
		),
	};
}

describe.each(["SQLite", "D1"] as const)("%s self-bind winning statements", (kind) => {
	it("connects the exact reviewed current Identity when every enrollment is NULL", async () => {
		// Arrange: the unique own review supplies the current Identity, never an alternate choice.
		const f = await selfBindFixture(kind, "peer_controller", "named-current-identity");
		close.push(f.close);
		f.db.exec("UPDATE enrolled_devices SET identity_id=NULL WHERE device_id='device-a'");
		const s = f.steps();
		// Act
		const start = await s.start();
		expect(start).toMatchObject({ kind: "started" });
		expect(await s.claim()).toMatchObject({ kind: "browser_claimed" });
		expect(await s.verify()).toMatchObject({ kind: "verified" });
		const confirmed = await s.confirm();
		if (confirmed?.kind !== "confirmed") throw new Error(JSON.stringify(confirmed));
		const input = f.finalizedInput(
			f.db.prepare("SELECT * FROM coordinator_device_rebind_attempts").get() as DeviceRebindAttempt,
			confirmed.completionSecret,
		);
		const result = await f.makeCeremony(f.backend).finalize(input);
		// Assert
		expect(result).toMatchObject({
			kind: "finalized",
			receipt: { previousIdentityId: f.identityId, targetIdentityId: f.identityId },
		});
		expect(
			f.db.prepare("SELECT identity_id FROM enrolled_devices WHERE device_id='device-a'").all(),
		).toEqual([{ identity_id: f.identityId }, { identity_id: f.identityId }]);
	});
	it("recomputes authority after preflight and before the winning commit", async () => {
		// Arrange
		const f = await prepared(kind);
		const racing: AuthLinkBackend = {
			...f.backend,
			batch: async (statements) => {
				f.db.exec(
					"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='changed' WHERE device_id='device-a'",
				);
				return f.backend.batch(statements);
			},
		};
		// Act
		const result = await f.makeCeremony(racing).finalize(f.final);
		// Assert
		expect(result?.kind).toBe("refused");
		assertUnbound(f);
	});

	it("rolls back a zero-row NULL enrollment fill", async () => {
		// Arrange
		const f = await prepared(kind);
		f.db.exec(
			"CREATE TRIGGER ignore_null_fill BEFORE UPDATE ON enrolled_devices WHEN OLD.identity_id IS NULL BEGIN SELECT RAISE(IGNORE); END",
		);
		// Act
		const result = await f.makeCeremony(f.backend).finalize(f.final);
		// Assert
		expect(result).toEqual({ kind: "unknown" });
		assertUnbound(f);
		expect(f.db.prepare("SELECT state FROM coordinator_device_rebind_attempts").get()).toEqual({
			state: "confirmed",
		});
	});

	it("does not promote a NULL ordinary attempt when own proof appears after start", async () => {
		// Arrange
		const f = await selfBindFixture(kind, "peer");
		close.push(f.close);
		const controller = f.db
			.prepare("SELECT * FROM coordinator_auth_controller_attestations WHERE device_id='device-a'")
			.get() as Record<string, unknown>;
		f.db.exec("DELETE FROM coordinator_auth_controller_attestations WHERE device_id='device-a'");
		const s = f.steps();
		expect(await s.start()).toMatchObject({ kind: "started" });
		expect(
			f.db.prepare("SELECT start_authority_json FROM coordinator_device_rebind_attempts").get(),
		).toEqual({ start_authority_json: null });
		const keys = Object.keys(controller);
		f.db
			.prepare(
				`INSERT INTO coordinator_auth_controller_attestations(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
			)
			.run(...Object.values(controller));
		// Act
		const result = await s.claim();
		// Assert
		expect(result?.kind).not.toBe("browser_claimed");
		assertUnbound(f);
		expect(() =>
			f.db.exec("UPDATE coordinator_device_rebind_attempts SET start_authority_json='{}'"),
		).toThrow(/immutable/);
	});

	it("refuses a freshly verified Google account linked to a different Identity", async () => {
		// Arrange
		const f = await selfBindFixture(kind, "peer");
		close.push(f.close);
		f.db
			.prepare(
				"INSERT INTO coordinator_auth_account_links(coordinator_id,link_id,issuer,subject,identity_id,attempt_id,auth_config_revision,created_at_ms,authority_kind,device_claim_id) VALUES(?,'foreign-link',?,'foreign-subject','foreign-identity','foreign-attempt',?,1,'device_claim','foreign-claim')",
			)
			.run(f.config.coordinatorId, f.config.issuer, f.config.revision);
		const s = f.steps();
		expect(await s.start()).toMatchObject({ kind: "started" });
		expect(await s.claim()).toMatchObject({ kind: "browser_claimed" });
		f.account.subject = "foreign-subject";
		// Act
		const result = await s.verify();
		// Assert
		expect(result?.kind).toBe("refused");
		assertUnbound(f);
	});
});
