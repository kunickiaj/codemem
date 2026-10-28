import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AccountContext, AccountContextReader } from "../account/context.js";
import {
	type AccountLinkOperationV1,
	type AccountLinkRegistry,
	type AccountOperationIntent,
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
async function readBody(
	request: Request,
	keys: string[],
	optional: string[] = [],
): Promise<Record<string, unknown> | null> {
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
		if (
			keys.some((key) => !actual.includes(key)) ||
			actual.some((key) => !keys.includes(key) && !optional.includes(key))
		)
			return null;
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
function validStartBody(body: Record<string, unknown> | null): body is {
	groupId: string;
	intent?: AccountOperationIntent;
	contextId: string;
	expectedLinkId?: string;
	coordinatorId: string;
	authority: "controller_attestation" | "device_claim" | null;
} {
	return (
		body !== null &&
		validString(body.groupId) &&
		validString(body.contextId) &&
		validString(body.coordinatorId) &&
		(body.intent !== "disconnect" || validString(body.expectedLinkId)) &&
		(body.intent === undefined ||
			body.intent === "connect" ||
			body.intent === "refresh" ||
			body.intent === "disconnect" ||
			body.intent === "sign_in") &&
		(body.authority === "controller_attestation" ||
			body.authority === "device_claim" ||
			(body.intent === "sign_in" && body.authority === null))
	);
}
function unlinkTargetChanged(
	body: { intent?: string; expectedLinkId?: string },
	view: AccountLinkViewV1,
): boolean {
	return body.intent === "disconnect" && body.expectedLinkId !== view.unlinkTarget;
}
async function startOperation(c: Context, options: Options): Promise<Response> {
	const body = await readBody(
		c.req.raw,
		["groupId", "contextId", "authority", "coordinatorId"],
		["intent", "expectedLinkId"],
	);
	if (!validStartBody(body)) return c.json({ error: "account_invalid_request" }, 400);
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
		ownIdentityOnly: body.intent === "sign_in",
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
	if (!actionAllowed(view, body.intent) || view.remote.kind !== "status")
		return c.json({ error: "account_link_not_allowed", blockedReason: view.blockedReason }, 409);
	if (unlinkTargetChanged(body, view)) return c.json({ error: "account_context_changed" }, 409);
	return beginCurrentOperation(
		c,
		options,
		body,
		view,
		view.remote.coordinatorId,
		checkedContext,
		expectedLifecycleToken,
	);
}
function actionAllowed(view: AccountLinkViewV1, intent = "connect"): boolean {
	if (intent === "connect") return view.canLink;
	if (intent === "sign_in") return view.canSignIn === true;
	if (intent === "refresh" || intent === "disconnect")
		return view.managementActions?.[intent] === true;
	return false;
}
function beginCurrentOperation(
	c: Context,
	options: Options,
	body: {
		intent?: AccountOperationIntent;
		groupId: string;
		contextId: string;
		expectedLinkId?: string;
		coordinatorId: string;
		authority: "controller_attestation" | "device_claim" | null;
	},
	view: AccountLinkViewV1,
	expectedCoordinatorId: string,
	checkedContext: AccountContext,
	expectedLifecycleToken: symbol,
): Response {
	if (c.req.raw.signal.aborted) return c.json({ error: "account_invalid_request" }, 400);
	if (
		view.remote.kind !== "status" ||
		((body.intent ?? "connect") === "connect" && view.remote.authority !== body.authority) ||
		view.remote.coordinatorId !== body.coordinatorId
	)
		return c.json({ error: "account_context_changed" }, 409);
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
		intent: body.intent ?? "connect",
		context: checkedContext,
		expectedCoordinatorId,
		expectedAuthority: body.authority,
		expectedLifecycleToken,
		expectedLinkId: body.expectedLinkId,
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
