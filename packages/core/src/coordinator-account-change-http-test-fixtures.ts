import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { expect, vi } from "vitest";
import { AccountChangeOperations } from "./coordinator-account-change.js";
import { AUTH_ACCOUNT_CHANGE_PURPOSE } from "./coordinator-account-change-contract.js";
import {
	applyAccountConnectionSchema,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import { type CreateCoordinatorAppOptions, createCoordinatorApp } from "./coordinator-api.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { buildCanonicalRequest, SIGNATURE_VERSION, verifySignature } from "./sync-auth.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

export const NOW = 1_791_028_800_000;
export const ROOT = "/v1/auth/account-changes";
export const ORIGIN = "https://coordinator.example.test";
export const config = {
	coordinatorId: "coordinator-a",
	issuer: "https://accounts.example.test",
	revision: "a".repeat(64),
	enabled: true,
	redirectUri: `${ORIGIN}/auth/callback`,
};
const defaultConfig = config;
export const runtimeVerifier = Buffer.alloc(32, 17).toString("base64url");
export const completion = Buffer.alloc(32, 29).toString("base64url");
export const hash = (raw: string) =>
	createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex");
export const h = (n: number) => n.toString(16).padStart(64, "0");
const databases: ReturnType<typeof setupStore>["db"][] = [];
export function cleanupAccountChangeHttpFixtures() {
	for (const db of databases.splice(0)) if (db.open) db.close();
	vi.restoreAllMocks();
}
export function keypair(deviceId = "device-a") {
	const keys = generateKeyPairSync("ed25519");
	const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
	const kind = Buffer.from("ssh-ed25519");
	const wire = Buffer.alloc(8 + kind.length + raw.length);
	wire.writeUInt32BE(kind.length, 0);
	kind.copy(wire, 4);
	wire.writeUInt32BE(raw.length, 4 + kind.length);
	raw.copy(wire, 8 + kind.length);
	const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
	return {
		deviceId,
		publicKey,
		fingerprint: fingerprintPublicKey(publicKey),
		privateKey: keys.privateKey,
	};
}
export function headers(key: ReturnType<typeof keypair>, method: string, path: string, body = "") {
	const timestamp = String(NOW / 1000),
		nonce = randomBytes(16).toString("hex");
	const signature = sign(
		null,
		buildCanonicalRequest(method, path, timestamp, nonce, Buffer.from(body)),
		key.privateKey,
	);
	return {
		"content-type": "application/json",
		"X-Opencode-Device": key.deviceId,
		"X-Opencode-Timestamp": timestamp,
		"X-Opencode-Nonce": nonce,
		"X-Opencode-Signature": `${SIGNATURE_VERSION}:${signature.toString("base64")}`,
	};
}
export const createBody = (extra: Record<string, unknown> = {}) => ({
	group_id: "group-a",
	identity_id: "identity-a",
	intent: "refresh",
	attempt_id: "change-a",
	runtime_verifier_hash: hash(runtimeVerifier),
	browser_start_hash: h(51),
	loopback_redirect: "http://127.0.0.1:4567/codemem/auth/complete",
	...extra,
});
export const statusPins = () => ({
	group_id: "group-a",
	identity_id: "identity-a",
	runtime_verifier_hash: hash(runtimeVerifier),
});
export const capabilitiesPath = `${ROOT}?group_id=group-a&identity_id=identity-a`;

async function startBirth(
	base: ReturnType<typeof setupStore>,
	key: ReturnType<typeof keypair>,
	authority: "device_claim" | "controller_attestation",
	config = defaultConfig,
) {
	await base.store.createGroup("group-a");
	await base.store.enrollDevice("group-a", key);
	const signer = {
		groupId: "group-a",
		deviceId: key.deviceId,
		publicKey: key.publicKey,
		fingerprint: key.fingerprint,
	};
	const birth = {
		attemptId: "birth",
		signer,
		authority:
			authority === "device_claim"
				? { kind: authority, identityId: "identity-a" }
				: { kind: authority },
		runtimeVerifierHash: h(1),
		browserStartHash: h(2),
		loopbackRedirect: createBody().loopback_redirect,
	};
	if (authority === "controller_attestation")
		expect(
			await base.store.createAuthControllerAttestation({
				...signer,
				identityId: "identity-a",
				coordinatorId: config.coordinatorId,
				attestationId: "controller-a",
				reviewReceiptId: "review-a",
				evidenceDigest: h(90),
			}),
		).toMatchObject({ kind: "created" });
	expect(await base.store.createAuthLinkAttempt(birth, config)).toMatchObject({ kind: "created" });
	return birth;
}
async function verifyBirth(base: ReturnType<typeof setupStore>, config: typeof defaultConfig) {
	const browser = {
		purpose: "link" as const,
		attemptId: "birth",
		browserStartHash: h(2),
		stateHash: h(3),
		binderHash: h(4),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	expect(await base.store.startAuthBrowserTransaction(browser, config)).toMatchObject({
		kind: "started",
	});
	const bound = await base.store.resolveAuthLinkBrowserTransaction(
		{ attemptId: "birth", binderHash: h(4) },
		config,
	);
	if (!bound) throw new Error("missing birth fixture");
	expect(await base.store.consumeAuthBrowserTransaction(browser, config)).toMatchObject({
		kind: "consumed",
	});
	const pins = { attemptId: "birth", ...bound };
	// Synthetic provider facts only seed the existing link. Device authorization is real Ed25519.
	expect(
		await base.store.recordAuthLinkOidcVerified(
			{
				...pins,
				account: { issuer: config.issuer, subject: "account-A" },
				profile: { displayName: "Birth" },
			},
			config,
		),
	).toMatchObject({ kind: "applied" });
	expect(
		await base.store.confirmAuthLinkAttempt({ ...pins, completionSecretHash: h(5) }, config),
	).toMatchObject({ kind: "applied" });
	return pins;
}
async function seedBirth(
	base: ReturnType<typeof setupStore>,
	key: ReturnType<typeof keypair>,
	authority: "device_claim" | "controller_attestation",
	config: typeof defaultConfig,
) {
	const birth = await startBirth(base, key, authority, config);
	const signer = birth.signer;
	const pins = await verifyBirth(base, config);
	expect(
		await base.store.finalizeAuthLinkAttempt(
			{
				...birth,
				purpose: "coordinator-account-link-v1",
				coordinatorId: config.coordinatorId,
				groupId: signer.groupId,
				identityId: "identity-a",
				deviceId: key.deviceId,
				fingerprint: key.fingerprint,
				completionSecretHash: h(5),
			},
			config,
		),
	).toMatchObject({ kind: "applied" });
	expect(
		await base.store.redeemAuthLinkSessionWithBrowserTransaction(
			{ ...pins, binderHash: h(4), credentialHash: h(6) },
			config,
		),
	).toMatchObject({ kind: "issued" });
}
export async function fixture(
	authority: "device_claim" | "controller_attestation" = "device_claim",
	configOverrides: Partial<typeof defaultConfig> = {},
	fixtureOptions: { install?: boolean } = {},
) {
	const config = { ...defaultConfig, ...configOverrides };
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	const clock = { now: NOW };
	const base = setupStore("SQLite", { authClock: () => clock.now });
	databases.push(base.db);
	vi.spyOn(base.store, "close").mockResolvedValue(undefined);
	const key = keypair();
	await seedBirth(base, key, authority, config);
	const backend: AuthLinkBackend = {
		async first<T>({ sql, values }: Parameters<AuthLinkBackend["first"]>[0]) {
			return (base.db.prepare(sql).get(...values) as T | undefined) ?? null;
		},
		run: async ({ sql, values }) => base.db.prepare(sql).run(...values).changes,
		batch: async (statements) =>
			base.db.transaction(() => {
				for (const { sql, values } of statements) base.db.prepare(sql).run(...values);
			})(),
	};
	if (fixtureOptions.install !== false) await applyAccountConnectionSchema(backend);
	const operations = new AccountChangeOperations(backend, () => clock.now);
	const http = httpFixture(base, backend, operations, key, config);
	const snapshot = () =>
		(
			base.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
				name: string;
			}[]
		)
			.filter(({ name }) => name !== "request_nonces")
			.map(({ name }) => [name, base.db.prepare(`SELECT * FROM "${name}"`).all()]);
	return {
		...base,
		...http,
		key,
		snapshot,
		prepare: (intent: "refresh" | "disconnect") =>
			prepareChange(operations, http.send, config, intent),
		config,
		clock,
	};
}
function httpFixture(
	base: ReturnType<typeof setupStore>,
	backend: AuthLinkBackend,
	operations: AccountChangeOperations,
	key: ReturnType<typeof keypair>,
	config: typeof defaultConfig,
) {
	// Full schema installation and the actual checker on an isolated in-memory database.
	const assertReady = async () => {
		if ((await readConnectionSchemaState(backend)) !== "ready")
			throw new Error("schema unsupported");
	};
	const options: CreateCoordinatorAppOptions = {
		storeFactory: () => base.store,
		runtime: { adminSecret: () => null, now: () => new Date(NOW).toISOString() },
		requestVerifier: (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		accountChanges: {
			config,
			storeFactory: () => base.store,
			assertReady,
			operationsFactory: () => operations,
		},
	};
	const app = createCoordinatorApp(options);
	const send = (method: string, path: string, data?: unknown, signingKey = key) => {
		const body = data === undefined ? "" : JSON.stringify(data);
		return app.request(`${new URL(config.redirectUri).origin}${path}`, {
			method,
			headers: headers(signingKey, method, path, body),
			...(body ? { body } : {}),
		});
	};
	const finalBody = (extra: Record<string, unknown> = {}) => ({
		purpose: AUTH_ACCOUNT_CHANGE_PURPOSE,
		coordinator_id: config.coordinatorId,
		attempt_id: "change-a",
		group_id: "group-a",
		identity_id: "identity-a",
		device_id: key.deviceId,
		fingerprint: key.fingerprint,
		runtime_verifier: runtimeVerifier,
		completion,
		...extra,
	});
	const statusPath = (extra: Record<string, string> = {}) =>
		`${ROOT}/change-a?${new URLSearchParams({ ...statusPins(), ...extra })}`;
	return { app, send, options, finalBody, statusPath };
}
async function prepareChange(
	operations: AccountChangeOperations,
	send: ReturnType<typeof httpFixture>["send"],
	config: typeof defaultConfig,
	intent: "refresh" | "disconnect",
) {
	expect((await send("POST", ROOT, createBody({ intent }))).status).toBe(200);
	const material = {
		attemptId: "change-a",
		browserStartHash: h(51),
		stateHash: h(52),
		binderHash: h(53),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	expect(await operations.claimBrowser(material, config)).toBe(true);
	expect(await operations.consumeCallback(material, config)).not.toBeNull();
	// Trusted synthetic provider output, not a mocked HTTP verifier or live provider claim.
	expect(
		await operations.recordVerifiedCallback(
			{
				...material,
				issuer: config.issuer,
				subject: "account-A",
				profile: { displayName: "Refreshed" },
				completionSecretHash: hash(completion),
			},
			config,
		),
	).toBe(true);
	if (intent === "disconnect")
		expect(
			await operations.confirmDisconnect(
				{ ...material, completionSecretHash: hash(completion) },
				config,
			),
		).toBe(true);
}
