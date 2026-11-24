import type { Context, Hono } from "hono";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { DeviceAuthLinkDeps } from "./coordinator-device-auth-link.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";

export const DEVICE_REJOIN_EVENTS_PATH = "/v1/auth/rejoin-events";
type Deps = Pick<
	DeviceAuthLinkDeps,
	| "authorizeRequest"
	| "authErrorStatus"
	| "config"
	| "rateLimitedResponse"
	| "readRequestBytes"
	| "storeFactory"
>;
type Event = { event_id: string; device_id: string; group_ids: string[]; finalized_at_ms: number };

const EVENTS_SQL = `WITH input(coordinator_id, group_id, device_id, public_key, fingerprint, key_id, after_id)
AS (VALUES (?, ?, ?, ?, ?, ?, ?)), caller AS (
	SELECT b.identity_id FROM input i JOIN enrolled_devices e
	  ON e.group_id = i.group_id AND e.device_id = i.device_id AND e.public_key = i.public_key
	  AND e.fingerprint = i.fingerprint AND e.key_id = i.key_id AND e.enabled = 1
	JOIN groups g ON g.group_id = e.group_id AND g.archived_at IS NULL
	JOIN coordinator_device_ownership_bindings b
	  ON b.device_id = e.device_id AND b.key_id = e.key_id AND b.coordinator_id = i.coordinator_id
	WHERE NOT EXISTS (SELECT 1 FROM coordinator_device_revocations r
	    WHERE (r.subject_kind = 'device_id' AND r.subject_value = e.device_id)
	      OR (r.subject_kind = 'ed25519_key' AND r.subject_value = e.key_id))
), cursor AS (
	SELECT l.event_id, l.finalized_at_ms FROM input i CROSS JOIN caller
	JOIN coordinator_device_rejoin_audit_log l
	  ON l.coordinator_id = i.coordinator_id AND l.identity_id = caller.identity_id AND l.event_id = i.after_id
)
SELECT l.event_id, l.device_id, l.finalized_at_ms,
	json_extract(a.final_receipt_json, '$.group_ids') AS group_ids_json
FROM input i CROSS JOIN caller JOIN coordinator_device_rejoin_audit_log l
  ON l.coordinator_id = i.coordinator_id AND l.identity_id = caller.identity_id
JOIN coordinator_device_rejoin_attempts a ON a.coordinator_id = l.coordinator_id
  AND a.attempt_id = l.attempt_id AND a.state = 'finalized'
  AND a.identity_id = l.identity_id AND a.device_id = l.device_id
  AND a.binding_id = l.binding_id AND a.finalized_at_ms = l.finalized_at_ms
WHERE i.after_id IS NULL OR EXISTS (SELECT 1 FROM cursor c
	WHERE (l.finalized_at_ms, l.event_id) > (c.finalized_at_ms, c.event_id))
ORDER BY l.finalized_at_ms, l.event_id LIMIT 50`;

function eventQuery(url: URL) {
	const ids = url.searchParams.getAll("group_id");
	const cursors = url.searchParams.getAll("after");
	const [groupId] = ids;
	const [after = null] = cursors;
	if (
		ids.length !== 1 ||
		!isAuthControllerId(groupId) ||
		cursors.length > 1 ||
		(after !== null && !isAuthControllerId(after)) ||
		[...url.searchParams.keys()].some((key) => key !== "group_id" && key !== "after")
	)
		return null;
	return { groupId, after };
}

function page(c: Context, items: Event[] = [], after: string | null = null) {
	return c.json({ items, next_cursor: items.at(-1)?.event_id ?? after });
}

async function readPage(c: Context, deps: Deps, query: NonNullable<ReturnType<typeof eventQuery>>) {
	const { groupId, after } = query;
	const store = deps.storeFactory();
	try {
		const auth = await deps.authorizeRequest(store, {
			method: c.req.method,
			url: c.req.url,
			groupId,
			body: new Uint8Array(),
			deviceId: c.req.header("X-Opencode-Device") ?? null,
			signature: c.req.header("X-Opencode-Signature") ?? null,
			timestamp: c.req.header("X-Opencode-Timestamp") ?? null,
			nonce: c.req.header("X-Opencode-Nonce") ?? null,
		});
		const enrollment = auth.enrollment;
		if (!auth.ok || !enrollment) {
			return (
				deps.rateLimitedResponse(c, DEVICE_REJOIN_EVENTS_PATH, { authenticated: false }) ??
				c.json({ error: auth.error }, deps.authErrorStatus(auth.error))
			);
		}
		const limited = deps.rateLimitedResponse(c, enrollment.device_id, { authenticated: true });
		if (limited) return limited;
		const keyId = await ed25519KeyId(enrollment.public_key);
		if (!keyId) return page(c, [], after);
		const backend = await store.readDeviceRejoinBackend?.();
		if (!backend?.all) return c.json({ error: "not_found" }, 404);
		const rows = await backend.all<Omit<Event, "group_ids"> & { group_ids_json: string }>({
			sql: EVENTS_SQL,
			values: [
				deps.config.coordinatorId,
				groupId,
				enrollment.device_id,
				enrollment.public_key,
				enrollment.fingerprint,
				keyId,
				after,
			],
		});
		return page(
			c,
			rows.map(({ group_ids_json, ...row }) => ({
				...row,
				group_ids: JSON.parse(group_ids_json) as string[],
			})),
			after,
		);
	} finally {
		await store.close();
	}
}

export function registerDeviceRejoinEvents(app: Hono, deps: Deps): void {
	if (!deps.config.enabled || !isAuthControllerId(deps.config.coordinatorId)) return;
	const origin = new URL(deps.config.redirectUri).origin;
	app.get(DEVICE_REJOIN_EVENTS_PATH, async (c) => {
		c.header("Cache-Control", "no-store");
		c.header("Referrer-Policy", "no-referrer");
		const url = new URL(c.req.url);
		const query = eventQuery(url);
		if (!query || url.origin !== origin) return c.json({ error: "invalid_input" }, 400);
		if ((await deps.readRequestBytes(c, 1))?.length !== 0)
			return c.json({ error: "invalid_input" }, 400);
		try {
			return await readPage(c, deps, query);
		} catch {
			return c.json({ error: "device_rejoin_events_unavailable" }, 503);
		}
	});
}
