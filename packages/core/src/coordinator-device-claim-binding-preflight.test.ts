import { afterEach, describe, expect, it } from "vitest";
import {
	config,
	input,
	NOW,
	otherKey,
	seedBindingSql,
	seedEnrollmentSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import {
	AUTH_DEVICE_CLAIM_BINDING_STRUCTURE_SQL,
	AUTH_DEVICE_CLAIM_ELIGIBLE_SQL,
	AUTH_DEVICE_CLAIM_INPUT_SQL,
	captureDeviceClaimEligibility,
} from "./coordinator-auth-device-claim-eligibility.js";
import { type Fixture, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { isDeviceClaimBindingConflict } from "./coordinator-device-claim-binding.js";
import { nativeBackend } from "./coordinator-owner-enrollment-start-test-fixtures.js";

let f: Fixture;
afterEach(async () => {
	await f?.store.close();
	if (f?.db.open) f.db.close();
});

for (const kind of ["SQLite", "D1"] as const) {
	describe(`${kind} first-link setup structure`, () => {
		async function eligibility() {
			const backend = nativeBackend(f.db);
			const captured = await captureDeviceClaimEligibility(backend, input, config, NOW);
			if (!captured) throw new Error("expected captured signer");
			return backend.first({
				sql: `${AUTH_DEVICE_CLAIM_INPUT_SQL} SELECT 1 FROM claim_input p WHERE ${AUTH_DEVICE_CLAIM_ELIGIBLE_SQL}`,
				values: captured.values,
			});
		}
		it("admits a device with consistent key enrollments before any account claim", async () => {
			// Arrange
			f = setupStore(kind);
			f.db.exec(seedEnrollmentSql);
			// Act
			const result = await eligibility();
			// Assert
			expect(result).not.toBeNull();
		});
		it.each([
			[
				"another enrollment with an older key",
				`INSERT INTO groups (group_id,created_at) VALUES ('group-b','created'); INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,created_at) VALUES ('group-b','device-a','${otherKey}','${"c".repeat(64)}',NULL,'created')`,
			],
			[
				"a canonical-key alias with NULL Identity",
				`UPDATE enrolled_devices SET public_key='${input.signer.publicKey} same-key-alias',identity_id=NULL WHERE device_id='unrelated-device'`,
			],
			[
				"a fingerprint mismatch in another group",
				`INSERT INTO groups (group_id,created_at) VALUES ('group-b','created'); INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,created_at) VALUES ('group-b','device-a','${input.signer.publicKey}','${"c".repeat(64)}',NULL,'created')`,
			],
			[
				"a binding in another coordinator namespace",
				seedBindingSql.replace("'coordinator-a'", "'other-coordinator'"),
			],
		])("rejects %s before OIDC", async (_name, sql) => {
			// Arrange
			f = setupStore(kind);
			f.db.exec(seedEnrollmentSql);
			f.db.exec(sql);
			// Act
			const result = await eligibility();
			// Assert
			expect(result).toBeNull();
			expect(f.db.prepare("SELECT * FROM coordinator_auth_link_attempts").all()).toHaveLength(0);
		});
		it("treats an exact existing D/K/X binding as structurally compatible", async () => {
			// Arrange: reuse/mint decisions remain with the producer, not this negative predicate.
			f = setupStore(kind);
			f.db.exec(seedEnrollmentSql);
			f.db.exec(seedBindingSql);
			const backend = nativeBackend(f.db);
			const captured = await captureDeviceClaimEligibility(backend, input, config, NOW);
			if (!captured) throw new Error("expected captured signer");
			// Act
			const result = await backend.first({
				sql: `${AUTH_DEVICE_CLAIM_INPUT_SQL} SELECT 1 FROM claim_input p WHERE ${AUTH_DEVICE_CLAIM_BINDING_STRUCTURE_SQL}`,
				values: captured.values,
			});
			// Assert
			expect(result).not.toBeNull();
		});
	});
}

describe("binding rollback error classification", () => {
	it("identifies only its dedicated fatal JSON path, including a D1 cause", () => {
		// Arrange
		const error = new Error("D1_ERROR", {
			cause: new Error("bad JSON path: 'device_claim_binding_count_mismatch'"),
		});
		// Act
		const result = isDeviceClaimBindingConflict(error);
		// Assert
		expect(result).toBe(true);
	});
	it.each([
		"disk I/O error",
		"malformed JSON",
		"device_claim_binding_count_mismatch",
		"bad JSON path: 'unrelated'",
	])("does not classify %s as a known rollback", (message) => {
		// Arrange
		const error = new Error(message);
		// Act
		const result = isDeviceClaimBindingConflict(error);
		// Assert
		expect(result).toBe(false);
	});
});
