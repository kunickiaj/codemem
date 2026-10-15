import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AccountContext, AccountContextReader } from "../account/context.js";
import {
	type AccountLinkOperationV1,
	type AccountLinkRegistry,
	sameAuthority,
} from "../account/link-registry.js";
import {
	type AccountLinkViewV1,
	type AccountStatusOptions,
	readAccountStatus,
} from "../account/status.js";

type Options = AccountStatusOptions & {
	readContext: AccountContextReader;
	registry: AccountLinkRegistry;
};
const ROOT = "/api/account/link-operations";
function validString(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 256 &&
		value.trim() === value &&
		!/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)
	);
}
function noBody(request: Request): boolean {
	const length = request.headers.get("Content-Length");
	return (
		request.body === null &&
		(length === null || length === "0") &&
		!request.headers.has("Transfer-Encoding")
	);
}
/** Cap both bytes and elapsed time; cancellation must not wait on an uncooperative stream. */
async function readBody(request: Request, keys: string[]): Promise<Record<string, unknown> | null> {
	if (
		!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(
			request.headers.get("Content-Type") ?? "",
		)
	)
		return null;
	const reader = request.body?.getReader();
	if (!reader) return null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stop = () => {};
	try {
		const expired = new Promise<never>((_, reject) => {
			stop = () => reject(new Error("invalid body"));
			timer = setTimeout(stop, 10_000);
			request.signal.addEventListener("abort", stop, { once: true });
			if (request.signal.aborted) stop();
		});
		const bytes = new Uint8Array(1024);
		let length = 0;
		while (true) {
			const chunk = await Promise.race([reader.read(), expired]);
			if (chunk.done) break;
			if (length + chunk.value.byteLength > bytes.length) return null;
			bytes.set(chunk.value, length);
			length += chunk.value.byteLength;
		}
		const value: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
		);
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		const actual = Object.keys(value);
		if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return null;
		return value as Record<string, unknown>;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		request.signal.removeEventListener("abort", stop);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
function isCurrent(options: Options, operation: AccountLinkOperationV1): boolean {
	const fresh = options.readContext(operation.groupId);
	return (
		!("error" in fresh) &&
		fresh.setup === "ready" &&
		fresh.context?.groupId === operation.groupId &&
		fresh.context.contextId === operation.contextId
	);
}
async function startOperation(c: Context, options: Options): Promise<Response> {
	const body = await readBody(c.req.raw, ["groupId", "contextId"]);
	if (!body || !validString(body.groupId) || !validString(body.contextId))
		return c.json({ error: "account_invalid_request" }, 400);
	const initial = options.readContext(body.groupId);
	if ("error" in initial && initial.error === "account_group_not_configured")
		return c.json({ error: initial.error }, 400);
	if (
		"error" in initial ||
		initial.setup !== "ready" ||
		!initial.context ||
		initial.context?.contextId !== body.contextId
	)
		return c.json({ error: "account_context_changed" }, 409);
	// Preserve the complete authority checked by signed status, not just its public ID.
	const checkedContext = structuredClone(initial.context);
	const expectedLifecycleToken = options.registry.lifecycleToken();
	const view = await readAccountStatus(options, body.groupId, c.req.raw.signal, {
		expectedContext: checkedContext,
	});
	if (
		"error" in view ||
		view.setup !== "ready" ||
		view.contextId !== body.contextId ||
		(view.remote.kind === "unavailable" && view.remote.code === "context_changed")
	)
		return c.json({ error: "account_context_changed" }, 409);
	if (view.operation && view.operation.finishedAt === null)
		return c.json(
			{ error: "account_link_in_progress", operationId: view.operation.operationId },
			409,
		);
	if (view.blockedReason === "operation_active")
		return c.json({ error: "account_link_not_allowed", blockedReason: "operation_active" }, 409);
	if (view.remote.kind === "unavailable")
		return c.json({ error: "account_status_unavailable" }, 503);
	if (!view.canLink || view.remote.kind !== "status" || view.remote.state !== "unlinked")
		return c.json({ error: "account_link_not_allowed", blockedReason: view.blockedReason }, 409);
	return beginCurrentOperation(
		c,
		options,
		{ groupId: body.groupId, contextId: body.contextId },
		view,
		view.remote.coordinatorId,
		checkedContext,
		expectedLifecycleToken,
	);
}
function beginCurrentOperation(
	c: Context,
	options: Options,
	body: { groupId: string; contextId: string },
	view: AccountLinkViewV1,
	expectedCoordinatorId: string,
	checkedContext: AccountContext,
	expectedLifecycleToken: symbol,
): Response {
	if (c.req.raw.signal.aborted) return c.json({ error: "account_invalid_request" }, 400);
	const fresh = options.readContext(body.groupId);
	if (
		"error" in fresh ||
		fresh.setup !== "ready" ||
		!fresh.context ||
		fresh.context.contextId !== body.contextId ||
		fresh.context.contextId !== view.contextId ||
		fresh.context.groupId !== body.groupId ||
		!sameAuthority(checkedContext, fresh.context)
	)
		return c.json({ error: "account_context_changed" }, 409);
	const result = options.registry.start({
		context: checkedContext,
		expectedCoordinatorId,
		expectedLifecycleToken,
	});
	if ("error" in result)
		return c.json(result, result.error === "account_shutting_down" ? 503 : 409);
	return c.json({ version: 1, operation: result.operation }, 202);
}
async function performOperation(c: Context, options: Options): Promise<Response> {
	const { id, action } = c.req.param();
	if (
		!validString(id) ||
		(action !== "browser-url" && action !== "cancel") ||
		!(await readBody(c.req.raw, []))
	)
		return c.json({ error: "account_invalid_request" }, 400);
	const operation = options.registry.get(id);
	if (!operation) return c.json({ error: "account_operation_not_found" }, 404);
	if (action === "cancel") {
		const cancelled = options.registry.cancel(id);
		if (!cancelled) return c.json({ error: "account_operation_not_found" }, 404);
		return c.json({ version: 1, operation: cancelled }, cancelled.finishedAt === null ? 202 : 200);
	}
	if (operation.state !== "awaiting_browser")
		return c.json({ error: "account_browser_url_unavailable" }, 409);
	const url = options.registry.browserUrl(id);
	if (!url) return c.json({ error: "account_browser_url_unavailable" }, 409);
	return c.json({ version: 1, url });
}
export function accountOperationRoutes(options: Options): Hono {
	const app = new Hono();
	// Catch private callback errors here, before Hono's default error logger can see them.
	app.onError((_error, c) => c.json({ error: "account_internal_error" }, 500));
	const rejectQuery: MiddlewareHandler = async (c, next) => {
		if ([...new URL(c.req.url).searchParams].length)
			return c.json({ error: "account_invalid_request" }, 400);
		await next();
	};
	app.use(ROOT, rejectQuery);
	app.use(`${ROOT}/*`, rejectQuery);
	app.post(ROOT, (c) => startOperation(c, options));
	app.get(`${ROOT}/:id`, (c) => {
		if (!noBody(c.req.raw) || !validString(c.req.param("id")))
			return c.json({ error: "account_invalid_request" }, 400);
		const operation = options.registry.get(c.req.param("id"));
		if (!operation) return c.json({ error: "account_operation_not_found" }, 404);
		return c.json({ version: 1, operation, current: isCurrent(options, operation) });
	});
	app.post(`${ROOT}/:id/:action`, (c) => performOperation(c, options));
	return app;
}
