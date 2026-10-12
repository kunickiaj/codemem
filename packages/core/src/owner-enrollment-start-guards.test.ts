import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type AuthLinkBackend, AuthLinkOperations } from "./coordinator-auth-link.js";
import {
	AUTH_LINK_CREATE_WINDOW_MS,
	AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
} from "./coordinator-auth-link-contract.js";
import { attempt as linkAttempt, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { enroll, review } from "./coordinator-auth-store-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { oidcFixture } from "./coordinator-oidc-test-fixtures.js";
import {
	ATTEMPTS,
	browserForm,
	config,
	ORIGIN,
	type OwnerStartFixture,
	ownerStartFixture,
	proof,
	TRANSACTIONS,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import {
	createCoordinatorOwnerEnrollment,
	ownerEnrollmentStartMessage,
} from "./owner-enrollment-start.js";

let f: OwnerStartFixture;
beforeEach(() => {
	f = ownerStartFixture();
});
afterEach(() => {
	f.close();
	vi.restoreAllMocks();
});
const pin = {
	coordinatorId: config.coordinatorId,
	origin: ORIGIN,
	issuer: config.issuer,
	revision: config.revision,
};
const rejected = { kind: "rejected", error: "owner_enrollment_unavailable" };
const guards = ["revoked-device", "revoked-key", "bound-device", "bound-key"] as const;
type Guard = (typeof guards)[number];
const snapshot = () => [...f.snapshot(), f.rows("coordinator_device_revocations")];

async function compose(
	clock = () => NOW,
	options: {
		limiter?: Parameters<typeof createCoordinatorOwnerEnrollment>[0]["limiter"];
		backend?: AuthLinkBackend;
	} = {},
) {
	// Comment bytes differ from the canonical revoked-key identity.
	const publicKey = `${f.key.publicKey} signed-comment`;
	const input = {
		attemptId: "attempt-a",
		deviceId: "device-a",
		publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: proof(),
		signature: "",
	};
	const form = await browserForm(input.attemptId, input.browserStartCode);
	const provider = oidcFixture({ issuer: config.issuer });
	const result = await createCoordinatorOwnerEnrollment({
		purpose: "owner_enroll",
		mode: "local_test",
		config,
		backend: options.backend ?? f.backend,
		csrfKey: form.csrfKey,
		limiter: options.limiter ?? { check: () => ({ allowed: true, retryAfterS: 0 }) },
		oidcOptions: { fetch: provider.fetch },
		clock,
	});
	if (!result.ok) throw new Error("fixture composition failed");
	const signed = (attemptId: string, deviceId = input.deviceId) => {
		const next = { ...input, attemptId, deviceId, browserStartCode: proof() };
		return { ...next, signature: f.key.sign(ownerEnrollmentStartMessage(next, pin)) };
	};
	return {
		...result.enrollment,
		form,
		signed,
		input: { ...input, signature: f.key.sign(ownerEnrollmentStartMessage(input, pin)) },
	};
}

it.each([undefined, "", " transport-a", "client\u0000", "x".repeat(129)])(
	"rejects invalid trusted client %j before crypto or storage",
	async (client) => {
		// Arrange: exercise the runtime boundary including omitted JS caller arguments.
		const check = vi.fn(() => ({ allowed: true, retryAfterS: 0 }));
		const c = await compose(() => NOW, { limiter: { check } });
		const verify = vi.spyOn(crypto.subtle, "verify");
		const digest = vi.spyOn(crypto.subtle, "digest");
		const run = vi.spyOn(f.backend, "run");
		const first = vi.spyOn(f.backend, "first");
		// Act
		const result = await c.start(c.input, client as string);
		// Assert
		expect(result).toEqual(rejected);
		expect(check).not.toHaveBeenCalled();
		expect(verify).not.toHaveBeenCalled();
		expect(digest).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
		expect(first).not.toHaveBeenCalled();
	},
);

it("shares admission across nominated device/attempt changes, before signature and DB work", async () => {
	// Arrange: one accepted admission followed by limiter denial for the same transport client.
	const check = vi.fn(() => ({ allowed: false, retryAfterS: 1 }));
	check.mockReturnValueOnce({ allowed: true, retryAfterS: 0 });
	const c = await compose(() => NOW, { limiter: { check } });
	expect((await c.start(c.input, "x".repeat(128))).kind).toBe("started");
	const changed = { ...c.signed("attempt-b"), deviceId: "device-b" };
	const verify = vi.spyOn(crypto.subtle, "verify");
	const digest = vi.spyOn(crypto.subtle, "digest");
	const run = vi.spyOn(f.backend, "run");
	const first = vi.spyOn(f.backend, "first");
	const before = snapshot();
	// Act: changed nominated IDs and even a now-invalid signature cannot bypass admission.
	const result = await c.start(changed, "x".repeat(128));
	// Assert
	expect(result).toEqual(rejected);
	expect(check.mock.calls[1]).toEqual(check.mock.calls[0]);
	expect(verify).not.toHaveBeenCalled();
	expect(digest).not.toHaveBeenCalled();
	expect(run).not.toHaveBeenCalled();
	expect(first).not.toHaveBeenCalled();
	expect(snapshot()).toEqual(before);
});

// Copy real birth facts with distinct IDs/commitments; capacity is coordinator-wide, not per-device.
function seedCapacity(count: number, state: "pending" | "failed") {
	// Avoid the replacement-collision scan during bulk fixture setup only.
	// Restore the exact trigger before either admission boundary is exercised.
	const trigger = f.db
		.prepare(
			"SELECT sql FROM sqlite_master WHERE type='trigger' AND name='owner_enrollment_pins_insert'",
		)
		.get() as { sql: string };
	f.db.exec("DROP TRIGGER owner_enrollment_pins_insert");
	try {
		f.db
			.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < ?)
	INSERT INTO ${ATTEMPTS} (coordinator_id,attempt_id,purpose,origin,device_id,public_key,key_id,fingerprint,
	issuer,auth_config_revision,loopback_redirect,browser_start_hash,state,created_at_ms,expires_at_ms)
	SELECT a.coordinator_id,'capacity-'||n.i,a.purpose,a.origin,'capacity-device-'||n.i,a.public_key,a.key_id,a.fingerprint,
	a.issuer,a.auth_config_revision,CASE WHEN ?='pending' THEN a.loopback_redirect ELSE NULL END,
	printf('%064x',n.i),?,a.created_at_ms,a.expires_at_ms FROM ${ATTEMPTS} a,n WHERE a.attempt_id='attempt-a'`)
			.run(count, state, state);
	} finally {
		f.db.exec(trigger.sql);
	}
	expect(
		f.db
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type='trigger' AND name='owner_enrollment_pins_insert'",
			)
			.get(),
	).toEqual(trigger);
}

it("caps live coordinator attempts at 1000 while time-expired rows release capacity without deletion", async () => {
	// Arrange: distinct devices avoid the existing per-device limit.
	let now = NOW;
	const c = await compose(() => now);
	expect((await c.start(c.input, "transport-a")).kind).toBe("started");
	seedCapacity(998, "pending");
	// Act / Assert: last live slot succeeds, next fails closed.
	expect((await c.start(c.signed("last-slot"), "transport-a")).kind).toBe("started");
	const before = snapshot();
	expect(await c.start(c.signed("over-cap", "new-device"), "transport-a")).toEqual(rejected);
	expect(snapshot()).toEqual(before);
	now += 600000;
	// Act
	const afterExpiry = await c.start(c.signed("after-expiry"), "transport-a");
	// Assert: old rows are still replay tombstones.
	expect(afterExpiry.kind).toBe("started");
	expect(f.rows(ATTEMPTS)).toHaveLength(1001);
});

it("fails closed at the retained unfinished ceiling even after tombstones expire", async () => {
	// Arrange: terminal rows do not consume active slots, but still consume retained storage.
	let now = NOW;
	const c = await compose(() => now);
	expect((await c.start(c.input, "transport-a")).kind).toBe("started");
	seedCapacity(AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR - 2, "failed");
	now += AUTH_LINK_CREATE_WINDOW_MS;
	expect((await c.start(c.signed("last-retained-slot"), "transport-a")).kind).toBe("started");
	now += AUTH_LINK_CREATE_WINDOW_MS;
	const before = snapshot();
	expect(f.db.prepare(`SELECT count(*) AS count FROM ${ATTEMPTS}`).get()).toEqual({
		count: AUTH_LINK_MAX_UNFINISHED_PER_COORDINATOR,
	});
	// Act
	const result = await c.start(c.signed("over-retained-cap"), "transport-a");
	// Assert: no cleanup or mutation to make room for a new unsigned timestamp-free tuple.
	expect(result).toEqual(rejected);
	expect(snapshot()).toEqual(before);
});

it.each(["pending", "failed", "retired"] as const)(
	"denies exact signed-start replay of retained %s history",
	async (state) => {
		// Arrange: real signed start, retained beyond both TTL and recent-create window.
		let now = NOW;
		const c = await compose(() => now);
		expect((await c.start(c.input, "transport-a")).kind).toBe("started");
		if (state !== "pending")
			f.db.exec(`UPDATE ${ATTEMPTS} SET state='${state}',loopback_redirect=NULL`);
		now += AUTH_LINK_CREATE_WINDOW_MS;
		const before = snapshot();
		// Act
		const replay = await c.start(c.input, "other-transport");
		// Assert: a storage conflict must never produce a new started result.
		expect(replay.kind).toBe("rejected");
		expect(snapshot()).toEqual(before);
	},
);

it.each(["pending", "expired"] as const)(
	"owner creation atomically excludes %s link attempt IDs",
	async (state) => {
		// Arrange: actual SQL checks terminal rows too; introduce the link at the winning INSERT.
		const c = await compose();
		const sql = `INSERT INTO coordinator_auth_link_attempts
	(coordinator_id,attempt_id,identity_id,group_id,device_id,public_key,fingerprint,controller_attestation_id,
	controller_review_receipt_id,controller_revision,issuer,auth_config_revision,runtime_verifier_hash,loopback_redirect,state,created_at_ms,expires_at_ms)
	VALUES ('${config.coordinatorId}','attempt-a','identity-a','group-a','link-device','key','${"b".repeat(64)}','attestation-a','receipt-a',1,
	'${config.issuer}','${config.revision}','${"c".repeat(64)}','http://127.0.0.1:43210/complete','${state}',${NOW},${NOW + 600000})`;
		const run = f.backend.run;
		vi.spyOn(f.backend, "run").mockImplementationOnce(async (s) => {
			f.db.exec(sql);
			return run(s);
		});
		// Act
		const result = await c.start(c.input, "transport-a");
		// Assert
		expect(result).toEqual(rejected);
		expect(f.rows(ATTEMPTS)).toEqual([]);
		expect(f.rows("coordinator_auth_link_attempts")).toHaveLength(1);
	},
);

it.each(["pending", "failed"] as const)(
	"link creation atomically excludes %s owner attempt IDs",
	async (state) => {
		// Arrange: real controller authority plus a different-ID positive creation control.
		await enroll(f.store);
		expect((await f.store.createAuthControllerAttestation(review())).kind).toBe("created");
		const c = await compose();
		const links = new AuthLinkOperations(f.backend, () => NOW);
		expect(
			(await links.createAuthLinkAttempt(linkAttempt({ attemptId: "other-attempt" }), config)).kind,
		).toBe("created");
		const run = f.backend.run;
		vi.spyOn(f.backend, "run").mockImplementationOnce(async (s) => {
			// The collision arrives after the create preflight, before its atomic INSERT.
			expect((await c.start(c.input, "transport-a")).kind).toBe("started");
			if (state === "failed")
				f.db.exec(`UPDATE ${ATTEMPTS} SET state='failed',loopback_redirect=NULL`);
			return run(s);
		});
		// Act: unique verifier avoids an unrelated unique-key rejection.
		const result = await links.createAuthLinkAttempt(
			linkAttempt({ runtimeVerifierHash: "e".repeat(64) }),
			config,
		);
		// Assert
		expect(result).toEqual({ kind: "rejected", error: "attempt_conflict" });
		expect(f.rows("coordinator_auth_link_attempts").map((r) => r.attempt_id)).toEqual([
			"other-attempt",
		]);
		expect(f.rows(ATTEMPTS)).toHaveLength(1);
	},
);

it.each(
	(["pending", "expired"] as const).flatMap((state) =>
		[false, true].map((retry) => ({ state, retry })),
	),
)(
	"link creation reports a conflict for a $state owner browser-only attempt ID with retry=$retry",
	async ({ state, retry }) => {
		// Arrange: browser history reserves the ID even without an owner attempt row.
		await enroll(f.store);
		expect((await f.store.createAuthControllerAttestation(review())).kind).toBe("created");
		const links = new AuthLinkOperations(f.backend, () => NOW);
		const input = linkAttempt({ runtimeVerifierHash: "e".repeat(64) });
		if (retry) {
			// Act / Assert: an exact same-purpose retry succeeds before the legacy collision.
			const original = await links.createAuthLinkAttempt(input, config);
			expect(original.kind).toBe("created");
			expect(await links.createAuthLinkAttempt(input, config)).toEqual({
				...original,
				kind: "existing",
			});
		}
		// Arrange: seed retained legacy history after any successful link retry.
		f.db
			.prepare(`INSERT INTO ${TRANSACTIONS}
		(coordinator_id,browser_transaction_hash,purpose,attempt_id,state_hash,binder_hash,
		issuer,auth_config_revision,redirect_uri,state,nonce,pkce_verifier,created_at_ms,expires_at_ms)
		VALUES (?,?,'owner_enroll','attempt-a',?,?,?,?,?,?,?,?,?,?)`)
			.run(
				config.coordinatorId,
				"1".repeat(64),
				"2".repeat(64),
				"3".repeat(64),
				config.issuer,
				config.revision,
				config.redirectUri,
				state,
				state === "pending" ? proof() : null,
				state === "pending" ? proof() : null,
				NOW - 300000,
				state === "pending" ? NOW + 300000 : NOW - 1,
			);
		const before = f.rows(TRANSACTIONS);
		// Act: a different ID succeeds; the reserved ID must not look rate-limited.
		const created = await links.createAuthLinkAttempt(
			linkAttempt({ attemptId: "other-attempt" }),
			config,
		);
		const linkRows = f.rows("coordinator_auth_link_attempts");
		const collision = await links.createAuthLinkAttempt(input, config);
		// Assert: terminal history also retains the reservation without being mutated.
		expect(created.kind).toBe("created");
		expect(collision).toEqual({ kind: "rejected", error: "attempt_conflict" });
		expect(f.rows(ATTEMPTS)).toEqual([]);
		expect(f.rows(TRANSACTIONS)).toEqual(before);
		expect(f.rows("coordinator_auth_link_attempts")).toEqual(linkRows);
	},
);

it.each(["pending", "failed"] as const)(
	"exact link retry rejects a retained legacy %s owner attempt collision",
	async (state) => {
		// Arrange: real controller authority and an unrelated signed owner start.
		await enroll(f.store);
		expect((await f.store.createAuthControllerAttestation(review())).kind).toBe("created");
		const c = await compose();
		expect((await c.start(c.signed("owner-source"), "transport-a")).kind).toBe("started");
		const links = new AuthLinkOperations(f.backend, () => NOW);
		const input = linkAttempt();
		// Act / Assert: a matching link row normally permits an exact retry.
		const original = await links.createAuthLinkAttempt(input, config);
		expect(original.kind).toBe("created");
		expect(await links.createAuthLinkAttempt(input, config)).toEqual({
			...original,
			kind: "existing",
		});
		// Arrange: insert legacy birth facts without changing any immutable pins.
		f.db
			.prepare(`INSERT INTO ${ATTEMPTS}
		(coordinator_id,attempt_id,purpose,origin,device_id,public_key,key_id,fingerprint,
		issuer,auth_config_revision,loopback_redirect,browser_start_hash,state,created_at_ms,expires_at_ms)
		SELECT coordinator_id,'attempt-a',purpose,origin,device_id,public_key,key_id,fingerprint,
		issuer,auth_config_revision,CASE WHEN ?='pending' THEN loopback_redirect ELSE NULL END,
		?, ?,created_at_ms,expires_at_ms FROM ${ATTEMPTS} WHERE attempt_id='owner-source'`)
			.run(state, "f".repeat(64), state);
		const before = snapshot();
		const linkRows = f.rows("coordinator_auth_link_attempts");
		// Act
		const collision = await links.createAuthLinkAttempt(input, config);
		// Assert: neither retained owner history nor the matching link row changes.
		expect(collision).toEqual({ kind: "rejected", error: "attempt_conflict" });
		expect(snapshot()).toEqual(before);
		expect(f.rows("coordinator_auth_link_attempts")).toEqual(linkRows);
	},
);

async function collisionSql(guard: Guard, matches: boolean) {
	const keyId = await ed25519KeyIdForRevocation(f.key.publicKey);
	const device = matches ? "device-a" : "unrelated-device";
	const key = matches ? keyId : "b".repeat(64);
	if (guard.startsWith("revoked")) {
		const kind = guard === "revoked-device" ? "device_id" : "ed25519_key";
		const value = kind === "device_id" ? device : key;
		return `INSERT INTO coordinator_device_revocations
		(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at)
		VALUES ('${kind}','${value}','revocation-a','group-a','evidence-device','evidence-key','evidence-fingerprint','2026-10-01')`;
	}
	const boundDevice = guard === "bound-device" ? device : "other-device";
	const boundKey = guard === "bound-key" ? key : "c".repeat(64);
	return `INSERT INTO coordinator_device_ownership_bindings
	(device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
	VALUES ('${boundDevice}','${boundKey}','other-identity','other-coordinator','binding-a','reviewed_legacy_migration','receipt-a','2026-10-01')`;
}

it.each(guards.flatMap((guard) => [false, true].map((matches) => ({ guard, matches }))))(
	"start checks $guard with matching=$matches",
	async ({ guard, matches }) => {
		// Arrange: unrelated rows are positive controls for each actual SQL predicate.
		const c = await compose();
		f.db.exec(await collisionSql(guard, matches));
		const before = snapshot();
		// Act
		const result = await c.start(c.input, "transport-a");
		// Assert
		if (matches) {
			expect(result).toEqual(rejected);
			expect(snapshot()).toEqual(before);
		} else {
			expect(result.kind).toBe("started");
			expect(f.rows(ATTEMPTS)).toHaveLength(1);
			expect(snapshot().slice(1)).toEqual(before.slice(1));
		}
	},
);

it.each(
	guards.flatMap((guard) =>
		["insert", "update"].flatMap((stage) =>
			[false, true].map((matches) => ({ guard, stage, matches })),
		),
	),
)("claim rechecks $guard at $stage with matching=$matches", async ({ guard, stage, matches }) => {
	// Arrange: genuine start precedes the new ledger fact; no authority backend mocks.
	const c = await compose();
	expect((await c.start(c.input, "transport-a")).kind).toBe("started");
	const sql = await collisionSql(guard, matches);
	if (stage === "insert") f.db.exec(sql);
	else f.db.exec(`CREATE TRIGGER new_collision AFTER INSERT ON ${TRANSACTIONS} BEGIN ${sql}; END`);
	const before = snapshot();
	// Act: UPDATE must notice a fact introduced after the transaction INSERT.
	const result = await c.claimBrowser(c.form.request(), "browser-a");
	// Assert: failed claims roll back transaction, attempt and trigger-inserted ledger row.
	if (matches) {
		expect(result).toEqual({ kind: "rejected", error: "owner_enrollment_unknown" });
		expect(snapshot()).toEqual(before);
	} else {
		expect(result.kind).toBe("browser_claimed");
		expect(f.rows(ATTEMPTS)[0]?.state).toBe("browser_claimed");
		expect(f.rows(TRANSACTIONS)).toHaveLength(1);
	}
});

it.each(["active", "failed", "expired"] as const)(
	"third attempt respects the two-active cap with predecessors %s",
	async (state) => {
		// Arrange: two real signed starts prove the limit is not a blanket denial.
		let now = NOW;
		const c = await compose(() => now);
		expect((await c.start(c.input, "transport-a")).kind).toBe("started");
		expect((await c.start(c.signed("attempt-b"), "transport-a")).kind).toBe("started");
		if (state === "failed")
			f.db.exec(`UPDATE ${ATTEMPTS} SET state='failed',loopback_redirect=NULL`);
		if (state === "expired") now += 600000;
		const before = snapshot();
		// Act
		const result = await c.start(c.signed("attempt-c"), "transport-a");
		// Assert: terminal and time-expired rows do not consume active slots.
		if (state === "active") {
			expect(result).toEqual(rejected);
			expect(snapshot()).toEqual(before);
		} else {
			expect(result.kind).toBe("started");
			expect(f.rows(ATTEMPTS)).toHaveLength(3);
		}
	},
);

it.each([AUTH_LINK_CREATE_WINDOW_MS - 1, AUTH_LINK_CREATE_WINDOW_MS])(
	"seventh start respects the six-create window at elapsed %i",
	async (elapsed) => {
		// Arrange: valid terminal rows free active slots but still count as recent creates.
		let now = NOW;
		const c = await compose(() => now);
		for (let n = 0; n < 6; n++) {
			expect((await c.start(c.signed(`attempt-${n}`), "transport-a")).kind).toBe("started");
			f.db.exec(
				`UPDATE ${ATTEMPTS} SET state='failed',loopback_redirect=NULL WHERE state='pending'`,
			);
		}
		now += elapsed;
		const before = snapshot();
		// Act
		const result = await c.start(c.signed("attempt-seventh"), "transport-a");
		// Assert: exact window boundary releases old creates, one millisecond earlier does not.
		if (elapsed < AUTH_LINK_CREATE_WINDOW_MS) {
			expect(result).toEqual(rejected);
			expect(snapshot()).toEqual(before);
		} else {
			expect(result.kind).toBe("started");
			expect(f.rows(ATTEMPTS)).toHaveLength(7);
		}
	},
);
