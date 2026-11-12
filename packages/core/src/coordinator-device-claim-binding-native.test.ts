import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAccountConnectionSchema } from "./coordinator-account-connection-schema.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	completeDeviceClaimBinding,
	deviceClaimBindingStatements,
	isDeviceClaimBindingConflict,
	prepareDeviceClaimBinding,
	prepareFirstLinkDeviceClaimBinding,
	readDeviceClaimBindingReceipt,
	readFirstLinkDeviceClaimOwnershipComplete,
} from "./coordinator-device-claim-binding.js";
import { retainProducerOwner } from "./coordinator-producer-negative-owner-test-fixtures.js";
import { D1CoordinatorStore, type D1DatabaseLike } from "./d1-coordinator-store.js";
import {
	LEGACY_SETUP,
	type LinkedLegacySetupFixture,
	linkedLegacySetupFixture,
} from "./linked-legacy-setup-test-fixtures.js";

// Resolve the existing Worker runtime dependency. No test dependency or network
// service is added to core, and outbound HTTP is forbidden by the runtime.
const workerRequire = createRequire(
	new URL("../../cloudflare-coordinator-worker/package.json", import.meta.url),
);
const runtimeRequire = createRequire(workerRequire.resolve("wrangler/package.json"));
const { Miniflare, convertV4MiniflareOptions } = runtimeRequire("miniflare");
let runtime: { dispose(): Promise<void>; getD1Database(name: string): Promise<D1DatabaseLike> };
let f: LinkedLegacySetupFixture;
let d1: D1DatabaseLike;
let backend: AuthLinkBackend;
const now = Date.parse(LEGACY_SETUP.now);
const input = () => ({ signer: f.account.signer, currentIdentityId: LEGACY_SETUP.identityId });

function nativeD1Backend(db: D1DatabaseLike): AuthLinkBackend {
	const prepared = (s: AuthLinkStatement) => db.prepare(s.sql).bind(...s.values);
	return {
		first: <T>(s: AuthLinkStatement) => prepared(s).first<T>(),
		all: async <T>(s: AuthLinkStatement) => (await prepared(s).all<T>()).results ?? [],
		run: async (s: AuthLinkStatement) => (await prepared(s).run()).meta?.changes ?? 0,
		batch: async (statements: AuthLinkStatement[]) => {
			if (!db.batch) throw new Error("Native D1 batch unavailable");
			return db.batch(statements.map(prepared));
		},
	};
}

beforeEach(async () => {
	// The copy below must be V2: tests install the account extension on it themselves.
	f = await linkedLegacySetupFixture("SQLite", { accountSchema: "v2" });
	await retainProducerOwner(f.coordinator.db, {
		...f.account.signer,
		coordinatorId: LEGACY_SETUP.coordinatorId,
		ownerIdentityId: LEGACY_SETUP.identityId,
	});
	runtime = new Miniflare(
		convertV4MiniflareOptions({
			modules: true,
			script: "export default { fetch() { return new Response(null,{status:404}); } };",
			compatibilityDate: "2026-03-28",
			compatibilityFlags: ["nodejs_compat"],
			d1Databases: { DB: "synthetic-claim-binding" },
			cf: false,
			host: "127.0.0.1",
			port: 0,
			outboundService: () => {
				throw new Error("External network forbidden");
			},
		}),
	);
	d1 = await runtime.getD1Database("DB");
	backend = nativeD1Backend(d1);
	// Copy the real fixture schema as complete prepared statements so trigger-body
	// semicolons are never split. The database remains entirely disposable.
	const objects = f.coordinator.db
		.prepare(
			"SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END",
		)
		.all() as { type: string; name: string; sql: string }[];
	for (const object of objects) await backend.run({ sql: object.sql, values: [] });
	for (const table of objects.filter((o) => o.type === "table")) {
		const rows = f.coordinator.db.prepare(`SELECT * FROM ${table.name}`).all() as Record<
			string,
			string | number | null
		>[];
		for (const row of rows) {
			const keys = Object.keys(row);
			await backend.run({
				sql: `INSERT INTO ${table.name} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
				values: Object.values(row),
			});
		}
	}
}, 30_000);
afterEach(async () => {
	await runtime?.dispose();
	await f?.close();
});

async function seedExistingBinding() {
	await backend.run({
		sql: `INSERT INTO coordinator_device_ownership_bindings (device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
 SELECT device_id,key_id,identity_id,coordinator_id,'existing-owned-binding','reviewed_legacy_migration','existing-reviewed-source','2026-01-01T00:00:00.000Z' FROM coordinator_auth_device_claims`,
		values: [],
	});
}
describe("native D1 first-link existing ownership", () => {
	it.each(["NULL", "complete"])(
		"preserves existing provenance and audit with %s enrollment",
		async (state) => {
			// Arrange
			await seedExistingBinding();
			if (state === "complete")
				await backend.run({
					sql: "UPDATE enrolled_devices SET identity_id=? WHERE device_id=?",
					values: [LEGACY_SETUP.identityId, f.keyA.deviceId],
				});
			const binding = await d1
				.prepare("SELECT * FROM coordinator_device_ownership_bindings ORDER BY device_id")
				.all();
			const audit = await d1.prepare("SELECT * FROM coordinator_device_rebind_audit_log").all();
			const plan = await prepareFirstLinkDeviceClaimBinding(
				backend,
				input(),
				f.account.config,
				now,
			);
			if (!plan) throw new Error("expected first-link plan");
			// Act
			const writes = await backend.batch(
				deviceClaimBindingStatements(plan, "unused-binding", "unused-audit", {
					winning: { sql: "1", values: [] },
				}),
			);
			const complete = await readFirstLinkDeviceClaimOwnershipComplete(
				backend,
				input(),
				f.account.config,
				now,
			);
			// Assert
			if (state === "complete")
				expect(
					(writes as { meta: { changes: number } }[]).every((result) => result.meta.changes === 0),
				).toBe(true);
			expect(complete).toBe(true);
			expect(
				(
					await d1
						.prepare("SELECT * FROM coordinator_device_ownership_bindings ORDER BY device_id")
						.all()
				).results,
			).toEqual(binding.results);
			expect(
				(await d1.prepare("SELECT * FROM coordinator_device_rebind_audit_log").all()).results,
			).toEqual(audit.results);
			expect(await readDeviceClaimBindingReceipt(backend, input(), f.account.config)).toBeNull();
		},
		30_000,
	);
});
describe("native D1 existing ownership atomicity", () => {
	it.each([
		[
			"zero update",
			[
				`CREATE TRIGGER ignore_reuse_update BEFORE UPDATE ON enrolled_devices BEGIN SELECT RAISE(IGNORE); END`,
			],
		],
		[
			"enrollment drift",
			[`UPDATE enrolled_devices SET identity_id='other-identity' WHERE device_id='device-a'`],
		],
		[
			"binding drift",
			[
				`DROP TRIGGER coordinator_device_ownership_immutable_update`,
				`UPDATE coordinator_device_ownership_bindings SET source_ref='changed-source' WHERE device_id='device-a'`,
			],
		],
		[
			"post-update key alias",
			[
				`CREATE TRIGGER add_reuse_alias AFTER UPDATE ON enrolled_devices WHEN NEW.device_id='device-a' BEGIN INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,enabled,created_at) VALUES (NEW.group_id,'racing-alias',NEW.public_key,NEW.fingerprint,NULL,1,NEW.created_at); END`,
			],
		],
	])(
		"strictly rolls back reuse after %s",
		async (_name, sql) => {
			// Arrange
			await seedExistingBinding();
			const plan = await prepareFirstLinkDeviceClaimBinding(
				backend,
				input(),
				f.account.config,
				now,
			);
			if (!plan) throw new Error("expected first-link plan");
			for (const statement of sql) await backend.run({ sql: statement, values: [] });
			const before = await effects();
			// Act
			const write = backend.batch(
				deviceClaimBindingStatements(plan, "unused-binding", "unused-audit", {
					winning: { sql: "1", values: [] },
				}),
			);
			// Assert
			await expect(write).rejects.toThrow();
			expect(isDeviceClaimBindingConflict(await write.catch((error) => error))).toBe(true);
			expect(await effects()).toEqual(before);
		},
		30_000,
	);
	it("recovers completed existing ownership after a lost write reply", async () => {
		// Arrange
		await seedExistingBinding();
		const plan = await prepareFirstLinkDeviceClaimBinding(backend, input(), f.account.config, now);
		if (!plan) throw new Error("expected first-link plan");
		// Act
		const reply = backend
			.batch(deviceClaimBindingStatements(plan, "unused-binding", "unused-audit"))
			.then(() => {
				throw new Error("reply_lost");
			});
		const error = await reply.catch((error) => error);
		const before = await effects();
		const complete = await readFirstLinkDeviceClaimOwnershipComplete(
			backend,
			input(),
			f.account.config,
			now,
		);
		// Assert
		expect(error).toMatchObject({ message: "reply_lost" });
		expect(complete).toBe(true);
		expect(await effects()).toEqual(before);
	}, 30_000);
});

async function effects() {
	const rows = [];
	for (const table of [
		"coordinator_device_ownership_bindings",
		"enrolled_devices",
		"coordinator_device_rebind_audit_log",
		"coordinator_identity_group_grants",
	])
		rows.push((await d1.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all()).results);
	return rows;
}

describe("native D1 claim binding composition", () => {
	it("keeps the shared structural predicate within the original first-link readiness query", async () => {
		// Arrange: an existing claim makes first-link unavailable without mutating it.
		const store = new D1CoordinatorStore(d1, { authClock: () => now });
		const before = await effects();
		// Act
		const result = await store.readAuthDeviceClaimReadiness(
			{ signer: f.account.signer, identityId: LEGACY_SETUP.identityId },
			f.account.config,
		);
		// Assert
		expect(result).toEqual({ kind: "unavailable" });
		expect(await effects()).toEqual(before);
	}, 30_000);
	it("performs zero writes for a losing producer despite an existing valid claim", async () => {
		// Arrange
		const plan = await prepareDeviceClaimBinding(backend, input(), f.account.config, now);
		if (!plan) throw new Error("expected plan");
		const before = await effects();
		// Act
		await backend.batch(
			deviceClaimBindingStatements(plan, "losing-binding", "losing-event", {
				winning: { sql: "? = 1", values: [0] },
			}),
		);
		// Assert
		expect(await effects()).toEqual(before);
	}, 30_000);
	it("executes the larger connection-genesis provenance stages on native D1", async () => {
		// Arrange
		await applyAccountConnectionSchema(backend);
		// Act
		const result = await completeDeviceClaimBinding(backend, input(), f.account.config, now);
		// Assert
		expect(result.kind).toBe("completed");
	}, 30_000);
	it("executes the full staged provenance guard below D1's expression-depth limit and recovers its receipt", async () => {
		// Arrange
		const peer = await d1
			.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id='device-b'")
			.all();
		// Act
		const result = await completeDeviceClaimBinding(backend, input(), f.account.config, now);
		const receipt = await readDeviceClaimBindingReceipt(backend, input(), f.account.config);
		// Assert
		expect(result).toEqual({ kind: "completed", receipt });
		expect(receipt).toMatchObject({ deviceId: "device-a", identityId: LEGACY_SETUP.identityId });
		expect(
			(
				await d1
					.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id='device-b'")
					.all()
			).results,
		).toEqual(peer.results);
	}, 30_000);

	it.each([
		[
			"zero-row binding",
			`CREATE TRIGGER inject_zero BEFORE INSERT ON coordinator_device_ownership_bindings BEGIN SELECT RAISE(IGNORE); END`,
		],
		[
			"zero-row enrollment",
			`CREATE TRIGGER inject_zero BEFORE UPDATE ON enrolled_devices WHEN OLD.device_id='device-a' BEGIN SELECT RAISE(IGNORE); END`,
		],
		[
			"zero-row audit",
			`CREATE TRIGGER inject_zero BEFORE INSERT ON coordinator_device_rebind_audit_log BEGIN SELECT RAISE(IGNORE); END`,
		],
		[
			"audit failure",
			`CREATE TRIGGER inject_error BEFORE INSERT ON coordinator_device_rebind_audit_log BEGIN SELECT RAISE(ABORT,'audit_failure'); END`,
		],
		[
			"update-count drift",
			`CREATE TRIGGER inject_drift AFTER INSERT ON coordinator_device_ownership_bindings WHEN NEW.device_id='device-a' BEGIN UPDATE enrolled_devices SET identity_id=NEW.identity_id WHERE device_id=NEW.device_id; END`,
		],
	])(
		"atomically rolls back %s",
		async (_name, sql) => {
			// Arrange
			const plan = await prepareDeviceClaimBinding(backend, input(), f.account.config, now);
			if (!plan) throw new Error("expected completion plan");
			await backend.run({ sql, values: [] });
			const before = await effects();
			// Act
			for (const options of [{}, { winning: { sql: "? = 1", values: [1] } }]) {
				const write = backend.batch(
					deviceClaimBindingStatements(plan, "native-binding", "native-event", options),
				);
				// Assert: both legacy and winning-producer paths enforce every count.
				await expect(write).rejects.toThrow();
				const error = await write.catch((error) => error);
				expect(isDeviceClaimBindingConflict(error)).toBe(_name !== "audit failure");
				expect(await effects()).toEqual(before);
			}
		},
		30_000,
	);

	it("denies a revoked link without any completion writes", async () => {
		// Arrange
		await backend.run({
			sql: "UPDATE coordinator_auth_account_links SET revoked_at_ms=1",
			values: [],
		});
		const before = await effects();
		// Act
		const result = await completeDeviceClaimBinding(backend, input(), f.account.config, now);
		// Assert
		expect(result).toEqual({ kind: "requires_review" });
		expect(await effects()).toEqual(before);
	}, 30_000);
});
