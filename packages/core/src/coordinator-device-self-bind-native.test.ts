import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import type { DeviceRebindAttempt } from "./coordinator-device-rebind-proof.js";
import { readDeviceSelfBindEligibility } from "./coordinator-device-self-bind-authority.js";
import {
	SELF_BIND_NOW,
	type SelfBindLinkOrigin,
	selfBindFixture,
} from "./coordinator-device-self-bind-test-fixtures.js";
import type { D1DatabaseLike } from "./d1-coordinator-store.js";

const requireWorker = createRequire(
	new URL("../../cloudflare-coordinator-worker/package.json", import.meta.url),
);
const requireRuntime = createRequire(requireWorker.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = requireRuntime("miniflare");
const close: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const fn of close.splice(0).reverse()) await fn();
});

async function nativeFixture(origin: SelfBindLinkOrigin) {
	// The copy below models a D1 coordinator, which migrations leave on V2 for now.
	const f = await selfBindFixture("SQLite", origin, undefined, { accountSchema: "v2" });
	close.push(f.close);
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
	const objects = f.db
		.prepare(
			"SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
		)
		.all() as { type: string; name: string; sql: string }[];
	for (const object of objects) await backend.run({ sql: object.sql, values: [] });
	for (const table of objects.filter((o) => o.type === "table")) {
		for (const row of f.db.prepare(`SELECT * FROM ${table.name}`).all() as Record<
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
	return { ...f, native: backend };
}

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
