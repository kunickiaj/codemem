import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	ensureDeviceIdentity,
	initTestSchema,
	loadPublicKey,
	MemoryStore,
	readCoordinatorAccountLinkStatus,
	readCoordinatorResolvedAccountOwnerStatus,
} from "@codemem/core";
import { afterEach, expect, it, vi } from "vitest";
import { retainAccountOwnerAssociation } from "../../../core/src/account-owner-association.js";
import {
	fixture as accountFixture,
	cleanupAccountChangeHttpFixtures,
	h,
	keypair,
	NOW,
} from "../../../core/src/coordinator-account-change-http-test-fixtures.js";
import { createCoordinatorApp } from "../../../core/src/coordinator-api.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "../../../core/src/coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "../../../core/src/coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "../../../core/src/coordinator-oidc-test-fixtures.js";
import { createInMemoryRequestRateLimiter } from "../../../core/src/request-rate-limit.js";
import { seedResolvedOwner } from "../../test/resolved-owner-test-fixture.js";
import { createAccountContextReader } from "../account/context.js";
import { createAccountLinkRegistry } from "../account/link-registry.js";
import { createApp } from "../index.js";

// Cases build a real signed coordinator (RSA OIDC keys, Ed25519 device key,
// SQLite) and make real signed requests: well under a second idle, but over 5s
// on a busy CI runner. These are correctness checks, not performance budgets.
vi.setConfig({ testTimeout: 15_000 });

// Compare digests: deep-equality on whole SQLite files took ~1s per call.
const dbDigest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const LOCAL = "http://127.0.0.1:7441";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
	cleanupAccountChangeHttpFixtures();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

async function seedOtherAccount(f: Awaited<ReturnType<typeof accountFixture>>) {
	// Independent B history in the same group, born via a different device claim.
	const key = keypair("device-b");
	await f.store.enrollDevice("group-a", key);
	const signer = {
		groupId: "group-a",
		deviceId: key.deviceId,
		publicKey: key.publicKey,
		fingerprint: key.fingerprint,
	};
	const birth = {
		attemptId: "birth-b",
		signer,
		authority: { kind: "device_claim" as const, identityId: "identity-b" },
		runtimeVerifierHash: h(101),
		browserStartHash: h(102),
		loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
	};
	expect(await f.store.createAuthLinkAttempt(birth, f.config)).toMatchObject({ kind: "created" });
	const browser = {
		purpose: "link" as const,
		attemptId: birth.attemptId,
		browserStartHash: h(102),
		stateHash: h(103),
		binderHash: h(104),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	expect(await f.store.startAuthBrowserTransaction(browser, f.config)).toMatchObject({
		kind: "started",
	});
	const bound = await f.store.resolveAuthLinkBrowserTransaction(
		{ attemptId: birth.attemptId, binderHash: h(104) },
		f.config,
	);
	if (!bound) throw new Error("Missing B browser binding");
	expect(await f.store.consumeAuthBrowserTransaction(browser, f.config)).toMatchObject({
		kind: "consumed",
	});
	const pins = { attemptId: birth.attemptId, ...bound };
	expect(
		await f.store.recordAuthLinkOidcVerified(
			{
				...pins,
				account: { issuer: f.config.issuer, subject: "account-B" },
				profile: { displayName: "Unrelated B" },
			},
			f.config,
		),
	).toMatchObject({ kind: "applied" });
	expect(
		await f.store.confirmAuthLinkAttempt({ ...pins, completionSecretHash: h(105) }, f.config),
	).toMatchObject({ kind: "applied" });
	expect(
		await f.store.finalizeAuthLinkAttempt(
			{
				...birth,
				purpose: "coordinator-account-link-v1",
				coordinatorId: f.config.coordinatorId,
				groupId: signer.groupId,
				identityId: "identity-b",
				deviceId: key.deviceId,
				fingerprint: key.fingerprint,
				completionSecretHash: h(105),
			},
			f.config,
		),
	).toMatchObject({ kind: "applied" });
}

async function configuredCoordinator(f: Awaited<ReturnType<typeof accountFixture>>) {
	const browser = await createCoordinatorBrowserAuth(
		captureCoordinatorBrowserAuthOptions({
			config: { ...f.config, clientId: PROVIDER.clientId, clientSecret: PROVIDER.clientSecret },
			csrfKey: await importBrowserCsrfKey(randomBytes(32)),
			oidcOptions: { fetch: oidcFixture({ issuer: f.config.issuer }).fetch },
		}),
		f.store,
		createInMemoryRequestRateLimiter({ now: () => NOW }),
	);
	if (!browser.ok) throw new Error(`Browser fixture failed: ${browser.error}`);
	return createCoordinatorApp({
		...f.options,
		browserAuth: {
			kind: "ready",
			auth: browser.auth,
			storeFactory: () => f.store,
			clientKey: () => "fixture-client",
		},
	});
}

async function scopeDevices(f: Awaited<ReturnType<typeof accountFixture>>, scopeId: string) {
	const result = await f.store.getScopeAuthorization({ groupId: "group-a", scopeId });
	if (result.kind !== "authorized") throw new Error(`Scope fixture failed: ${result.error}`);
	return result.members.map(({ membership }) => membership.device_id).sort();
}

async function seedScopes(f: Awaited<ReturnType<typeof accountFixture>>) {
	for (const [scopeId, deviceId] of [
		["team-a", "device-a"],
		["project-b", "device-b"],
	] as const) {
		await f.store.createScope({
			scopeId,
			label: scopeId,
			coordinatorId: f.config.coordinatorId,
			groupId: "group-a",
			membershipEpoch: 2,
			manifestIssuerDeviceId: "issuer-a",
			manifestHash: "manifest-a",
		});
		await f.store.grantScopeMembership({
			scopeId,
			deviceId,
			effectId: `grant:${scopeId}`,
			membershipEpoch: 2,
			manifestIssuerDeviceId: "issuer-a",
			manifestHash: "manifest-a",
		});
	}
}

function captureAsC(dbPath: string, keysDir: string, directory: string) {
	// C's existing memory label is historical B; owner A must never rewrite it.
	vi.stubEnv("CODEMEM_ACTOR_ID", "identity-b");
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "absent-config.json"));
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	const store = new MemoryStore(dbPath, { keysDir });
	try {
		const session = store.getOrCreateSessionForOpencodeSession({
			opencodeSessionId: "capture-c",
			project: "project-c",
		});
		const id = store.remember(session, "decision", "C capture", "Keep C as the author", 1, [], {});
		expect(store.actorId).toBe("identity-b");
		return id;
	} finally {
		store.close();
	}
}

async function fixture(options: { fact?: boolean } = {}) {
	for (const name of [
		"CODEMEM_ACTOR_ID",
		"CODEMEM_DEVICE_ID",
		"CODEMEM_SYNC_COORDINATOR_URL",
		"CODEMEM_SYNC_COORDINATOR_GROUP",
		"CODEMEM_SYNC_COORDINATOR_GROUPS",
	])
		vi.stubEnv(name, undefined);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	const f = await accountFixture("device_claim", { issuer: "https://accounts.google.com" });
	await seedOtherAccount(f);
	const directory = mkdtempSync(join(tmpdir(), "viewer-signed-owner-"));
	cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
	const dbPath = join(directory, "memory.sqlite"),
		keysDir = join(directory, "keys");
	const db = connect(dbPath);
	initTestSchema(db);
	const [deviceId] = ensureDeviceIdentity(db, { keysDir });
	const { fingerprint } = db.prepare("SELECT fingerprint FROM sync_device").get() as {
		fingerprint: string;
	};
	db.close();
	const memoryId = captureAsC(dbPath, keysDir, directory);
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new Error("Missing C profile key");
	const signer = { groupId: "group-a", deviceId, publicKey, fingerprint };
	const proof = await seedResolvedOwner(f, signer, options);
	const attestationId = proof.controller.attestation_id;
	const coordinatorUrl = new URL(f.config.redirectUri).origin;
	retainAccountOwnerAssociation(
		{
			dbPath,
			deviceId,
			publicKey,
			fingerprint,
			actorId: "identity-b",
			coordinatorUrl,
			coordinatorId: f.config.coordinatorId,
			groupId: "group-a",
		},
		{ ownerIdentityId: "identity-a", attestationId, reviewDigest: h(121) },
	);
	const config = {
		actor_id: "identity-b",
		sync_coordinator_url: coordinatorUrl,
		sync_coordinator_groups: ["group-a"],
	};
	const readContext = createAccountContextReader({
		getProfile: () => ({ dbPath, deviceId, identityId: "identity-b" }),
		readConfig: () => config,
		keysDir,
	});
	const coordinator = await configuredCoordinator(f);
	const requests: Request[] = [];
	const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		if (new URL(request.url).origin !== coordinatorUrl)
			throw new Error("Unexpected external request");
		requests.push(request.clone());
		return coordinator.request(request);
	});
	vi.stubGlobal("fetch", transport);
	const link = vi.fn(async () => {
		throw new Error("Unexpected owner mutation");
	});
	const registry = createAccountLinkRegistry({ readContext, link });
	cleanup.push(() => registry.close());
	const app = createApp({
		accountLink: {
			readContext,
			registry,
			getListenerAddress: () => ({ host: "127.0.0.1", port: 7441 }),
		},
	});
	const session = await app.request(`${LOCAL}/api/account/session`, {
		headers: { Host: "127.0.0.1:7441" },
	});
	expect(session.status).toBe(200);
	const { csrfToken } = await session.json();
	const headers = { Host: "127.0.0.1:7441", Origin: LOCAL, "X-Codemem-Account-Csrf": csrfToken };
	const read = () => app.request(`${LOCAL}/api/account/link-status`, { headers });
	return {
		...f,
		app,
		coordinator,
		coordinatorUrl,
		directory,
		dbPath,
		read,
		requests,
		readContext,
		deviceId,
		memoryId,
		attestationId,
		signer,
		headers,
		proof,
		keysDir,
		link,
	};
}

it("fixture control: checked resolution and real signed clients confirm A without ordinary A authority", async () => {
	// Arrange: the source is retained outside the current group, and current C stays weak.
	const f = await fixture();
	const before = f.snapshot();
	const localBefore = dbDigest(f.dbPath);
	const privateKeyBefore = readFileSync(join(f.keysDir, "device.key"));
	const publicKeyBefore = readFileSync(join(f.keysDir, "device.key.pub"));
	const input = {
		dbPath: f.dbPath,
		keysDir: f.keysDir,
		groupId: "group-a",
		coordinatorUrl: f.coordinatorUrl,
	};
	// Act: real local keys sign all requests and the coordinator verifies each signature.
	const actor = await readCoordinatorAccountLinkStatus({ ...input, identityId: "identity-b" });
	const ordinaryOwner = await readCoordinatorAccountLinkStatus({
		...input,
		identityId: "identity-a",
	});
	const resolvedOwner = await readCoordinatorResolvedAccountOwnerStatus({
		...input,
		ownerIdentityId: "identity-a",
	});
	// Assert: a proposed local association is insufficient; the persisted proof is independently readable.
	expect(actor).toMatchObject({
		kind: "status",
		status: { coordinatorId: f.config.coordinatorId },
	});
	expect(ordinaryOwner).toMatchObject({ kind: "status", status: { account: null } });
	if (ordinaryOwner.kind !== "status") throw new Error("Missing ordinary status control");
	expect(ordinaryOwner.status.state).not.toBe("linked");
	expect(resolvedOwner).toMatchObject({
		kind: "owner_status",
		status: {
			state: "owner_confirmed",
			ownerIdentity: "identity-a",
			profileState: "linked",
			profile: { displayName: "Birth" },
		},
	});
	expect(
		f.db
			.prepare("SELECT identity_id FROM enrolled_devices WHERE group_id='group-a' AND device_id=?")
			.get(f.deviceId),
	).toEqual({ identity_id: "identity-b" });
	expect(f.snapshot()).toEqual(before);
	expect(dbDigest(f.dbPath)).toBe(localBefore);
	expect(readFileSync(join(f.keysDir, "device.key"))).toEqual(privateKeyBefore);
	expect(readFileSync(join(f.keysDir, "device.key.pub"))).toEqual(publicKeyBefore);
	expect(f.db.prepare("SELECT * FROM request_nonces").all()).toHaveLength(3);
});

it("fixture control: local association alone leaves signed owner unconfirmed", async () => {
	// Arrange: retain the proposal and historical source, but do not commit an accepted resolution.
	const f = await fixture({ fact: false });
	const before = f.snapshot();
	// Act
	const result = await readCoordinatorResolvedAccountOwnerStatus({
		dbPath: f.dbPath,
		keysDir: f.keysDir,
		groupId: "group-a",
		coordinatorUrl: f.coordinatorUrl,
		ownerIdentityId: "identity-a",
	});
	// Assert
	expect(result).toMatchObject({
		kind: "owner_status",
		status: {
			state: "owner_unconfirmed",
			ownerIdentity: null,
			profileState: "unavailable",
			profile: null,
		},
	});
	expect(JSON.stringify(result)).not.toContain("Birth");
	expect(f.snapshot()).toEqual(before);
});

it("reads proven A through separate signed owner GET while ordinary C, A/B history and C authorship stay unchanged", async () => {
	// Arrange: A and B have independent device-claim births; C's memory actor remains C.
	const f = await fixture();
	await seedScopes(f);
	const before = f.snapshot();
	const localBefore = dbDigest(f.dbPath);
	const scopesBefore = await Promise.all([scopeDevices(f, "team-a"), scopeDevices(f, "project-b")]);
	// Act: the production viewer calls the production client; only HTTPS transport is in-process.
	const response = await f.read();
	const view = await response.json();
	// Assert: C and A are separately requested, signed and verified by the coordinator route.
	expect(response.status).toBe(200);
	expect(
		view,
		JSON.stringify({
			view,
			requests: f.requests.map((request) => request.url),
		}),
	).toMatchObject({
		local: { identityId: "identity-b", deviceId: f.deviceId },
		accountOwner: { identityId: "identity-a", memoryActorId: "identity-b" },
		remote: { kind: "not_checked" },
		ownerProjection: {
			kind: "resolved_account_owner",
			status: {
				version: 1,
				ownerIdentity: "identity-a",
				state: "owner_confirmed",
				profileState: "linked",
				profile: { displayName: "Birth" },
			},
		},
		canLink: false,
	});
	expect(f.requests.map((request) => new URL(request.url).pathname)).toEqual([
		"/v1/auth/account-link-status",
		"/v1/auth/resolved-account-owner-status",
	]);
	expect(
		f.requests.map(({ url }) => {
			const params = new URL(url).searchParams;
			return { actor: params.get("identity_id"), owner: params.get("owner_identity_id") };
		}),
	).toEqual([
		{ actor: "identity-b", owner: null },
		{ actor: null, owner: "identity-a" },
	]);
	expect(
		f.requests.every(
			(request) =>
				request.headers.get("X-Opencode-Device") === f.deviceId &&
				request.headers.has("X-Opencode-Signature"),
		),
	).toBe(true);
	expect(view).not.toHaveProperty("remote.authority");
	expect(view).not.toHaveProperty("ownerProjection.status.authority");
	expect(view).not.toHaveProperty("managementActions");
	expect(view).not.toHaveProperty("unlinkTarget");
	expect(f.snapshot()).toEqual(before);
	expect(scopesBefore).toEqual([["device-a"], ["device-b"]]);
	expect(await Promise.all([scopeDevices(f, "team-a"), scopeDevices(f, "project-b")])).toEqual(
		scopesBefore,
	);
	expect(dbDigest(f.dbPath)).toBe(localBefore);
	const local = connect(f.dbPath);
	try {
		expect(
			local.prepare("SELECT actor_id, body_text FROM memory_items WHERE id=?").get(f.memoryId),
		).toEqual({ actor_id: "identity-b", body_text: "Keep C as the author" });
	} finally {
		local.close();
	}
	expect(f.readContext()).toMatchObject({ context: { identityId: "identity-b" } });
	expect(f.link).not.toHaveBeenCalled();
});

it.each(["account_unlinked", "unavailable"] as const)(
	"keeps confirmed owner separate when the signed profile is %s",
	async (profileState) => {
		// Arrange: change current account/profile state without changing retained resolution proof.
		const f = await fixture();
		if (profileState === "account_unlinked")
			f.db
				.prepare(
					"UPDATE coordinator_auth_account_links SET revoked_at_ms=? WHERE identity_id='identity-a'",
				)
				.run(NOW + 1);
		else
			f.db.exec(
				"UPDATE coordinator_auth_link_attempts SET account_subject='wrong-generation' WHERE identity_id='identity-a'",
			);
		const before = f.snapshot();
		// Act
		const response = await f.read();
		const view = await response.json();
		// Assert
		expect(response.status).toBe(200);
		expect(view).toMatchObject({
			remote: { kind: "not_checked" },
			accountOwner: { identityId: "identity-a", memoryActorId: "identity-b" },
			ownerProjection: { status: { state: "owner_confirmed", profileState, profile: null } },
			canLink: false,
			blockedReason: "status_unavailable",
		});
		expect(view).not.toHaveProperty("managementActions");
		expect(view).not.toHaveProperty("unlinkTarget");
		expect(JSON.stringify(view)).not.toContain("Birth");
		expect(f.snapshot()).toEqual(before);
	},
);

it.each(["connect", "refresh", "disconnect"] as const)(
	"does not promote real signed owner projection to raw %s POST authority",
	async (intent) => {
		// Arrange: the valid display context differs from the actual actor's mutation context.
		const f = await fixture();
		const status = await f.read();
		const view = await status.json();
		const original = f.readContext();
		if (!("context" in original) || !original.context) throw new Error("Missing actor context");
		const before = f.snapshot();
		const requestCount = f.requests.length;
		// Act
		const responses = [];
		for (const contextId of [view.contextId, original.context.contextId])
			responses.push(
				await f.app.request(`${LOCAL}/api/account/link-operations`, {
					method: "POST",
					headers: { ...f.headers, "Content-Type": "application/json" },
					body: JSON.stringify({
						intent,
						contextId,
						groupId: "group-a",
						coordinatorId: f.config.coordinatorId,
						authority: "controller_attestation",
						...(intent === "disconnect" ? { expectedLinkId: "birth" } : {}),
					}),
				}),
			);
		// Assert: loopback/CSRF is valid, but neither context provides ordinary account authority.
		expect(view).toHaveProperty("ownerProjection.status.ownerIdentity", "identity-a");
		for (const response of responses) {
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "account_context_changed" });
		}
		expect(f.link).not.toHaveBeenCalled();
		expect(f.requests.slice(requestCount).every((request) => request.method === "GET")).toBe(true);
		expect(f.snapshot()).toEqual(before);
	},
);

it.each([
	"wrong-owner",
	"wrong-key",
	"disabled-device",
	"revoked-controller",
	"archived-group",
	"missing-fact",
])("hides account metadata after %s even with a real private association", async (mode) => {
	// Arrange: local evidence cannot override current remote authority or liveness.
	const f = await fixture({ fact: mode !== "missing-fact" });
	if (mode === "wrong-owner") {
		const path = join(
			f.directory,
			readdirSync(f.directory).find((name) => name.includes(".account-owner-")) ?? "absent",
		);
		writeFileSync(
			path,
			JSON.stringify({
				...JSON.parse(readFileSync(path, "utf8")),
				ownerIdentityId: "identity-b",
			}),
		);
	}
	if (mode === "disabled-device")
		f.db.prepare("UPDATE enrolled_devices SET enabled=0 WHERE device_id=?").run(f.deviceId);
	if (mode === "wrong-key")
		f.db
			.prepare("UPDATE enrolled_devices SET public_key=? WHERE device_id=?")
			.run(f.key.publicKey, f.deviceId);
	if (mode === "revoked-controller")
		f.db
			.prepare(
				"UPDATE coordinator_auth_controller_attestations SET revoked_at=? WHERE attestation_id=?",
			)
			.run(new Date(NOW).toISOString(), f.attestationId);
	if (mode === "archived-group")
		f.db
			.prepare("UPDATE groups SET archived_at=? WHERE group_id='group-a'")
			.run(new Date(NOW).toISOString());
	const before = f.snapshot();
	// Act
	const response = await f.read();
	const view = await response.json();
	// Assert
	expect(response.status).toBe(200);
	expect(view.canLink).toBe(false);
	expect(view).not.toHaveProperty("accountOwner");
	expect(view).not.toHaveProperty("ownerProjection");
	expect(view).not.toHaveProperty("managementActions");
	expect(view).not.toHaveProperty("unlinkTarget");
	expect(JSON.stringify(view)).not.toContain("Birth");
	expect(JSON.stringify(view)).not.toContain("Unrelated B");
	expect(f.snapshot()).toEqual(before);
});
