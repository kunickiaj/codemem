/** Unpublished, opt-in operator pilot. Normal coordinator entrypoints are unchanged. */
import { createHmac, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BetterSqliteCoordinatorStore } from "../../packages/core/src/better-sqlite-coordinator-store.js";
import { createCoordinatorApp } from "../../packages/core/src/coordinator-api.js";
import { isAuthControllerId } from "../../packages/core/src/coordinator-auth-controller.js";
import type { AuthLinkBackend } from "../../packages/core/src/coordinator-auth-link.js";
import {
	captureCoordinatorBrowserAuthOptions,
	createCoordinatorBrowserAuth,
} from "../../packages/core/src/coordinator-browser-auth-app.js";
import { captureCoordinatorBrowserAuthConfig } from "../../packages/core/src/coordinator-browser-auth-config.js";
import { importBrowserCsrfKey } from "../../packages/core/src/coordinator-browser-csrf.js";
import type { CoordinatorOidcOptions } from "../../packages/core/src/coordinator-oidc.js";
import {
	initializeOwnerPilotProfile,
	runOwnerEnrollment,
} from "../../packages/core/src/coordinator-owner-enrollment-client.js";
import { COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL } from "../../packages/core/src/coordinator-owner-enrollment-commit.js";
import { createCoordinatorOwnerEnrollmentHttp } from "../../packages/core/src/coordinator-owner-enrollment-http.js";
import { createInMemoryRequestRateLimiter } from "../../packages/core/src/request-rate-limit.js";
import { verifySignature } from "../../packages/core/src/sync-auth.js";
import { fingerprintPublicKey } from "../../packages/core/src/sync-fingerprint.js";

type Phase = "link" | "owner";
type PilotState = {
	kind: "owner-pilot-v1";
	origin: string;
	coordinatorId: string;
	groupId: string;
};
const COMMAND_FLAGS: Record<string, readonly string[]> = {
	init: ["state", "origin", "coordinator-id", "group"],
	"init-device": ["profile", "name"],
	serve: ["state", "phase", "cert", "key", "bind"],
	"issue-grant": ["state", "device"],
	"enroll-b": ["profile", "coordinator", "group", "resume"],
};
const HELP = `Isolated owner pilot (not a production auth server)
  init --state DIR --origin HTTPS_ORIGIN --coordinator-id ID --group GROUP
  init-device --profile NEW_DIR [--name NAME]
  serve --state DIR --phase link|owner --cert CERT --key KEY [--bind PRIVATE_IP]
  issue-grant --state DIR --device REVIEWED_A_DEVICE_ID
  enroll-b --profile NEW_DIR --coordinator HTTPS_ORIGIN --group GROUP [--resume]

serve reads CODEMEM_OWNER_PILOT_CLIENT_ID, CODEMEM_OWNER_PILOT_CLIENT_SECRET,
and CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET from the operator's environment.
Device commands require CODEMEM_CONFIG=PROFILE_DIR/config.json.
No reset, cleanup, CA installation, or live-provider setup is performed.
The HTTPS origin must include an unprivileged port (1024-65535).
`;

function unavailable(): never {
	throw new Error("Owner pilot unavailable. Check the explicit isolated paths and operator setup.");
}
function text(value: string | undefined): string {
	if (
		!value ||
		value.trim() !== value ||
		value.length > 4096 ||
		/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	)
		return unavailable();
	return value;
}
function httpsOrigin(value: string): string {
	const url = new URL(text(value));
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	)
		return unavailable();
	return url.origin;
}
function identifier(value: string): string {
	if (!isAuthControllerId(value)) return unavailable();
	return value;
}
export function parseOwnerPilotArgs(argv: string[]) {
	const args = argv[0] === "--" ? argv.slice(1) : argv;
	const command = args[0] ?? "help";
	if (["help", "--help", "-h"].includes(command)) return { command: "help", flags: {} };
	const allowed = COMMAND_FLAGS[command];
	if (!allowed) return unavailable();
	const flags: Record<string, string> = {};
	for (let index = 1; index < args.length; index++) {
		const flag = args[index]?.replace(/^--/, "");
		if (!args[index]?.startsWith("--") || !flag || !allowed.includes(flag) || flag in flags)
			return unavailable();
		flags[flag] = flag === "resume" ? "true" : text(args[++index]);
	}
	return { command, flags };
}
function statePaths(directory: string) {
	const dir = resolve(text(directory));
	return {
		dir,
		marker: join(dir, "owner-pilot.json"),
		db: join(dir, "coordinator.sqlite"),
		revisionKey: join(dir, "revision.key"),
	};
}
function requirePrivatePath(path: string, directory = false): void {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) unavailable();
	if (directory && (stat.mode & 0o777) !== 0o700) unavailable();
}
export function readOwnerPilotState(directory: string): PilotState {
	const paths = statePaths(directory);
	requirePrivatePath(paths.dir, true);
	requirePrivatePath(paths.marker);
	requirePrivatePath(paths.db);
	requirePrivatePath(paths.revisionKey);
	if (
		(lstatSync(paths.revisionKey).mode & 0o777) !== 0o600 ||
		readFileSync(paths.revisionKey).length !== 32
	)
		return unavailable();
	const state = JSON.parse(readFileSync(paths.marker, "utf8")) as PilotState;
	if (state.kind !== "owner-pilot-v1" || httpsOrigin(state.origin) !== state.origin) unavailable();
	identifier(state.coordinatorId);
	identifier(state.groupId);
	return state;
}
export async function initializeOwnerPilotState(options: {
	stateDir: string;
	origin: string;
	coordinatorId: string;
	groupId: string;
}): Promise<PilotState> {
	const state: PilotState = {
		kind: "owner-pilot-v1",
		origin: httpsOrigin(options.origin),
		coordinatorId: identifier(options.coordinatorId),
		groupId: identifier(options.groupId),
	};
	const paths = statePaths(options.stateDir);
	mkdirSync(paths.dir, { mode: 0o700 });
	writeFileSync(paths.marker, JSON.stringify(state), { mode: 0o600, flag: "wx" });
	writeFileSync(paths.revisionKey, randomBytes(32), { mode: 0o600, flag: "wx" });
	const store = new BetterSqliteCoordinatorStore(paths.db);
	try {
		store.db.exec(COORDINATOR_OWNER_ENROLLMENT_AUDIT_SCHEMA_SQL);
		await store.createGroup(state.groupId, "Owner pilot discovery");
	} finally {
		await store.close();
	}
	return state;
}
function backend(store: BetterSqliteCoordinatorStore): AuthLinkBackend {
	return {
		first: async <T>(statement: Parameters<AuthLinkBackend["first"]>[0]) =>
			(store.db.prepare(statement.sql).get(...statement.values) as T | undefined) ?? null,
		run: async (statement) =>
			store.db
				.transaction(() => store.db.prepare(statement.sql).run(...statement.values).changes)
				.immediate(),
		batch: async (statements) => {
			store.db
				.transaction(() => {
					for (const statement of statements)
						store.db.prepare(statement.sql).run(...statement.values);
				})
				.immediate();
		},
	};
}
export async function createOwnerPilotHandler(options: {
	stateDir: string;
	phase: Phase;
	config: unknown;
	adminSecret: string;
	oidcOptions?: CoordinatorOidcOptions;
}) {
	const state = readOwnerPilotState(options.stateDir);
	const settings = captureCoordinatorBrowserAuthConfig(options.config);
	if (
		settings.kind !== "enabled" ||
		settings.publicOrigin !== state.origin ||
		settings.store.coordinatorId !== state.coordinatorId
	)
		return unavailable();
	if (settings.store.redirectUri !== `${state.origin}/auth/callback`) return unavailable();
	if (text(options.adminSecret).length < 32 || !["link", "owner"].includes(options.phase))
		return unavailable();
	const store = new BetterSqliteCoordinatorStore(statePaths(options.stateDir).db);
	try {
		return await composeHandler(options, state, store);
	} catch {
		await store.close();
		return unavailable();
	}
}
async function composeHandler(
	options: Parameters<typeof createOwnerPilotHandler>[0],
	state: PilotState,
	store: BetterSqliteCoordinatorStore,
) {
	const limiter = createInMemoryRequestRateLimiter();
	const oidcOptions: CoordinatorOidcOptions = options.oidcOptions ?? { fetch: providerFetch };
	const browser =
		options.phase === "link"
			? await createCoordinatorBrowserAuth(
					captureCoordinatorBrowserAuthOptions({
						config: options.config,
						csrfKey: await importBrowserCsrfKey(randomBytes(32)),
						oidcOptions,
					}),
					store,
					limiter,
				)
			: null;
	if (browser && !browser.ok) return unavailable();
	const owner =
		options.phase === "owner"
			? await createCoordinatorOwnerEnrollmentHttp({
					config: options.config,
					backend: backend(store),
					oidcOptions,
				})
			: null;
	const app = createCoordinatorApp({
		storeFactory: () => store,
		runtime: { adminSecret: () => options.adminSecret, now: () => new Date().toISOString() },
		requestVerifier: (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		requestRateLimit: { limiter },
		browserAuth: browser?.ok
			? {
					kind: "ready",
					auth: browser.auth,
					storeFactory: () => store,
					clientKey: (c) => c.env.trustedClientKey ?? null,
				}
			: undefined,
	});
	return {
		close: () => store.close(),
		handle: async (request: Request, trustedClientKey: string) => {
			const url = new URL(request.url);
			if (url.origin !== state.origin) return new Response("Unavailable", { status: 400 });
			if (owner && (url.pathname.startsWith("/auth/") || url.pathname.startsWith("/v1/auth/owner")))
				return owner.handle(request, trustedClientKey);
			return app.fetch(request, { trustedClientKey });
		},
	};
}
const providerFetch: NonNullable<CoordinatorOidcOptions["fetch"]> = (url, options) => {
	const body =
		options.body instanceof Uint8Array ? Uint8Array.from(options.body).buffer : options.body;
	return globalThis.fetch(url, { ...options, body });
};
function requireTls(): void {
	if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") unavailable();
}
function operatorConfig(state: PilotState, stateDir: string) {
	const config = {
		enabled: true,
		coordinatorId: state.coordinatorId,
		issuer: "https://accounts.google.com",
		redirectUri: `${state.origin}/auth/callback`,
		clientId: text(process.env.CODEMEM_OWNER_PILOT_CLIENT_ID),
		clientSecret: text(process.env.CODEMEM_OWNER_PILOT_CLIENT_SECRET),
	};
	return {
		...config,
		revision: createHmac("sha256", readFileSync(statePaths(stateDir).revisionKey))
			.update(JSON.stringify(config))
			.digest("hex"),
	};
}
function privateBind(value: string): string {
	if (!isIP(value)) return unavailable();
	if (value === "::1" || /^(?:fc|fd|fe80:)/i.test(value)) return value;
	const [a, b] = value.split(".").map(Number);
	if (
		a === 127 ||
		a === 10 ||
		(a === 192 && b === 168) ||
		(a === 172 && b !== undefined && b >= 16 && b <= 31) ||
		(a === 100 && b !== undefined && b >= 64 && b <= 127)
	)
		return value;
	return unavailable();
}
async function incomingRequest(message: IncomingMessage, origin: string): Promise<Request> {
	if (message.headers.host !== new URL(origin).host) return unavailable();
	const url = new URL(message.url ?? "/", origin);
	if (url.origin !== origin) return unavailable();
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of message) {
		length += chunk.length;
		if (length > 65536) return unavailable();
		chunks.push(Buffer.from(chunk));
	}
	const headers = new Headers();
	for (let i = 0; i < message.rawHeaders.length; i += 2)
		headers.append(message.rawHeaders[i] ?? "", message.rawHeaders[i + 1] ?? "");
	const method = message.method ?? "GET";
	if (["GET", "HEAD"].includes(method) && length) return unavailable();
	return new Request(url, { method, headers, body: length ? Buffer.concat(chunks) : undefined });
}
async function send(response: Response, target: ServerResponse): Promise<void> {
	target.statusCode = response.status;
	response.headers.forEach((value, name) => {
		if (name !== "set-cookie") target.setHeader(name, value);
	});
	const cookies = response.headers.getSetCookie();
	if (cookies.length) target.setHeader("Set-Cookie", cookies);
	target.end(Buffer.from(await response.arrayBuffer()));
}
export function ownerPilotListenPort(origin: string): number {
	const port = Number(new URL(httpsOrigin(origin)).port);
	if (!Number.isInteger(port) || port < 1024 || port > 65535) {
		throw new Error(
			"Use an explicit HTTPS port from 1024 to 65535 and register that exact callback URI.",
		);
	}
	return port;
}
async function serve(flags: Record<string, string>): Promise<void> {
	requireTls();
	const state = readOwnerPilotState(text(flags.state));
	const port = ownerPilotListenPort(state.origin);
	const phase = text(flags.phase);
	if (phase !== "link" && phase !== "owner") return unavailable();
	const host = privateBind(flags.bind ?? "127.0.0.1");
	const tls = { cert: readFileSync(text(flags.cert)), key: readFileSync(text(flags.key)) };
	const handler = await createOwnerPilotHandler({
		stateDir: flags.state as string,
		phase,
		config: operatorConfig(state, flags.state as string),
		adminSecret: text(process.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET),
	});
	const server = createServer(tls, async (incoming, outgoing) => {
		try {
			const request = await incomingRequest(incoming, state.origin);
			await send(await handler.handle(request, incoming.socket.remoteAddress ?? ""), outgoing);
		} catch {
			outgoing.statusCode = 400;
			outgoing.end("Pilot request unavailable.");
		}
	});
	server.on("error", () => {
		void handler.close();
		process.exitCode = 1;
	});
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => {
			server.close(() => {
				void handler.close();
			});
		});
	await new Promise<void>((ready, reject) => {
		server.once("error", reject);
		server.listen(port, host, ready);
	});
	console.log(
		JSON.stringify({
			ready: true,
			phase,
			origin: state.origin,
			coordinatorId: state.coordinatorId,
			groupId: state.groupId,
		}),
	);
}
async function issueGrant(flags: Record<string, string>) {
	const state = readOwnerPilotState(text(flags.state));
	const store = new BetterSqliteCoordinatorStore(statePaths(flags.state as string).db);
	try {
		const matches = store.db
			.prepare(
				`SELECT a.attestation_id FROM coordinator_auth_controller_attestations a
 JOIN enrolled_devices e ON e.group_id = a.group_id AND e.device_id = a.device_id
 AND e.public_key = a.public_key AND e.fingerprint = a.fingerprint
 WHERE a.coordinator_id = ? AND a.group_id = ? AND a.device_id = ? AND a.revoked_at IS NULL LIMIT 2`,
			)
			.pluck()
			.all(state.coordinatorId, state.groupId, identifier(text(flags.device)));
		if (matches.length !== 1 || typeof matches[0] !== "string") return unavailable();
		const result = await store.issueIdentityGroupGrantFromControllerAttestation({
			coordinatorId: state.coordinatorId,
			attestationId: matches[0],
		});
		if (result.kind === "rejected" || result.grant.group_id !== state.groupId) return unavailable();
		return result;
	} finally {
		await store.close();
	}
}
export async function runOwnerPilot(argv: string[]): Promise<void> {
	const { command, flags } = parseOwnerPilotArgs(argv);
	if (command === "help") {
		process.stdout.write(HELP);
		return;
	}
	if (command === "serve") return serve(flags);
	if (command === "init") {
		console.log(
			JSON.stringify(
				await initializeOwnerPilotState({
					stateDir: text(flags.state),
					origin: text(flags.origin),
					coordinatorId: text(flags["coordinator-id"]),
					groupId: text(flags.group),
				}),
			),
		);
		return;
	}
	if (command === "issue-grant") {
		console.log(JSON.stringify(await issueGrant(flags)));
		return;
	}
	if (command === "init-device") {
		const p = initializeOwnerPilotProfile(text(flags.profile), { displayName: flags.name });
		console.log(
			JSON.stringify({
				deviceId: p.deviceId,
				fingerprint: fingerprintPublicKey(p.publicKey),
				identityId: p.initialActorId,
			}),
		);
		return;
	}
	requireTls();
	if (!process.stderr.isTTY) return unavailable();
	const result = await runOwnerEnrollment({
		profileDir: text(flags.profile),
		coordinatorUrl: httpsOrigin(text(flags.coordinator)),
		groupId: text(flags.group),
		resume: flags.resume === "true",
		openBrowser: (url, device) => {
			process.stderr.write(
				`Device: ${device.deviceId}\nFingerprint: ${device.fingerprint}\nCompare these values on the confirmation page.\nOpen this private sign-in URL on this device; do not share or log it:\n${url}\n`,
			);
		},
	});
	console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	void runOwnerPilot(process.argv.slice(2)).catch(() => {
		process.stderr.write(
			"Owner pilot incomplete. Keep its isolated state and check the runbook before retrying.\n",
		);
		process.exitCode = 1;
	});
}
