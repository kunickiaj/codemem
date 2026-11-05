import type {
	D1DatabaseLike,
	InMemoryRequestRateLimiter,
} from "@codemem/core/internal/cloudflare-coordinator";
import { authenticate, readOwnerJsonRequest } from "./owner-admin.js";
import { provisionRelayAdmission } from "./relay-admission-setup.js";
import { captureRelayEnv, type RelayRealmConfig, readRelayConfig } from "./relay-config.js";
import { type RelayHealthWorkerEnv, startRelayHealth } from "./relay-health-link.js";
import type { RelayRealm } from "./relay-realm.js";

const RELAY_UPGRADE_PATH = /^\/v1\/relay\/([0-9a-f]{64})$/;
const REALM_ID = /^[0-9a-f]{64}$/;
export const RELAY_QUOTA_ADMIN_PATH = "/v1/admin/relay/quota";
export const RELAY_ADMISSION_ADMIN_PATH = "/v1/admin/relay/admission";

export interface RelayWorkerEnv extends RelayHealthWorkerEnv {
	readonly RELAY_REALM?: DurableObjectNamespace<RelayRealm>;
	readonly COORDINATOR_DB?: D1DatabaseLike;
}

function relayConfig(env: RelayWorkerEnv): RelayRealmConfig | null {
	return readRelayConfig(captureRelayEnv(env as Readonly<Record<string, unknown>>));
}

function json(value: Record<string, unknown>, status: number): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

/**
 * Hands a WebSocket upgrade on /v1/relay/<realmId> to that realm's object and
 * returns its response unchanged. Returns null for every other request, and for
 * every request while relay is off, so those stay with the coordinator. With relay
 * on, unknown realms and a missing binding get 404 before any object is named, so
 * callers cannot create objects.
 */
export function routeRelayUpgrade(
	request: Request,
	env: RelayWorkerEnv,
): Promise<Response> | Response | null {
	if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
		return null;
	const realmId = RELAY_UPGRADE_PATH.exec(new URL(request.url).pathname)?.[1];
	if (!realmId) return null;
	const config = relayConfig(env);
	// Relay off: the coordinator answers this path exactly as before.
	if (!config) return null;
	const namespace = env.RELAY_REALM;
	if (!namespace || !config.realms.has(realmId)) return new Response(null, { status: 404 });
	return namespace.get(namespace.idFromName(realmId)).fetch(request);
}

interface RelayAdminOptions {
	readonly adminSecret: string | null;
	readonly limiter: InMemoryRequestRateLimiter;
}

/**
 * Operator route that provisions and switches one realm's quota. Returns null
 * while relay is off, so the coordinator answers that path exactly as before.
 */
export function handleRelayQuotaAdmin(
	request: Request,
	env: RelayWorkerEnv,
	options: RelayAdminOptions,
): Promise<Response> | null {
	if (new URL(request.url).pathname !== RELAY_QUOTA_ADMIN_PATH) return null;
	const config = relayConfig(env);
	const namespace = env.RELAY_REALM;
	if (!config || !namespace) return null;
	return provisionRealmQuota(request, config, namespace, options).catch(() =>
		json({ error: "relay_quota_unavailable" }, 503),
	);
}

async function readQuotaRequest(
	request: Request,
): Promise<{ realmId: string; enabled: boolean } | null> {
	const body = await readOwnerJsonRequest(request).catch(() => null);
	if (!body || Object.keys(body).length !== 2) return null;
	const { realm_id: realmId, enabled } = body;
	if (typeof realmId !== "string" || !REALM_ID.test(realmId) || typeof enabled !== "boolean")
		return null;
	return { realmId, enabled };
}

/** Method, query, Origin, secret, rate limit and content type checks shared by relay admin routes. */
async function refuseAdminRequest(
	request: Request,
	options: RelayAdminOptions,
	limitKey: string,
): Promise<Response | null> {
	if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
	if (new URL(request.url).search || request.headers.has("Origin"))
		return json({ error: "invalid_request" }, 400);
	if (!(await authenticate(request, options.adminSecret)))
		return json({ error: "unauthorized" }, 401);
	if (!options.limiter.check(limitKey, 20).allowed) return json({ error: "rate_limited" }, 429);
	if (
		!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? "")
	)
		return json({ error: "invalid_content_type" }, 415);
	return null;
}

async function provisionRealmQuota(
	request: Request,
	config: RelayRealmConfig,
	namespace: DurableObjectNamespace<RelayRealm>,
	options: RelayAdminOptions,
): Promise<Response> {
	const refused = await refuseAdminRequest(request, options, "relay-quota-admin");
	if (refused) return refused;
	const input = await readQuotaRequest(request);
	if (!input) return json({ error: "invalid_request" }, 400);
	// Only configured realms are named, so this route cannot create arbitrary objects either.
	if (!config.realms.has(input.realmId)) return json({ error: "relay_not_configured" }, 404);
	const stub = namespace.get(namespace.idFromName(input.realmId));
	const result = await stub.provisionQuota(input.realmId, input.enabled);
	if (!result.ok)
		return json({ error: result.error }, result.error === "relay_quota_conflict" ? 409 : 404);
	return json({ realm_id: result.realmId, enabled: result.enabled }, 200);
}

/**
 * Operator route that writes the D1 admission policy, realm rows and budgets for
 * the relay config. It takes an empty JSON object, because every value comes
 * from config and the fixed budget profile. After a successful setup it arms the
 * relay health alarm, which writes readiness. Returns null while relay is off.
 */
export function handleRelayAdmissionSetup(
	request: Request,
	env: RelayWorkerEnv,
	options: RelayAdminOptions,
): Promise<Response> | null {
	if (new URL(request.url).pathname !== RELAY_ADMISSION_ADMIN_PATH) return null;
	const config = relayConfig(env);
	const db = env.COORDINATOR_DB;
	if (!config || !db) return null;
	return setupRelayAdmission(request, config, db, options, env).catch(() =>
		json({ error: "relay_admission_unavailable" }, 503),
	);
}

async function setupRelayAdmission(
	request: Request,
	config: RelayRealmConfig,
	db: D1DatabaseLike,
	options: RelayAdminOptions,
	env: RelayHealthWorkerEnv,
): Promise<Response> {
	const refused = await refuseAdminRequest(request, options, "relay-admission-admin");
	if (refused) return refused;
	const body = await readOwnerJsonRequest(request).catch(() => null);
	if (!body || Object.keys(body).length !== 0) return json({ error: "invalid_request" }, 400);
	const result = await provisionRelayAdmission(db, config);
	if (!result.ok) return json({ error: result.error }, 409);
	return json({ ...result.body, health: await startRelayHealth(env) }, 200);
}
