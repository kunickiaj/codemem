import { createRequire } from "node:module";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { review } from "./coordinator-auth-store-test-fixtures.js";
import { completeDeviceClaimBinding } from "./coordinator-device-claim-binding.js";
import type { DeviceRebindAttempt } from "./coordinator-device-rebind-proof.js";
import { readDeviceSelfBindEligibility } from "./coordinator-device-self-bind-authority.js";
import {
	assignLegacyCompletion,
	retainOwnReviewOwnership,
	SELF_BIND_NOW,
	type SelfBindLinkOrigin,
	selfBindFixture,
} from "./coordinator-device-self-bind-test-fixtures.js";
import { nativeBackend } from "./coordinator-owner-enrollment-start-test-fixtures.js";
import type { D1DatabaseLike } from "./d1-coordinator-store.js";
import { LEGACY_SETUP, linkedLegacySetupFixture } from "./linked-legacy-setup-test-fixtures.js";

const requireWorker = createRequire(
	new URL("../../cloudflare-coordinator-worker/package.json", import.meta.url),
);
const requireRuntime = createRequire(requireWorker.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = requireRuntime("miniflare");
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0).reverse()) await fn();
});

async function nativeFixture(
	origin: SelfBindLinkOrigin,
	arrange?: (f: Awaited<ReturnType<typeof selfBindFixture>>) => Promise<void>,
) {
	// The copy below models a D1 coordinator, which migrations leave on V2 for now.
	const f = await selfBindFixture("SQLite", origin, undefined, { accountSchema: "v2" });
	close.push(f.close);
	await arrange?.(f);
	return { ...f, native: await copyBackend(f.db) };
}

async function copyBackend(source: Database.Database): Promise<AuthLinkBackend> {
	const runtime = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch() { return new Response(null,{status:404}); } };",
			compatibilityDate: "2026-03-28",
			compatibilityFlags: ["nodejs_compat"],
			d1Databases: { DB: "synthetic-self-bind" },
			cf: false,
			host: "127.0.0.1",
			port: 0,
			outboundService: () => {
				throw new Error("External network forbidden");
			},
		}),
	);
	close.push(() => runtime.dispose());
	const db: D1DatabaseLike = await runtime.getD1Database("DB");
	const prepared = (s: AuthLinkStatement) => db.prepare(s.sql).bind(...s.values);
	const backend: AuthLinkBackend = {
		first: <T>(s: AuthLinkStatement) => prepared(s).first<T>(),
		all: async <T>(s: AuthLinkStatement) => (await prepared(s).all<T>()).results ?? [],
		run: async (s) => (await prepared(s).run()).meta?.changes ?? 0,
		batch: async (statements) => {
			if (!db.batch) throw new Error("D1 batch unavailable");
			return db.batch(statements.map(prepared));
		},
	};
	const objects = source
		.prepare(
			"SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
		)
		.all() as { type: string; name: string; sql: string }[];
	// Copy the persisted state before enabling write-time constraints such as
	// the connection-order reset check. The ceremony runs with every trigger installed.
	for (const object of objects.filter((o) => o.type !== "trigger"))
		await backend.run({ sql: object.sql, values: [] });
	for (const table of objects.filter((o) => o.type === "table")) {
		for (const row of source.prepare(`SELECT * FROM ${table.name}`).all() as Record<
			string,
			string | number | null
		>[])
			await backend.run({
				sql: `INSERT INTO ${table.name} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
					.map(() => "?")
					.join(",")})`,
				values: Object.values(row),
			});
	}
	for (const object of objects.filter((o) => o.type === "trigger"))
		await backend.run({ sql: object.sql, values: [] });
	return backend;
}

describe.each(["SQLite", "native D1"])("%s ownership generation", (kind) => {
	async function preparedBackend(source: Database.Database, deviceId: string, identityId: string) {
		source
			.prepare("UPDATE enrolled_devices SET identity_id=? WHERE device_id=?")
			.run(identityId, deviceId);
		source.prepare("INSERT INTO groups(group_id,created_at) VALUES('unrelated','now')").run();
		source.exec("UPDATE groups SET readiness_generation='prepared'");
		const backend = kind === "SQLite" ? nativeBackend(source) : await copyBackend(source);
		const affected = () =>
			backend.first({
				sql: `SELECT count(*) n FROM groups g WHERE readiness_generation IS NOT NULL AND EXISTS
		 (SELECT 1 FROM enrolled_devices e WHERE e.group_id=g.group_id AND e.device_id=?)`,
				values: [deviceId],
			});
		const neighbor = () =>
			backend.first({
				sql: "SELECT readiness_generation FROM groups WHERE group_id='unrelated'",
				values: [],
			});
		return { backend, affected, neighbor };
	}

	it("claim invalidates all its groups even without a NULL identity", async () => {
		const f = await linkedLegacySetupFixture("SQLite");
		close.push(f.close);
		const { signer, config } = f.account;
		const { backend, affected, neighbor } = await preparedBackend(
			f.coordinator.db,
			signer.deviceId,
			LEGACY_SETUP.identityId,
		);
		const result = await completeDeviceClaimBinding(
			backend,
			{ signer, currentIdentityId: LEGACY_SETUP.identityId },
			config,
			Date.parse(LEGACY_SETUP.now),
		);
		expect(result.kind).toBe("completed");
		expect(await affected()).toEqual({ n: 0 });
		expect(await neighbor()).toEqual({ readiness_generation: "prepared" });
	}, 30000);

	it("self-bind invalidates all its groups even without a NULL identity", async () => {
		const f = await selfBindFixture("SQLite", "peer", undefined, { accountSchema: "v2" });
		close.push(f.close);
		const { backend, affected, neighbor } = await preparedBackend(
			f.db,
			f.signer.deviceId,
			f.identityId,
		);
		const ceremony = f.makeCeremony(backend);
		const steps = f.steps(ceremony);
		expect(await steps.start()).toMatchObject({ kind: "started" });
		await steps.claim();
		await steps.verify();
		const confirmed = await steps.confirm();
		if (confirmed?.kind !== "confirmed") throw new Error("not confirmed");
		const row = await backend.first<DeviceRebindAttempt>({
			sql: "SELECT * FROM coordinator_device_rebind_attempts",
			values: [],
		});
		if (!row) throw new Error("missing attempt");
		expect(
			await ceremony.finalize(f.finalizedInput(row, confirmed.completionSecret)),
		).toMatchObject({ kind: "finalized" });
		expect(await affected()).toEqual({ n: 0 });
		expect(await neighbor()).toEqual({ readiness_generation: "prepared" });
	}, 30000);
});

it("native D1 binds a reviewed multiple-group legacy device through the full browser ceremony", async () => {
	const f = await nativeFixture("peer", async (f) => {
		expect(
			await f.store.createAuthControllerAttestation(
				review({
					...f.signer,
					groupId: "group-b",
					identityId: f.identityId,
					attestationId: "second-group-review",
					reviewReceiptId: "second-group-receipt",
				}),
			),
		).toMatchObject({ kind: "created" });
		assignLegacyCompletion({
			...f,
			signer: { ...f.signer, groupId: "group-b" },
			identityId: "old-owner",
		});
		await retainOwnReviewOwnership(f, {
			reviewedWeakLabels: [
				{
					label: "old-owner",
					kind: "legacy_included_owner_label",
					group_id: "group-b",
					device_id: f.signer.deviceId,
					evidence_ref: "c".repeat(64),
					effect: "account_owner_display_only",
				},
			],
		});
	});
	const c = f.makeCeremony(f.native);
	const s = f.steps(c);
	expect(await s.start()).toMatchObject({ kind: "started" });
	expect(await s.claim()).toMatchObject({ kind: "browser_claimed" });
	expect(await s.verify()).toMatchObject({ kind: "verified" });
	const confirmed = await s.confirm();
	if (confirmed?.kind !== "confirmed") throw new Error(JSON.stringify(confirmed));
	const row = await f.native.first<DeviceRebindAttempt>({
		sql: "SELECT * FROM coordinator_device_rebind_attempts",
		values: [],
	});
	if (!row) throw new Error("missing attempt");
	expect(await c.finalize(f.finalizedInput(row, confirmed.completionSecret))).toMatchObject({
		kind: "finalized",
		receipt: {
			previousIdentityId: f.identityId,
			targetIdentityId: f.identityId,
			enrollmentCount: 2,
		},
	});
	expect(
		await f.native.first({
			sql: "SELECT count(*) n FROM coordinator_device_ownership_bindings",
			values: [],
		}),
	).toEqual({ n: 1 });
}, 30000);

describe.each(["own", "peer", "peer_controller"] as const)(
	"native D1 %s-origin self-bind",
	(origin) => {
		it("runs the actual composed authority, browser and atomic commit SQL within D1 depth limits", async () => {
			// Arrange
			const f = await nativeFixture(origin);
			const c = f.makeCeremony(f.native);
			const s = f.steps(c);
			// Act
			const ready = await readDeviceSelfBindEligibility(
				f.native,
				{ signer: f.signer, currentIdentityId: f.identityId },
				f.config,
				SELF_BIND_NOW,
			);
			const start = await s.start();
			const claim = await s.claim();
			const verified = await s.verify();
			const confirmed = await s.confirm();
			if (confirmed?.kind !== "confirmed")
				throw new Error(JSON.stringify({ start, claim, verified, confirmed }));
			const row = await f.native.first<DeviceRebindAttempt>({
				sql: "SELECT * FROM coordinator_device_rebind_attempts",
				values: [],
			});
			if (!row) throw new Error("missing attempt");
			const input = f.finalizedInput(row, confirmed.completionSecret);
			const result = await c.finalize(input);
			const replay = await c.finalize(input);
			// Assert
			expect(ready).toEqual({ kind: "eligible", identityId: f.identityId });
			expect(result).toMatchObject({
				kind: "finalized",
				receipt: { targetIdentityId: f.identityId, enrollmentCount: 2 },
			});
			expect(replay).toMatchObject({ kind: "prior_commit" });
		}, 30000);

		it("recomputes authority in the winning commit and rolls back an audit fault", async () => {
			// Arrange
			const f = await nativeFixture(origin);
			const c = f.makeCeremony(f.native);
			const s = f.steps(c);
			expect(await s.start()).toMatchObject({ kind: "started" });
			expect(await s.claim()).toMatchObject({ kind: "browser_claimed" });
			expect(await s.verify()).toMatchObject({ kind: "verified" });
			const confirmed = await s.confirm();
			if (confirmed?.kind !== "confirmed") throw new Error(JSON.stringify(confirmed));
			const row = await f.native.first<DeviceRebindAttempt>({
				sql: "SELECT * FROM coordinator_device_rebind_attempts",
				values: [],
			});
			if (!row) throw new Error("missing attempt");
			const input = f.finalizedInput(row, confirmed.completionSecret);
			await f.native.run({
				sql: "CREATE TRIGGER audit_failure BEFORE INSERT ON coordinator_device_rebind_audit_log BEGIN SELECT RAISE(ABORT,'audit failed'); END",
				values: [],
			});
			// Act
			const fault = await c.finalize(input);
			await f.native.run({ sql: "DROP TRIGGER audit_failure", values: [] });
			await f.native.run({
				sql: "UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked' WHERE device_id='device-a'",
				values: [],
			});
			const drift = await c.finalize(input);
			// Assert
			expect(fault).toEqual({ kind: "unknown" });
			expect(drift?.kind).toBe("refused");
			expect(
				await f.native.first({
					sql: "SELECT count(*) n FROM coordinator_device_ownership_bindings",
					values: [],
				}),
			).toEqual({ n: 0 });
			expect(
				await f.native.first({
					sql: "SELECT count(*) n FROM enrolled_devices WHERE device_id='device-a' AND identity_id IS NULL",
					values: [],
				}),
			).toEqual({ n: 1 });
		}, 30000);
	},
);
