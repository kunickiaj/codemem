import type { D1Database } from "@cloudflare/workers-types";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { changeFixture, changeTable, config, input } from "./account-change-fixture.js";
import type { AuthLinkBackend } from "../../core/src/coordinator-auth-link.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";

// Native D1 runs the account-change reads, the decision and the combined guard. A fact
// changed after the reads and before the write must abort the write there too.
it("native D1 aborts an account change whose authority facts changed before the write", async () => {
	// Arrange
	const db = (env as unknown as { COORDINATOR_DB: D1Database }).COORDINATOR_DB;
	let beforeNextBatch: (() => Promise<unknown>) | undefined;
	const backend: AuthLinkBackend = {
		first: ({ sql, values }) => db.prepare(sql).bind(...values).first(),
		run: async ({ sql, values }) => (await db.prepare(sql).bind(...values).run()).meta.changes,
		batch: async (statements) => {
			const hook = beforeNextBatch;
			beforeNextBatch = undefined;
			await hook?.();
			return db.batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values)));
		},
	};
	const store = new D1CoordinatorStore(db, { authClock: () => 1791028800000 });
	const f = await changeFixture(store, backend);
	const state = async (n: number) =>
		(await db.prepare(`SELECT state FROM ${changeTable} WHERE attempt_id = ?`).bind(`change-${n}`).first<{ state: string }>())?.state;
	const revoke = (kind: string, value: string) => () =>
		db.prepare(`INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,'created')`)
			.bind(kind, value, `raced-${kind}`, input.signer.groupId, input.signer.deviceId, input.signer.publicKey, input.signer.fingerprint).run();
	await f.prepare(1, "refresh");
	// Act: a revocation lands after the finalize reads, then one lands after the create reads.
	beforeNextBatch = revoke("device_id", input.signer.deviceId);
	const finalized = await f.operations.finalize(f.proof(1), config);
	await db.prepare("DELETE FROM coordinator_device_revocations").run();
	beforeNextBatch = revoke("device_id", input.signer.deviceId);
	const created = await f.operations.create(f.request(2, "refresh"), config);
	await db.prepare("DELETE FROM coordinator_device_revocations").run();
	// Assert: nothing was written, and the same steps succeed once nothing changes.
	expect(finalized).toBeNull();
	expect(await state(1)).toBe("confirmed");
	expect(created).toBe(false);
	expect(await state(2)).toBeUndefined();
	expect(await f.operations.finalize(f.proof(1), config)).toMatchObject({ intent: "refresh" });
	expect(await f.operations.create(f.request(2, "refresh"), config)).toBe(true);
});
