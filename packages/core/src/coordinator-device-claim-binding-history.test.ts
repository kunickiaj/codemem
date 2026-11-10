import SqliteDatabase from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
	config,
	input,
	NOW,
} from "../../cloudflare-coordinator-worker/test/account-change-fixture.js";
import { reconnectFixture } from "../../cloudflare-coordinator-worker/test/account-reconnect-fixture.js";
import {
	AUTH_DEVICE_CLAIM_ELIGIBLE_SQL,
	AUTH_DEVICE_CLAIM_INPUT_SQL,
	captureDeviceClaimEligibility,
} from "./coordinator-auth-device-claim-eligibility.js";
import { type Fixture, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	completeDeviceClaimBinding,
	readDeviceClaimBindingReadiness,
} from "./coordinator-device-claim-binding.js";
import { nativeBackend } from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { retainProducerOwner } from "./coordinator-producer-negative-owner-test-fixtures.js";
import type { D1CoordinatorStore } from "./d1-coordinator-store.js";

function historyBackend(db: Fixture["db"]) {
	return {
		...nativeBackend(db),
		all: async <T>({ sql, values }: import("./coordinator-auth-link.js").AuthLinkStatement) =>
			db.prepare(sql).all(...values) as T[],
		batch: async (statements: import("./coordinator-auth-link.js").AuthLinkStatement[]) =>
			db
				.transaction(() => statements.map((s) => db.prepare(s.sql).run(...s.values).changes))
				.immediate(),
	};
}

import {
	LEGACY_SETUP,
	type LinkedLegacySetupFixture,
	linkedLegacySetupFixture,
} from "./linked-legacy-setup-test-fixtures.js";

let base: Fixture | undefined;
let legacy: LinkedLegacySetupFixture | undefined;
let historicalConnection: Fixture["db"] | undefined;

/** Import coherent connection history into a fresh pre-binding snapshot. This
 * models the older producer without deleting or rewriting any immutable row.
 * Restore the exact schema's triggers after importing its historical records.
 */
function preBindingConnectionSnapshot(source: Fixture["db"]): Fixture["db"] {
	const snapshot = new SqliteDatabase(":memory:");
	const objects = source
		.prepare(
			"SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
		)
		.all() as { type: string; name: string; sql: string }[];
	for (const table of objects.filter((o) => o.type === "table")) snapshot.exec(table.sql);
	for (const table of objects.filter(
		(o) =>
			o.type === "table" &&
			!["coordinator_device_ownership_bindings", "coordinator_device_rebind_audit_log"].includes(
				o.name,
			),
	)) {
		const rows = source.prepare(`SELECT * FROM ${table.name}`).all() as Record<
			string,
			string | number | null
		>[];
		for (const row of rows)
			snapshot
				.prepare(
					`INSERT INTO ${table.name} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
						.map(() => "?")
						.join(",")})`,
				)
				.run(...Object.values(row));
	}
	for (const object of objects.filter((o) => o.type !== "table")) snapshot.exec(object.sql);
	historicalConnection = snapshot;
	return snapshot;
}
afterEach(async () => {
	historicalConnection?.close();
	historicalConnection = undefined;
	if (base) {
		await base.store.close();
		if (base.db.open) base.db.close();
		base = undefined;
	}
	await legacy?.close();
	legacy = undefined;
});

describe("claim binding source authority", () => {
	it("accepts compatible retained owner evidence only alongside the committed own claim", async () => {
		// Arrange
		legacy = await linkedLegacySetupFixture("SQLite");
		const db = historyBackend(legacy.coordinator.db);
		await retainProducerOwner(legacy.coordinator.db, {
			...legacy.account.signer,
			coordinatorId: LEGACY_SETUP.coordinatorId,
			ownerIdentityId: LEGACY_SETUP.identityId,
		});
		// Act
		const result = await completeDeviceClaimBinding(
			db,
			{ signer: legacy.account.signer, currentIdentityId: LEGACY_SETUP.identityId },
			legacy.account.config,
			Date.parse(LEGACY_SETUP.now),
		);
		// Assert
		expect(result.kind).toBe("completed");
	});
	it.each(["device_claim", "controller_attestation"] as const)(
		"uses %s evidence only according to its authority",
		async (authority) => {
			// Arrange: real current connection schema and coherent genesis.
			base = setupStore("D1", { authClock: () => NOW });
			await reconnectFixture(base.store as D1CoordinatorStore, historyBackend(base.db), authority);
			const snapshot = preBindingConnectionSnapshot(base.db);
			const db = historyBackend(snapshot);
			const before = snapshot.prepare("SELECT * FROM coordinator_device_ownership_bindings").all();
			// Act
			const result = await completeDeviceClaimBinding(
				db,
				{ signer: input.signer, currentIdentityId: input.identityId },
				config,
				NOW + 100,
			);
			// Assert
			expect(result.kind).toBe(authority === "device_claim" ? "completed" : "requires_review");
			if (authority === "controller_attestation")
				expect(
					snapshot.prepare("SELECT * FROM coordinator_device_ownership_bindings").all(),
				).toEqual(before);
		},
	);

	it("accepts a verified active connection successor rooted in the original claim", async () => {
		// Arrange
		base = setupStore("D1", { authClock: () => NOW });
		const db = historyBackend(base.db);
		const f = await reconnectFixture(base.store as D1CoordinatorStore, db);
		await f.disconnect(1);
		const next = await f.confirmed(1);
		expect(await f.links.finalizeAuthLinkAttempt(next.proof, config)).toMatchObject({
			kind: "applied",
		});
		// Act
		const result = await completeDeviceClaimBinding(
			historyBackend(preBindingConnectionSnapshot(base.db)),
			{ signer: input.signer, currentIdentityId: input.identityId },
			config,
			NOW + 100,
		);
		// Assert
		expect(result.kind).toBe("completed");
		expect(base.db.prepare("SELECT * FROM coordinator_auth_device_claims").all()).toHaveLength(1);
	});

	it("rejects a successor after its retained history is revoked", async () => {
		// Arrange
		base = setupStore("D1", { authClock: () => NOW });
		const db = historyBackend(base.db);
		const f = await reconnectFixture(base.store as D1CoordinatorStore, db);
		await f.disconnect(1);
		const next = await f.confirmed(1);
		expect(await f.links.finalizeAuthLinkAttempt(next.proof, config)).toMatchObject({
			kind: "applied",
		});
		const snapshot = preBindingConnectionSnapshot(base.db);
		snapshot.exec("UPDATE coordinator_auth_account_connection_history SET revoked_at_ms=1");
		// Act
		const result = await completeDeviceClaimBinding(
			historyBackend(snapshot),
			{ signer: input.signer, currentIdentityId: input.identityId },
			config,
			NOW + 100,
		);
		// Assert
		expect(result).toEqual({ kind: "requires_review" });
		expect(
			snapshot.prepare("SELECT * FROM coordinator_device_ownership_bindings").all(),
		).toHaveLength(0);
	});
});
describe("retained history compatibility", () => {
	it.each(["same-owner missing source", "conflicting owner"])(
		"uses %s retained resolution only to deny",
		async (caseName) => {
			// Arrange
			legacy = await linkedLegacySetupFixture("SQLite");
			const db = nativeBackend(legacy.coordinator.db);
			await retainProducerOwner(
				legacy.coordinator.db,
				{
					...legacy.account.signer,
					coordinatorId: LEGACY_SETUP.coordinatorId,
					ownerIdentityId:
						caseName === "conflicting owner" ? "other-identity" : LEGACY_SETUP.identityId,
				},
				{ removeSource: true },
			);
			// Act
			const result = await completeDeviceClaimBinding(
				db,
				{ signer: legacy.account.signer, currentIdentityId: LEGACY_SETUP.identityId },
				legacy.account.config,
				Date.parse(LEGACY_SETUP.now),
			);
			// Assert
			expect(result).toEqual({ kind: "requires_review" });
			expect(
				legacy.coordinator.db
					.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id='device-a'")
					.all(),
			).toHaveLength(0);
		},
	);

	it("keeps strict first-link eligibility separate from legacy readiness", async () => {
		// Arrange
		legacy = await linkedLegacySetupFixture("SQLite");
		const db = nativeBackend(legacy.coordinator.db);
		const now = Date.parse(LEGACY_SETUP.now);
		const captured = await captureDeviceClaimEligibility(
			db,
			{ signer: legacy.account.signer, identityId: LEGACY_SETUP.identityId },
			legacy.account.config,
			now,
		);
		if (!captured) throw new Error("expected metadata");
		// Act
		const firstLink = await db.first({
			sql: `${AUTH_DEVICE_CLAIM_INPUT_SQL} SELECT 1 FROM claim_input p WHERE ${AUTH_DEVICE_CLAIM_ELIGIBLE_SQL}`,
			values: captured.values,
		});
		const readiness = await readDeviceClaimBindingReadiness(
			db,
			{ signer: legacy.account.signer, currentIdentityId: LEGACY_SETUP.identityId },
			legacy.account.config,
			now,
		);
		// Assert
		expect(firstLink).toBeNull();
		expect(readiness).toEqual({ kind: "ready" });
	});
});
