import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import { headers, keypair } from "./coordinator-account-change-http-test-fixtures.js";
import { createCoordinatorApp } from "./coordinator-api.js";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { ownerStartFixture } from "./coordinator-owner-enrollment-historical-test-fixture.js";
import {
	ATTEMPTS,
	browserForm,
	config,
	nativeBackend,
	ORIGIN,
	proof,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { pendingOwner } from "./coordinator-owner-enrollment-test-harness.js";
import {
	importOwnerEnrollmentAdmissionKey,
	issueOwnerEnrollmentAdmissionV2,
} from "./owner-enrollment-admission.js";
import {
	createCoordinatorOwnerEnrollment,
	ownerEnrollmentStartMessage,
} from "./owner-enrollment-start.js";
import { verifySignature } from "./sync-auth.js";

const migration = (name: string) =>
	readFileSync(
		new URL(`../../cloudflare-coordinator-worker/migrations/${name}`, import.meta.url),
		"utf8",
	);

it("old 0030 storage with existing rows preserves constructor, groups and genuine signed HTTP until explicit 0034 opt-in", async () => {
	// Arrange: replace only disposable fixture owner storage with the exact released 0030 source.
	const f = ownerStartFixture();
	const network = vi
		.spyOn(globalThis, "fetch")
		.mockRejectedValue(new Error("Live network forbidden"));
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	let reopened: BetterSqliteCoordinatorStore | undefined;
	try {
		f.db.exec(`DROP TABLE ${ATTEMPTS}`);
		f.db.exec(migration("0030_add_owner_enrollment_attempts.sql"));
		const { admission_owner_hash: _pin, ...oldRow } = pendingOwner;
		const entries = Object.entries(oldRow);
		f.db
			.prepare(
				`INSERT INTO ${ATTEMPTS} (${entries.map(([k]) => k).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
			)
			.run(...entries.map(([, v]) => v));
		const definitions = () =>
			f.db
				.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name = ? ORDER BY type,name")
				.all(ATTEMPTS);
		const before = definitions();
		// Act: normal startup must neither ALTER the table nor reject the legacy coordinator.
		reopened = new BetterSqliteCoordinatorStore(f.db.name, { authClock: () => NOW });
		await reopened.createGroup("legacy-group");
		const key = keypair();
		await reopened.enrollDevice("legacy-group", key);
		const store = reopened;
		const app = createCoordinatorApp({
			storeFactory: () => Object.assign(Object.create(store), { close: async () => undefined }),
			runtime: { adminSecret: () => null, now: () => new Date(NOW).toISOString() },
			requestVerifier: (input) =>
				verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		});
		const path = "/v1/peers?group_id=legacy-group";
		const signed = await app.request(`${ORIGIN}${path}`, { headers: headers(key, "GET", path) });
		const invalidHeaders = { ...headers(key, "GET", path), "X-Opencode-Signature": "invalid" };
		const rejected = await app.request(`${ORIGIN}${path}`, { headers: invalidHeaders });
		// Assert: existing signed authorization still verifies real key possession.
		expect(signed.status).toBe(200);
		expect(rejected.status).toBe(401);
		expect(await store.listGroups()).toEqual([
			expect.objectContaining({ group_id: "legacy-group" }),
		]);
		expect(definitions()).toEqual(before);
		expect(f.rows(ATTEMPTS)).toEqual([expect.objectContaining(oldRow)]);
		await checkExplicitOptIn(f, store);
		expect(network).not.toHaveBeenCalled();
	} finally {
		await reopened?.close();
		f.close();
		vi.restoreAllMocks();
	}
});

async function checkExplicitOptIn(
	f: ReturnType<typeof ownerStartFixture>,
	store: BetterSqliteCoordinatorStore,
) {
	// Arrange: an unmounted owner runtime cannot use or repair the old table.
	const key = await importOwnerEnrollmentAdmissionKey(new Uint8Array(32).fill(23));
	const start = {
		attemptId: "new-attempt",
		deviceId: "new-device",
		publicKey: f.key.publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: proof(),
		signature: "",
	};
	const pin = { ...config, origin: ORIGIN };
	start.signature = f.key.sign(ownerEnrollmentStartMessage(start, pin));
	const resolvedOwner = {
		coordinatorId: config.coordinatorId,
		issuer: config.issuer,
		subject: "fixture-subject",
		identityId: "identity-a",
		linkId: "link-a",
	};
	const token = await issueOwnerEnrollmentAdmissionV2(key, pin, start, {
		resolvedOwner,
		nowMs: NOW,
		ttlMs: 900000,
	});
	const form = await browserForm(start.attemptId, start.browserStartCode);
	const provider = vi
		.fn<typeof fetch>()
		.mockRejectedValue(new Error("Discovery forbidden before claim"));
	const result = await createCoordinatorOwnerEnrollment({
		purpose: "owner_enroll",
		mode: "production",
		config,
		backend: nativeBackend(store.db),
		admissionKey: key,
		csrfKey: form.csrfKey,
		limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		oidcOptions: { fetch: provider },
		clock: () => NOW,
	});
	if (!result.ok) throw new Error("Legacy fixture composition failed");
	const before = f.rows(ATTEMPTS);
	// Act
	const denied = await result.enrollment.startOwnerBound(start, "transport-a", {
		admissionToken: token,
		resolvedOwner,
	});
	f.db.exec(migration("0034_add_owner_admission_pin.sql"));
	const admitted = await result.enrollment.startOwnerBound(start, "transport-a", {
		admissionToken: token,
		resolvedOwner,
	});
	// Assert: only explicit migration unlocks the new path; historical NULL is not backfilled.
	expect(denied.kind).toBe("rejected");
	expect(admitted.kind).toBe("started");
	expect(f.rows(ATTEMPTS)[0]).toEqual({ ...before[0], admission_owner_hash: null });
	expect(f.rows(ATTEMPTS)[1]?.admission_owner_hash).toMatch(/^[a-f0-9]{64}$/);
	expect(provider).not.toHaveBeenCalled();
}
