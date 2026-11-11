import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Fixture, setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { revocationInput } from "./coordinator-device-revocation-test-harness.js";
import {
	producerSnapshot,
	retainProducerOwner,
} from "./coordinator-producer-negative-owner-test-fixtures.js";
import { recipientInvite } from "./coordinator-recipient-revocation-test-harness.js";
import type { CoordinatorConsumeRecipientInviteInput } from "./coordinator-store-contract.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-06T00:00:00.000Z"));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

function conflictingController(f: Fixture, input: CoordinatorConsumeRecipientInviteInput) {
	f.db
		.prepare(`INSERT INTO coordinator_auth_controller_attestations
		(attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,
		review_receipt_id,evidence_digest,enrollment_identity_id,revision,created_at,revoked_at)
		VALUES (?,?,?,'repair-race-group',?,?,?,'repair-race-review',?,NULL,1,?,NULL)`)
		.run(
			"repair-race-controller-B",
			input.coordinatorId,
			"owner-B",
			input.deviceId,
			input.publicKey,
			input.fingerprint,
			"b".repeat(64),
			"2026-10-01T00:00:00.000Z",
		);
}

for (const backend of ["SQLite", "D1"] as const) {
	type RepairFixture = Fixture & {
		hooks: { beforeToken?: () => void; beforeRepair?: () => void; beforeGrant?: () => void };
		winningBatches(): number;
	};
	const test = it.extend<{ f: RepairFixture }>({
		f: async ({ task: _task }, use) => {
			const base = setupStore(backend);
			const hooks: RepairFixture["hooks"] = {};
			let winners = 0;
			const store =
				backend === "D1"
					? new D1CoordinatorStore(
							sqliteD1(base.db, {
								beforeBatch(statements) {
									if (
										statements.some(({ query }) =>
											/UPDATE coordinator_invites SET token\s*=/.test(query),
										)
									) {
										winners++;
										hooks.beforeToken?.();
									}
									if (
										statements.some(({ query }) =>
											/UPDATE enrolled_devices SET identity_id\s*=/.test(query),
										)
									)
										hooks.beforeRepair?.();
									if (
										statements.some(({ query }) =>
											/UPDATE coordinator_invites SET bootstrap_grant_id\s*=/.test(query),
										) &&
										!statements.some(({ query }) =>
											/UPDATE coordinator_invites SET token\s*=/.test(query),
										)
									)
										hooks.beforeGrant?.();
								},
							}),
						)
					: base.store;
			const f: RepairFixture = { db: base.db, store, hooks, winningBatches: () => winners };
			try {
				await use(f);
			} finally {
				await store.close();
				if (base.db.open) base.db.close();
			}
		},
	});
	async function prepared(f: RepairFixture, kind: "team_member" | "add_device") {
		const harness = {
			store: f.store,
			input: revocationInput("repair-consistency"),
			exec: async (sql: string, ...values: unknown[]) => {
				f.db.prepare(sql).run(...values);
			},
			rows: async (table: string) => f.db.prepare(`SELECT * FROM ${table}`).all(),
		};
		const invitation = await recipientInvite(harness, kind);
		const input = { ...invitation.input, coordinatorId: "coordinator-a" };
		await retainProducerOwner(f.db, { ...input, ownerIdentityId: input.identityId });
		return input;
	}
	function clearIdentity(f: RepairFixture, input: CoordinatorConsumeRecipientInviteInput) {
		f.db
			.prepare("UPDATE enrolled_devices SET identity_id=NULL WHERE device_id=?")
			.run(input.deviceId);
	}
	async function missingGrant(f: RepairFixture) {
		const input = await prepared(f, "add_device");
		const groupId = "repair-consistency-group";
		await f.store.setDeviceEnabled(groupId, `${input.deviceId}-seed`, false);
		expect((await f.store.consumeRecipientInvite(input)).bootstrap_grant).toBeNull();
		await f.store.setDeviceEnabled(groupId, `${input.deviceId}-seed`, true);
		return input;
	}
	test(`${backend} no-op identity retry recovers exactly one missing grant`, async ({ f }) => {
		const input = await missingGrant(f);
		const recovered = await f.store.consumeRecipientInvite(input);
		const retry = await f.store.consumeRecipientInvite(input);
		expect(recovered).toMatchObject({
			status: "existing",
			bootstrap_grant: { worker_device_id: input.deviceId },
		});
		expect(retry.bootstrap_grant).toEqual(recovered.bootstrap_grant);
		expect(f.db.prepare("SELECT * FROM coordinator_bootstrap_grants").all()).toHaveLength(1);
	});
	if (backend === "D1") {
		for (const mode of ["unchanged owner", "conflicting owner"] as const) {
			test(`D1 losing token write with ${mode} cannot bypass its full pin`, async ({ f }) => {
				const input = await prepared(f, "add_device");
				const readInvite = f.store.getInviteByTokenForInspection.bind(f.store);
				let externalChange: ReturnType<typeof producerSnapshot> | undefined;
				vi.spyOn(f.store, "getInviteByTokenForInspection").mockImplementationOnce(async (token) => {
					const initial = await readInvite(token);
					expect(initial?.consumed_at).toBeNull();
					f.db
						.prepare("UPDATE enrolled_devices SET enabled=0 WHERE device_id=?")
						.run(`${input.deviceId}-seed`);
					expect(await f.store.consumeRecipientInvite(input)).toMatchObject({
						status: "accepted",
						bootstrap_grant: null,
					});
					f.db
						.prepare("UPDATE enrolled_devices SET enabled=1 WHERE device_id=?")
						.run(`${input.deviceId}-seed`);
					f.hooks.beforeToken = () => {
						delete f.hooks.beforeToken;
						if (mode === "conflicting owner") conflictingController(f, input);
						externalChange = producerSnapshot(f.db);
					};
					return initial;
				});
				const outcome = await f.store.consumeRecipientInvite(input).then(
					(value) => ({ kind: "accepted", value }),
					(error: unknown) => ({ kind: "denied", error }),
				);
				expect(externalChange).toBeDefined();
				if (mode === "conflicting owner") {
					expect(outcome).toMatchObject({ kind: "denied" });
					expect(producerSnapshot(f.db)).toEqual(externalChange);
					expect(f.db.prepare("SELECT * FROM coordinator_bootstrap_grants").all()).toEqual([]);
					return;
				}
				expect(outcome).toMatchObject({
					kind: "accepted",
					value: { status: "existing", bootstrap_grant: { worker_device_id: input.deviceId } },
				});
				expect(f.db.prepare("SELECT * FROM coordinator_bootstrap_grants").all()).toHaveLength(1);
			});
		}
		for (const metadata of [undefined, null, "1", -1, 1.5, 2, Number.NaN]) {
			test(`D1 unknown repair changes ${String(metadata)} cannot authorize grant recovery`, async ({
				f,
			}) => {
				const input = await missingGrant(f);
				const before = producerSnapshot(f.db);
				const adapter = sqliteD1(f.db);
				const batch = adapter.batch?.bind(adapter);
				if (!batch) throw new Error("test batch unavailable");
				// Falsify the first write's result: guard and read results carry rows, writes do not.
				let falsified = 0;
				adapter.batch = async (statements) => {
					const results = await batch(statements);
					const write = results.findIndex((result) => !("results" in (result as object)));
					if (write < 0) return results;
					falsified++;
					results[write] = { meta: { changes: metadata } };
					return results;
				};
				const store = new D1CoordinatorStore(adapter);
				await expect(store.consumeRecipientInvite(input)).rejects.toThrow(
					"device_ownership_authorization_unavailable",
				);
				expect(falsified).toBe(1);
				expect(producerSnapshot(f.db)).toEqual(before);
				expect(f.db.prepare("SELECT * FROM coordinator_bootstrap_grants").all()).toEqual([]);
			});
		}
		for (const stage of ["beforeRepair", "beforeGrant"] as const) {
			test(`D1 no-op identity retry retains full pin ${stage}`, async ({ f }) => {
				const input = await missingGrant(f);
				let externalChange: ReturnType<typeof producerSnapshot> | undefined;
				f.hooks[stage] = () => {
					delete f.hooks[stage];
					conflictingController(f, input);
					externalChange = producerSnapshot(f.db);
				};
				await expect(f.store.consumeRecipientInvite(input)).rejects.toThrow();
				expect(externalChange).toBeDefined();
				expect(producerSnapshot(f.db)).toEqual(externalChange);
				expect(f.db.prepare("SELECT * FROM coordinator_bootstrap_grants").all()).toEqual([]);
			});
		}
	}
	for (const kind of ["team_member", "add_device"] as const) {
		test(`${backend} ${kind} fresh consumption permits its own changes after the full initial pin`, async ({
			f,
		}) => {
			// Arrange: original retained A and its unrevoked source precede the producer.
			const input = await prepared(f, kind);
			// Act
			const result = await f.store.consumeRecipientInvite(input);
			// Assert: applying the pre-write snapshot after own output would reject this control.
			expect(result.status).toBe("accepted");
			expect(await f.store.getEnrollment("repair-consistency-group", input.deviceId)).toMatchObject(
				{ identity_id: input.identityId, enabled: 1 },
			);
			expect(f.db.prepare("SELECT * FROM coordinator_bootstrap_grants").all()).toHaveLength(
				kind === "add_device" ? 1 : 0,
			);
		});
		test(`${backend} ${kind} consumed invite repairs a null identity without racing evidence`, async ({
			f,
		}) => {
			// Arrange: the real initial acceptance remains the exact expected post-repair state.
			const input = await prepared(f, kind);
			expect((await f.store.consumeRecipientInvite(input)).status).toBe("accepted");
			const repaired = producerSnapshot(f.db);
			clearIdentity(f, input);
			const winningBatches = f.winningBatches();
			// Act
			const result = await f.store.consumeRecipientInvite(input);
			// Assert: repair changes only the missing identity, not grants, token, or sibling rows.
			expect(result.status).toBe("existing");
			expect(producerSnapshot(f.db)).toEqual(repaired);
			expect(f.winningBatches()).toBe(winningBatches);
		});
		if (backend === "D1") {
			test(`D1 ${kind} repair is its invocation's first write and must pin initial current evidence`, async ({
				f,
			}) => {
				// Arrange: the previous invocation consumed the token; this invocation only repairs.
				const input = await prepared(f, kind);
				expect((await f.store.consumeRecipientInvite(input)).status).toBe("accepted");
				clearIdentity(f, input);
				const winningBatches = f.winningBatches();
				let injected = false;
				let externalChange: ReturnType<typeof producerSnapshot> | undefined;
				f.hooks.beforeRepair = () => {
					delete f.hooks.beforeRepair;
					injected = true;
					// The D1 shim invokes this before opening the repair batch transaction.
					conflictingController(f, input);
					externalChange = producerSnapshot(f.db);
				};
				// Act: full evidence was captured before the new current controller B appears.
				const outcome = await f.store.consumeRecipientInvite(input).then(
					(result) => ({ kind: "accepted", status: result.status }),
					(error: unknown) => ({ kind: "denied", error }),
				);
				// Assert: preserve external B but do not repair A or write any sibling rows.
				expect(injected).toBe(true);
				expect(f.winningBatches()).toBe(winningBatches);
				expect.soft(outcome).toMatchObject({ kind: "denied" });
				expect.soft(producerSnapshot(f.db)).toEqual(externalChange);
				expect
					.soft(
						f.db
							.prepare("SELECT identity_id FROM enrolled_devices WHERE device_id=?")
							.get(input.deviceId),
					)
					.toEqual({ identity_id: null });
			});
		} else {
			test(`SQLite ${kind} consumed repair rejects conflicting current evidence before its immediate transaction`, async ({
				f,
			}) => {
				// Arrange: SQLite's synchronous transaction has no external interleaving at its repair UPDATE.
				const input = await prepared(f, kind);
				expect((await f.store.consumeRecipientInvite(input)).status).toBe("accepted");
				clearIdentity(f, input);
				conflictingController(f, input);
				const before = producerSnapshot(f.db);
				// Act
				const acceptance = f.store.consumeRecipientInvite(input);
				// Assert: characterize its existing full evidence check without inventing an in-transaction race.
				await expect(acceptance).rejects.toThrow();
				expect(producerSnapshot(f.db)).toEqual(before);
			});
		}
	}
}
