import { expect } from "vitest";
import { readConnectionSchemaState } from "../../core/src/coordinator-account-connection-schema.js";
import { EXPECTED_KEY_ID } from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { OwnerEnrollmentQualificationOps } from "../../core/src/coordinator-owner-enrollment-qualification.js";
import {
	aliasKey,
	config,
	NOW,
	otherKey,
	seedKeyRevocationSql,
} from "./device-claim-eligibility-fixture.js";
import {
	attestation,
	current,
	faultedOperations,
	history,
	type Mutation,
	registerIssueFaults,
	registerRaces,
	rejected,
	type Test,
} from "./owner-enrollment-qualification-ops-test-harness.js";

export function registerExtendedQualificationOpsTests(test: Test) {
	registerDigestChanges(test);
	registerIssueFaults(test, ["before_commit"]);
	registerRevokeFaults(test);
	registerReadFaults(test);
	registerMalformedInputs(test);
	registerAccessors(test);
	registerEvidenceDenials(test);
	registerConfigDenials(test);
	registerRaces(test, { stages: ["before preview"], mutations });
	registerRaces(test, {
		stages: ["before INSERT"],
		mutations: mutations.filter(([name]) => name !== "disabled enrollment"),
	});
	registerHistory(test);
	registerSchemaDenials(test);
}
function registerDigestChanges(test: Test) {
	test.for(["review_receipt_id='new-review'", `evidence_digest='${"b".repeat(64)}'`])(
		"changed reviewed birth fact invalidates confirmation: %s",
		async (assignment, { fixture: f }) => {
			// Arrange
			const p = await f.ready();
			// Act
			await f.corrupt("coordinator_auth_controller_attestations", assignment);
			// Assert
			expect((await f.ready()).digest).not.toBe(p.digest);
			expect(await f.ops.issue({ ...attestation, expectedDigest: p.digest })).toEqual({
				kind: "rejected",
				error: "preview_changed",
			});
			expect(await f.rows()).toEqual([]);
		},
	);
}
function registerRevokeFaults(test: Test) {
	test.for(["before_commit", "after_commit"] as const)(
		"revoke write fault %s reports unknown and retry preserves the first stored timestamp",
		async (write, { fixture: f }) => {
			// Arrange
			const created = await f.issue();
			const pair = { qualificationId: created.qualificationId, linkId: "claim-a" };
			const before = (await f.rows())[0];
			// Act
			const unknown = await faultedOperations(f, { write }).revoke(pair);
			const committed = await f.rows();
			f.clock(NOW + 300);
			const retry = await f.ops.revoke(pair);
			// Assert
			expect(unknown).toEqual({ kind: "outcome_unknown" });
			expect(committed).toEqual([
				{ ...before, revoked_at_ms: write === "after_commit" ? NOW + 100 : null },
			]);
			expect(retry).toEqual({ kind: "revoked", qualificationId: created.qualificationId });
			expect(await f.rows()).toEqual([
				{ ...before, revoked_at_ms: write === "after_commit" ? NOW + 100 : NOW + 300 },
			]);
		},
	);
}
function registerReadFaults(test: Test) {
	test("issue post-write retry read failure reports unknown and retries the same retained ID", async ({
		fixture: f,
	}) => {
		// Arrange
		const p = await f.ready();
		const created = await f.issue();
		const before = await f.rows();
		// Act: the INSERT is a no-op, but the checked retry read loses its response.
		const unknown = await faultedOperations(f, { read: "after_write" }).issue({
			...attestation,
			expectedDigest: p.digest,
		});
		const retry = await f.ops.issue({ ...attestation, expectedDigest: p.digest });
		// Assert
		expect(unknown).toEqual({ kind: "outcome_unknown" });
		expect(retry).toEqual({ kind: "existing", qualificationId: created.qualificationId });
		expect(await f.rows()).toEqual(before);
	});
	test("revoke commit followed by a failed read reports unknown and retry retains its timestamp", async ({
		fixture: f,
	}) => {
		// Arrange
		const created = await f.issue();
		const pair = { qualificationId: created.qualificationId, linkId: "claim-a" };
		const before = (await f.rows())[0];
		// Act
		const unknown = await faultedOperations(f, { read: "after_write" }).revoke(pair);
		const committed = await f.rows();
		f.clock(NOW + 300);
		const retry = await f.ops.revoke(pair);
		// Assert
		expect(unknown).toEqual({ kind: "outcome_unknown" });
		expect(committed).toEqual([{ ...before, revoked_at_ms: NOW + 100 }]);
		expect(retry).toEqual({ kind: "revoked", qualificationId: created.qualificationId });
		expect(await f.rows()).toEqual(committed);
	});
	test("pre-write read failures remain unavailable and never attempt an issue or revoke write", async ({
		fixture: f,
	}) => {
		// Arrange
		const p = await f.ready();
		const created = await f.issue();
		const before = await f.rows();
		const ops = faultedOperations(f, { read: "before_write" });
		f.calls.length = 0;
		// Act
		const issue = await ops.issue({ ...attestation, expectedDigest: p.digest });
		const revoke = await ops.revoke({ qualificationId: created.qualificationId, linkId: p.linkId });
		// Assert
		expect(issue).toEqual(rejected);
		expect(revoke).toEqual(rejected);
		expect(f.calls).toEqual([]);
		expect(await f.rows()).toEqual(before);
	});
}
function registerAccessors(test: Test) {
	test.for(["attestationId", "expectedDigest", "qualificationId", "linkId"])(
		"never invokes an accessor for %s",
		async (field, { fixture: f }) => {
			// Arrange
			let reads = 0;
			const value = Object.defineProperty(
				{ ...attestation, expectedDigest: "a".repeat(64), qualificationId: "q", linkId: "claim-a" },
				field,
				{
					get() {
						reads++;
						throw new Error("accessor forbidden");
					},
				},
			);
			f.calls.length = 0;
			// Act
			const actions: Record<string, () => Promise<unknown>> = {
				attestationId: () => f.ops.preview(value),
				expectedDigest: () => f.ops.issue(value),
				qualificationId: () => f.ops.revoke(value),
				linkId: () => f.ops.revoke(value),
			};
			const action = actions[field];
			if (!action) throw new Error("unknown accessor test");
			const result = await action();
			// Assert
			expect(result).toEqual({ kind: "rejected", error: "invalid_input" });
			expect(reads).toBe(0);
			expect(f.calls).toEqual([]);
		},
	);
}
function registerMalformedInputs(test: Test) {
	test.for([
		null,
		[],
		{},
		{ attestationId: "" },
		{ attestationId: " leading" },
		{ attestationId: "x\0y" },
		{ attestationId: "x".repeat(257) },
	])("rejects malformed input %j without database access", async (value, { fixture: f }) => {
		// Arrange
		f.calls.length = 0;
		// Act
		const p = await f.ops.preview(value as never);
		const issue = await f.ops.issue(value as never);
		const revoke = await f.ops.revoke(value as never);
		// Assert
		for (const result of [p, issue, revoke])
			expect(result).toEqual({ kind: "rejected", error: "invalid_input" });
		expect(f.calls).toEqual([]);
	});
	test("rejects accessors without executing getters and captures input/config before awaits", async ({
		fixture: f,
	}) => {
		// Arrange
		let getters = 0;
		const hostile = {
			get attestationId(): string {
				getters++;
				throw new Error("do not invoke");
			},
		};
		const mutable = { ...attestation };
		const cfg = { ...config };
		const ops = new OwnerEnrollmentQualificationOps(f.backend, cfg, () => NOW + 100);
		cfg.enabled = false;
		// Act
		const bad = await ops.preview(hostile);
		const pending = ops.preview(mutable);
		mutable.attestationId = "wrong-after-await";
		// Assert
		expect(bad).toEqual({ kind: "rejected", error: "invalid_input" });
		expect(getters).toBe(0);
		expect(await pending).toMatchObject({ kind: "ready", attestationId: "attestation-a" });
		const p = await f.ready();
		const issueInput = { ...attestation, expectedDigest: p.digest };
		const issued = ops.issue(issueInput);
		issueInput.expectedDigest = "b".repeat(64);
		expect(await issued).toMatchObject({ kind: "created" });
	});
	test.for(["", "A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65)])(
		"rejects malformed confirmation digest %j before querying",
		async (expectedDigest, { fixture: f }) => {
			// Arrange
			f.calls.length = 0;
			// Act
			const result = await f.ops.issue({ ...attestation, expectedDigest });
			// Assert
			expect(result).toEqual({ kind: "rejected", error: "invalid_input" });
			expect(f.calls).toEqual([]);
		},
	);
}
const evidenceDenials = [
	["review coordinator", "coordinator_auth_controller_attestations", "coordinator_id='other'"],
	["review Identity", "coordinator_auth_controller_attestations", "identity_id='other'"],
	["review group", "coordinator_auth_controller_attestations", "group_id='other'"],
	["review device", "coordinator_auth_controller_attestations", "device_id='other'"],
	["review key", "coordinator_auth_controller_attestations", `public_key='${otherKey}'`],
	[
		"review fingerprint",
		"coordinator_auth_controller_attestations",
		`fingerprint='${"b".repeat(64)}'`,
	],
	["review receipt", "coordinator_auth_controller_attestations", "review_receipt_id=''"],
	["review revocation", "coordinator_auth_controller_attestations", "revoked_at='revoked'"],
	[
		"review enrollment",
		"coordinator_auth_controller_attestations",
		"enrollment_identity_id='other'",
	],
	["claim Identity", "coordinator_auth_device_claims", "identity_id='other'"],
	["claim group", "coordinator_auth_device_claims", "group_id='other'"],
	["claim device", "coordinator_auth_device_claims", "device_id='other'"],
	["claim key ID", "coordinator_auth_device_claims", `key_id='${"b".repeat(64)}'`],
	["claim key", "coordinator_auth_device_claims", `public_key='${otherKey}'`],
	["claim attempt", "coordinator_auth_device_claims", "attempt_id='other'"],
	["claim issuer", "coordinator_auth_device_claims", "issuer='other'"],
	["claim revision", "coordinator_auth_device_claims", `auth_config_revision='${"b".repeat(64)}'`],
	["claim timestamp", "coordinator_auth_device_claims", `created_at_ms=${NOW - 1}`],
	["link claim", current, "device_claim_id='missing'"],
	["link Identity", current, "identity_id='other'"],
	["link subject", current, "subject='other'"],
	["link revoked", current, `revoked_at_ms=${NOW + 1}`],
	["committed checkpoint", "coordinator_auth_link_attempts", "confirmed_at_ms=NULL"],
	["committed order", "coordinator_auth_link_attempts", `oidc_verified_at_ms=${NOW + 1}`],
	[
		"committed browser",
		"coordinator_auth_link_attempts",
		"state='expired',browser_transaction_hash=NULL,link_id=NULL,finalized_at_ms=NULL",
	],
	[
		"committed authority",
		"coordinator_auth_link_attempts",
		"authority_kind='controller_attestation',controller_attestation_id='attestation-a',controller_review_receipt_id='receipt-a',controller_revision=1",
	],
	["audit receipt", "coordinator_auth_link_audit_log", "device_claim_id='other'"],
] as const;
function registerEvidenceDenials(test: Test) {
	test.for(["revision=2", `evidence_digest='${"g".repeat(64)}'`])(
		"storage rejects malformed review facts: %s",
		async (assignment, { fixture: f }) => {
			// Arrange
			const before = await f.rows("coordinator_auth_controller_attestations");
			// Act / Assert: table CHECKs prevent these states even with fixture trigger removal.
			await expect(
				f.corrupt("coordinator_auth_controller_attestations", assignment),
			).rejects.toThrow();
			expect(await f.rows("coordinator_auth_controller_attestations")).toEqual(before);
			expect(await f.issue()).toMatchObject({ kind: "created" });
		},
	);
	test.for(evidenceDenials)(
		"rejects mismatched historical $0 with complete schema",
		async ([, name, assignment], { fixture: f }) => {
			// Arrange: start with proven eligible evidence, then corrupt only the named fact.
			const p = await f.ready();
			await f.corrupt(name, assignment);
			expect(await readConnectionSchemaState(f.backend)).toBe("ready");
			// Act
			const preview = await f.ops.preview(attestation);
			const issue = await f.ops.issue({ ...attestation, expectedDigest: p.digest });
			// Assert
			expect(preview).toEqual(rejected);
			expect(issue).toEqual(rejected);
			expect(await f.rows()).toEqual([]);
		},
	);
	test("an arbitrary attestation is not committed claim proof", async ({ fixture: f }) => {
		// Arrange
		const p = await f.ready();
		await f.exec("DELETE FROM coordinator_auth_link_audit_log");
		// Act
		const result = await f.ops.issue({ ...attestation, expectedDigest: p.digest });
		// Assert
		expect(await f.rows("coordinator_auth_controller_attestations")).toHaveLength(1);
		expect(result).toEqual(rejected);
		expect(await f.rows()).toEqual([]);
	});
	test("canonical key aliases cannot hide a contradictory Identity", async ({ fixture: f }) => {
		// Arrange: a harmless alias for the same actor is accepted.
		await f.exec(
			`INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,identity_id,created_at) VALUES ('group-a','alias-device','${aliasKey}','${"c".repeat(64)}','identity-a','created')`,
		);
		const p = await f.ready();
		// Act
		await f.exec("UPDATE enrolled_devices SET identity_id='other' WHERE device_id='alias-device'");
		// Assert
		expect(await f.ops.preview(attestation)).toEqual(rejected);
		expect(await f.ops.issue({ ...attestation, expectedDigest: p.digest })).toEqual(rejected);
		expect(await f.rows()).toEqual([]);
	});
}
function registerConfigDenials(test: Test) {
	test("unknown attestation and disabled/wrong-coordinator configurations fail closed", async ({
		fixture: f,
	}) => {
		// Arrange
		const p = await f.ready();
		// Act / Assert
		expect(await f.ops.preview({ attestationId: "missing" })).toEqual(rejected);
		for (const patch of [
			{ enabled: false },
			{ coordinatorId: "other" },
			{ issuer: "https://other.example.test" },
		]) {
			const ops = new OwnerEnrollmentQualificationOps(
				f.backend,
				{ ...config, ...patch },
				() => NOW + 100,
			);
			expect(await ops.preview(attestation)).toEqual(rejected);
			expect(await ops.issue({ ...attestation, expectedDigest: p.digest })).toEqual(rejected);
		}
		expect(await f.rows()).toEqual([]);
	});
}
const mutations: Mutation[] = [
	[
		"same-actor enrollment without renewed exact review",
		(f) =>
			f.exec("UPDATE enrolled_devices SET identity_id='identity-a' WHERE device_id='device-a'"),
	],
	[
		"disabled enrollment",
		(f) => f.exec("UPDATE enrolled_devices SET enabled=0 WHERE device_id='device-a'"),
	],
	[
		"changed enrollment key",
		(f) =>
			f.exec(`UPDATE enrolled_devices SET public_key='${otherKey}' WHERE device_id='device-a'`),
	],
	[
		"changed enrollment actor",
		(f) => f.exec("UPDATE enrolled_devices SET identity_id='other' WHERE device_id='device-a'"),
	],
	["archived group", (f) => f.exec("UPDATE groups SET archived_at='archived'")],
	[
		"revoked review",
		(f) => f.exec("UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked'"),
	],
	["key revocation", (f) => f.exec(seedKeyRevocationSql)],
	[
		"device revocation",
		(f) =>
			f.exec(
				seedKeyRevocationSql
					.replace("'ed25519_key'", "'device_id'")
					.replace(`'${EXPECTED_KEY_ID}'`, "'device-a'"),
			),
	],
	["ended connection", (f) => f.end()],
	["same-account new link ID", (f) => f.end({ relink: true })],
];
function registerHistory(test: Test) {
	test("same-account relink never inherits the previous qualification", async ({ fixture: f }) => {
		// Arrange
		const original = await f.ready();
		const created = await f.issue();
		const before = await f.rows();
		// Act
		await f.end({ relink: true });
		// Assert: the old proof is retained but cannot qualify a different generation.
		expect((await f.rows(current))[0]).toMatchObject({
			link_id: "link-b",
			subject: "private-claim-subject",
		});
		expect(await f.ops.issue({ ...attestation, expectedDigest: original.digest })).toEqual({
			kind: "rejected",
			error: "preview_changed",
		});
		const fresh = await f.ready();
		expect(fresh.linkId).toBe("link-b");
		expect(fresh.digest).not.toBe(original.digest);
		expect(await f.rows()).toEqual(before);
		expect(before[0]).toMatchObject({
			qualification_id: created.qualificationId,
			link_id: "claim-a",
		});
		const issued = await f.ops.issue({ ...attestation, expectedDigest: fresh.digest });
		expect(issued).toMatchObject({
			kind: "created",
			qualificationId: expect.not.stringMatching(`^${created.qualificationId}$`),
		});
		expect(await f.rows()).toHaveLength(2);
	});
	test("retained history revocation blocks an otherwise matching current link", async ({
		fixture: f,
	}) => {
		// Arrange
		await f.end({ relink: true });
		await f.ready();
		await f.exec(`UPDATE ${history} SET revoked_at_ms=${NOW + 60}`);
		// Act
		const result = await f.ops.preview(attestation);
		// Assert
		expect(result).toEqual(rejected);
		expect(await f.rows()).toEqual([]);
	});
}
function registerSchemaDenials(test: Test) {
	test.for([
		"DROP TRIGGER connection_link_prior_immutable",
		"DROP INDEX connection_history_head",
		"DROP TABLE coordinator_auth_account_connection_orders",
		"DROP TRIGGER owner_enrollment_qualification_immutable_update",
	])("partial schema denies without repairing it: %s", async (sql, { fixture: f }) => {
		// Arrange
		const p = await f.ready();
		await f.exec(sql);
		const before = await f.query("SELECT type,name,sql FROM sqlite_master ORDER BY type,name");
		// Act
		const preview = await f.ops.preview(attestation);
		const issue = await f.ops.issue({ ...attestation, expectedDigest: p.digest });
		// Assert
		expect(preview).toEqual(rejected);
		expect(issue).toEqual(rejected);
		expect(await f.query("SELECT type,name,sql FROM sqlite_master ORDER BY type,name")).toEqual(
			before,
		);
		expect(await f.rows()).toEqual([]);
	});
}
