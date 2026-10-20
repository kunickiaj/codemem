import { expect, it, vi } from "vitest";
import { oidcFixture } from "./coordinator-oidc-test-fixtures.js";
import {
	type OwnerAttempt,
	ownerEnrollmentFinalMessage,
} from "./coordinator-owner-enrollment-proof.js";
import {
	importOwnerEnrollmentAdmissionKey,
	issueOwnerEnrollmentAdmission,
	issueOwnerEnrollmentAdmissionV2,
	ownerEnrollmentOwnerCommitment,
} from "./owner-enrollment-admission.js";
import {
	createCoordinatorOwnerEnrollment,
	type OwnerEnrollmentComposition,
	type OwnerEnrollmentStart,
} from "./owner-enrollment-start.js";

const TABLE = "coordinator_owner_enrollment_attempts";
const unavailable = { kind: "rejected", error: "owner_enrollment_unavailable" };
export interface OwnerPinFixture {
	options: OwnerEnrollmentComposition;
	start: OwnerEnrollmentStart;
	key: { sign(message: string): string | Promise<string> };
	claimRequest(): Request;
	attempt(): Promise<OwnerAttempt>;
	exec(sql: string, ...values: (string | number | null)[]): Promise<unknown>;
	snapshot(options?: { authorityOnly?: boolean }): Promise<unknown>;
}

function ownerPinTest(fixture: (use: (f: OwnerPinFixture) => Promise<void>) => Promise<void>) {
	return it.extend<{ fixture: OwnerPinFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}
export function registerOwnerPinTests(fixture: Parameters<typeof ownerPinTest>[0]) {
	const test = ownerPinTest(fixture);
	registerCeremony(test);
	registerWrongAccount(test);
	registerInvalidAdmission(test);
	registerOperator(test);
	registerStorage(test);
	registerReadiness(test);
	registerDrift(test);
	registerMutation(test);
	registerMalformedInsert(test);
	registerFinalRace(test);
}
type OwnerPinTest = ReturnType<typeof ownerPinTest>;
async function compose(f: OwnerPinFixture) {
	const config = f.options.config as {
		coordinatorId: string;
		issuer: string;
		revision: string;
		redirectUri: string;
	};
	const pin = { ...config, origin: new URL(config.redirectUri).origin };
	const owner = {
		coordinatorId: config.coordinatorId,
		issuer: config.issuer,
		subject: "fixture-subject",
		identityId: "identity-a",
		linkId: "link-a",
	};
	const key = await importOwnerEnrollmentAdmissionKey(new Uint8Array(32).fill(23));
	const nowMs = f.options.clock?.() ?? 0;
	const provider = oidcFixture({ issuer: config.issuer });
	const options = {
		...f.options,
		mode: "production" as const,
		admissionKey: key,
		oidcOptions: { fetch: provider.fetch },
	};
	const result = await createCoordinatorOwnerEnrollment(options);
	if (!result.ok) throw new Error("Owner pin composition failed");
	const token = await issueOwnerEnrollmentAdmissionV2(key, pin, f.start, {
		resolvedOwner: owner,
		nowMs,
		ttlMs: 900000,
	});
	return {
		api: result.enrollment,
		key,
		pin,
		owner,
		nowMs,
		provider,
		options,
		token,
		admission: { admissionToken: token, resolvedOwner: owner },
	};
}
type Composition = Awaited<ReturnType<typeof compose>>;
async function claimed(f: OwnerPinFixture, c: Composition) {
	expect((await c.api.startOwnerBound(f.start, "transport-a", c.admission)).kind).toBe("started");
	const result = await c.api.claimBrowser(f.claimRequest(), "browser-a");
	if (result.kind !== "browser_claimed")
		throw new Error(`Owner pin claim failed: ${JSON.stringify(result)}`);
	const cookie = result.setCookies[0]?.split(";")[0] ?? "";
	const url = c.provider.authorize(result.authorizationUrl);
	return { cookie, callback: () => new Request(url, { headers: { cookie } }) };
}
async function verified(f: OwnerPinFixture, c: Composition) {
	const claim = await claimed(f, c);
	const result = await c.api.verifyCallback(claim.callback());
	if (result.kind !== "verified")
		throw new Error(`Owner pin callback failed: ${JSON.stringify(result)}`);
	const request = () =>
		new Request(`${c.pin.origin}/auth/owner/confirm`, {
			method: "POST",
			headers: {
				cookie: claim.cookie,
				origin: c.pin.origin,
				"content-type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ csrf: result.csrf, attempt_id: f.start.attemptId }),
		});
	return { result, request };
}

function registerCeremony(test: OwnerPinTest) {
	test("retains owner A's admission pin through real SDK callback, confirm, finalize and exact retry", async ({
		fixture: f,
	}) => {
		// Arrange: authority is seeded; every enrollment transition uses the production API.
		const c = await compose(f);
		const authority = await f.snapshot({ authorityOnly: true });
		const v = await verified(f, c);
		const commitment = await ownerEnrollmentOwnerCommitment(c.owner);
		expect(await f.attempt()).toMatchObject({
			admission_owner_hash: commitment,
			account_subject: c.owner.subject,
			identity_id: c.owner.identityId,
			link_id: c.owner.linkId,
		});
		expect(await f.snapshot({ authorityOnly: true })).toEqual(authority);
		const confirmation = await c.api.confirm(
			v.request(),
			"browser-a",
			v.result.confirmation.confirmationHash,
		);
		if (confirmation.kind !== "confirmed") throw new Error("Owner pin confirmation failed");
		const body = {
			attemptId: f.start.attemptId,
			completionSecret: confirmation.completionSecret,
			signature: await f.key.sign(
				ownerEnrollmentFinalMessage(await f.attempt(), confirmation.completionSecret),
			),
		};
		// Act
		const final = await c.api.finalize(body);
		const beforeRetry = await f.snapshot();
		const retry = await c.api.finalize(JSON.parse(JSON.stringify(body)));
		// Assert: a lost response retry must preserve the receipt and immutable owner.
		expect(final).toMatchObject({
			kind: "finalized",
			identityId: "identity-a",
			groups: ["group-a", "group-b"],
		});
		expect(retry).toEqual({ ...final, kind: "prior_commit" });
		expect(await f.attempt()).toMatchObject({
			state: "finalized",
			admission_owner_hash: commitment,
		});
		expect(await f.snapshot()).toEqual(beforeRetry);
		expect(c.provider.requests.some((r) => r.url.endsWith("/token"))).toBe(true);
	});
}
function registerWrongAccount(test: OwnerPinTest) {
	test("rejects A-admitted/B-OIDC even when B has valid independent account and grants", async ({
		fixture: f,
	}) => {
		// Arrange: admit a different exact tuple; the browser authenticates the seeded owner.
		const c = await compose(f);
		c.admission.resolvedOwner = {
			...c.owner,
			subject: "admitted-owner-a",
			identityId: "admitted-identity-a",
			linkId: "admitted-link-a",
		};
		c.admission.admissionToken = await issueOwnerEnrollmentAdmissionV2(c.key, c.pin, f.start, {
			resolvedOwner: c.admission.resolvedOwner,
			nowMs: c.nowMs,
			ttlMs: 900000,
		});
		const claim = await claimed(f, c);
		const before = await f.snapshot({ authorityOnly: true });
		const pin = (await f.attempt()).admission_owner_hash;
		// Act
		const result = await c.api.verifyCallback(claim.callback());
		// Assert: consuming browser proof must not populate a substituted owner or ownership.
		expect(result).toEqual(unavailable);
		expect(await f.snapshot({ authorityOnly: true })).toEqual(before);
		expect(await f.attempt()).toMatchObject({
			admission_owner_hash: pin,
			account_subject: null,
			identity_id: null,
			link_id: null,
			confirmation_hash: null,
			completion_secret_hash: null,
		});
		expect(c.provider.requests.some((r) => r.url.endsWith("/token"))).toBe(true);
	});
}
function registerInvalidAdmission(test: OwnerPinTest) {
	test.for([
		"wrong-owner",
		"v1",
		"malformed",
		"accessor-owner",
		"accessor-token",
		"accessor-start",
	])("denies %s admission before any write or provider call", async (fault, { fixture: f }) => {
		// Arrange
		const c = await compose(f);
		let start = { ...f.start };
		const admission = { ...c.admission, resolvedOwner: { ...c.owner } };
		let reads = 0;
		const getter = () => {
			reads++;
			throw new Error("accessor must not run");
		};
		if (fault === "wrong-owner") admission.resolvedOwner.subject = "other-owner";
		if (fault === "v1")
			admission.admissionToken = await issueOwnerEnrollmentAdmission(c.key, c.pin, f.start, {
				nowMs: c.nowMs,
				ttlMs: 900000,
			});
		if (fault === "malformed") admission.admissionToken += ".extra";
		if (fault === "accessor-owner")
			Object.defineProperty(admission.resolvedOwner, "subject", { get: getter });
		if (fault === "accessor-token")
			Object.defineProperty(admission, "admissionToken", { get: getter });
		if (fault === "accessor-start")
			start = Object.defineProperty(start, "signature", { get: getter });
		const before = await f.snapshot();
		// Act
		const result = await c.api.startOwnerBound(start, "transport-a", admission);
		// Assert
		expect(result).toEqual(unavailable);
		expect(await f.snapshot()).toEqual(before);
		expect(c.provider.requests).toEqual([]);
		expect(reads).toBe(0);
	});
}
function registerOperator(test: OwnerPinTest) {
	test("operator v1 remains NULL-pinned and cannot silently accept a v2 token", async ({
		fixture: f,
	}) => {
		// Arrange
		const c = await compose(f);
		const before = await f.snapshot();
		const v1 = await issueOwnerEnrollmentAdmission(c.key, c.pin, f.start, {
			nowMs: c.nowMs,
			ttlMs: 900000,
		});
		// Act
		const denied = await c.api.start(f.start, "transport-a", c.token);
		const afterDenied = await f.snapshot();
		const accepted = await c.api.start(f.start, "transport-a", v1);
		// Assert
		expect(denied).toEqual(unavailable);
		expect(afterDenied).toEqual(before);
		expect(accepted.kind).toBe("started");
		expect((await f.attempt()).admission_owner_hash).toBeNull();
		await expect(
			f.exec(`UPDATE ${TABLE} SET admission_owner_hash = ?`, c.token.split(".")[3] ?? ""),
		).rejects.toThrow(/owner_enrollment_admission_immutable/);
		expect((await f.attempt()).admission_owner_hash).toBeNull();
		expect(c.provider.requests).toEqual([]);
	});
}
function registerStorage(test: OwnerPinTest) {
	test.for([null, "b".repeat(64), "BAD", ""].map((replacement) => ({ replacement })))(
		"raw UPDATE/REPLACE cannot change an admitted birth pin to %j",
		async ({ replacement }, { fixture: f }) => {
			// Arrange
			const c = await compose(f);
			expect((await c.api.startOwnerBound(f.start, "transport-a", c.admission)).kind).toBe(
				"started",
			);
			const before = await f.snapshot();
			const row = await f.attempt();
			// Act / Assert: identical updates are legal, different pins are not.
			await f.exec(`UPDATE ${TABLE} SET admission_owner_hash = ?`, row.admission_owner_hash);
			expect(await f.snapshot()).toEqual(before);
			await expect(
				f.exec(`UPDATE ${TABLE} SET admission_owner_hash = ?`, replacement),
			).rejects.toThrow(/owner_enrollment_admission_immutable/);
			const entries = Object.entries({ ...row, admission_owner_hash: replacement });
			await expect(
				f.exec(
					`INSERT OR REPLACE INTO ${TABLE} (${entries.map(([k]) => k).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
					...entries.map(([, v]) => v),
				),
			).rejects.toThrow(/owner_enrollment_admission_immutable/);
			expect(await f.snapshot()).toEqual(before);
		},
	);
}
function registerReadiness(test: OwnerPinTest) {
	test.for(["missing-update", "missing-insert", "missing-both", "missing-column"])(
		"incomplete %s schema denies opt-in runtime before writes or discovery",
		async (fault, { fixture: f }) => {
			// Arrange: no constructor or runtime may repair operator-owned schema implicitly.
			const c = await compose(f);
			if (fault !== "missing-insert")
				await f.exec("DROP TRIGGER owner_enrollment_admission_update");
			if (fault !== "missing-update")
				await f.exec("DROP TRIGGER owner_enrollment_admission_insert");
			if (fault === "missing-column")
				await f.exec(`ALTER TABLE ${TABLE} DROP COLUMN admission_owner_hash`);
			const before = await f.snapshot();
			// Act
			const result = await createCoordinatorOwnerEnrollment(c.options);
			const start = await c.api.startOwnerBound(f.start, "transport-a", c.admission);
			const claim = await c.api.claimBrowser(f.claimRequest(), "browser-a");
			// Assert
			expect(result.ok).toBe(true);
			expect(start.kind).toBe("rejected");
			expect(claim).toEqual(unavailable);
			expect(await f.snapshot()).toEqual(before);
			expect(c.provider.requests).toEqual([]);
		},
	);
}
function registerDrift(test: OwnerPinTest) {
	test.for(["link", "grant", "revocation"])(
		"rejects live %s drift after verification without ownership writes",
		async (fault, { fixture: f }) => {
			// Arrange
			const c = await compose(f);
			const v = await verified(f, c);
			if (fault === "link")
				await f.exec(
					"UPDATE coordinator_auth_account_links SET revoked_at_ms = ? WHERE link_id = 'link-a'",
					c.nowMs,
				);
			if (fault === "grant")
				await f.exec(
					"UPDATE coordinator_identity_group_grants SET revision = revision + 1 WHERE group_id = 'group-a'",
				);
			if (fault === "revocation")
				await f.exec(
					"INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES ('device_id',?,'revocation-a','group-a','device-a','fixture-key','fixture-fingerprint',?)",
					f.start.deviceId,
					new Date(c.nowMs).toISOString(),
				);
			const before = await f.snapshot();
			// Act
			const result = await c.api.confirm(
				v.request(),
				"browser-a",
				v.result.confirmation.confirmationHash,
			);
			// Assert
			expect(result).toEqual(unavailable);
			expect(await f.snapshot()).toEqual(before);
		},
	);
}

function registerMutation(test: OwnerPinTest) {
	test.for([true, false])(
		"captures owner before async work (initial match %s)",
		async (matching, { fixture: f }) => {
			// Arrange: pause hashing without sleeps, then replace caller-owned inputs.
			const c = await compose(f);
			const owner = { ...c.owner, subject: matching ? c.owner.subject : "wrong-owner" };
			const options = { ...c.admission, resolvedOwner: owner };
			const start = { ...f.start };
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const digest = crypto.subtle.digest.bind(crypto.subtle);
			const spy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
				entered.resolve();
				await release.promise;
				return digest(...args);
			});
			const before = await f.snapshot();
			// Act
			const pending = c.api.startOwnerBound(start, "transport-a", options);
			await entered.promise;
			owner.subject = matching ? "wrong-owner" : c.owner.subject;
			options.admissionToken = "invalid";
			start.deviceId = "substituted-device";
			release.resolve();
			const result = await pending;
			spy.mockRestore();
			// Assert: mutation can neither repair a denied owner nor retarget an admitted attempt.
			if (matching) {
				expect(result.kind).toBe("started");
				expect(await f.attempt()).toMatchObject({
					device_id: f.start.deviceId,
					admission_owner_hash: await ownerEnrollmentOwnerCommitment(c.owner),
				});
			} else {
				expect(result).toEqual(unavailable);
				expect(await f.snapshot()).toEqual(before);
			}
			expect(c.provider.requests).toEqual([]);
		},
	);
}

function registerMalformedInsert(test: OwnerPinTest) {
	test.for(["BAD", "g".repeat(64), "a".repeat(63), `${"a".repeat(63)}\0`])(
		"rejects malformed raw inserted pin %j without removing the original",
		async (value, { fixture: f }) => {
			// Arrange
			const c = await compose(f);
			expect((await c.api.startOwnerBound(f.start, "transport-a", c.admission)).kind).toBe(
				"started",
			);
			const row = await f.attempt();
			const before = await f.snapshot();
			const entries = Object.entries({
				...row,
				attempt_id: "new-attempt",
				browser_start_hash: "f".repeat(64),
				admission_owner_hash: value,
			});
			// Act
			const insertion = f.exec(
				`INSERT INTO ${TABLE} (${entries.map(([k]) => k).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
				...entries.map(([, v]) => v),
			);
			// Assert: a new identity avoids collision triggers and exercises the hash CHECK itself.
			await expect(insertion).rejects.toThrow(/CHECK constraint failed/);
			expect(await f.snapshot()).toEqual(before);
		},
	);
}

async function liveDrift(f: OwnerPinFixture, fault: string, nowMs: number) {
	if (fault === "link")
		return f.exec(
			"UPDATE coordinator_auth_account_links SET revoked_at_ms = ? WHERE link_id = 'link-a'",
			nowMs,
		);
	if (fault === "grant")
		return f.exec(
			"UPDATE coordinator_identity_group_grants SET revision = revision + 1 WHERE group_id = 'group-a'",
		);
	return f.exec(
		"INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES ('device_id',?,'revocation-a','group-a','device-a','fixture-key','fixture-fingerprint',?)",
		f.start.deviceId,
		new Date(nowMs).toISOString(),
	);
}

function registerFinalRace(test: OwnerPinTest) {
	test.for(["config", "link", "grant", "revocation"])(
		"finalize denies %s drift, including authority loss immediately before atomic commit",
		async (fault, { fixture: f }) => {
			// Arrange: an actual browser-confirmed pin and real pending-key final signature.
			const c = await compose(f);
			const v = await verified(f, c);
			const confirmation = await c.api.confirm(
				v.request(),
				"browser-a",
				v.result.confirmation.confirmationHash,
			);
			if (confirmation.kind !== "confirmed") throw new Error("Race fixture confirmation failed");
			const input = {
				attemptId: f.start.attemptId,
				completionSecret: confirmation.completionSecret,
				signature: await f.key.sign(
					ownerEnrollmentFinalMessage(await f.attempt(), confirmation.completionSecret),
				),
			};
			let api = c.api;
			let expected = await f.snapshot();
			let entered = false;
			if (fault === "config") {
				const changed = await createCoordinatorOwnerEnrollment({
					...c.options,
					config: { ...(c.options.config as object), revision: "c".repeat(64) },
				});
				if (!changed.ok) throw new Error("Config race composition failed");
				api = changed.enrollment;
			} else {
				const batch = c.options.backend.batch.bind(c.options.backend);
				vi.spyOn(c.options.backend, "batch").mockImplementationOnce(async (statements) => {
					entered = true;
					await liveDrift(f, fault, c.nowMs);
					expected = await f.snapshot();
					return batch(statements);
				});
			}
			// Act
			const result = await api.finalize(input);
			// Assert: the database race itself remains, but no ownership or receipt write escapes.
			expect(result.kind).toBe("rejected");
			expect(entered).toBe(fault !== "config");
			expect(await f.snapshot()).toEqual(expected);
			expect(await f.attempt()).toMatchObject({
				state: "confirmed",
				admission_owner_hash: await ownerEnrollmentOwnerCommitment(c.owner),
				binding_id: null,
				audit_event_id: null,
				final_outcome_json: null,
			});
		},
	);
}
