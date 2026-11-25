import { createHash } from "node:crypto";
import {
	type MemoryStore,
	normalizeCoordinatorAccountLinkOrigin,
	readAccountLinkDevice,
	readCoordinatorDeviceRejoinEvents,
	readCoordinatorSyncConfig,
} from "@codemem/core";
import { type Context, Hono } from "hono";

const PATH = "/api/sync/devices/rejoin-events";
const HASH = /^[a-f0-9]{64}$/u;
type Options = { getStore: () => MemoryStore; readConfig?: typeof readCoordinatorSyncConfig };

function captureTarget(options: Options) {
	const config = (options.readConfig ?? readCoordinatorSyncConfig)();
	const origin = normalizeCoordinatorAccountLinkOrigin(config.syncCoordinatorUrl);
	const groups = [...new Set(config.syncCoordinatorGroups)].sort();
	if (!origin || !groups.length || groups.length > 25) return null;
	const store = options.getStore();
	const { deviceId, fingerprint } = readAccountLinkDevice(store.dbPath);
	if (deviceId !== store.deviceId) return null;
	const keysDir = process.env.CODEMEM_KEYS_DIR?.trim() || undefined;
	const scope = createHash("sha256")
		.update(JSON.stringify([origin, groups, deviceId, fingerprint]))
		.digest("hex");
	return { origin, groups, deviceId, fingerprint, dbPath: store.dbPath, scope, keysDir };
}

function isCurrentTarget(options: Options, target: NonNullable<ReturnType<typeof captureTarget>>) {
	const current = captureTarget(options);
	return (
		current?.scope === target.scope &&
		current.dbPath === target.dbPath &&
		current.keysDir === target.keysDir
	);
}

function input(query: URLSearchParams) {
	const [scope] = query.getAll("scope");
	const [after] = query.getAll("after");
	if (
		[...query.keys()].some((key) => key !== "scope" && key !== "after") ||
		query.getAll("scope").length > 1 ||
		query.getAll("after").length > 1 ||
		(scope !== undefined && !HASH.test(scope)) ||
		(after !== undefined && (!scope || !after.trim() || after.length > 256))
	)
		return null;
	return { scope, after };
}

async function readEvents(
	c: Context,
	options: Options,
	query: NonNullable<ReturnType<typeof input>>,
) {
	const target = captureTarget(options);
	if (!target) return c.json(null);
	const after = query.scope === target.scope ? query.after : undefined;
	const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(10_000)]);
	for (const groupId of target.groups) {
		if (signal.aborted || !isCurrentTarget(options, target))
			return c.json({ error: "events_unavailable" }, 503);
		const result = await readCoordinatorDeviceRejoinEvents({
			dbPath: target.dbPath,
			coordinatorUrl: target.origin,
			keysDir: target.keysDir,
			groupId,
			expectedSigner: target,
			after,
			signal,
		});
		if (result.kind === "not_enrolled") continue;
		if (result.kind === "unsupported") return c.json(null);
		if (result.kind !== "page" || signal.aborted)
			return c.json({ error: "events_unavailable" }, 503);
		if (!isCurrentTarget(options, target)) return c.json({ error: "events_unavailable" }, 503);
		return c.json({
			scope: target.scope,
			localDeviceId: target.deviceId,
			items: result.items,
			nextCursor: result.nextCursor,
		});
	}
	return c.json(null);
}

/** The browser supplies only a cursor. The profile selects the coordinator, signer and groups. */
export function deviceRejoinEventRoutes(options: Options) {
	return new Hono().get(PATH, async (c) => {
		c.header("Cache-Control", "no-store");
		const query = input(new URL(c.req.url).searchParams);
		if (!query) return c.json({ error: "invalid_input" }, 400);
		try {
			return await readEvents(c, options, query);
		} catch {
			return c.json({ error: "events_unavailable" }, 503);
		}
	});
}
