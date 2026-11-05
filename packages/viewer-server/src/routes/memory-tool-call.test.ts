import type { MemoryStore } from "@codemem/core";
import { buildViewerIdentityTarget } from "@codemem/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
	MEMORY_TOOL_CALL_CAPABILITY,
	type MemoryToolCallFn,
	memoryToolCallRoutes,
	parseMemoryToolCall,
} from "./memory-tool-call.js";
import { packTransportRoutes } from "./pack.js";

const DB_PATH = "/tmp/codemem-memory-tool-call/mem.sqlite";

function storeStub(): MemoryStore {
	return { dbPath: DB_PATH, hasCurrentIdentity: () => true } as unknown as MemoryStore;
}

function appWith(call: MemoryToolCallFn): Hono {
	const app = new Hono();
	app.route("/", memoryToolCallRoutes(storeStub, call));
	return app;
}

function validBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		arguments: { query: "retry" },
		caller: {
			directory: "/work/acme-api",
			env_project: null,
			session_id: "ses_1",
			request_id: "call_1",
		},
		db_path: DB_PATH,
		identity_target: buildViewerIdentityTarget(),
		...extra,
	};
}

function post(app: Hono, name: string, body: unknown): Promise<Response> {
	return Promise.resolve(
		app.request(`/api/memory-tools/${name}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

describe("POST /api/memory-tools/:name", () => {
	it("runs the tool with the caller's directory, env project, and session", async () => {
		const call = vi.fn<MemoryToolCallFn>(async () => ({ ok: true, result: { items: [] } }));

		const res = await post(appWith(call), "memory_search", validBody());

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, result: { items: [] } });
		expect(call).toHaveBeenCalledWith(
			expect.anything(),
			"memory_search",
			{ query: "retry" },
			{
				cwd: "/work/acme-api",
				envProject: null,
				sessionId: "ses_1",
				requestId: "call_1",
				statelessLedger: true,
			},
		);
	});

	it("passes a tool-level error through with status 200", async () => {
		const call = vi.fn<MemoryToolCallFn>(async () => ({ ok: false, error: "not_found" }));

		const res = await post(appWith(call), "memory_get", validBody({ arguments: { memory_id: 9 } }));

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: false, error: "not_found" });
	});

	it("rejects names outside the memory tool namespace before reading the body", async () => {
		const call = vi.fn<MemoryToolCallFn>();

		const res = await post(appWith(call), "shell_exec", validBody());

		expect(res.status).toBe(400);
		expect(call).not.toHaveBeenCalled();
	});

	it("requires the target pair because the route can write", async () => {
		const call = vi.fn<MemoryToolCallFn>();
		const { db_path: _db, identity_target: _identity, ...untargeted } = validBody();

		const res = await post(appWith(call), "memory_remember", untargeted);

		expect(res.status).toBe(400);
		expect(call).not.toHaveBeenCalled();
	});

	it("returns 409 when the request targets another database", async () => {
		const call = vi.fn<MemoryToolCallFn>();

		const res = await post(
			appWith(call),
			"memory_search",
			validBody({ db_path: "/tmp/elsewhere.sqlite" }),
		);

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({ error: { code: "viewer_db_mismatch" } });
		expect(call).not.toHaveBeenCalled();
	});

	it("reports an exception from the call function as 500", async () => {
		const call = vi.fn<MemoryToolCallFn>(async () => {
			throw new Error("store closed");
		});

		const res = await post(appWith(call), "memory_search", validBody());

		expect(res.status).toBe(500);
		expect(await res.json()).toMatchObject({ error: { code: "tool_call_failed" } });
	});
});

describe("parseMemoryToolCall", () => {
	it("requires an absolute caller directory so nothing defaults to the viewer's cwd", () => {
		expect(parseMemoryToolCall({ caller: {} })).toMatchObject({ ok: false });
		expect(parseMemoryToolCall({ caller: { directory: "relative/dir" } })).toMatchObject({
			ok: false,
		});
		expect(parseMemoryToolCall({ arguments: {} })).toMatchObject({ ok: false });
	});

	it("treats missing arguments as an empty object and blank env project as none", () => {
		expect(parseMemoryToolCall({ caller: { directory: "/work", env_project: "  " } })).toEqual({
			ok: true,
			args: {},
			caller: { cwd: "/work", envProject: null, statelessLedger: true },
		});
	});

	it("requires a session when a request ID is sent, because retries dedupe per session", () => {
		expect(
			parseMemoryToolCall({ caller: { directory: "/w", request_id: "call_1" } }),
		).toMatchObject({ ok: false, message: expect.stringContaining("session_id") });
	});

	it("rejects non-object arguments and non-string env project", () => {
		expect(parseMemoryToolCall({ arguments: [1], caller: { directory: "/w" } })).toMatchObject({
			ok: false,
		});
		expect(parseMemoryToolCall({ caller: { directory: "/w", env_project: 3 } })).toMatchObject({
			ok: false,
		});
	});
});

describe("prompt-pack profile capabilities", () => {
	it("advertises only the capabilities it is given", async () => {
		const withCall = new Hono().route(
			"/",
			packTransportRoutes(storeStub, { capabilities: [MEMORY_TOOL_CALL_CAPABILITY] }),
		);
		const without = new Hono().route("/", packTransportRoutes(storeStub));

		const advertised = await (await withCall.request("/api/prompt-pack-profile")).json();
		const absent = await (await without.request("/api/prompt-pack-profile")).json();

		expect(advertised).toMatchObject({ capabilities: ["memory_tool_call"] });
		expect(absent).toMatchObject({ capabilities: [] });
	});
});
