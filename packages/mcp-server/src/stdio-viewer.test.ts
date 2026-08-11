import { describe, expect, it, vi } from "vitest";
import {
	ensureViewer,
	isViewerHealthy,
	type SpawnViewerProcess,
	type ViewerChildProcess,
} from "./stdio-viewer.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function createFetchMock(...responses: Array<Response | Error>): typeof fetch {
	const fetchMock = vi.fn<typeof fetch>();
	for (const response of responses) {
		if (response instanceof Response) fetchMock.mockResolvedValueOnce(response);
		else fetchMock.mockRejectedValueOnce(response);
	}
	return fetchMock;
}

function createSpawnMock(options: { throws?: boolean } = {}) {
	const child: ViewerChildProcess = {
		on: vi.fn(),
		unref: vi.fn(),
	};
	const spawnMock = vi.fn<SpawnViewerProcess>(() => {
		if (options.throws) throw new Error("spawn failed");
		return child;
	});
	return { child, spawnMock };
}

describe("MCP viewer probe", () => {
	it.each([
		["healthy", { service: "codemem-viewer", ready: true }],
		["degraded", { service: "codemem-viewer", ready: false }],
	])("accepts a live %s viewer", async (_state, body) => {
		const fetchMock = createFetchMock(jsonResponse(body));

		await expect(isViewerHealthy({ fetchImpl: fetchMock })).resolves.toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:38888/api/health",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it.each([
		["wrong service", jsonResponse({ service: "something-else", ready: true })],
		["malformed JSON", new Response("not json", { status: 200 })],
		["server error", jsonResponse({ service: "codemem-viewer" }, 500)],
		["timeout", new DOMException("timed out", "TimeoutError")],
		["network failure", new Error("connection refused")],
	])("rejects %s without compatibility fallback", async (_case, response) => {
		const fetchMock = createFetchMock(response);

		await expect(isViewerHealthy({ fetchImpl: fetchMock })).resolves.toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("falls back to stats exactly once when health is absent", async () => {
		const fetchMock = createFetchMock(
			new Response(null, { status: 404 }),
			jsonResponse({ viewer_pid: 1234 }),
		);

		await expect(isViewerHealthy({ fetchImpl: fetchMock })).resolves.toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenNthCalledWith(
			2,
			"http://127.0.0.1:38888/api/stats",
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it.each([
		["missing viewer_pid", jsonResponse({})],
		["invalid viewer_pid", jsonResponse({ viewer_pid: "1234" })],
		["malformed JSON", new Response("not json", { status: 200 })],
		["server error", jsonResponse({ viewer_pid: 1234 }, 500)],
	])("rejects a stats fallback with %s", async (_case, statsResponse) => {
		const fetchMock = createFetchMock(new Response(null, { status: 404 }), statsResponse);

		await expect(isViewerHealthy({ fetchImpl: fetchMock })).resolves.toBe(false);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("MCP viewer ensure", () => {
	it("does not spawn when the viewer is healthy", async () => {
		const { spawnMock } = createSpawnMock();

		await ensureViewer({
			fetchImpl: createFetchMock(jsonResponse({ service: "codemem-viewer", ready: true })),
			resolveCliPath: () => "codemem",
			spawnImpl: spawnMock,
		});

		expect(spawnMock).not.toHaveBeenCalled();
	});

	it.each([
		"CODEMEM_VIEWER",
		"CODEMEM_VIEWER_AUTO",
	] as const)("respects the %s opt-out", async (variable) => {
		const fetchMock = createFetchMock();
		const { spawnMock } = createSpawnMock();

		await ensureViewer({
			env: { [variable]: "0" },
			fetchImpl: fetchMock,
			spawnImpl: spawnMock,
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(spawnMock).not.toHaveBeenCalled();
	});

	it("spawns detached with preserved arguments and polls five times", async () => {
		const fetchMock = createFetchMock(...Array.from({ length: 6 }, () => new Error("offline")));
		const sleep = vi.fn(async () => {});
		const { child, spawnMock } = createSpawnMock();

		await ensureViewer({
			env: { EXISTING: "value" },
			execPath: "/node",
			fetchImpl: fetchMock,
			host: "localhost",
			port: "39999",
			resolveCliPath: () => "/codemem/index.js",
			sleep,
			spawnImpl: spawnMock,
		});

		expect(spawnMock).toHaveBeenCalledWith(
			"/node",
			["/codemem/index.js", "serve", "start", "--host", "localhost", "--port", "39999"],
			{
				detached: true,
				stdio: "ignore",
				env: { EXISTING: "value", CODEMEM_PLUGIN_IGNORE: "1" },
			},
		);
		expect(child.on).toHaveBeenCalledWith("error", expect.any(Function));
		expect(child.unref).toHaveBeenCalledOnce();
		expect(sleep).toHaveBeenCalledTimes(5);
		expect(sleep).toHaveBeenCalledWith(1_000);
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	it("stops polling as soon as the spawned viewer becomes healthy", async () => {
		const fetchMock = createFetchMock(
			new Error("offline"),
			new Error("offline"),
			new Error("offline"),
			jsonResponse({ service: "codemem-viewer", ready: true }),
		);
		const sleep = vi.fn(async () => {});
		const { spawnMock } = createSpawnMock();

		await ensureViewer({
			fetchImpl: fetchMock,
			resolveCliPath: () => "codemem",
			sleep,
			spawnImpl: spawnMock,
		});

		expect(spawnMock).toHaveBeenCalledOnce();
		expect(sleep).toHaveBeenCalledTimes(3);
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("swallows spawn failures", async () => {
		const { spawnMock } = createSpawnMock({ throws: true });

		await expect(
			ensureViewer({
				fetchImpl: createFetchMock(new Error("offline")),
				resolveCliPath: () => "codemem",
				spawnImpl: spawnMock,
			}),
		).resolves.toBeUndefined();
	});
});
