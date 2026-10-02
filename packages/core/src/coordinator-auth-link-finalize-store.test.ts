import { describe, expect } from "vitest";
import type { CoordinatorAuthLinkFinalizeInput as FinalizeInput } from "./coordinator-auth-link-contract.js";
import {
	advance,
	attempt,
	authorize,
	backendTest,
	browser,
	browserHash,
	cfg,
	completionHash,
	device,
	expectRejected,
	finalize,
	type LinkFixture,
	rows,
	setIdentity,
	signer,
	snapshot,
	status,
	TABLES,
	type Test,
	TTL,
} from "./coordinator-auth-link-test-fixtures.js";
import { type Backend, review } from "./coordinator-auth-store-test-fixtures.js";

const liveChanges = [
	"missing",
	"revoked",
	"receipt",
	"key",
	"fingerprint",
	"removed",
	"disabled",
	"archive",
	"identity",
] as const;
async function changeAuthority(f: LinkFixture, change: (typeof liveChanges)[number]) {
	if (change === "missing") f.db.exec("DELETE FROM coordinator_auth_controller_attestations");
	if (change === "revoked")
		await f.store.revokeAuthControllerAttestation(cfg.coordinatorId, review().attestationId);
	if (change === "receipt")
		f.db
			.prepare("UPDATE coordinator_auth_controller_attestations SET review_receipt_id = ?")
			.run("changed-receipt");
	if (change === "key")
		await f.store.enrollDevice(signer.groupId, { ...signer, publicKey: "replacement-key" });
	if (change === "fingerprint")
		await f.store.enrollDevice(signer.groupId, { ...signer, fingerprint: "e".repeat(64) });
	if (change === "removed") await f.store.removeDevice(signer.groupId, signer.deviceId);
	if (change === "disabled") await f.store.setDeviceEnabled(signer.groupId, signer.deviceId, false);
	if (change === "archive") await f.store.archiveGroup(signer.groupId);
	if (change === "identity") setIdentity(f, "identity-other");
}

function registerAuthorityTests(test: Test) {
	test.for(liveChanges.filter((value) => value !== "receipt"))(
		"cannot initiate with %s controller authority",
		async (change, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await changeAuthority(f, change);
			// Act
			const result = await f.store.createAuthLinkAttempt(attempt(), f.cfg);
			// Assert
			expectRejected(result, "controller_not_active");
			expect(snapshot(f)).toEqual([[], [], []]);
		},
	);
	test.for(liveChanges)(
		"atomically rejects finalization after %s authority change",
		async (change, { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, "confirmed");
			await changeAuthority(f, change);
			const before = snapshot(f);
			// Act
			const result = await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
			// Assert
			expectRejected(result, "controller_not_active");
			expect(snapshot(f)).toEqual(before);
		},
	);
	test.for([null, "identity-a"])(
		"finalizes with live null-or-matching Identity %s",
		async (identity, { fixture: f }) => {
			// Arrange
			await authorize(f);
			setIdentity(f, "identity-a");
			await advance(f, "confirmed");
			setIdentity(f, identity);
			// Act
			const result = await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
			// Assert
			expect(result).toEqual({ kind: "applied", status: status("finalized") });
			expect(rows(f, TABLES[1])).toHaveLength(1);
			expect(rows(f, TABLES[2])).toHaveLength(1);
		},
	);
}

const wrongFinalizations: [string, Partial<FinalizeInput>, string][] = [
	["purpose", { purpose: "other-purpose" as FinalizeInput["purpose"] }, "invalid_input"],
	["coordinator", { coordinatorId: "coordinator-b" }, "invalid_input"],
	["group", { groupId: "other-group" }, "attempt_unavailable"],
	["identity", { identityId: "other-identity" }, "attempt_unavailable"],
	["device", { deviceId: "other-device" }, "attempt_unavailable"],
	["fingerprint", { fingerprint: "e".repeat(64) }, "attempt_unavailable"],
	["runtime proof", { runtimeVerifierHash: "e".repeat(64) }, "attempt_unavailable"],
	["completion proof", { completionSecretHash: "e".repeat(64) }, "attempt_unavailable"],
	[
		"swapped proofs",
		{ runtimeVerifierHash: completionHash, completionSecretHash: attempt().runtimeVerifierHash },
		"attempt_unavailable",
	],
	["signer key", { signer: { ...signer, publicKey: "wrong-key" } }, "attempt_unavailable"],
];

function registerFinalizationTests(test: Test) {
	test.for(wrongFinalizations)(
		"rejects wrong %s without consuming or exposing a proof oracle",
		async ([_label, overrides, error], { fixture: f }) => {
			// Arrange
			await authorize(f);
			await advance(f, "confirmed");
			const before = snapshot(f);
			// Act
			const denied = await f.store.finalizeAuthLinkAttempt(finalize(overrides), f.cfg);
			const afterDenied = snapshot(f);
			const valid = await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
			// Assert
			expectRejected(denied, error);
			expect(afterDenied).toEqual(before);
			expect(valid).toEqual({ kind: "applied", status: status("finalized") });
		},
	);
	test("concurrent exact finalization has one effect and retry never returns browser credentials", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "confirmed");
		const enrollment = f.db.prepare("SELECT * FROM enrolled_devices").all();
		// Act
		const results = await Promise.all([
			f.store.finalizeAuthLinkAttempt(finalize(), f.cfg),
			f.store.finalizeAuthLinkAttempt(finalize(), f.cfg),
		]);
		const after = snapshot(f);
		f.now += TTL + 1;
		const retry = await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
		// Assert
		expect(results).toEqual(
			expect.arrayContaining([
				{ kind: "applied", status: status("finalized") },
				{ kind: "existing", status: status("finalized") },
			]),
		);
		expect(retry).toEqual({ kind: "existing", status: status("finalized") });
		expect(snapshot(f)).toEqual(after);
		expect(rows(f, TABLES[1])).toHaveLength(1);
		expect(rows(f, TABLES[2])).toHaveLength(1);
		expect(f.db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(enrollment);
		const audit = JSON.stringify(rows(f, TABLES[2]));
		for (const forbidden of [
			"opaque-subject-a",
			browserHash,
			completionHash,
			attempt().runtimeVerifierHash,
			attempt().loopbackRedirect,
		])
			expect(audit).not.toContain(forbidden);
	});
}

function registerBindingTests(test: Test) {
	test("re-enrollment with another key after confirmation cannot inherit reviewed ownership", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "confirmed");
		await f.store.removeDevice(signer.groupId, signer.deviceId);
		await f.store.enrollDevice(signer.groupId, {
			...signer,
			publicKey: "replacement-key",
			fingerprint: "e".repeat(64),
		});
		const before = snapshot(f);
		// Act
		const result = await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
		// Assert
		expectRejected(result, "controller_not_active");
		expect(snapshot(f)).toEqual(before);
	});
	test("finalization binds only the previously verified account, not extra caller account content", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "confirmed");
		const input = {
			...finalize(),
			account: { issuer: "https://attacker.example.test", subject: "forged-subject" },
			identityId: "identity-a",
		};
		// Act
		const result = await f.store.finalizeAuthLinkAttempt(input, f.cfg);
		// Assert
		expect(result.kind).toBe("applied");
		expect(rows(f, TABLES[1])[0]).toMatchObject({
			issuer: cfg.issuer,
			subject: "opaque-subject-a",
			identity_id: "identity-a",
		});
		expect(JSON.stringify(snapshot(f))).not.toContain("forged-subject");
	});
	test("missing attempt never grants status or finalization authority", async ({ fixture: f }) => {
		// Arrange
		await authorize(f);
		// Act
		const result = await f.store.finalizeAuthLinkAttempt(finalize(), f.cfg);
		const publicStatus = await f.store.getAuthLinkAttemptStatus("attempt-a", device, f.cfg);
		// Assert
		expectRejected(result, "attempt_unavailable");
		expect(publicStatus).toBeNull();
		expect(snapshot(f)).toEqual([[], [], []]);
	});
	test("coordinator namespaces isolate identical attempts and proof commitments", async ({
		fixture: f,
	}) => {
		// Arrange
		await authorize(f);
		await advance(f, "confirmed");
		const otherCfg = { ...f.cfg, coordinatorId: "coordinator-b" };
		await f.store.createAuthControllerAttestation(
			review({ coordinatorId: otherCfg.coordinatorId }),
		);
		// Act
		const created = await f.store.createAuthLinkAttempt(attempt(), otherCfg);
		const replay = await f.store.finalizeAuthLinkAttempt(finalize(), otherCfg);
		const publicStatus = await f.store.getAuthLinkAttemptStatus("attempt-a", browser, otherCfg);
		// Assert
		expect(created).toEqual({
			kind: "created",
			status: status("pending"),
			identityId: "identity-a",
		});
		expectRejected(replay, "invalid_input");
		expect(publicStatus).toBeNull();
		expect(
			rows(f, TABLES[0])
				.map((row) => row.state)
				.sort(),
		).toEqual(["confirmed", "pending"]);
		expect(rows(f, TABLES[1])).toEqual([]);
	});
}

function registerBackend(backend: Backend) {
	const test = backendTest(backend);
	registerAuthorityTests(test);
	registerFinalizationTests(test);
	registerBindingTests(test);
}
describe.each(["SQLite", "D1"] as const)(
	"%s auth-link finalization parity (D1 is SQLite-backed)",
	registerBackend,
);
