import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { type CreateCoordinatorAppOptions, createCoordinatorApp } from "./coordinator-api.js";
import { backendTest, type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { snapshot } from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import {
	expectDisplayOnly,
	expectNoDisclosure,
	safeProfile,
	selectedOwnerId,
	setupResolved,
	signer,
} from "./coordinator-resolved-account-owner-status-test-fixtures.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";
import { buildCanonicalRequest, SIGNATURE_VERSION, verifySignature } from "./sync-auth.js";

const ROOT = "/v1/auth/resolved-account-owner-status";
const ORIGIN = "https://app.example.test";
// RFC 8032 section 7.1 test 2: public test vector matching the accepted requester's key.
const privateKey = createPrivateKey({
	key: Buffer.from(
		"302e020100300506032b6570042204204ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
		"hex",
	),
	format: "der",
	type: "pkcs8",
});
let nonce = 0;
beforeEach(() => {
	nonce = 0;
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
	}
});
function path(ownerIdentityId = selectedOwnerId, origin = ORIGIN, groupId = signer.groupId) {
	return `${ROOT}?${new URLSearchParams({ group_id: groupId, owner_identity_id: ownerIdentityId, coordinator_origin: origin })}`;
}
function headers(
	url = path(),
	options: { timestamp?: string; deviceId?: string; key?: typeof privateKey; method?: string } = {},
) {
	const timestamp = options.timestamp ?? String(NOW / 1000);
	const requestNonce = String(++nonce).padStart(32, "0");
	return {
		"X-Opencode-Device": options.deviceId ?? signer.deviceId,
		"X-Opencode-Timestamp": timestamp,
		"X-Opencode-Nonce": requestNonce,
		"X-Opencode-Signature": `${SIGNATURE_VERSION}:${sign(null, buildCanonicalRequest(options.method ?? "GET", url, timestamp, requestNonce, Buffer.alloc(0)), options.key ?? privateKey).toString("base64")}`,
	};
}
async function setup(
	f: LinkFixture,
	kind: Backend,
	origin = ORIGIN,
	options: { fact?: boolean } = {},
) {
	const proof = await setupResolved(f, kind, options);
	const oidc = oidcFixture({ issuer: f.cfg.issuer });
	const captured = captureCoordinatorBrowserAuthOptions({
		config: { ...PROVIDER, ...f.cfg, redirectUri: `${origin}/auth/callback` },
		csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(7)),
		oidcOptions: { fetch: oidc.fetch },
	});
	const auth = await createCoordinatorBrowserAuth(
		captured,
		f.store,
		createInMemoryRequestRateLimiter({ now: () => NOW }),
	);
	if (!auth.ok) throw new Error("browser auth fixture unavailable");
	const appOptions: CreateCoordinatorAppOptions = {
		storeFactory: () => f.store,
		runtime: { adminSecret: () => "fixture-admin-secret", now: () => new Date(NOW).toISOString() },
		requestVerifier: (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		browserAuth: {
			kind: "ready",
			auth: auth.auth,
			storeFactory: () => f.store,
			clientKey: () => "synthetic-client",
		},
	};
	// A shared in-memory store survives per-request close; assert the calls, not a closed DB.
	const close = vi.spyOn(f.store, "close").mockResolvedValue(undefined);
	return {
		...f,
		proof,
		oidc,
		options: appOptions,
		close,
		origin,
		app: createCoordinatorApp(appOptions),
	};
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function protectedSnapshot(f: Fixture) {
	return {
		catalog: f.db
			.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
			.all(),
		// Normal signed GET authentication records/cleans request nonces, nothing else.
		tables: snapshot(f, ["request_nonces"]),
	};
}
async function get(
	f: Fixture,
	input: {
		path?: string;
		headers?: Record<string, string>;
		origin?: string;
		app?: Fixture["app"];
		request?: Request;
	} = {},
) {
	const url = input.path ?? path(selectedOwnerId, f.origin);
	const before = protectedSnapshot(f);
	const calls = f.oidc.requests.length;
	const app = input.app ?? f.app;
	// Preserve hostile raw-request overrides; a Request initializer would clone them away.
	const response = input.request
		? await app.fetch(input.request)
		: await app.request(`${input.origin ?? f.origin}${url}`, {
				headers: input.headers ?? headers(url),
			});
	expect(protectedSnapshot(f)).toEqual(before);
	expect(f.oidc.requests).toHaveLength(calls);
	expect(response.status, "resolved owner GET must be mounted, not a generic 404").not.toBe(404);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.getSetCookie()).toEqual([]);
	expect(await response.clone().text()).not.toMatch(
		/private-claim-subject|public_key|evidence_digest|source_review_receipt|fixture-admin-secret|fixture-secret/,
	);
	return response;
}
function confirmed(f: Fixture) {
	return {
		version: 1,
		coordinatorId: f.cfg.coordinatorId,
		groupId: signer.groupId,
		deviceId: signer.deviceId,
		fingerprint: signer.fingerprint,
		state: "owner_confirmed",
		ownerIdentity: selectedOwnerId,
		profileState: "linked",
		profile: safeProfile,
	};
}
for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	test(`${kind} control: accepted persisted owner and real crypto work before HTTP`, async ({
		fixture: f,
	}) => {
		// Arrange: current enrollment is weak C; A's account birth and checked writer are real.
		const h = await setup(f, kind);
		const signed = headers();
		const before = protectedSnapshot(h);
		const nonces = snapshot(h).find(([table]) => table === "request_nonces");
		// Act
		const valid = verifySignature({
			method: "GET",
			pathWithQuery: path(),
			bodyBytes: Buffer.alloc(0),
			publicKey: signer.publicKey,
			deviceId: signer.deviceId,
			timestamp: signed["X-Opencode-Timestamp"],
			nonce: signed["X-Opencode-Nonce"],
			signature: signed["X-Opencode-Signature"],
		});
		const result = await h.store.readResolvedAccountOwnerStatus(signer, h.cfg, {
			ownerIdentityId: selectedOwnerId,
		});
		// Assert: no auth nonce writes occur in the store projection itself.
		expect(valid).toBe(true);
		expect(result).toEqual(confirmed(h));
		expect(protectedSnapshot(h)).toEqual(before);
		expect(snapshot(h).find(([table]) => table === "request_nonces")).toEqual(nonces);
	});
	test(`${kind} signed weak C reads proven A but ordinary status remains unauthorized`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setup(f, kind);
		const ordinary = await h.store.readAccountLinkStatus(signer, h.cfg, {
			identityId: selectedOwnerId,
		});
		const beforeNonces = h.db.prepare("SELECT * FROM request_nonces").all().length;
		const read = vi.spyOn(h.store, "readResolvedAccountOwnerStatus");
		// Act
		const response = await get(h);
		const body = await response.json();
		const ordinaryAfter = await h.store.readAccountLinkStatus(signer, h.cfg, {
			identityId: selectedOwnerId,
		});
		// Assert
		expect(response.status).toBe(200);
		expect(body).toEqual(confirmed(h));
		expectDisplayOnly(body);
		expect(read).toHaveBeenCalledWith(signer, expect.objectContaining(h.cfg), {
			ownerIdentityId: selectedOwnerId,
		});
		expect(ordinary.state).not.toBe("linked");
		expect(ordinaryAfter).toEqual(ordinary);
		expect(h.db.prepare("SELECT * FROM request_nonces").all()).toHaveLength(beforeNonces + 1);
		expect(h.close).toHaveBeenCalledOnce();
	});
	test.for(["account-unlinked", "profile-unavailable"])(
		`${kind} separates proven owner from %s profile`,
		async (mode, { fixture: f }) => {
			// Arrange: change current account state, never the persisted owner proof.
			const h = await setup(f, kind);
			if (mode === "account-unlinked")
				h.db.exec("UPDATE coordinator_auth_account_links SET revoked_at_ms=1791028800001");
			else
				h.db.exec(
					"UPDATE coordinator_auth_link_attempts SET account_subject='wrong-generation-subject'",
				);
			// Act
			const response = await get(h);
			// Assert
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				...confirmed(h),
				profile: null,
				profileState: mode === "account-unlinked" ? "account_unlinked" : "unavailable",
			});
		},
	);
	test(`${kind} does not mount the read for a disabled ready adapter`, async ({ fixture: f }) => {
		// Arrange
		const h = await setup(f, kind);
		const ready = h.options.browserAuth;
		if (ready?.kind !== "ready") throw new Error("fixture must be ready");
		const factory = vi.fn(() => h.store);
		const app = createCoordinatorApp({
			...h.options,
			storeFactory: factory,
			browserAuth: {
				...ready,
				storeFactory: factory,
				auth: { ...ready.auth, storeConfig: { ...ready.auth.storeConfig, enabled: false } },
			},
		});
		const before = protectedSnapshot(h);
		// Act
		const response = await app.request(`${ORIGIN}${path()}`, { headers: headers() });
		// Assert: the disabled endpoint is not a device/admin read surface.
		expect(response.status).toBe(404);
		expect(factory).not.toHaveBeenCalled();
		expect(protectedSnapshot(h)).toEqual(before);
		expect(h.db.prepare("SELECT * FROM request_nonces").all()).toEqual([]);
	});
	test.for(["unknown-owner", "missing-fact", "revoked-source", "other-device"])(
		`${kind} valid signer gets unconfirmed, never another owner's profile: %s`,
		async (mode, { fixture: f }) => {
			// Arrange
			const h = await setup(f, kind, ORIGIN, { fact: mode !== "missing-fact" });
			let url = path();
			let signed = headers(url);
			if (mode === "unknown-owner") {
				url = path("unknown-owner");
				signed = headers(url);
			}
			if (mode === "revoked-source") {
				h.db
					.prepare(
						"UPDATE coordinator_auth_controller_attestations SET revoked_at=? WHERE attestation_id=?",
					)
					.run(new Date(NOW).toISOString(), h.proof.fact?.controller.attestation_id);
			}
			if (mode === "other-device") {
				await h.store.enrollDevice(signer.groupId, { ...signer, deviceId: "other-device" });
				signed = headers(url, { deviceId: "other-device" });
			}
			// Act
			const response = await get(h, { path: url, headers: signed });
			// Assert: selected owner is a selector, not evidence or a privacy oracle.
			expect(response.status).toBe(200);
			expectNoDisclosure(await response.json());
		},
	);
	test.for([
		"unsigned",
		"admin-only",
		"wrong-key",
		"wrong-device",
		"wrong-group",
		"stale",
		"future",
		"owner-tamper",
		"method-tamper",
		"disabled",
		"revoked",
	])(
		`${kind} rejects %s proof without profile disclosure or nonce admission`,
		async (mode, { fixture: f }) => {
			// Arrange: use the real verifier/freshness path, never a successful auth mock.
			const h = await setup(f, kind);
			let url = path();
			let signed: Record<string, string> = headers(url);
			let expected = 401;
			if (mode === "unsigned") signed = {};
			if (mode === "admin-only") signed = { Authorization: "Bearer fixture-admin-secret" };
			if (mode === "wrong-key")
				signed = headers(url, { key: generateKeyPairSync("ed25519").privateKey });
			if (mode === "wrong-device") signed = headers(url, { deviceId: "unknown-device" });
			if (mode === "wrong-group") {
				url = path(selectedOwnerId, ORIGIN, "other-group");
				signed = headers(url);
			}
			if (mode === "stale") signed = headers(url, { timestamp: String(NOW / 1000 - 10000) });
			if (mode === "future") signed = headers(url, { timestamp: String(NOW / 1000 + 10000) });
			if (mode === "owner-tamper") url = path("other-owner");
			if (mode === "method-tamper") signed = headers(url, { method: "POST" });
			if (mode === "disabled") {
				await h.store.setDeviceEnabled(signer.groupId, signer.deviceId, false);
				expected = 403;
			}
			if (mode === "revoked") {
				await h.store.createDeviceRevocation(signer);
				expected = 403;
			}
			const before = h.db.prepare("SELECT * FROM request_nonces").all();
			// Act
			const response = await get(h, { path: url, headers: signed });
			// Assert
			expect(response.status).toBe(expected);
			expect(await response.text()).not.toContain(safeProfile.email);
			expect(h.db.prepare("SELECT * FROM request_nonces").all()).toEqual(before);
		},
	);
	test(`${kind} admits one nonce, rejects replay, and preserves authenticated nonce cleanup`, async ({
		fixture: f,
	}) => {
		// Arrange
		const h = await setup(f, kind);
		const cleanup = vi.spyOn(h.store, "cleanupNonces");
		const signed = headers();
		// Act
		const first = await get(h, { headers: signed });
		const nonces = h.db.prepare("SELECT * FROM request_nonces").all();
		const replay = await get(h, { headers: signed });
		// Assert
		expect(first.status).toBe(200);
		expect(replay.status).toBe(401);
		expect(await replay.text()).not.toContain(safeProfile.email);
		expect(h.db.prepare("SELECT * FROM request_nonces").all()).toEqual(nonces);
		expect(cleanup).toHaveBeenCalledOnce();
		expect(h.close).toHaveBeenCalledTimes(2);
	});
	test(`${kind} binds signed recipient to request/config origin before nonce use`, async ({
		fixture: f,
	}) => {
		// Arrange: same path/query/signature remains cryptographically valid on either host.
		const h = await setup(f, kind, "https://second.example.test");
		const verifier = vi.fn(h.options.requestVerifier);
		const app = createCoordinatorApp({ ...h.options, requestVerifier: verifier });
		const signed = headers(path());
		const before = h.db.prepare("SELECT * FROM request_nonces").all();
		// Act
		const wrongRecipient = await get(h, { app, path: path(), headers: signed });
		const wrongRequestHost = await get(h, { app, path: path(), origin: ORIGIN, headers: signed });
		// Assert
		expect(wrongRecipient.status).toBe(403);
		expect(wrongRequestHost.status).toBe(403);
		expect(verifier).not.toHaveBeenCalled();
		expect(h.db.prepare("SELECT * FROM request_nonces").all()).toEqual(before);
		// Act: changing signed query origin breaks proof; a freshly signed recipient works.
		const correct = path(selectedOwnerId, h.origin);
		const tampered = await get(h, { app, path: correct, headers: signed });
		const valid = await get(h, { app, path: correct, headers: headers(correct) });
		// Assert
		expect(tampered.status).toBe(401);
		expect(valid.status).toBe(200);
		expect(await valid.json()).toEqual(confirmed(h));
	});
	test.for([
		"missing-owner",
		"duplicate-owner",
		"duplicate-group",
		"duplicate-origin",
		"fingerprint",
		"device_id",
		"coordinator_id",
		"authority",
		"blank-owner",
	])(
		`${kind} rejects invalid signed query %s before any owner read`,
		async (mode, { fixture: f }) => {
			// Arrange
			const h = await setup(f, kind);
			const url = new URL(path(), ORIGIN);
			if (mode === "missing-owner") url.searchParams.delete("owner_identity_id");
			else if (mode === "blank-owner") url.searchParams.set("owner_identity_id", "");
			else if (mode.startsWith("duplicate-")) {
				const field = {
					"duplicate-owner": "owner_identity_id",
					"duplicate-group": "group_id",
					"duplicate-origin": "coordinator_origin",
				}[mode];
				if (!field) throw new Error("missing duplicate selector");
				url.searchParams.append(field, url.searchParams.get(field) ?? "");
			} else url.searchParams.append(mode, "caller-override");
			const read = vi.spyOn(h.store, "readResolvedAccountOwnerStatus");
			const nonces = h.db.prepare("SELECT * FROM request_nonces").all();
			// Act
			const response = await get(h, { path: url.pathname + url.search });
			// Assert
			expect(response.status).toBe(400);
			expect(read).not.toHaveBeenCalled();
			expect(h.db.prepare("SELECT * FROM request_nonces").all()).toEqual(nonces);
		},
	);
	test(`${kind} rejects a GET body without constructing a forbidden Fetch GET initializer`, async ({
		fixture: f,
	}) => {
		// Arrange: model the adapter's body-bearing raw request; Request(GET, {body}) itself throws.
		const h = await setup(f, kind);
		const request = new Request(`${ORIGIN}${path()}`, { headers: headers() });
		const body = new ReadableStream({
			start(c) {
				c.close();
			},
		});
		const observeBody = vi.fn(() => body);
		Object.defineProperty(request, "body", {
			get: observeBody,
		});
		const read = vi.spyOn(h.store, "readResolvedAccountOwnerStatus");
		// Act
		const response = await get(h, { request });
		// Assert
		expect(observeBody).toHaveBeenCalled();
		expect(observeBody).toHaveReturnedWith(body);
		expect(response.status).toBe(400);
		expect(read).not.toHaveBeenCalled();
		expect(h.db.prepare("SELECT * FROM request_nonces").all()).toEqual([]);
	});
	test.for(["missing-capability", "reader-failure", "missing-schema"])(
		`${kind} fails unavailable for %s without ordinary fallback or installing DDL`,
		async (mode, { fixture: f }) => {
			// Arrange
			const h = await setup(f, kind);
			if (mode === "missing-capability")
				Object.defineProperty(h.store, "readResolvedAccountOwnerStatus", { value: undefined });
			if (mode === "reader-failure")
				vi.spyOn(h.store, "readResolvedAccountOwnerStatus").mockRejectedValue(
					new Error("private upstream proof"),
				);
			if (mode === "missing-schema") h.db.exec("DROP TABLE coordinator_legacy_owner_resolutions");
			const ordinary = vi.spyOn(h.store, "readAccountLinkStatus");
			// Act
			const response = await get(h);
			// Assert: get compares the complete catalog and every non-nonce table.
			expect(response.status).toBe(503);
			expect(await response.text()).not.toMatch(/private upstream proof|owner-a@example.test/);
			expect(ordinary).not.toHaveBeenCalled();
			expect(h.close).toHaveBeenCalledOnce();
		},
	);
	test.for(["absent", "unavailable", "schema-upgrade"])(
		`${kind} never reads through %s browser auth`,
		async (mode, { fixture: f }) => {
			// Arrange
			const h = await setup(f, kind);
			const factory = vi.fn(() => h.store);
			let browserAuth: CreateCoordinatorAppOptions["browserAuth"];
			if (mode === "absent") {
				browserAuth = undefined;
			} else if (mode === "schema-upgrade") {
				browserAuth = {
					kind: "unavailable",
					error: "coordinator_auth_schema_upgrade_required",
				};
			} else {
				browserAuth = { kind: "unavailable", error: undefined };
			}
			const app = createCoordinatorApp({
				...h.options,
				storeFactory: factory,
				browserAuth,
			});
			// Act
			const response = await get(h, { app });
			// Assert
			expect(response.status).toBe(503);
			expect(factory).not.toHaveBeenCalled();
			if (mode === "schema-upgrade")
				expect(response.headers.get("X-Codemem-Auth-Error")).toBe(
					"coordinator_auth_schema_upgrade_required",
				);
		},
	);
	test.for(["signed", "anonymous"])(
		`${kind} preserves %s rate limits`,
		async (mode, { fixture: f }) => {
			// Arrange
			const h = await setup(f, kind);
			const app = createCoordinatorApp({
				...h.options,
				requestRateLimit: { readLimit: 1, unauthenticatedReadLimit: 1 },
			});
			const input = { app, headers: mode === "anonymous" ? {} : undefined };
			// Act
			const first = await get(h, input);
			const blocked = await get(h, { ...input, path: path("another-owner") });
			// Assert
			expect(first.status).toBe(mode === "anonymous" ? 401 : 200);
			expect(blocked.status).toBe(429);
			expect(await blocked.text()).not.toContain(safeProfile.email);
		},
	);
}
