import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as httpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as httpsServer } from "node:https";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import type { BrowserContext } from "@playwright/test";
import preact from "@preact/preset-vite";
import { build } from "vite";
import { BetterSqliteCoordinatorStore } from "../../core/src/better-sqlite-coordinator-store";
import { applyAccountConnectionSchema } from "../../core/src/coordinator-account-connection-schema";
import {
	changeCoordinatorAccount,
	linkCoordinatorAccount,
} from "../../core/src/coordinator-account-link-runtime";
import { signAccountLinkRequest } from "../../core/src/coordinator-account-link-signer";
import {
	readCoordinatorAccountChangeCapabilities,
	readCoordinatorAccountLinkStatus,
} from "../../core/src/coordinator-account-link-status-client";
import { createCoordinatorApp } from "../../core/src/coordinator-api";
import type { AuthLinkBackend } from "../../core/src/coordinator-auth-link";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "../../core/src/coordinator-browser-auth-app";
import { importBrowserCsrfKey } from "../../core/src/coordinator-browser-csrf";
import type { CoordinatorOidcOptions } from "../../core/src/coordinator-oidc";
import { createInMemoryRequestRateLimiter } from "../../core/src/request-rate-limit";
import { verifySignature } from "../../core/src/sync-auth";
import { fingerprintPublicKey } from "../../core/src/sync-fingerprint";
import { initTestSchema, seedMixedScopeFixture } from "../../core/src/test-utils";
import type { AccountContextResult } from "../../viewer-server/src/account/context";
import { createAccountGuard } from "../../viewer-server/src/account/guard";
import { createAccountLinkRegistry } from "../../viewer-server/src/account/link-registry";
import { accountOperationRoutes } from "../../viewer-server/src/routes/account-operations";
import { accountStatusRoutes } from "../../viewer-server/src/routes/account-status";
import { uiAliases } from "../ui-aliases";

const Database = createRequire(resolve(import.meta.dirname, "../../core/package.json"))(
	"better-sqlite3",
) as new (
	path: string,
) => BetterSqliteCoordinatorStore["db"];
const { Hono } = createRequire(resolve(import.meta.dirname, "../../viewer-server/package.json"))(
	"hono",
) as { Hono: new () => ReturnType<typeof createAccountGuard>["routes"] };
const hash = (raw: string) =>
	createHash("sha256").update(Buffer.from(raw, "base64url")).digest("hex");
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((done) => {
		release = done;
	});
	return { promise, release };
}

// Synthetic OIDC provider only: real RSA tokens, nonce/PKCE and adapter verification.
// This does not import the Vitest fixture into Playwright's separate runner.
function provider(redirectUri: string) {
	const issuer = "https://accounts.google.com";
	const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const jwk = { ...keys.publicKey.export({ format: "jwk" }), kid: "browser-key", alg: "RS256" };
	const claims: Record<string, unknown> = {
		sub: "account-A",
		name: "Refreshed profile",
		email: "a@example.test",
		email_verified: true,
		picture: "https://lh3.googleusercontent.com/browser-avatar",
	};
	const codes = new Map<string, { nonce: string; challenge: string }>();
	const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
	const response = (value: unknown) =>
		new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
	const fetch: NonNullable<CoordinatorOidcOptions["fetch"]> = async (url, options) => {
		if (url === `${issuer}/.well-known/openid-configuration`)
			return response({
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				jwks_uri: `${issuer}/jwks`,
				response_types_supported: ["code"],
				subject_types_supported: ["public"],
				id_token_signing_alg_values_supported: ["RS256"],
				token_endpoint_auth_methods_supported: ["client_secret_post"],
			});
		if (url === `${issuer}/jwks`) return response({ keys: [jwk] });
		if (url !== `${issuer}/token` || !(options.body instanceof URLSearchParams))
			throw new Error("Unexpected provider transport");
		const form = options.body;
		const authorization = codes.get(form.get("code") ?? "");
		codes.delete(form.get("code") ?? "");
		if (
			!authorization ||
			form.get("redirect_uri") !== redirectUri ||
			form.get("client_id") !== "browser-client" ||
			form.get("client_secret") !== "browser-secret" ||
			createHash("sha256")
				.update(form.get("code_verifier") ?? "")
				.digest("base64url") !== authorization.challenge
		)
			throw new Error("Invalid synthetic authorization");
		const now = Math.floor(Date.now() / 1000);
		const input = `${encode({ alg: "RS256", kid: "browser-key" })}.${encode({ iss: issuer, aud: "browser-client", iat: now, exp: now + 600, nonce: authorization.nonce, ...claims })}`;
		return response({
			access_token: "browser-access",
			token_type: "Bearer",
			expires_in: 600,
			id_token: `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`,
		});
	};
	return {
		issuer,
		claims,
		fetch,
		authorize(url: URL) {
			const code = randomBytes(24).toString("base64url");
			codes.set(code, {
				nonce: url.searchParams.get("nonce") ?? "",
				challenge: url.searchParams.get("code_challenge") ?? "",
			});
			const callback = new URL(redirectUri);
			callback.searchParams.set("state", url.searchParams.get("state") ?? "");
			callback.searchParams.set("code", code);
			return callback;
		},
	};
}

function serve(getApp: () => { fetch(request: Request): Promise<Response> | Response }) {
	return async (req: IncomingMessage, res: ServerResponse) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			const body = Buffer.concat(chunks);
			const reply = await getApp().fetch(
				new Request(
					`${"encrypted" in req.socket && req.socket.encrypted ? "https" : "http"}://${req.headers.host}${req.url}`,
					{
						method: req.method,
						headers: req.headers as Record<string, string>,
						...(body.length ? { body } : {}),
					},
				),
			);
			res.writeHead(reply.status, {
				...Object.fromEntries(reply.headers),
				"set-cookie": reply.headers.getSetCookie(),
			});
			res.end(Buffer.from(await reply.arrayBuffer()));
		} catch {
			res.writeHead(500);
			res.end("Browser fixture request failed");
		}
	};
}

// Browser traffic uses local HTTPS/HTTP. Signed runtime traffic uses app.fetch
// with unchanged raw signatures and the actual Ed25519 verifier, not network TLS.
export async function fixture(browser: BrowserContext) {
	const root = resolve(import.meta.dirname, "../../../.tmp/account-browser");
	mkdirSync(root, { recursive: true });
	const dir = mkdtempSync(resolve(root, "fixture-"));
	const cleanup: (() => void | Promise<void>)[] = [
		() => rmSync(dir, { recursive: true, force: true }),
	];
	const close = async () => {
		for (const dispose of cleanup.reverse()) await dispose();
	};
	try {
		const keysDir = resolve(dir, "keys");
		mkdirSync(keysDir);
		execFileSync(
			"openssl",
			[
				"req",
				"-x509",
				"-newkey",
				"rsa:2048",
				"-nodes",
				"-keyout",
				resolve(dir, "tls.key"),
				"-out",
				resolve(dir, "tls.crt"),
				"-days",
				"1",
				"-subj",
				"/CN=127.0.0.1",
				"-addext",
				"subjectAltName=IP:127.0.0.1",
			],
			{ stdio: "ignore" },
		);
		const dbPath = resolve(dir, "local.sqlite");
		const local = new Database(dbPath);
		cleanup.push(() => {
			if (local.open) local.close();
		});
		initTestSchema(local);
		const keys = generateKeyPairSync("ed25519");
		const raw = Buffer.from(keys.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
		const kind = Buffer.from("ssh-ed25519");
		const wire = Buffer.alloc(8 + kind.length + raw.length);
		wire.writeUInt32BE(kind.length);
		kind.copy(wire, 4);
		wire.writeUInt32BE(raw.length, 4 + kind.length);
		raw.copy(wire, 8 + kind.length);
		const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
		const device = {
			deviceId: "device-a",
			publicKey,
			fingerprint: fingerprintPublicKey(publicKey),
		};
		writeFileSync(
			resolve(keysDir, "device.key"),
			keys.privateKey.export({ type: "pkcs8", format: "pem" }),
			{ mode: 0o600 },
		);
		writeFileSync(resolve(keysDir, "device.key.pub"), publicKey);
		const now = new Date().toISOString();
		local
			.prepare(
				"INSERT INTO sync_device (device_id, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?)",
			)
			.run(device.deviceId, publicKey, device.fingerprint, now);
		seedMixedScopeFixture(local, device.deviceId);
		local
			.prepare(
				"INSERT INTO actors (actor_id, display_name, is_local, created_at, updated_at) VALUES ('identity-a', 'Browser identity', 1, ?, ?)",
			)
			.run(now, now);
		const remotePath = resolve(dir, "coordinator.sqlite");
		const store = new BetterSqliteCoordinatorStore(remotePath);
		cleanup.push(() => {
			if (store.db.open) store.db.close();
		});
		const backend: AuthLinkBackend = {
			async first<T>({ sql, values }: Parameters<AuthLinkBackend["first"]>[0]) {
				return (store.db.prepare(sql).get(...values) as T | undefined) ?? null;
			},
			run: async ({ sql, values }) => store.db.prepare(sql).run(...values).changes,
			batch: async (statements) =>
				store.db.transaction(() => {
					for (const { sql, values } of statements) store.db.prepare(sql).run(...values);
				})(),
		};
		await store.createGroup("group-a");
		await store.enrollDevice("group-a", { ...device, identityId: "identity-a" });
		await store.createAuthControllerAttestation({
			...device,
			groupId: "group-a",
			identityId: "identity-a",
			coordinatorId: "coordinator-a",
			attestationId: "attestation-a",
			reviewReceiptId: "review-a",
			evidenceDigest: "9".repeat(64),
		});
		const grant = await store.issueIdentityGroupGrantFromControllerAttestation({
			coordinatorId: "coordinator-a",
			attestationId: "attestation-a",
		});
		if (grant.kind !== "created") throw new Error("Fixture sharing grant was not created");
		let app: ReturnType<typeof createCoordinatorApp>;
		const coordinator = httpsServer(
			{ key: readFileSync(resolve(dir, "tls.key")), cert: readFileSync(resolve(dir, "tls.crt")) },
			serve(() => app),
		);
		coordinator.listen(0, "127.0.0.1");
		await once(coordinator, "listening");
		cleanup.push(async () => {
			coordinator.closeAllConnections();
			await new Promise<void>((done) => coordinator.close(() => done()));
		});
		const origin = `https://127.0.0.1:${(coordinator.address() as AddressInfo).port}`;
		const oidc = provider(`${origin}/auth/callback`);
		const config = {
			enabled: true,
			coordinatorId: "coordinator-a",
			revision: "a".repeat(64),
			issuer: oidc.issuer,
			redirectUri: `${origin}/auth/callback`,
			clientId: "browser-client",
			clientSecret: "browser-secret",
		};
		const storeFactory = () => new BetterSqliteCoordinatorStore(remotePath);
		await applyAccountConnectionSchema(backend);
		const auth = await createCoordinatorBrowserAuth(
			captureCoordinatorBrowserAuthOptions({
				config,
				csrfKey: await importBrowserCsrfKey(randomBytes(32)),
				oidcOptions: { fetch: oidc.fetch },
			}),
			store,
			createInMemoryRequestRateLimiter(),
		);
		if (!auth.ok) throw new Error(`Production browser composition failed: ${auth.error}`);
		app = createCoordinatorApp({
			storeFactory,
			runtime: { adminSecret: () => null, now: () => new Date().toISOString() },
			requestVerifier: (input) =>
				verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
			browserAuth: {
				kind: "ready",
				auth: auth.auth,
				storeFactory,
				clientKey: () => "browser-fixture",
			},
		});
		const signed = async (path: string, value: unknown) => {
			const bodyBytes = Buffer.from(JSON.stringify(value));
			return app.fetch(
				new Request(`${origin}${path}`, {
					method: "POST",
					headers: {
						...signAccountLinkRequest({
							dbPath,
							keysDir,
							device,
							method: "POST",
							url: `${origin}${path}`,
							bodyBytes,
						}),
						"content-type": "application/json",
					},
					body: bodyBytes,
				}),
			);
		};
		// Seed an existing A link through original link storage and signed finalization.
		const proofRaw = randomBytes(32).toString("base64url");
		const created = await signed("/v1/auth/link-attempts", {
			group_id: "group-a",
			identity_id: "identity-a",
			authority: "controller_attestation",
			attempt_id: "genesis",
			runtime_verifier_hash: hash(proofRaw),
			browser_start_hash: hash(proofRaw),
			loopback_redirect: "http://127.0.0.1:4567/codemem/auth/complete",
		});
		if (created.status !== 201)
			throw new Error(`Genesis create ${created.status}: ${await created.text()}`);
		const material = {
			purpose: "link" as const,
			attemptId: "genesis",
			browserStartHash: hash(proofRaw),
			stateHash: "1".repeat(64),
			binderHash: "2".repeat(64),
			nonce: "n".repeat(43),
			pkceVerifier: "p".repeat(43),
		};
		await store.startAuthBrowserTransaction(material, config);
		const consumed = await store.consumeAuthBrowserTransaction(material, config);
		if (consumed.kind !== "consumed") throw new Error("Genesis consume failed");
		const proof = { attemptId: "genesis", browserTransactionHash: consumed.browserTransactionHash };
		await store.recordAuthLinkOidcVerified(
			{
				...proof,
				account: { issuer: config.issuer, subject: "account-A" },
				profile: {
					displayName: "Original profile",
					email: "original@example.test",
					emailVerified: true,
					pictureUrl: "https://lh3.googleusercontent.com/original-avatar",
				},
			},
			config,
		);
		await store.confirmAuthLinkAttempt({ ...proof, completionSecretHash: hash(proofRaw) }, config);
		const birthBody = {
			purpose: "coordinator-account-link-v1",
			coordinator_id: config.coordinatorId,
			attempt_id: "genesis",
			group_id: "group-a",
			identity_id: "identity-a",
			device_id: device.deviceId,
			fingerprint: device.fingerprint,
			runtime_verifier: proofRaw,
			completion: proofRaw,
		};
		const seeded = await signed("/v1/auth/link-attempts/genesis/finalize", birthBody);
		if (!seeded.ok) throw new Error(`Genesis finalize ${seeded.status}: ${await seeded.text()}`);
		const session = await store.redeemAuthLinkSessionWithBrowserTransaction(
			{ ...proof, binderHash: material.binderHash, credentialHash: "6".repeat(64) },
			config,
		);
		if (session.kind !== "issued") throw new Error("Genesis session unavailable");
		const allowed = new Set([origin]);
		const blocked: string[] = [];
		const browserPosts: string[] = [];
		const acknowledgement = gate();
		cleanup.push(acknowledgement.release);
		const finalized = gate();
		const finalRequests: Request[] = [];
		const unlinkRequests: Request[] = [];
		const providerHops: string[] = [];
		let hold = false;
		const transport: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			const url = new URL(request.url);
			if (url.origin !== origin) throw new Error("Unexpected runtime origin");
			if (
				request.method === "POST" &&
				["/v1/auth/account-changes", "/v1/auth/link-attempts"].includes(url.pathname)
			) {
				const body = await request.clone().json();
				allowed.add(new URL(body.loopback_redirect).origin);
			}
			const response = await app.fetch(request.clone());
			if(url.pathname === "/v1/auth/account-unlinks") unlinkRequests.push(request);
			if (url.pathname.endsWith("/finalize")) {
				finalRequests.push(request);
				if (!response.ok) throw new Error(`Signed finalization failed: ${response.status}`);
				finalized.release();
				if (hold) await acknowledgement.promise;
			}
			return response;
		};
		const context = {
			contextId: "context-a",
			groupId: "group-a",
			...device,
			identityId: "identity-a",
			identityLabel: "Browser identity",
			deviceLabel: "Browser device",
			dbPath,
			keysDir,
			coordinatorUrl: origin,
			fileIdentity: { dev: "1", ino: "2" },
		};
		let current = true;
		const readContext = (): AccountContextResult => ({
			setup: "ready",
			groups: ["group-a"],
			selectedGroupId: "group-a",
			coordinator: { origin },
			context: { ...context, ...(current ? {} : { contextId: "context-changed" }) },
		});
		const registry = createAccountLinkRegistry({
			readContext,
			change: (input) => changeCoordinatorAccount({ ...input, fetch: transport }),
			link: (input) => linkCoordinatorAccount({ ...input, fetch: transport }),
		});
		cleanup.push(() => registry.close());
		const address = { host: "127.0.0.1", port: 0 };
		const options = {
			getListenerAddress: () => address,
			readContext,
			registry,
			readRemoteStatus: (input: Parameters<typeof readCoordinatorAccountLinkStatus>[0]) =>
				readCoordinatorAccountLinkStatus({ ...input, fetch: transport }),
			readRemoteCapabilities: (
				input: Parameters<typeof readCoordinatorAccountChangeCapabilities>[0],
			) => readCoordinatorAccountChangeCapabilities({ ...input, fetch: transport }),
		};
		const guard = createAccountGuard(options);
		const viewerApp = new Hono();
		viewerApp.use("/api/account/*", guard.middleware);
		viewerApp.route("/", guard.routes);
		viewerApp.route("/", accountStatusRoutes(options));
		viewerApp.route("/", accountOperationRoutes(options));
		const entry = resolve(dir, "entry.ts");
		writeFileSync(
			entry,
			`import { mountRecipientPolicySharing } from ${JSON.stringify(resolve(import.meta.dirname, "../src/tabs/recipient-policy-sharing.tsx"))}; mountRecipientPolicySharing(document.querySelector('main'), [], {version:1,identities:[],teams:[],teamMemberships:[],identityDevices:[],projectRecipients:[]});`,
		);
		const bundle = await build({
			configFile: false,
			root: resolve(import.meta.dirname, ".."),
			logLevel: "error",
			resolve: { alias: uiAliases },
			plugins: [preact()],
			build: { write: false, lib: { entry, name: "AccountFixture", formats: ["iife"] } },
		});
		const output = Array.isArray(bundle) ? bundle[0] : bundle;
		if (!output || !("output" in output)) throw new Error("Unexpected browser bundle");
		const js = output.output
			.filter((chunk) => chunk.type === "chunk")
			.map((chunk) => chunk.code)
			.join("\n");
		viewerApp.get("/app.js", (c) => c.body(js, 200, { "Content-Type": "application/javascript" }));
		viewerApp.get("/", (c) =>
			c.html(
				'<!doctype html><html><body><main></main><script src="/app.js"></script></body></html>',
			),
		);
		const viewer = httpServer(serve(() => viewerApp));
		viewer.listen(0, "127.0.0.1");
		await once(viewer, "listening");
		cleanup.push(async () => {
			viewer.closeAllConnections();
			await new Promise<void>((done) => viewer.close(() => done()));
		});
		address.port = (viewer.address() as AddressInfo).port;
		const viewerOrigin = `http://127.0.0.1:${address.port}`;
		allowed.add(viewerOrigin);
		await browser.route("**/*", async (route) => {
			const url = new URL(route.request().url());
			if (route.request().method() === "POST" && url.origin === origin)
				browserPosts.push(url.pathname);
			if (url.origin === oidc.issuer && url.pathname === "/authorize") {
				providerHops.push(url.href);
				const callback = oidc.authorize(url);
				await route.fulfill({
					status: 200,
					headers: { "content-type": "text/html", "Cross-Origin-Opener-Policy": "same-origin" },
					body: `<!doctype html><h1>Synthetic provider authorization</h1><a href="${callback.href.replaceAll("&", "&amp;")}">Complete synthetic sign-in</a>`,
				});
				return;
			}
			if (!allowed.has(url.origin)) {
				blocked.push(url.origin);
				await route.abort("blockedbyclient");
				return;
			}
			await route.continue();
		});
		cleanup.push(async () => {
			acknowledgement.release();
			await registry.close();
			await Promise.all(browser.pages().map((page) => page.close()));
			await browser.unrouteAll({ behavior: "wait" });
		});
		const rows = (table: string) => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
		const preserved = () => ({
			keys: readFileSync(resolve(keysDir, "device.key"), "utf8"),
			local: local.prepare("SELECT * FROM sync_device").all(),
			identities: local.prepare("SELECT * FROM actors ORDER BY actor_id").all(),
			history: local.prepare("SELECT * FROM memory_items ORDER BY id").all(),
			sessions: local.prepare("SELECT * FROM sessions ORDER BY id").all(),
			grants: rows("coordinator_identity_group_grants"),
			owners: rows("coordinator_device_ownership_bindings"),
		});
		return {
			origin,
			viewerOrigin,
			store,
			rows,
			preserved,
			finalRequests,
			unlinkRequests,
			providerHops,
			signed,
			browserPosts,
			blocked,
			claims: oidc.claims,
			finalized: finalized.promise,
			hold: () => {
				hold = true;
			},
			release: acknowledgement.release,
			stale: () => {
				current = false;
			},
			status: () =>
				readCoordinatorAccountLinkStatus({
					dbPath,
					keysDir,
					coordinatorUrl: origin,
					groupId: "group-a",
					identityId: "identity-a",
					fetch: transport,
				}),
			oldSession: () => store.readAuthSession("6".repeat(64), config),
			replayBirth: () => signed("/v1/auth/link-attempts/genesis/finalize", birthBody),
			close,
		};
	} catch (error) {
		await close();
		throw error;
	}
}
