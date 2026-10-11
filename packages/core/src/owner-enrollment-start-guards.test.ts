import { afterEach, beforeEach, expect, it } from "vitest";
import { AUTH_LINK_CREATE_WINDOW_MS } from "./coordinator-auth-link-contract.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
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

async function compose(clock = () => NOW) {
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
		backend: f.backend,
		csrfKey: form.csrfKey,
		limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		oidcOptions: { fetch: provider.fetch },
		clock,
	});
	if (!result.ok) throw new Error("fixture composition failed");
	const signed = (attemptId: string) => {
		const next = { ...input, attemptId, browserStartCode: proof() };
		return { ...next, signature: f.key.sign(ownerEnrollmentStartMessage(next, pin)) };
	};
	return {
		...result.enrollment,
		form,
		signed,
		input: { ...input, signature: f.key.sign(ownerEnrollmentStartMessage(input, pin)) },
	};
}

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
		const result = await c.start(c.input);
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
	expect((await c.start(c.input)).kind).toBe("started");
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
		expect((await c.start(c.input)).kind).toBe("started");
		expect((await c.start(c.signed("attempt-b"))).kind).toBe("started");
		if (state === "failed")
			f.db.exec(`UPDATE ${ATTEMPTS} SET state='failed',loopback_redirect=NULL`);
		if (state === "expired") now += 600000;
		const before = snapshot();
		// Act
		const result = await c.start(c.signed("attempt-c"));
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
			expect((await c.start(c.signed(`attempt-${n}`))).kind).toBe("started");
			f.db.exec(
				`UPDATE ${ATTEMPTS} SET state='failed',loopback_redirect=NULL WHERE state='pending'`,
			);
		}
		now += elapsed;
		const before = snapshot();
		// Act
		const result = await c.start(c.signed("attempt-seventh"));
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
