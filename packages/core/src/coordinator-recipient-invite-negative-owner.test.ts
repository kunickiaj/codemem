import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type Fixture, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { otherKey } from "./coordinator-device-ownership-evidence-test-fixtures.js";
import { revocationInput } from "./coordinator-device-revocation-test-harness.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";
import {
	beforeProducerWriteBatch,
	prepareProducerOwner,
	producerSnapshot,
	retainProducerOwner,
} from "./coordinator-producer-negative-owner-test-fixtures.js";
import { recipientInvite } from "./coordinator-recipient-revocation-test-harness.js";
import { OWNED_DENIAL } from "./shared-owned-device-enrollment-test-harness.js";
import { bindRecipient } from "./shared-owned-recipient-invites-test-harness.js";

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	vi.restoreAllMocks();
});

// Maintained callers supply a trusted namespace; legacy direct callers omit it.
// Neither path may infer a namespace from actors or Teams.
for (const backend of ["SQLite", "D1"] as const) {
	const test = it.extend<{ f: Fixture }>({
		f: async ({ task: _task }, use) => {
			const f = setupStore(backend);
			try {
				await use(f);
			} finally {
				await f.store.close();
				if (f.db.open) f.db.close();
			}
		},
	});
	async function invitation(f: Fixture, kind: "team_member" | "add_device") {
		const harness = {
			store: f.store,
			input: revocationInput("producer"),
			exec: async (sql: string, ...values: unknown[]) => {
				f.db.prepare(sql).run(...values);
			},
			rows: async (table: string) => f.db.prepare(`SELECT * FROM ${table}`).all(),
		};
		const invitation = await recipientInvite(harness, kind);
		return {
			...invitation,
			input: { ...invitation.input, coordinatorId: "coordinator-a" },
			harness,
		};
	}
	for (const catalog of ["missing", "ready"] as const) {
		test(`${backend} legacy recipient without namespace preserves ${catalog} fact-free admission`, async ({
			f,
		}) => {
			// Arrange: omit the field entirely, as existing direct store callers do.
			const { input } = await invitation(f, "add_device");
			const { coordinatorId: _trustedNamespace, ...legacyInput } = input;
			if (catalog === "missing")
				f.db.exec("DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions");
			else {
				f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
				await retainProducerOwner(
					f.db,
					{
						...input,
						coordinatorId: "foreign-coordinator",
						deviceId: "unrelated-retained-device",
						publicKey: otherKey,
						ownerIdentityId: "unrelated-owner",
					},
					{ removeSource: true },
				);
			}
			// Act
			const result = await f.store.consumeRecipientInvite(legacyInput);
			// Assert
			expect(result.status).toBe("accepted");
			expect(await f.store.getEnrollment("producer-group", input.deviceId)).toMatchObject({
				identity_id: input.identityId,
				enabled: 1,
			});
		});
	}
	for (const match of ["device", "canonical key"] as const) {
		test(`${backend} legacy recipient without namespace denies retained foreign ${match} fact`, async ({
			f,
		}) => {
			// Arrange: even a same-owner fact is not usable without a trusted namespace.
			const { input } = await invitation(f, "add_device");
			const { coordinatorId: _trustedNamespace, ...legacyInput } = input;
			await retainProducerOwner(
				f.db,
				{
					...input,
					coordinatorId: "foreign-coordinator",
					ownerIdentityId: input.identityId,
					publicKey: match === "device" ? otherKey : `${input.publicKey} retained-alias`,
				},
				{
					removeSource: true,
					resolutionDeviceId: match === "device" ? input.deviceId : "original-device",
				},
			);
			const before = producerSnapshot(f.db);
			// Act
			const acceptance = f.store.consumeRecipientInvite(legacyInput);
			// Assert: unknown namespace cannot ignore a relevant fact in any coordinator.
			await expect(acceptance).rejects.toThrow();
			expect(producerSnapshot(f.db)).toEqual(before);
		});
	}
	test(`${backend} legacy recipient pins absence across namespaces at winning token UPDATE`, async ({
		f,
	}) => {
		// Arrange: prepare canonical metadata before the synchronous winning-write hook.
		const { input } = await invitation(f, "add_device");
		const { coordinatorId: _trustedNamespace, ...legacyInput } = input;
		const seed = await prepareProducerOwner(
			f.db,
			{ ...input, coordinatorId: "foreign-coordinator", ownerIdentityId: input.identityId },
			{ removeSource: true },
		);
		let atWrite: ReturnType<typeof producerSnapshot> | undefined;
		const hook = beforeProducerWriteBatch(f.db, () => {
			seed();
			atWrite = producerSnapshot(f.db);
		});
		try {
			// Act
			const acceptance = f.store.consumeRecipientInvite(legacyInput);
			// Assert: the late fact, token update, enrollment and bootstrap all roll back.
			await expect(acceptance).rejects.toThrow();
			expect(hook.observed()).toBe(true);
			expect(producerSnapshot(f.db)).toEqual(atWrite);
		} finally {
			hook.restore();
		}
	});
	for (const kind of ["team_member", "add_device"] as const) {
		test(`${backend} ${kind} pins empty subject facts at winning token UPDATE`, async ({ f }) => {
			// Arrange
			const { input } = await invitation(f, kind);
			const seed = await prepareProducerOwner(
				f.db,
				{ ...input, coordinatorId: "coordinator-a", ownerIdentityId: "owner-A" },
				{ removeSource: true },
			);
			let atWrite: ReturnType<typeof producerSnapshot> | undefined;
			const hook = beforeProducerWriteBatch(f.db, () => {
				seed();
				atWrite = producerSnapshot(f.db);
			});
			try {
				// Act
				const acceptance = f.store.consumeRecipientInvite(input);
				// Assert: the transaction must roll back rather than leave a consumed token.
				await expect(acceptance).rejects.toThrow();
				expect(hook.observed()).toBe(true);
				expect(producerSnapshot(f.db)).toEqual(atWrite);
			} finally {
				hook.restore();
			}
		});
		for (const catalog of ["missing", "ready", "same owner", "foreign"] as const) {
			test(`${backend} ${kind} preserves ${catalog} recipient admission`, async ({ f }) => {
				// Arrange
				const { input } = await invitation(f, kind);
				if (catalog === "missing")
					f.db.exec("DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions");
				if (catalog === "ready") f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
				if (catalog === "same owner" || catalog === "foreign")
					await retainProducerOwner(f.db, {
						...input,
						coordinatorId: catalog === "foreign" ? "foreign-coordinator" : "coordinator-a",
						ownerIdentityId: catalog === "foreign" ? "owner-A" : input.identityId,
					});
				// Act
				const result = await f.store.consumeRecipientInvite(input);
				// Assert: retained facts do not grant extra access or overwrite receipt metadata.
				expect(result.status).toBe("accepted");
				expect(await f.store.getEnrollment("producer-group", input.deviceId)).toMatchObject({
					identity_id: input.identityId,
					enabled: 1,
				});
			});
		}
		for (const match of ["device", "canonical key"] as const) {
			test(`${backend} ${kind} cannot consume for B over retained A by ${match}`, async ({ f }) => {
				// Arrange: old retained facts precede the producer; no enrollment bypass is installed.
				const { input } = await invitation(f, kind);
				await retainProducerOwner(
					f.db,
					{
						...input,
						coordinatorId: "coordinator-a",
						ownerIdentityId: "owner-A",
						publicKey: match === "device" ? otherKey : `${input.publicKey} old-alias`,
					},
					{
						removeSource: true,
						resolutionDeviceId: match === "device" ? input.deviceId : "original-device",
					},
				);
				const before = producerSnapshot(f.db);
				// Act
				const acceptance = f.store.consumeRecipientInvite(input);
				// Assert: token, recipient enrollment, bootstrap, access and audit are all unchanged.
				await expect(acceptance).rejects.toThrow();
				expect(producerSnapshot(f.db)).toEqual(before);
			});
		}
		test(`${backend} ${kind} same-owner fact preserves existing ownership-ledger denial`, async ({
			f,
		}) => {
			// Arrange
			const { input, harness } = await invitation(f, kind);
			await retainProducerOwner(f.db, {
				...input,
				coordinatorId: "coordinator-a",
				ownerIdentityId: input.identityId,
			});
			await bindRecipient(harness, input);
			const before = producerSnapshot(f.db);
			// Act
			const acceptance = f.store.consumeRecipientInvite(input);
			// Assert: do not convert this older named denial into a generic resolution error.
			await expect(acceptance).rejects.toThrow(new RegExp(`^${OWNED_DENIAL}$`));
			expect(producerSnapshot(f.db)).toEqual(before);
		});
		test(`${backend} ${kind} partial resolution catalog fails closed`, async ({ f }) => {
			// Arrange
			const { input } = await invitation(f, kind);
			f.db.exec(
				"DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions; CREATE TABLE coordinator_legacy_owner_resolutions (device_id TEXT)",
			);
			const before = producerSnapshot(f.db);
			// Act
			const acceptance = f.store.consumeRecipientInvite(input);
			// Assert
			await expect(acceptance).rejects.toThrow();
			expect(producerSnapshot(f.db)).toEqual(before);
		});
		test(`${backend} ${kind} pins absent resolution catalog at winning token UPDATE`, async ({
			f,
		}) => {
			// Arrange
			const { input } = await invitation(f, kind);
			f.db.exec("DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions");
			let atWrite: ReturnType<typeof producerSnapshot> | undefined;
			const hook = beforeProducerWriteBatch(f.db, () => {
				f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
				atWrite = producerSnapshot(f.db);
			});
			try {
				// Act
				const acceptance = f.store.consumeRecipientInvite(input);
				// Assert: denial rolls back both the token mutation and dependent stages.
				await expect(acceptance).rejects.toThrow();
				expect(hook.observed()).toBe(true);
				expect(producerSnapshot(f.db)).toEqual(atWrite);
			} finally {
				hook.restore();
			}
		});
	}
}
