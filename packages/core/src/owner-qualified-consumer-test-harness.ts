import { expect, it, vi } from "vitest";
import { applyAccountConnectionSchema } from "./coordinator-account-connection-schema.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { issueBrowserCookie } from "./coordinator-browser-credential.js";
import { importBrowserCsrfKey, issueBrowserCsrfToken } from "./coordinator-browser-csrf.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import {
	type OwnerAttempt,
	ownerEnrollmentFinalMessage,
} from "./coordinator-owner-enrollment-proof.js";
import { OwnerEnrollmentQualificationOps } from "./coordinator-owner-enrollment-qualification.js";
import type { D1CoordinatorStore } from "./d1-coordinator-store.js";
import {
	createOwnerBrowserAdmissionHandler,
	OWNER_BROWSER_ADMISSION_PATH,
} from "./owner-browser-admission.js";
import { importOwnerEnrollmentAdmissionKey } from "./owner-enrollment-admission.js";
import {
	createCoordinatorOwnerEnrollment,
	ownerEnrollmentStartMessage,
} from "./owner-enrollment-start.js";

export const NOW = 1_791_028_800_000;
const origin = "https://app.example.test";
const config = {
	enabled: true,
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.google.com",
	revision: "a".repeat(64),
	redirectUri: PROVIDER.redirectUri,
	clientId: PROVIDER.clientId,
	clientSecret: PROVIDER.clientSecret,
};
type Store = Pick<
	D1CoordinatorStore,
	| "createGroup"
	| "enrollDevice"
	| "createAuthLinkAttempt"
	| "startAuthBrowserTransaction"
	| "resolveAuthLinkBrowserTransaction"
	| "consumeAuthBrowserTransaction"
	| "recordAuthLinkOidcVerified"
	| "confirmAuthLinkAttempt"
	| "finalizeAuthLinkAttempt"
	| "redeemAuthLinkSessionWithBrowserTransaction"
	| "createAuthControllerAttestation"
	| "issueIdentityGroupGrantFromControllerAttestation"
	| "readAuthSession"
	| "revokeAuthControllerAttestation"
>;
export interface QualifiedDatabase {
	explain(
		statement: import("./coordinator-auth-link.js").AuthLinkStatement,
	): Promise<{ id: number; parent: number; detail: string }[]>;
	store: Store;
	backend: AuthLinkBackend;
	rows(table: string): Promise<Record<string, unknown>[]>;
	key(): Promise<{ publicKey: string; sign(message: string): Promise<string> }>;
}
async function digest(text: string) {
	return Buffer.from(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
	).toString("hex");
}
type Api = Extract<
	Awaited<ReturnType<typeof createCoordinatorOwnerEnrollment>>,
	{ ok: true }
>["enrollment"];
export interface QualifiedFixture extends QualifiedDatabase {
	errors: string[];
	exec(sql: string, ...values: (string | number | null)[]): Promise<number>;
	api: Api;
	start: import("./owner-enrollment-start.js").OwnerEnrollmentStart;
	link: Record<string, unknown>;
	original: Record<string, unknown>[][];
	authority(): Promise<Record<string, unknown>[][]>;
	qualify(): Promise<string>;
	grant(): Promise<void>;
	ops: OwnerEnrollmentQualificationOps;
	admit(): Promise<Response | null>;
	claim(): Promise<{ cookie: string; request(): Request }>;
	verified(): Promise<{
		result: { csrf: string; confirmation: { confirmationHash: string } };
		request(): Request;
	}>;
	confirmed(): Promise<{ attemptId: string; completionSecret: string; signature: string }>;
	attempt(): Promise<OwnerAttempt>;
	provider: ReturnType<typeof oidcFixture>;
	fingerprint: string;
	review: { attestationId: string };
}
export async function qualifiedFixture(db: QualifiedDatabase): Promise<QualifiedFixture> {
	const traced = traceBackend(db.backend);
	db = { ...db, backend: traced.backend };
	await applyAccountConnectionSchema(db.backend);
	const source = await ordinaryClaim(db);
	const reviewed = await reviewClaim(db, source);
	const composition = await composeConsumer(db);
	const admit = admission(db, composition, source.session);
	const consumer = browserStages(db, composition, admit, traced.errors);
	return {
		...db,
		...source,
		...reviewed,
		...consumer,
		errors: traced.errors,
		exec: (sql, ...values) => db.backend.run({ sql, values }),
	};
}
function traceBackend(storage: AuthLinkBackend) {
	const errors: string[] = [];
	const backend: AuthLinkBackend = {
		first: async <T>(s: import("./coordinator-auth-link.js").AuthLinkStatement) => {
			expect(s.values.length).toBeLessThanOrEqual(100);
			try {
				return await storage.first<T>(s);
			} catch (e) {
				errors.push(String(e));
				throw e;
			}
		},
		run: async (s) => {
			expect(s.values.length).toBeLessThanOrEqual(100);
			try {
				return await storage.run(s);
			} catch (e) {
				errors.push(String(e));
				throw e;
			}
		},
		batch: (s) => {
			for (const statement of s) expect(statement.values.length).toBeLessThanOrEqual(100);
			return storage.batch(s);
		},
	};
	return { errors, backend };
}
async function ordinaryClaim(db: QualifiedDatabase) {
	const { store, rows } = db;
	const old = await db.key();
	const fingerprint = await digest(old.publicKey);
	const signer = {
		groupId: "group-a",
		deviceId: "old-device-a",
		publicKey: old.publicKey,
		fingerprint,
	};
	await store.createGroup(signer.groupId);
	await store.enrollDevice(signer.groupId, signer);
	const request = {
		attemptId: "link-attempt-a",
		authority: { kind: "device_claim" as const, identityId: "identity-a" },
		signer,
		runtimeVerifierHash: "b".repeat(64),
		browserStartHash: "c".repeat(64),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	expect(await store.createAuthLinkAttempt(request, config)).toMatchObject({ kind: "created" });
	const session = await completeClaim(store, request);
	const link = (await rows("coordinator_auth_account_links"))[0];
	if (!link) throw new Error("ordinary device link absent");
	const authority = () =>
		Promise.all(
			[
				"coordinator_auth_device_claims",
				"coordinator_auth_link_attempts",
				"coordinator_auth_account_links",
				"coordinator_auth_link_audit_log",
			].map(rows),
		);
	return { signer, fingerprint, session, link, authority, original: await authority() };
}
async function completeClaim(store: Store, request: Parameters<Store["createAuthLinkAttempt"]>[0]) {
	const signer = request.signer;
	const material = {
		purpose: "link" as const,
		attemptId: request.attemptId,
		browserStartHash: request.browserStartHash,
		stateHash: "d".repeat(64),
		binderHash: "e".repeat(64),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	await store.startAuthBrowserTransaction(material, config);
	const binding = await store.resolveAuthLinkBrowserTransaction(
		{ attemptId: request.attemptId, binderHash: material.binderHash },
		config,
	);
	if (!binding) throw new Error("ordinary claim browser not bound");
	expect(await store.consumeAuthBrowserTransaction(material, config)).toMatchObject({
		kind: "consumed",
	});
	const browser = { attemptId: request.attemptId, ...binding };
	// Trusted provider claims enter the real storage API; no SQL authority oracle is stubbed.
	expect(
		await store.recordAuthLinkOidcVerified(
			{ ...browser, account: { issuer: config.issuer, subject: "fixture-subject" } },
			config,
		),
	).toMatchObject({ kind: "applied" });
	expect(
		await store.confirmAuthLinkAttempt(
			{ ...browser, completionSecretHash: "f".repeat(64) },
			config,
		),
	).toMatchObject({ kind: "applied" });
	expect(
		await store.finalizeAuthLinkAttempt(
			{
				purpose: "coordinator-account-link-v1",
				coordinatorId: config.coordinatorId,
				attemptId: request.attemptId,
				groupId: signer.groupId,
				identityId: "identity-a",
				deviceId: signer.deviceId,
				fingerprint: signer.fingerprint,
				signer,
				runtimeVerifierHash: request.runtimeVerifierHash,
				completionSecretHash: "f".repeat(64),
			},
			config,
		),
	).toMatchObject({ kind: "applied" });
	const session = await issueBrowserCookie("session");
	expect(
		await store.redeemAuthLinkSessionWithBrowserTransaction(
			{ ...browser, binderHash: material.binderHash, credentialHash: session.cookieHash },
			config,
		),
	).toMatchObject({ kind: "issued" });
	return session;
}
async function reviewClaim(
	db: QualifiedDatabase,
	source: Awaited<ReturnType<typeof ordinaryClaim>>,
) {
	const { store, backend } = db;
	const { signer, fingerprint, link } = source;
	const review = {
		attestationId: "review-a",
		coordinatorId: config.coordinatorId,
		identityId: "identity-a",
		groupId: signer.groupId,
		deviceId: signer.deviceId,
		publicKey: signer.publicKey,
		fingerprint,
		reviewReceiptId: "receipt-a",
		evidenceDigest: "1".repeat(64),
	};
	expect(await store.createAuthControllerAttestation(review)).toMatchObject({ kind: "created" });
	const ops = new OwnerEnrollmentQualificationOps(backend, config, () => NOW);
	async function qualify() {
		const p = await ops.preview({ attestationId: review.attestationId });
		expect(p).toMatchObject({
			kind: "ready",
			linkId: link?.link_id,
			claimId: link?.device_claim_id,
		});
		if (p.kind !== "ready") throw new Error("qualification preview failed");
		const result = await ops.issue({
			attestationId: review.attestationId,
			expectedDigest: p.digest,
		});
		expect(result).toMatchObject({ kind: "created" });
		if (result.kind !== "created") throw new Error("qualification issue failed");
		return result.qualificationId;
	}
	async function grant() {
		expect(
			await store.issueIdentityGroupGrantFromControllerAttestation({
				coordinatorId: config.coordinatorId,
				attestationId: review.attestationId,
			}),
		).toMatchObject({ kind: "created" });
	}
	return { review, ops, qualify, grant };
}
async function composeConsumer(db: QualifiedDatabase) {
	const { backend } = db;
	const key = await db.key();
	const start = {
		attemptId: "owner-attempt-b",
		deviceId: "new-device-b",
		publicKey: key.publicKey,
		loopbackRedirect: "http://127.0.0.1:43210/codemem/auth/complete",
		browserStartCode: Buffer.alloc(32, 9).toString("base64url"),
		signature: "",
	};
	start.signature = await key.sign(ownerEnrollmentStartMessage(start, { ...config, origin }));
	const csrfKey = await importBrowserCsrfKey(new Uint8Array(32).fill(17));
	const admissionKey = await importOwnerEnrollmentAdmissionKey(new Uint8Array(32).fill(23));
	const provider = oidcFixture({ issuer: config.issuer });
	const composed = await createCoordinatorOwnerEnrollment({
		purpose: "owner_enroll",
		mode: "production",
		config,
		backend,
		csrfKey,
		admissionKey,
		limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		oidcOptions: { fetch: provider.fetch },
		clock: () => NOW,
	});
	if (!composed.ok) throw new Error("consumer composition failed");
	const api = composed.enrollment;
	return { api, start, provider, key, csrfKey, admissionKey };
}
function admission(
	db: QualifiedDatabase,
	c: Awaited<ReturnType<typeof composeConsumer>>,
	session: Awaited<ReturnType<typeof issueBrowserCookie>>,
) {
	const { store, backend } = db;
	const { api, start, csrfKey, admissionKey } = c;
	const handle = createOwnerBrowserAdmissionHandler({
		enabled: true,
		config,
		backend,
		csrfKey,
		admissionKey,
		limiter: { check: () => ({ allowed: true, retryAfterS: 0 }) },
		readSession: store.readAuthSession.bind(store),
		clock: () => NOW,
		getEnrollment: async () => api,
	});
	const cookie = session.setCookie.split(";")[0] ?? "";
	return async () => {
		const page = await handle(
			new Request(`${origin}${OWNER_BROWSER_ADMISSION_PATH}`, { headers: { cookie } }),
			"transport-b",
		);
		if (!page) throw new Error("admission page absent");
		const html = await page.text();
		if (page.status !== 200) return new Response(html, { status: page.status });
		const csrf = /name="csrf" value="([^"]*)"/.exec(html)?.[1] ?? "";
		const body = new FormData();
		body.append("csrf", csrf);
		body.append(
			"request",
			new File([JSON.stringify({ start })], "request.json", { type: "application/json" }),
		);
		return handle(
			new Request(`${origin}${OWNER_BROWSER_ADMISSION_PATH}`, {
				method: "POST",
				headers: { cookie, origin },
				body,
			}),
			"transport-b",
		);
	};
}
function browserStages(
	db: QualifiedDatabase,
	c: Awaited<ReturnType<typeof composeConsumer>>,
	admit: ReturnType<typeof admission>,
	errors: string[],
) {
	const { rows } = db;
	const { api, start, provider, key, csrfKey } = c;
	async function claim() {
		const admitted = await admit();
		expect(admitted?.status, errors.join("\n")).toBe(200);
		const browserCookie = await issueBrowserCookie("start");
		const csrf = await issueBrowserCsrfToken(csrfKey, browserCookie.secret, "start", {
			publicOrigin: origin,
			store: config,
		});
		const claimed = await api.claimBrowser(
			form("start", browserCookie.setCookie.split(";")[0] ?? "", {
				csrf,
				attempt_id: start.attemptId,
				start_code: start.browserStartCode,
			}),
			"browser-b",
		);
		if (claimed.kind !== "browser_claimed")
			throw new Error(`claim failed ${JSON.stringify(claimed)}`);
		const cookie = claimed.setCookies[0]?.split(";")[0] ?? "";
		return {
			cookie,
			request: () =>
				new Request(provider.authorize(claimed.authorizationUrl), { headers: { cookie } }),
		};
	}
	async function verified() {
		const c = await claim();
		const result = await api.verifyCallback(c.request());
		if (result.kind !== "verified") throw new Error(`callback failed ${JSON.stringify(result)}`);
		return {
			result,
			request: () => form("confirm", c.cookie, { csrf: result.csrf, attempt_id: start.attemptId }),
		};
	}
	async function confirmed() {
		return finalInput({ api, start, key, attempt, verified });
	}
	async function attempt() {
		const row = (await rows("coordinator_owner_enrollment_attempts")).find(
			(a) => a.attempt_id === start.attemptId,
		);
		if (!row) throw new Error("Missing exact consumer attempt");
		return row as unknown as OwnerAttempt;
	}
	return {
		api,
		start,
		admit,
		claim,
		verified,
		confirmed,
		attempt,
		provider,
	};
}
async function finalInput(
	f: Pick<QualifiedFixture, "api" | "start" | "attempt" | "verified"> & {
		key: Awaited<ReturnType<QualifiedDatabase["key"]>>;
	},
) {
	const v = await f.verified();
	const result = await f.api.confirm(
		v.request(),
		"browser-b",
		v.result.confirmation.confirmationHash,
	);
	if (result.kind !== "confirmed") throw new Error(`confirm failed ${JSON.stringify(result)}`);
	return {
		attemptId: f.start.attemptId,
		completionSecret: result.completionSecret,
		signature: await f.key.sign(
			ownerEnrollmentFinalMessage(await f.attempt(), result.completionSecret),
		),
	};
}
function form(action: string, cookie: string, fields: Record<string, string>) {
	return new Request(`${origin}/auth/owner/${action}`, {
		method: "POST",
		headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(fields),
	});
}
export function qualifiedTest(
	fixture: (
		use: (f: Awaited<ReturnType<typeof qualifiedFixture>>) => Promise<void>,
	) => Promise<void>,
) {
	return it.extend<{ fixture: Awaited<ReturnType<typeof qualifiedFixture>> }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}
export function registerQualifiedConsumerTests(test: ReturnType<typeof qualifiedTest>) {
	registerCeremony(test);
	registerLosses(test);
	registerRaces(test);
}
function registerCeremony(test: ReturnType<typeof qualifiedTest>) {
	test("ordinary claim plus real review and separate grant admits a fresh key to the same Identity", async ({
		fixture: f,
	}) => {
		// Arrange: qualification issues no grant and never rewrites the original proof.
		const id = await f.qualify();
		expect(await f.rows("coordinator_identity_group_grants")).toEqual([]);
		expect(await f.authority()).toEqual(f.original);
		await f.grant();
		const final = await f.confirmed();
		expect(await f.attempt()).toMatchObject({
			owner_qualification_id: id,
			link_controller_attestation_id: null,
			identity_id: "identity-a",
			link_id: f.link.link_id,
		});
		// Act
		const result = await f.api.finalize(final);
		const retry = await f.api.finalize(final);
		// Assert: immutable claim authority survives enrollment and receipt retry.
		expect(result).toMatchObject({
			kind: "finalized",
			identityId: "identity-a",
			groups: ["group-a"],
		});
		expect(retry).toEqual({ ...result, kind: "prior_commit" });
		expect(await f.authority()).toEqual(f.original);
		expect(await f.rows("coordinator_device_ownership_bindings")).toEqual([
			expect.objectContaining({
				device_id: f.start.deviceId,
				identity_id: "identity-a",
				key_id: await ed25519KeyId(f.start.publicKey),
			}),
		]);
		expect(f.provider.requests.some((r) => r.url.endsWith("/token"))).toBe(true);
	});
	test.for(["bare-reviewed-claim", "qualification-without-grant"])(
		"denies %s admission without minting authority",
		async (fault, { fixture: f }) => {
			// Arrange
			if (fault === "bare-reviewed-claim") await f.grant();
			else await f.qualify();
			// Act
			const response = await f.admit();
			// Assert
			expect(response?.status).not.toBe(200);
			expect(await f.rows("coordinator_owner_enrollment_attempts")).toEqual([]);
			expect(await f.authority()).toEqual(f.original);
			expect(f.provider.requests).toEqual([]);
		},
	);
	test("retains qualified owner authority after the old enrollment and controller are revoked", async ({
		fixture: f,
	}) => {
		// Arrange
		const id = await f.qualify();
		await f.grant();
		await f.exec("UPDATE enrolled_devices SET enabled=0 WHERE device_id='old-device-a'");
		await f.store.revokeAuthControllerAttestation("coordinator-a", f.review.attestationId);
		// Act
		const result = await f.api.finalize(await f.confirmed());
		// Assert
		expect(result).toMatchObject({ kind: "finalized", identityId: "identity-a" });
		expect(await f.attempt()).toMatchObject({ owner_qualification_id: id });
	});
}
function registerLosses(test: ReturnType<typeof qualifiedTest>) {
	for (const stage of ["callback", "confirm", "finalize"] as const) {
		test.for(["qualification", "link", "grant", "pending-device", "pending-key"])(
			`${stage} denies lost %s authority without ownership writes`,
			async (fault, { fixture: f }) => {
				// Arrange: real preceding stages are positive controls for every negative.
				await f.qualify();
				await f.grant();
				const transition = await nextTransition(f, stage);
				await revoke(f, fault);
				const before = await f.rows("coordinator_device_ownership_bindings");
				// Act
				const result = await transition();
				// Assert
				expect(result).toMatchObject({ kind: "rejected" });
				expect(await f.rows("coordinator_device_ownership_bindings")).toEqual(before);
				expect(await f.rows("coordinator_owner_enrollment_audit_log")).toEqual([]);
			},
		);
	}
}
async function nextTransition(f: QualifiedFixture, stage: "callback" | "confirm" | "finalize") {
	if (stage === "callback") {
		const c = await f.claim();
		return () => f.api.verifyCallback(c.request());
	}
	if (stage === "confirm") {
		const v = await f.verified();
		return () => f.api.confirm(v.request(), "browser-b", v.result.confirmation.confirmationHash);
	}
	const final = await f.confirmed();
	return () => f.api.finalize(final);
}
function registerRaces(test: ReturnType<typeof qualifiedTest>) {
	test.for(["qualification", "link", "grant"])(
		"winning final SQL denies a %s race after valid crypto",
		async (fault, { fixture: f }) => {
			// Arrange: intercept only scheduling; execute the actual atomic SQL batch.
			await f.qualify();
			await f.grant();
			const final = await f.confirmed();
			const batch = f.backend.batch.bind(f.backend);
			let entered = false;
			vi.spyOn(f.backend, "batch").mockImplementationOnce(async (statements) => {
				entered = true;
				await revoke(f, fault);
				return batch(statements);
			});
			// Act
			const result = await f.api.finalize(final);
			// Assert
			expect(entered).toBe(true);
			expect(result).toMatchObject({ kind: "rejected" });
			expect(await f.rows("coordinator_device_ownership_bindings")).toEqual([]);
			expect(await f.attempt()).toMatchObject({
				state: "confirmed",
				binding_id: null,
				final_outcome_json: null,
			});
		},
	);
}
async function revoke(f: Awaited<ReturnType<typeof qualifiedFixture>>, fault: string) {
	if (fault === "qualification")
		return f.exec("UPDATE coordinator_owner_enrollment_qualifications SET revoked_at_ms=?", NOW);
	if (fault === "link")
		return f.exec("UPDATE coordinator_auth_account_links SET revoked_at_ms=?", NOW);
	if (fault === "grant")
		return f.exec(
			"UPDATE coordinator_identity_group_grants SET revision=revision+1,status='revoked',revoked_at='revoked'",
		);
	const kind = fault === "pending-key" ? "ed25519_key" : "device_id";
	const value = kind === "ed25519_key" ? await ed25519KeyId(f.start.publicKey) : f.start.deviceId;
	await f.exec(
		"INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES (?,?,'pending-revocation','group-a','old-device-a',?,?,?)",
		kind,
		value,
		f.start.publicKey,
		f.fingerprint,
		new Date(NOW).toISOString(),
	);
}
