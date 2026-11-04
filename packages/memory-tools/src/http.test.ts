import { describe, expect, it, vi } from "vitest";
import {
	isSafeConnectFailure,
	proveViewerTarget,
	type ViewerEndpoint,
	viewerJson,
} from "./http.js";
import type { ViewerRequestTarget } from "./viewer-target.js";

const target: ViewerRequestTarget = {
	db_path: "/home/dev/.codemem/mem.sqlite",
	identity_target: {
		device_id: null,
		actor_id_present: false,
		actor_id: null,
		config_path: null,
		runtime_root: null,
		workspace_id: null,
		home_dir: "/home/dev",
		pack_compression: null,
		embedding_disabled: false,
		embedding_offline: false,
		embedding_model: "Xenova/bge-small-en-v1.5",
		embedding_revision: "ea104dacec62c0de699686887e3f920caeb4f3e3",
	},
};

function matchingProfile(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		service: "codemem-viewer",
		protocol_version: 1,
		min_supported_protocol_version: 1,
		db_path: target.db_path,
		identity_target: target.identity_target,
		...extra,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function endpointWith(
	fetchImpl: typeof fetch,
	overrides: Partial<ViewerEndpoint> = {},
): ViewerEndpoint {
	return {
		baseUrl: "http://127.0.0.1:38888",
		timeoutMs: 1_000,
		enabled: true,
		fetchImpl,
		...overrides,
	};
}

describe("proveViewerTarget", () => {
	it("returns proven with advertised capabilities when the profile matches", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse(matchingProfile({ capabilities: ["tool_directory", "retrieval_ledger"] })),
		);

		const proof = await proveViewerTarget(endpointWith(fetchImpl), target);

		expect(proof.proven).toBe(true);
		expect([...proof.capabilities]).toEqual(["tool_directory", "retrieval_ledger"]);
		expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:38888/api/prompt-pack-profile");
	});

	it("reports no capabilities for an older viewer that omits them", async () => {
		const proof = await proveViewerTarget(
			endpointWith(vi.fn(async () => jsonResponse(matchingProfile()))),
			target,
		);

		expect(proof.proven).toBe(true);
		expect(proof.capabilities.size).toBe(0);
	});

	it("is unproven when the viewer serves a different database", async () => {
		const proof = await proveViewerTarget(
			endpointWith(
				vi.fn(async () => jsonResponse(matchingProfile({ db_path: "/elsewhere.sqlite" }))),
			),
			target,
		);

		expect(proof.proven).toBe(false);
	});

	it("is unproven when the endpoint is disabled, without calling fetch", async () => {
		const fetchImpl = vi.fn();

		const proof = await proveViewerTarget(endpointWith(fetchImpl, { enabled: false }), target);

		expect(proof.proven).toBe(false);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("is unproven when fetch throws", async () => {
		const proof = await proveViewerTarget(
			endpointWith(
				vi.fn(async () => {
					throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
				}),
			),
			target,
		);

		expect(proof.proven).toBe(false);
	});
});

describe("viewerJson", () => {
	it("sends query params plus the target identifiers on GET", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ items: [] }));

		const result = await viewerJson(endpointWith(fetchImpl), target, "GET", "/api/memory", {
			query: { limit: 5, project: "acme", kind: undefined, blank: "" },
		});

		expect(result).toEqual({ ok: true, status: 200, data: { items: [] } });
		const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
		expect(url.pathname).toBe("/api/memory");
		expect(url.searchParams.get("limit")).toBe("5");
		expect(url.searchParams.get("project")).toBe("acme");
		expect(url.searchParams.has("kind")).toBe(false);
		expect(url.searchParams.has("blank")).toBe(false);
		expect(url.searchParams.get("db_path")).toBe(target.db_path);
		expect(JSON.parse(url.searchParams.get("identity_target") ?? "")).toEqual(
			target.identity_target,
		);
	});

	it("posts a JSON body with the content-type header", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ id: 7 }));

		await viewerJson(endpointWith(fetchImpl), target, "POST", "api/memories/remember", {
			body: { kind: "decision", title: "t", body: "b" },
		});

		const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({ "Content-Type": "application/json" });
		expect(JSON.parse(String(init.body))).toEqual({
			kind: "decision",
			title: "t",
			body: "b",
			db_path: target.db_path,
			identity_target: target.identity_target,
		});
	});

	it("sends the target in the body of a POST with no other fields", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({}));

		await viewerJson(endpointWith(fetchImpl), target, "POST", "/api/pack");

		const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toEqual({
			db_path: target.db_path,
			identity_target: target.identity_target,
		});
	});
});

describe("viewerJson failure classification", () => {
	it("treats 4xx as a safe fallback with the server's error message", async () => {
		const result = await viewerJson(
			endpointWith(vi.fn(async () => jsonResponse({ error: "not_found" }, 404))),
			target,
			"GET",
			"/api/memory",
		);

		expect(result).toEqual({ ok: false, error: "not_found", safeFallback: true, status: 404 });
	});

	it("treats 5xx as an unsafe fallback", async () => {
		const result = await viewerJson(
			endpointWith(
				vi.fn(async () => new Response("boom", { status: 500, statusText: "Internal" })),
			),
			target,
			"GET",
			"/api/memory",
		);

		expect(result).toMatchObject({ ok: false, safeFallback: false, status: 500 });
	});

	it("marks connection refusals as safe and other throws as unsafe", async () => {
		const refused = await viewerJson(
			endpointWith(
				vi.fn(async () => {
					throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
				}),
			),
			target,
			"GET",
			"/api/memory",
		);
		const reset = await viewerJson(
			endpointWith(
				vi.fn(async () => {
					throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
				}),
			),
			target,
			"GET",
			"/api/memory",
		);

		expect(refused).toMatchObject({ ok: false, safeFallback: true });
		expect(reset).toMatchObject({ ok: false, safeFallback: false });
	});

	it("aborts the request when the caller's signal aborts", async () => {
		const fetchImpl = vi.fn(
			(_url: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
					);
				}),
		);
		const controller = new AbortController();

		const pending = viewerJson(
			endpointWith(fetchImpl as typeof fetch),
			target,
			"GET",
			"/api/memory",
			{
				signal: controller.signal,
			},
		);
		controller.abort();

		expect(await pending).toMatchObject({ ok: false, error: "aborted", safeFallback: false });
	});

	it("returns a disabled error without fetching when the endpoint is off", async () => {
		const fetchImpl = vi.fn();

		const result = await viewerJson(
			endpointWith(fetchImpl, { enabled: false }),
			target,
			"GET",
			"/x",
		);

		expect(result).toEqual({ ok: false, error: "viewer disabled", safeFallback: true });
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});

describe("isSafeConnectFailure", () => {
	it("finds connect codes nested under cause", () => {
		const err = new Error("fetch failed", { cause: { code: "ENOTFOUND" } });
		expect(isSafeConnectFailure(err)).toBe(true);
	});

	it("rejects non-connect errors", () => {
		expect(isSafeConnectFailure(new Error("plain"))).toBe(false);
		expect(isSafeConnectFailure(null)).toBe(false);
	});
});
