import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";
import type { BrowserContext } from "@playwright/test";
import preact from "@preact/preset-vite";
import { build } from "vite";
import { accountOwnerAssociationDirectory } from "../../../core/src/account-owner-association-directory";
import { BetterSqliteCoordinatorStore } from "../../../core/src/better-sqlite-coordinator-store";
import { applyAccountConnectionSchema } from "../../../core/src/coordinator-account-connection-schema";
import { readCoordinatorAccountLinkStatus } from "../../../core/src/coordinator-account-link-status-client";
import { coordinatorAuthControllerReviewAction } from "../../../core/src/coordinator-actions";
import { createCoordinatorApp } from "../../../core/src/coordinator-api";
import type { AuthLinkBackend } from "../../../core/src/coordinator-auth-link";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "../../../core/src/coordinator-browser-auth-app";
import { importBrowserCsrfKey } from "../../../core/src/coordinator-browser-csrf";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "../../../core/src/coordinator-legacy-owner-resolution-schema";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionManifest,
} from "../../../core/src/coordinator-legacy-team-completion";
import {
	readCoordinatorResolvedAccountOwnerReceiptStatus,
	readCoordinatorResolvedAccountOwnerStatus,
} from "../../../core/src/coordinator-resolved-account-owner-status-client";
import { connect } from "../../../core/src/db";
import {
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
} from "../../../core/src/recipient-policy-identifiers";
import { deriveRecipientPolicyEffectiveDevicesFromDatabase } from "../../../core/src/recipient-policy-reconciliation";
import { createInMemoryRequestRateLimiter } from "../../../core/src/request-rate-limit";
import { MemoryStore } from "../../../core/src/store";
import { verifySignature } from "../../../core/src/sync-auth";
import { ensureDeviceIdentity, loadPublicKey } from "../../../core/src/sync-identity";
import { initTestSchema } from "../../../core/src/test-utils";
import { createAccountContextReader } from "../../../viewer-server/src/account/context";
import { createAccountGuard } from "../../../viewer-server/src/account/guard";
import { createAccountLinkRegistry } from "../../../viewer-server/src/account/link-registry";
import { createAccountOwnerRecoveryService } from "../../../viewer-server/src/account/owner-recovery-service";
import { accountOperationRoutes } from "../../../viewer-server/src/routes/account-operations";
import { accountOwnerRecoveryRoutes } from "../../../viewer-server/src/routes/account-owner-recovery";
import { accountStatusRoutes } from "../../../viewer-server/src/routes/account-status";
import { uiAliases } from "../../ui-aliases";

const { Hono } = createRequire(resolve(import.meta.dirname, "../../../viewer-server/package.json"))(
	"hono",
) as {
	Hono: new () => ReturnType<typeof createAccountGuard>["routes"];
};
const ORIGIN = "https://coordinator.example.test";
const GROUPS = ["group-a", "group-b"];
const ADMIN = "synthetic-recovery-admin";
const PROJECT = "https://example.invalid/original.git";
type Remote = BetterSqliteCoordinatorStore;
type Device = { deviceId: string; publicKey: string; fingerprint: string };
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

function backendFor(store: Remote): AuthLinkBackend {
	return {
		first: async <T>({ sql, values }: Parameters<AuthLinkBackend["first"]>[0]) =>
			(store.db.prepare(sql).get(...values) as T | undefined) ?? null,
		run: async ({ sql, values }) => store.db.prepare(sql).run(...values).changes,
		batch: async (statements) =>
			store.db.transaction(() => {
				for (const { sql, values } of statements) store.db.prepare(sql).run(...values);
			})(),
	};
}

// Seed a genuine canonical linked owner using ordinary birth storage. No Vitest,
// external provider, fake status response, or retained resolution is involved.
async function seedOwner(
	store: Remote,
	device: Device,
	config: {
		coordinatorId: string;
		issuer: string;
		revision: string;
		enabled: boolean;
		redirectUri: string;
	},
) {
	await store.createGroup("retained-source");
	await store.enrollDevice("retained-source", device);
	assert.equal(
		(
			await store.createAuthControllerAttestation({
				...device,
				groupId: "retained-source",
				identityId: "identity-a",
				coordinatorId: config.coordinatorId,
				attestationId: "original-controller",
				reviewReceiptId: "original-receipt",
				evidenceDigest: "a".repeat(64),
			})
		).kind,
		"created",
	);
	const signer = { ...device, groupId: "retained-source" };
	assert.equal(
		(
			await store.createAuthLinkAttempt(
				{
					attemptId: "original-birth",
					signer,
					authority: { kind: "controller_attestation" },
					runtimeVerifierHash: hash("runtime"),
					browserStartHash: hash("browser"),
					loopbackRedirect: "http://127.0.0.1:4567/codemem/auth/complete",
				},
				config,
			)
		).kind,
		"created",
	);
	const browser = {
		purpose: "link" as const,
		attemptId: "original-birth",
		browserStartHash: hash("browser"),
		stateHash: hash("state"),
		binderHash: hash("binder"),
		nonce: "n".repeat(43),
		pkceVerifier: "p".repeat(43),
	};
	assert.equal((await store.startAuthBrowserTransaction(browser, config)).kind, "started");
	const consumed = await store.consumeAuthBrowserTransaction(browser, config);
	assert.equal(consumed.kind, "consumed");
	if (consumed.kind !== "consumed") throw new Error("Missing synthetic birth transaction");
	const pins = {
		attemptId: browser.attemptId,
		browserTransactionHash: consumed.browserTransactionHash,
	};
	assert.equal(
		(
			await store.recordAuthLinkOidcVerified(
				{
					...pins,
					account: { issuer: config.issuer, subject: "synthetic-account-A" },
					profile: {
						displayName: "Canonical A profile",
						email: "a@example.test",
						emailVerified: true,
					},
				},
				config,
			)
		).kind,
		"applied",
	);
	assert.equal(
		(
			await store.confirmAuthLinkAttempt(
				{ ...pins, completionSecretHash: hash("completion") },
				config,
			)
		).kind,
		"applied",
	);
	assert.equal(
		(
			await store.finalizeAuthLinkAttempt(
				{
					attemptId: browser.attemptId,
					signer,
					runtimeVerifierHash: hash("runtime"),
					completionSecretHash: hash("completion"),
					purpose: "coordinator-account-link-v1",
					coordinatorId: config.coordinatorId,
					groupId: signer.groupId,
					identityId: "identity-a",
					deviceId: device.deviceId,
					fingerprint: device.fingerprint,
				},
				config,
			)
		).kind,
		"applied",
	);
}

async function seedConflictingHistory(store: Remote, device: Device) {
	const now = new Date().toISOString();
	for (const [index, group] of GROUPS.entries()) {
		await store.createGroup(group);
		await store.enrollDevice(group, device);
		store.db
			.prepare(
				"UPDATE enrolled_devices SET identity_id='identity-b' WHERE group_id=? AND device_id=?",
			)
			.run(group, device.deviceId);
		const owner = index === 0 ? "identity-a" : "identity-b";
		const candidate = legacyTeamCandidateId(ORIGIN, group);
		const manifest = normalizeCoordinatorLegacyTeamCompletionManifest({
			version: 1,
			coordinator_id: ORIGIN,
			candidate_ref: candidate,
			candidate_digest: "a".repeat(64),
			team_id: deterministicPolicyTeamId(candidate),
			team_digest: "b".repeat(64),
			source_digest: "c".repeat(64),
			finish_digest: "d".repeat(64),
			access_delta_digest: "e".repeat(64),
			team: {
				display_name: `Original ${group}`,
				policy_revision: "f".repeat(64),
				device_eligibility_mode: "reviewed_allowlist",
			},
			memberships: [{ identity_id: owner, role: "member" }],
			device_decisions: [
				{
					device_id: device.deviceId,
					key_fingerprint: device.fingerprint,
					enabled: true,
					identity_id: owner,
					decision: "included",
				},
			],
			project_mappings: [],
			project_recipients: [],
			completed_at: now,
		});
		store.db
			.prepare(
				"INSERT INTO coordinator_legacy_team_completions(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at) VALUES (?,?,1,?,?,?)",
			)
			.run(
				group,
				candidate,
				canonicalCoordinatorLegacyTeamCompletionManifestJson(manifest),
				now,
				now,
			);
	}
}

function seedLocal(store: MemoryStore, deviceId: string) {
	const now = new Date().toISOString();
	const session = store.getOrCreateSessionForOpencodeSession({
		opencodeSessionId: "original-browser-history",
		project: "original",
	});
	store.remember(session, "decision", "Original B memory", "Keep the original B author", 1, [], {});
	assert.equal(store.actorId, "identity-b");
	for (const [identity, name, local] of [
		["identity-a", "Known A", 0],
		["identity-b", "Original B", 1],
	] as const) {
		store.db
			.prepare(
				"INSERT INTO actors(actor_id,display_name,is_local,status,created_at,updated_at) VALUES (?,?,?,'active',?,?)",
			)
			.run(identity, name, local, now, now);
	}
	store.db
		.prepare(
			"INSERT INTO identity_devices(device_id,identity_id,display_name,status,provenance,revision,migration_state,assignment_version,idempotency_key,created_at,updated_at) VALUES (?,'identity-b','Original device','active','explicit','original','completed',1,'original-device',?,?)",
		)
		.run(deviceId, now, now);
	store.db
		.prepare(
			"INSERT INTO project_recipients(canonical_project_identity,recipient_kind,recipient_id,status,provenance,policy_revision,migration_state,idempotency_key,created_at,updated_at) VALUES (?,'identity','identity-b','active','explicit','original','completed','original-sharing',?,?)",
		)
		.run(PROJECT, now, now);
}

async function bundle(dir: string) {
	const entry = resolve(dir, "entry.ts");
	writeFileSync(
		entry,
		`import { mountRecipientPolicySharing } from ${JSON.stringify(resolve(import.meta.dirname, "../../src/tabs/recipient-policy-sharing.tsx"))}; mountRecipientPolicySharing(document.querySelector('main'), [], {version:1,identities:[],teams:[],teamMemberships:[],identityDevices:[],projectRecipients:[]});`,
	);
	const result = await build({
		configFile: false,
		root: resolve(import.meta.dirname, "../.."),
		logLevel: "error",
		resolve: { alias: uiAliases },
		plugins: [preact()],
		build: { write: false, lib: { entry, name: "RecoveryFixture", formats: ["iife"] } },
	});
	const output = Array.isArray(result) ? result[0] : result;
	if (!output || !("output" in output)) throw new Error("Missing browser bundle");
	return output.output
		.filter((chunk) => chunk.type === "chunk")
		.map((chunk) => chunk.code)
		.join("\n");
}

function serve(getApp: () => ReturnType<typeof createAccountGuard>["routes"]) {
	return async (req: IncomingMessage, res: ServerResponse) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const body = Buffer.concat(chunks);
			const response = await getApp().fetch(
				new Request(`http://${req.headers.host}${req.url}`, {
					method: req.method,
					headers: req.headers as Record<string, string>,
					...(body.length ? { body } : {}),
				}),
			);
			res.writeHead(response.status, {
				...Object.fromEntries(response.headers),
				"set-cookie": response.headers.getSetCookie(),
			});
			res.end(Buffer.from(await response.arrayBuffer()));
		} catch (error) {
			// Keep details in local test output; never echo them to the browser.
			console.error("Owner recovery browser fixture request failed", error);
			res.writeHead(500);
			res.end("Browser fixture request failed");
		}
	};
}

export async function recoveryFixture(browser: BrowserContext) {
	const dir = mkdtempSync(resolve(tmpdir(), "account-recovery-browser-"));
	const disposals: Array<() => void | Promise<void>> = [
		() => rmSync(dir, { recursive: true, force: true }),
	];
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async () => {
		throw new Error("External network forbidden");
	};
	const env = {
		HOME: dir,
		CODEMEM_DB: resolve(dir, "local.sqlite"),
		CODEMEM_KEYS_DIR: resolve(dir, "keys"),
		CODEMEM_CONFIG: resolve(dir, "config.json"),
		CODEMEM_SYNC_KEY_STORE: "file",
		CODEMEM_EMBEDDING_DISABLED: "1",
		CODEMEM_ACTOR_ID: undefined,
		CODEMEM_DEVICE_ID: undefined,
		CODEMEM_SYNC_COORDINATOR_URL: undefined,
		CODEMEM_SYNC_COORDINATOR_GROUP: undefined,
		CODEMEM_SYNC_COORDINATOR_GROUPS: undefined,
	};
	const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	// Reverse disposal restores HOME only after every service, socket and store closes.
	disposals.push(() => {
		globalThis.fetch = previousFetch;
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const close = async () => {
		for (const dispose of disposals.splice(0).reverse()) await dispose();
	};
	try {
		const associationDir = accountOwnerAssociationDirectory();
		assert.equal(process.env.HOME, dir);
		const associationRelative = relative(dir, associationDir);
		assert.ok(associationRelative && !associationRelative.startsWith(`..${sep}`));
		assert.equal(associationDir, resolve(dir, ".codemem", "account-owner-associations"));
		const associations = () => {
			assert.equal(accountOwnerAssociationDirectory(), associationDir);
			return [associationDir, dir].flatMap((directory) =>
				existsSync(directory)
					? readdirSync(directory)
							.filter((name) => name.includes(".account-owner-"))
							.sort()
							.map((name) => ({
								name: relative(dir, resolve(directory, name)),
								bytes: readFileSync(resolve(directory, name)),
							}))
					: [],
			);
		};
		const config = {
			enabled: true,
			coordinatorId: ORIGIN,
			revision: "a".repeat(64),
			issuer: "https://accounts.google.com",
			redirectUri: `${ORIGIN}/auth/callback`,
		};
		const profileConfig = {
			actor_id: "identity-b",
			sync_coordinator_url: ORIGIN,
			sync_coordinator_groups: GROUPS,
		};
		writeFileSync(env.CODEMEM_CONFIG, JSON.stringify(profileConfig));
		const dbPath = env.CODEMEM_DB,
			keysDir = env.CODEMEM_KEYS_DIR;
		const local = connect(dbPath);
		initTestSchema(local);
		const [deviceId] = ensureDeviceIdentity(local, { keysDir });
		const { fingerprint } = local.prepare("SELECT fingerprint FROM sync_device").get() as {
			fingerprint: string;
		};
		local.close();
		const publicKey = loadPublicKey(keysDir);
		assert.ok(publicKey);
		let memory = new MemoryStore(dbPath, { keysDir });
		disposals.push(() => memory.close());
		seedLocal(memory, deviceId);
		const remotePath = resolve(dir, "coordinator.sqlite");
		const store = new BetterSqliteCoordinatorStore(remotePath);
		disposals.push(() => store.close());
		await applyAccountConnectionSchema(backendFor(store));
		store.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
		await seedOwner(store, { deviceId, publicKey, fingerprint }, config);
		await seedConflictingHistory(store, { deviceId, publicKey, fingerprint });
		const browserAuth = await createCoordinatorBrowserAuth(
			captureCoordinatorBrowserAuthOptions({
				config: { ...config, clientId: "synthetic-client", clientSecret: "synthetic-secret" },
				csrfKey: await importBrowserCsrfKey(randomBytes(32)),
				oidcOptions: {
					fetch: async (url) => {
						if (url !== `${config.issuer}/.well-known/openid-configuration`)
							throw new Error("External provider forbidden");
						return Response.json({
							issuer: config.issuer,
							authorization_endpoint: `${config.issuer}/authorize`,
							token_endpoint: `${config.issuer}/token`,
							jwks_uri: `${config.issuer}/jwks`,
							response_types_supported: ["code"],
							subject_types_supported: ["public"],
							id_token_signing_alg_values_supported: ["RS256"],
							token_endpoint_auth_methods_supported: ["client_secret_post"],
						});
					},
				},
			}),
			store,
			createInMemoryRequestRateLimiter(),
		);
		if (!browserAuth.ok) throw new Error(`Missing browser auth: ${browserAuth.error}`);
		const coordinator = createCoordinatorApp({
			storeFactory: () => new BetterSqliteCoordinatorStore(remotePath),
			runtime: { adminSecret: () => ADMIN, now: () => new Date().toISOString() },
			requestVerifier: (input) =>
				verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
			browserAuth: {
				kind: "ready",
				auth: browserAuth.auth,
				storeFactory: () => new BetterSqliteCoordinatorStore(remotePath),
				clientKey: () => "synthetic-recovery",
			},
		});
		const requests: Request[] = [];
		let receiptUnavailable = false;
		const transport: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			if (url.origin !== ORIGIN) throw new Error("Unexpected external runtime origin");
			requests.push(request.clone());
			const response = await coordinator.fetch(request);
			// Fault injection drops only a real signed receipt response after the app
			// processed it. Neither successful proof nor failed DTOs are fabricated.
			if (receiptUnavailable && url.pathname === "/v1/auth/resolved-account-owner-receipt-status")
				throw new TypeError("Synthetic lost receipt response");
			return response;
		};
		globalThis.fetch = transport;
		const profile = { dbPath, deviceId, identityId: "identity-b", identityLabel: "Original B" };
		const readContext = createAccountContextReader({
			getProfile: () => profile,
			readConfig: () => profileConfig,
			configPath: env.CODEMEM_CONFIG,
			keysDir,
		});
		const address = { host: "127.0.0.1", port: 0 };
		const js = await bundle(dir);
		let services = composeViewer();
		disposals.push(async () => {
			await services.recovery.close();
			await services.registry.close();
		});
		const server = createServer(serve(() => services.app));
		server.listen(0, address.host);
		await once(server, "listening");
		disposals.push(async () => {
			server.closeAllConnections();
			await new Promise<void>((done) => server.close(() => done()));
		});
		address.port = (server.address() as AddressInfo).port;
		const viewerOrigin = `http://${address.host}:${address.port}`;
		const blocked: string[] = [];
		await browser.route("**/*", async (route) => {
			if (new URL(route.request().url()).origin !== viewerOrigin) {
				blocked.push(route.request().url());
				await route.abort("blockedbyclient");
			} else await route.continue();
		});
		disposals.push(async () => {
			await Promise.all(browser.pages().map((page) => page.close()));
			await browser.unrouteAll({ behavior: "wait" });
		});
		function composeViewer() {
			const registry = createAccountLinkRegistry({ readContext });
			const recovery = createAccountOwnerRecoveryService({
				readContext,
				registry,
				readAdminSecret: () => ADMIN,
				reviewOwner: (input) => coordinatorAuthControllerReviewAction(input),
				readRemoteStatus: (input) =>
					readCoordinatorAccountLinkStatus({ ...input, fetch: transport }),
				readRemoteOwnerStatus: (input) =>
					readCoordinatorResolvedAccountOwnerStatus({ ...input, fetch: transport }),
				readRemoteReceiptStatus: (input) =>
					readCoordinatorResolvedAccountOwnerReceiptStatus({ ...input, fetch: transport }),
			});
			const options = {
				readContext,
				registry,
				getListenerAddress: () => address,
				readRemoteStatus: (input: Parameters<typeof readCoordinatorAccountLinkStatus>[0]) =>
					readCoordinatorAccountLinkStatus({ ...input, fetch: transport }),
				readRemoteOwnerStatus: (
					input: Parameters<typeof readCoordinatorResolvedAccountOwnerStatus>[0],
				) => readCoordinatorResolvedAccountOwnerStatus({ ...input, fetch: transport }),
			};
			const guard = createAccountGuard(options),
				app = new Hono();
			app.use("/api/account/*", guard.middleware);
			app.route("/", guard.routes);
			app.route("/", accountStatusRoutes(options));
			app.route("/", accountOperationRoutes(options));
			app.route("/", accountOwnerRecoveryRoutes(recovery));
			app.get("/app.js", (c) => c.body(js, 200, { "Content-Type": "application/javascript" }));
			app.get("/", (c) =>
				c.html(
					'<!doctype html><html><body><main></main><script src="/app.js"></script></body></html>',
				),
			);
			return { app, registry, recovery };
		}
		const rows = (table: string) =>
			store.db
				.prepare(`SELECT * FROM ${table}`)
				.all()
				.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
		const localRows = (table: string) =>
			memory.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
		const preserved = () => ({
			local: [
				"sync_device",
				"actors",
				"memory_items",
				"sessions",
				"identity_devices",
				"policy_teams",
				"policy_team_memberships",
				"policy_team_device_decisions",
				"project_recipients",
			].map(localRows),
			remote: [
				"enrolled_devices",
				"coordinator_legacy_team_completions",
				"coordinator_identity_group_grants",
				"coordinator_device_ownership_bindings",
				"coordinator_auth_account_links",
				"coordinator_auth_controller_attestations",
				"coordinator_auth_device_claims",
				"coordinator_invites",
				"coordinator_auth_account_connection_history",
			].map(rows),
			keys: readdirSync(keysDir)
				.sort()
				.map((name) => [name, readFileSync(resolve(keysDir, name))]),
			config: readFileSync(env.CODEMEM_CONFIG),
			access: deriveRecipientPolicyEffectiveDevicesFromDatabase(memory.db, PROJECT),
		});
		return {
			viewerOrigin,
			rows,
			preserved,
			blocked,
			requests,
			confirmations: async () =>
				Promise.all(
					requests
						.filter(
							(request) => new URL(request.url).pathname === "/v1/admin/auth-controller-reviews",
						)
						.map((request) => request.clone().json() as Promise<Record<string, unknown>>),
				).then((bodies) =>
					bodies.filter((body) => Object.hasOwn(body, "confirm_owner_resolution_digest")),
				),
			associations,
			loseReceipt: () => {
				receiptUnavailable = true;
			},
			restoreReceipt: () => {
				receiptUnavailable = false;
			},
			restart: async () => {
				await services.recovery.close();
				await services.registry.close();
				memory.close();
				memory = new MemoryStore(dbPath, { keysDir });
				services = composeViewer();
			},
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
