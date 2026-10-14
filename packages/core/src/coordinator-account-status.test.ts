import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type CreateCoordinatorAppOptions, createCoordinatorApp } from "./coordinator-api.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { advance, attempt, finalize, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { type Backend, review, setupStore } from "./coordinator-auth-store-test-fixtures.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "./coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "./coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { createInMemoryRequestRateLimiter } from "./request-rate-limit.js";
import { buildCanonicalRequest, SIGNATURE_VERSION, verifySignature } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

const ROOT = "/v1/auth/account-link-status";
const ORIGIN = "https://app.example.test";
function statusPath(groupId = "group-a", origin = ORIGIN) {
	return `${ROOT}?${new URLSearchParams({ group_id: groupId, coordinator_origin: origin })}`;
}
const PATH = statusPath();
const config = {
	...PROVIDER,
	issuer: "https://accounts.google.com",
	enabled: true,
	coordinatorId: "coordinator-a",
	revision: "a".repeat(64),
};
const databases: ReturnType<typeof setupStore>["db"][] = [];
let nextNonce = 0;
beforeEach(() => {
	nextNonce = 0;
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		for (const db of databases.splice(0)) if (db.open) db.close();
	}
});
function identity(deviceId = "device-a") {
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(8 + kind.length + raw.length);
	wire.writeUInt32BE(kind.length);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	return { deviceId, publicKey, fingerprint: fingerprintPublicKey(publicKey), keys };
}
type Identity = ReturnType<typeof identity>;
function headers(key: Identity, path = PATH, timestamp = String(NOW / 1000)) {
	const nonce = String(++nextNonce).padStart(32, "0");
	const signature = sign(
		null,
		buildCanonicalRequest("GET", path, timestamp, nonce, Buffer.alloc(0)),
		key.keys.privateKey,
	);
	return {
		"X-Opencode-Device": key.deviceId,
		"X-Opencode-Timestamp": timestamp,
		"X-Opencode-Nonce": nonce,
		"X-Opencode-Signature": `${SIGNATURE_VERSION}:${signature.toString("base64")}`,
	};
}
async function setup(backend: Backend = "SQLite", origin = ORIGIN, key = identity()) {
	const f = setupStore(backend, { authClock: () => NOW });
	databases.push(f.db);
	vi.spyOn(f.store, "close").mockResolvedValue(undefined);
	await f.store.createGroup("group-a");
	await f.store.enrollDevice("group-a", key);
	const oidc = oidcFixture({ issuer: config.issuer });
	const captured = captureCoordinatorBrowserAuthOptions({
		config: { ...config, redirectUri: `${origin}/auth/callback` },
		csrfKey: await importBrowserCsrfKey(new Uint8Array(32).fill(7)),
		oidcOptions: { fetch: oidc.fetch },
	});
	const result = await createCoordinatorBrowserAuth(
		captured,
		f.store,
		createInMemoryRequestRateLimiter({ now: () => NOW }),
	);
	if (!result.ok) throw new Error("fixture composition failed");
	const options: CreateCoordinatorAppOptions = {
		storeFactory: () => f.store,
		runtime: { adminSecret: () => null, now: () => new Date(NOW).toISOString() },
		requestVerifier: (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		browserAuth: {
			kind: "ready",
			auth: result.auth,
			storeFactory: () => f.store,
			clientKey: () => "synthetic-client",
		},
	};
	return { ...f, key, origin, options, app: createCoordinatorApp(options), oidc };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function snapshot(f: Fixture) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	// All columns of every table are protected, including grants, history and profiles.
	return tables
		.filter(({ name }) => name !== "request_nonces")
		.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
async function get(
	f: Fixture,
	options: {
		path?: string;
		headers?: Record<string, string>;
		origin?: string;
		app?: Fixture["app"];
	} = {},
) {
	const path = options.path ?? statusPath("group-a", f.origin);
	const before = snapshot(f);
	const providerCalls = f.oidc.requests.length;
	const response = await (options.app ?? f.app).request(`${options.origin ?? f.origin}${path}`, {
		headers: options.headers ?? headers(f.key, path),
	});
	expect(snapshot(f)).toEqual(before);
	expect(f.oidc.requests).toHaveLength(providerCalls);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.getSetCookie()).toEqual([]);
	return response;
}
async function authorize(f: Fixture) {
	expect((await f.store.createAuthControllerAttestation(review(f.key))).kind).toBe("created");
}
async function seedLink(f: Fixture) {
	await authorize(f);
	const signer = { groupId: "group-a", ...f.key };
	await advance({ ...f, now: NOW, cfg: config }, "confirmed", attempt({ signer }));
	expect(
		(
			await f.store.finalizeAuthLinkAttempt(
				finalize({ signer, fingerprint: f.key.fingerprint }),
				config,
			)
		).kind,
	).toBe("applied");
	const row = f.db.prepare("SELECT link_id FROM coordinator_auth_account_links").get() as {
		link_id: string;
	};
	f.db
		.prepare(`INSERT INTO coordinator_auth_account_profiles
		(coordinator_id,link_id,display_name,email,email_verified,picture_url,source_session_id,source_signed_in_at_ms)
		VALUES (?,?,?,?,?,?,?,?)`)
		.run(
			config.coordinatorId,
			row.link_id,
			"Synthetic Person",
			"synthetic@example.test",
			1,
			"https://images.example.test/private-picture",
			"private-session",
			NOW,
		);
}
function dto(
	f: Fixture,
	state: string,
	identityId: string | null = "identity-a",
	account: unknown = null,
) {
	return {
		version: 1,
		coordinatorId: config.coordinatorId,
		groupId: "group-a",
		deviceId: f.key.deviceId,
		fingerprint: f.key.fingerprint,
		identityId,
		state,
		account,
	};
}
function privateFields(text: string) {
	for (const value of [
		"opaque-subject-a",
		"private-session",
		"private-picture",
		config.clientSecret,
		"account_subject",
		"providerSubject",
		"access_token",
		"refresh_token",
		"id_token",
		"pkce_verifier",
		"runtime_verifier",
		"completion_secret",
		"review_receipt_id",
		"evidence_digest",
		"public_key",
	])
		expect(text).not.toContain(value);
}

it.each(["linked", "unlinked", "revoked", "no-profile", "conflict", "unverified-email"])(
	"returns current %s status without mutating stored authority",
	async (state) => {
		// Arrange
		const f = await setup();
		if (state === "unlinked") await authorize(f);
		else await seedLink(f);
		if (state === "revoked")
			f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms = ?").run(NOW);
		if (state === "no-profile") f.db.prepare("DELETE FROM coordinator_auth_account_profiles").run();
		if (state === "conflict")
			f.db
				.prepare("UPDATE coordinator_auth_account_links SET issuer = 'https://other.example.test'")
				.run();
		if (state === "unverified-email")
			f.db.prepare("UPDATE coordinator_auth_account_profiles SET email_verified = 0").run();
		const nonces = f.db.prepare("SELECT * FROM request_nonces").all();
		// Act
		const response = await get(f);
		const text = await response.text();
		// Assert: exact keys prevent any stored provider identifiers/proofs escaping.
		expect(response.status).toBe(200);
		let account: unknown = null;
		let expectedState = state;
		if (state === "linked")
			account = { email: "synthetic@example.test", displayName: "Synthetic Person" };
		if (state === "no-profile") {
			account = {};
			expectedState = "linked";
		}
		if (state === "unverified-email") {
			account = { displayName: "Synthetic Person" };
			expectedState = "linked";
		}
		expect(JSON.parse(text)).toEqual(
			dto(f, expectedState, state === "conflict" ? null : "identity-a", account),
		);
		privateFields(text);
		expect(f.db.prepare("SELECT * FROM request_nonces").all()).toHaveLength(nonces.length + 1);
	},
);

for (const backend of ["SQLite", "D1"] as const) {
	it.each(["linked", "unlinked", "revoked", "conflict", "unverified-email", "review_required"])(
		`${backend} store projects %s without changing any stored fields`,
		async (state) => {
			// Arrange: D1 uses the fresh Worker schema via setupStore, not SQLite's initializer.
			const f = await setup(backend);
			if (state === "unlinked") await authorize(f);
			else await seedLink(f);
			if (state === "revoked")
				f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms = ?").run(NOW);
			if (state === "conflict")
				f.db
					.prepare(
						"UPDATE coordinator_auth_account_links SET issuer = 'https://other.example.test'",
					)
					.run();
			if (state === "unverified-email")
				f.db.prepare("UPDATE coordinator_auth_account_profiles SET email_verified = 0").run();
			if (state === "review_required")
				await f.store.revokeAuthControllerAttestation(config.coordinatorId, review().attestationId);
			const before = snapshot(f);
			const nonces = f.db.prepare("SELECT * FROM request_nonces").all();
			let account: unknown = null;
			if (state === "linked")
				account = { email: "synthetic@example.test", displayName: "Synthetic Person" };
			if (state === "unverified-email") account = { displayName: "Synthetic Person" };
			const identityId = ["conflict", "review_required"].includes(state) ? null : "identity-a";
			// Act
			const result = await f.store.readAccountLinkStatus({ groupId: "group-a", ...f.key }, config);
			// Assert
			expect(result).toEqual(
				dto(f, state === "unverified-email" ? "linked" : state, identityId, account),
			);
			privateFields(JSON.stringify(result));
			expect(snapshot(f)).toEqual(before);
			expect(f.db.prepare("SELECT * FROM request_nonces").all()).toEqual(nonces);
		},
	);
	it.each([
		"controller-revoked",
		"device-revoked",
		"key-revoked",
		"disabled",
		"rekeyed",
		"link-revoked",
	])(`${backend} rechecks %s after reading the first authority row`, async (change) => {
		// Arrange: wrap the production backend to commit the race between its two reads.
		const f = await setup(backend);
		await seedLink(f);
		const before = snapshot(f);
		const nonces = f.db.prepare("SELECT * FROM request_nonces").all();
		const operations = Reflect.get(f.store, "accountLinkStatus") as {
			backend: Pick<AuthLinkBackend, "first">;
		};
		const first = operations.backend.first.bind(operations.backend);
		let afterMutation: ReturnType<typeof snapshot> | undefined;
		let reads = 0;
		const wrapped = vi.spyOn(operations.backend, "first").mockImplementation(async (statement) => {
			const row = await first(statement);
			if (++reads !== 1) return row;
			expect(row).not.toBeNull();
			if (change === "controller-revoked")
				await f.store.revokeAuthControllerAttestation(config.coordinatorId, review().attestationId);
			if (["device-revoked", "key-revoked"].includes(change)) {
				expect((await f.store.createDeviceRevocation({ groupId: "group-a", ...f.key })).kind).toBe(
					"revoked",
				);
				// Isolate each revocation subject so neither case can pass on the other check.
				f.db
					.prepare("DELETE FROM coordinator_device_revocations WHERE subject_kind = ?")
					.run(change === "device-revoked" ? "ed25519_key" : "device_id");
			}
			if (change === "disabled") await f.store.setDeviceEnabled("group-a", f.key.deviceId, false);
			if (change === "rekeyed") await f.store.enrollDevice("group-a", identity());
			if (change === "link-revoked")
				f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms = ?").run(NOW);
			afterMutation = snapshot(f);
			return row;
		});
		// Act: no HTTP snapshot helper, because the injected write is intentional.
		const result = await f.store.readAccountLinkStatus({ groupId: "group-a", ...f.key }, config);
		// Assert: link revocation keeps the derived identity; lost controller authority does not.
		expect(result).toEqual(
			dto(
				f,
				change === "link-revoked" ? "revoked" : "review_required",
				change === "link-revoked" ? "identity-a" : null,
			),
		);
		expect(wrapped).toHaveBeenCalledTimes(2);
		expect(afterMutation).toBeDefined();
		expect(snapshot(f)).toEqual(afterMutation);
		const changedTable = {
			"controller-revoked": "coordinator_auth_controller_attestations",
			"device-revoked": "coordinator_device_revocations",
			"key-revoked": "coordinator_device_revocations",
			disabled: "enrolled_devices",
			rekeyed: "enrolled_devices",
			"link-revoked": "coordinator_auth_account_links",
		}[change];
		expect(snapshot(f).filter(([table]) => table !== changedTable)).toEqual(
			before.filter(([table]) => table !== changedTable),
		);
		expect(f.db.prepare("SELECT * FROM request_nonces").all()).toEqual(nonces);
		const text = JSON.stringify(result);
		privateFields(text);
		for (const pii of ["synthetic@example.test", "Synthetic Person"])
			expect(text).not.toContain(pii);
	});
}

it.each(["throws", "missing"])("returns a private 503 when the status reader %s", async (mode) => {
	// Arrange
	const f = await setup();
	await seedLink(f);
	if (mode === "missing")
		Object.defineProperty(f.store, "readAccountLinkStatus", { value: undefined });
	else
		vi.spyOn(f.store, "readAccountLinkStatus").mockRejectedValue(
			new Error("opaque-subject-a private-session"),
		);
	// Act
	const response = await get(f);
	// Assert
	expect(response.status).toBe(503);
	privateFields(await response.text());
});

it.each([
	"missing",
	"revoked",
	"stale-identity",
	"wrong-key",
	"wrong-fingerprint",
	"wrong-device",
	"wrong-group",
	"wrong-namespace",
])("returns review_required without PII for %s controller", async (variant) => {
	// Arrange: even an existing account/profile cannot substitute for current review.
	const f = await setup();
	await seedLink(f);
	if (variant === "missing")
		f.db.prepare("DELETE FROM coordinator_auth_controller_attestations").run();
	else if (variant === "revoked")
		await f.store.revokeAuthControllerAttestation(config.coordinatorId, review().attestationId);
	else if (variant === "stale-identity")
		f.db.prepare("UPDATE enrolled_devices SET identity_id = 'changed-identity'").run();
	else {
		const columns: Record<string, string> = {
			"wrong-key": "public_key",
			"wrong-fingerprint": "fingerprint",
			"wrong-device": "device_id",
			"wrong-group": "group_id",
			"wrong-namespace": "coordinator_id",
		};
		f.db
			.prepare(`UPDATE coordinator_auth_controller_attestations SET ${columns[variant]} = ?`)
			.run(variant === "wrong-fingerprint" ? "f".repeat(64) : "wrong-value");
	}
	// Act
	const response = await get(f);
	const text = await response.text();
	// Assert
	expect(response.status).toBe(200);
	expect(JSON.parse(text)).toEqual(dto(f, "review_required", null));
	privateFields(text);
	for (const pii of ["synthetic@example.test", "Synthetic Person", "identity-a"])
		expect(text).not.toContain(pii);
});

it.each([
	"unsigned",
	"bad-signature",
	"wrong-key",
	"wrong-device",
	"wrong-group",
	"stale-timestamp",
	"query-tamper",
	"removed",
	"disabled",
	"revoked",
])("rejects %s before exposing account information", async (variant) => {
	// Arrange
	const f = await setup();
	await seedLink(f);
	let path = PATH;
	let signed: Record<string, string> = headers(f.key);
	let expected = 401;
	if (variant === "unsigned") signed = {};
	if (variant === "bad-signature")
		signed["X-Opencode-Signature"] = `${SIGNATURE_VERSION}:${Buffer.alloc(64).toString("base64")}`;
	if (variant === "wrong-key") signed = headers(identity());
	if (variant === "wrong-device") signed = headers({ ...f.key, deviceId: "unknown-device" });
	if (variant === "wrong-group") {
		path = statusPath("other-group");
		signed = headers(f.key, path);
	}
	if (variant === "stale-timestamp") signed = headers(f.key, PATH, String(NOW / 1000 - 10000));
	if (variant === "query-tamper") signed = headers(f.key, statusPath("other-group"));
	if (variant === "removed") await f.store.removeDevice("group-a", f.key.deviceId);
	if (variant === "disabled") {
		await f.store.setDeviceEnabled("group-a", f.key.deviceId, false);
		expected = 403;
	}
	if (variant === "revoked") {
		await f.store.createDeviceRevocation({ groupId: "group-a", ...f.key });
		expected = 403;
	}
	const nonces = f.db.prepare("SELECT * FROM request_nonces").all();
	// Act
	const response = await get(f, { path, headers: signed });
	const text = await response.text();
	// Assert
	expect(response.status).toBe(expected);
	privateFields(text);
	for (const pii of ["synthetic@example.test", "Synthetic Person", "identity-a"])
		expect(text).not.toContain(pii);
	expect(f.db.prepare("SELECT * FROM request_nonces").all()).toEqual(nonces);
});

it("accepts a fresh signature once and rejects nonce replay", async () => {
	// Arrange
	const f = await setup();
	await authorize(f);
	const signed = headers(f.key);
	// Act
	const first = await get(f, { headers: signed });
	const nonces = f.db.prepare("SELECT * FROM request_nonces").all();
	const replay = await get(f, { headers: signed });
	// Assert
	expect(first.status).toBe(200);
	expect(await first.json()).toEqual(dto(f, "unlinked"));
	expect(replay.status).toBe(401);
	privateFields(await replay.text());
	expect(f.db.prepare("SELECT * FROM request_nonces").all()).toEqual(nonces);
});

it.each([
	"",
	`?${new URLSearchParams({ coordinator_origin: ORIGIN })}`,
	"?group_id=group-a",
	statusPath("").slice(ROOT.length),
	`${PATH}&group_id=group-a`.slice(ROOT.length),
	`${PATH}&coordinator_origin=${encodeURIComponent(ORIGIN)}`.slice(ROOT.length),
	...["identity_id", "identityId", "device_id", "coordinator_id"].map((key) =>
		`${PATH}&${key}=other`.slice(ROOT.length),
	),
])("rejects caller selectors or invalid query %s", async (query) => {
	// Arrange
	const f = await setup();
	await seedLink(f);
	// Act
	const response = await get(f, { path: `${ROOT}${query}` });
	// Assert
	expect(response.status).toBe(400);
	privateFields(await response.text());
});

it("rejects a valid signature sent to an unpinned origin", async () => {
	// Arrange
	const f = await setup();
	await seedLink(f);
	const nonces = f.db.prepare("SELECT * FROM request_nonces").all();
	// Act
	const response = await get(f, { origin: "https://wrong.example.test" });
	// Assert
	expect(response.status).toBe(403);
	privateFields(await response.text());
	expect(f.db.prepare("SELECT * FROM request_nonces").all()).toEqual(nonces);
});

it("rejects cross-coordinator replay before metadata or nonce use and rejects origin tampering", async () => {
	// Arrange: both configured coordinators enroll exactly the same valid group/device/key.
	const a = await setup();
	const b = await setup("SQLite", "https://coordinator-b.example.test", a.key);
	await seedLink(a);
	await seedLink(b);
	const metadata = vi.spyOn(b.store, "readAccountLinkStatus");
	const verifier = vi.fn(b.options.requestVerifier);
	b.app = createCoordinatorApp({ ...b.options, requestVerifier: verifier });
	const pathA = statusPath("group-a", a.origin);
	const pathB = statusPath("group-a", b.origin);
	const signedA = headers(a.key, pathA);
	const nonces = b.db.prepare("SELECT * FROM request_nonces").all();
	// Act
	const replay = await get(b, { path: pathA, headers: signedA });
	const replayText = await replay.text();
	// Assert: reject A's signed recipient before authorizing on B.
	expect(replay.status).toBe(403);
	expect(verifier).not.toHaveBeenCalled();
	expect(metadata).not.toHaveBeenCalled();
	expect(b.db.prepare("SELECT * FROM request_nonces").all()).toEqual(nonces);
	privateFields(replayText);
	expect(replayText).not.toMatch(/synthetic@example.test|Synthetic Person|identity-a/);
	// Act: rewriting the recipient to B cannot repair A's signature.
	const tampered = await get(b, { path: pathB, headers: signedA });
	const tamperedText = await tampered.text();
	// Assert
	expect(tampered.status).toBe(401);
	expect(metadata).not.toHaveBeenCalled();
	expect(b.db.prepare("SELECT * FROM request_nonces").all()).toEqual(nonces);
	privateFields(tamperedText);
	expect(tamperedText).not.toMatch(/synthetic@example.test|Synthetic Person|identity-a/);
	// Act: B's own recipient and a fresh matching signature remain valid.
	const valid = await get(b, { path: pathB, headers: headers(b.key, pathB) });
	// Assert
	expect(valid.status).toBe(200);
	expect(await valid.json()).toEqual(
		dto(b, "linked", "identity-a", {
			email: "synthetic@example.test",
			displayName: "Synthetic Person",
		}),
	);
	expect(metadata).toHaveBeenCalledOnce();
	expect(b.db.prepare("SELECT * FROM request_nonces").all()).toHaveLength(nonces.length + 1);
});

it.each(["absent", "unavailable"])(
	"returns 503 with %s browser auth rather than reading accounts",
	async (mode) => {
		// Arrange
		const f = await setup();
		const factory = vi.fn(() => f.store);
		const app = createCoordinatorApp({
			...f.options,
			storeFactory: factory,
			browserAuth: mode === "absent" ? undefined : { kind: "unavailable" },
		});
		// Act
		const response = await get(f, { app });
		// Assert
		expect(response.status).toBe(503);
		privateFields(await response.text());
		expect(factory).not.toHaveBeenCalled();
	},
);

it.each(["signed", "anonymous"])(
	"limits repeated %s reads without changing authority",
	async (mode) => {
		// Arrange
		const f = await setup();
		await authorize(f);
		const app = createCoordinatorApp({
			...f.options,
			requestRateLimit: { readLimit: 1, unauthenticatedReadLimit: 1 },
		});
		const options = mode === "anonymous" ? { app, headers: {} } : { app };
		// Act
		const first = await get(f, options);
		const blocked = await get(f, options);
		// Assert
		expect(first.status).toBe(mode === "anonymous" ? 401 : 200);
		expect(blocked.status).toBe(429);
		privateFields(await blocked.text());
	},
);
