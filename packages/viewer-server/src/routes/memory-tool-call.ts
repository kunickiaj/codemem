/**
 * POST /api/memory-tools/:name — run one codemem memory tool on behalf of a
 * thin host (the OpenCode plugin) in another directory.
 *
 * The viewer serves every OpenCode project on the machine from one process,
 * so the caller sends its own directory and CODEMEM_PROJECT and the tool runs
 * with those instead of the viewer's working directory and environment. The
 * tool itself is executed by an injected function: `codemem serve` supplies
 * `callCodememToolLocally` from @codemem/mcp, which this package must not
 * import. Results, input validation, and retrieval-ledger capture are
 * therefore identical to stdio MCP and to the `codemem memory-tool` fallback.
 *
 * Request body:
 *   { arguments: {...},
 *     caller: { directory: "/abs/path", env_project: string|null,
 *               session_id?: string, request_id?: string },
 *     db_path, identity_target }
 *
 * The target pair is required (not optional as on read routes) because this
 * route can write. Responses: 200 `{ok:true,result}` or `{ok:false,error,result?}`
 * when the tool ran; 400/409 when the request or target is invalid.
 */

import { isAbsolute } from "node:path";
import type { MemoryStore } from "@codemem/core";
import { Hono } from "hono";
import { parseJsonObjectBody } from "../helpers.js";
import { validateViewerTarget } from "./target-validation.js";

export const MEMORY_TOOL_CALL_CAPABILITY = "memory_tool_call";

const MEMORY_TOOL_NAME = /^memory_[a-z_]+$/;
const MEMORY_TOOL_CALL_MAX_BODY_BYTES = 1_048_576;
const MAX_ID_CHARS = 200;

export interface MemoryToolCaller {
	cwd: string;
	envProject: string | null;
	sessionId?: string;
	/** Host tool-call ID; a retried delivery of the same call records one ledger attempt. */
	requestId?: string;
	statelessLedger: true;
}

export type MemoryToolCallFn = (
	store: MemoryStore,
	name: string,
	args: Record<string, unknown>,
	caller: MemoryToolCaller,
) => Promise<unknown>;

type ParsedCall =
	| { ok: true; args: Record<string, unknown>; caller: MemoryToolCaller }
	| { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function invalidRequest(message: string) {
	return { error: { code: "invalid_request", message } };
}

function parseEnvProject(value: unknown): string | null | undefined {
	if (value == null) return null;
	if (typeof value !== "string") return undefined;
	return value.trim() || null;
}

/** Optional short identifier: null when absent or blank, undefined when invalid. */
function parseOptionalId(value: unknown): string | null | undefined {
	if (value == null) return null;
	if (typeof value !== "string" || value.length > MAX_ID_CHARS) return undefined;
	return value.trim() || null;
}

/** Validate the body shape; caller context is mandatory so nothing defaults to the viewer's cwd. */
export function parseMemoryToolCall(body: Record<string, unknown>): ParsedCall {
	const args = body.arguments ?? {};
	if (!isRecord(args)) return { ok: false, message: "arguments must be an object" };
	const caller = body.caller;
	if (!isRecord(caller)) return { ok: false, message: "caller is required" };
	if (typeof caller.directory !== "string" || !isAbsolute(caller.directory)) {
		return { ok: false, message: "caller.directory must be an absolute path" };
	}
	const envProject = parseEnvProject(caller.env_project);
	if (envProject === undefined)
		return { ok: false, message: "caller.env_project must be a string" };
	const sessionId = parseOptionalId(caller.session_id);
	if (sessionId === undefined) return { ok: false, message: "caller.session_id is invalid" };
	const requestId = parseOptionalId(caller.request_id);
	if (requestId === undefined) return { ok: false, message: "caller.request_id is invalid" };
	// The ledger scopes request IDs to the session; without one, a retry would
	// get a fresh stream and record twice, so the pairing is enforced here.
	if (requestId && !sessionId) {
		return { ok: false, message: "caller.request_id requires caller.session_id" };
	}
	return {
		ok: true,
		args,
		caller: {
			cwd: caller.directory,
			envProject,
			...(sessionId ? { sessionId } : {}),
			...(requestId ? { requestId } : {}),
			statelessLedger: true,
		},
	};
}

type RequestCheck =
	| { ok: true; parsed: Extract<ParsedCall, { ok: true }> }
	| { ok: false; status: 400 | 409; body: unknown };

/** Body shape, then target: a write-capable route must name the database it expects. */
function checkRequest(store: MemoryStore, body: Record<string, unknown>): RequestCheck {
	if (!Object.hasOwn(body, "db_path") || !Object.hasOwn(body, "identity_target")) {
		return {
			ok: false,
			status: 400,
			body: invalidRequest("db_path and identity_target are required"),
		};
	}
	const parsed = parseMemoryToolCall(body);
	if (!parsed.ok) return { ok: false, status: 400, body: invalidRequest(parsed.message) };
	const target = validateViewerTarget(store, body, {
		requireCurrentIdentity: true,
		requirePairedTargets: true,
	});
	if (!target.ok) return { ok: false, status: target.status, body: target.body };
	return { ok: true, parsed };
}

export function memoryToolCallRoutes(getStore: () => MemoryStore, call: MemoryToolCallFn) {
	const app = new Hono();

	app.post("/api/memory-tools/:name", async (c) => {
		const name = c.req.param("name");
		if (!MEMORY_TOOL_NAME.test(name)) {
			return c.json(invalidRequest(`not a memory tool: ${name}`), 400);
		}
		const body = await parseJsonObjectBody(c, MEMORY_TOOL_CALL_MAX_BODY_BYTES);
		if (body instanceof Response) return body;
		const store = getStore();
		const check = checkRequest(store, body);
		if (!check.ok) return c.json(check.body, check.status);
		const { parsed } = check;
		try {
			return c.json(await call(store, name, parsed.args, parsed.caller));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return c.json({ error: { code: "tool_call_failed", message } }, 500);
		}
	});

	return app;
}
