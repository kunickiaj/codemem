import type { Context, Hono, MiddlewareHandler } from "hono";
import type { DeviceAuthLinkDeps } from "./coordinator-device-auth-link.js";
import { InviteTokenRefusal } from "./coordinator-invite-token-seal.js";
import { INVITE_TOKEN_BACKFILL_MAX_ROWS } from "./coordinator-invite-token-storage.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";

export const INVITE_TOKEN_DIGESTS_PATH = "/v1/admin/invite-tokens/digests";
export const INVITE_TOKEN_LOOKUP_FLOOR_PATH = "/v1/admin/invite-tokens/lookup-floor";
export const INVITE_TOKEN_SEAL_PATH = "/v1/admin/invite-tokens/seal";
const DEFAULT_LIMIT = INVITE_TOKEN_BACKFILL_MAX_ROWS;

export interface InviteTokenRouteDeps
	extends Pick<DeviceAuthLinkDeps, "readRequestBytes" | "parseJsonObject" | "rateLimitedResponse"> {
	storeFactory(): CoordinatorStore;
	authorizeAdmin(secret: string | undefined): { ok: true } | { ok: false; error: string };
}

/**
 * Answers a request that invitation token storage refused with that refusal's
 * code and status, such as `409 invite_link_unavailable`. Register it before the
 * routes it covers.
 */
export const inviteTokenRefusals: MiddlewareHandler = async (c, next) => {
	await next();
	if (c.error instanceof InviteTokenRefusal)
		c.res = c.json({ error: c.error.code }, c.error.status);
};

/** `{}` or `{ "limit": n }` with 1 <= n <= the batch maximum; null for anything else. */
export function parseInviteTokenBackfillLimit(data: Record<string, unknown>): number | null {
	if (Object.keys(data).some((key) => key !== "limit")) return null;
	if (data.limit === undefined) return DEFAULT_LIMIT;
	const limit = data.limit;
	if (
		typeof limit !== "number" ||
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > INVITE_TOKEN_BACKFILL_MAX_ROWS
	)
		return null;
	return limit;
}

/** The response that refuses a request that is not the admin's, or null for the admin. */
function adminRefusal(c: Context, deps: InviteTokenRouteDeps): Response | null {
	const auth = deps.authorizeAdmin(c.req.header("X-Codemem-Coordinator-Admin"));
	if (!auth.ok)
		return (
			deps.rateLimitedResponse(c, c.req.path, { authenticated: false }) ??
			c.json({ error: auth.error }, 401)
		);
	return deps.rateLimitedResponse(c, "admin", { authenticated: true });
}

/** An admin request with a valid JSON object body, or the response that refuses it. */
async function adminBody(
	c: Context,
	deps: InviteTokenRouteDeps,
): Promise<Record<string, unknown> | Response> {
	const refused = adminRefusal(c, deps);
	if (refused) return refused;
	const raw = await deps.readRequestBytes(c, 4096);
	if (raw == null) return c.json({ error: "body_too_large" }, 413);
	return deps.parseJsonObject(raw) ?? c.json({ error: "invalid_json" }, 400);
}

/** An admin request with a valid batch size, or the response that refuses it. */
async function backfillLimit(c: Context, deps: InviteTokenRouteDeps): Promise<number | Response> {
	const data = await adminBody(c, deps);
	if (data instanceof Response) return data;
	return parseInviteTokenBackfillLimit(data) ?? c.json({ error: "invalid_input" }, 400);
}

/** Exactly `{ "min_serving_lookup_version": n }` with a safe integer n; null for anything else. */
function parseLookupFloor(data: Record<string, unknown>): number | null {
	const keys = Object.keys(data);
	if (keys.length !== 1 || keys[0] !== "min_serving_lookup_version") return null;
	const version = data.min_serving_lookup_version;
	return typeof version === "number" && Number.isSafeInteger(version) ? version : null;
}

/**
 * The lookup fence: GET reads what the database records, and POST records the
 * operator's confirmation that no build below `min_serving_lookup_version`
 * serves the database. The value only rises, never above this build's version.
 */
function registerLookupFloorRoutes(app: Hono, deps: InviteTokenRouteDeps): void {
	app.get(INVITE_TOKEN_LOOKUP_FLOOR_PATH, async (c) => {
		const refused = adminRefusal(c, deps);
		if (refused) return refused;
		const store = deps.storeFactory();
		try {
			// An admin request records this build's lookup version; anonymous requests never write.
			await store.recordInviteTokenLookupVersion();
			return c.json({ version: 1, ...(await store.inviteTokenLookupFence()) });
		} finally {
			await store.close();
		}
	});
	app.post(INVITE_TOKEN_LOOKUP_FLOOR_PATH, async (c) => {
		const data = await adminBody(c, deps);
		if (data instanceof Response) return data;
		const version = parseLookupFloor(data);
		if (version === null) return c.json({ error: "invalid_input" }, 400);
		const store = deps.storeFactory();
		try {
			return c.json({ version: 1, ...(await store.raiseInviteTokenLookupFloor(version)) });
		} finally {
			await store.close();
		}
	});
}

/** Registers an admin backfill route that runs one bounded batch per request. */
export function registerInviteTokenBackfillRoute(
	app: Hono,
	deps: InviteTokenRouteDeps,
	path: string,
	run: (store: CoordinatorStore, limit: number) => Promise<object>,
): void {
	app.post(path, async (c) => {
		const limit = await backfillLimit(c, deps);
		if (limit instanceof Response) return limit;
		const store = deps.storeFactory();
		try {
			return c.json({ version: 1, ...(await run(store, limit)) });
		} finally {
			await store.close();
		}
	});
}

/**
 * The admin-only invitation token routes: the lookup fence, and the backfills,
 * deploy steps that each run one bounded batch per request and report what
 * remains. The digest backfill gives invitations from before token digests their
 * digest and replaces join request token copies with their digest. The sealing
 * backfill seals invitations that still hold their token, once the floor is set.
 */
export function registerCoordinatorInviteTokenRoutes(app: Hono, deps: InviteTokenRouteDeps): void {
	registerLookupFloorRoutes(app, deps);
	registerInviteTokenBackfillRoute(app, deps, INVITE_TOKEN_DIGESTS_PATH, (store, limit) =>
		store.fillInviteTokenDigests(limit),
	);
	registerInviteTokenBackfillRoute(app, deps, INVITE_TOKEN_SEAL_PATH, (store, limit) =>
		store.sealStoredInviteTokens(limit),
	);
}
