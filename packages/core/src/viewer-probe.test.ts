import { describe, expect, it, vi } from "vitest";
import { probeCodememViewerLiveness, viewerUrl } from "./viewer-probe.js";

const target = { host: "127.0.0.1", port: 38_888 };
const healthy = {
	service: "codemem-viewer",
	ready: true,
	database: { reachable: true },
};

function response(body: unknown, init: ResponseInit = {}): Response {
	return new Response(body == null ? null : JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

describe("viewerUrl", () => {
	it("brackets IPv6 hosts and leaves others untouched", () => {
		expect(viewerUrl(target, "/api/health")).toBe("http://127.0.0.1:38888/api/health");
		expect(viewerUrl({ host: "::1", port: 38_888 }, "/api/health")).toBe(
			"http://[::1]:38888/api/health",
		);
		expect(viewerUrl({ host: "[::1]", port: 38_888 }, "/api/health")).toBe(
			"http://[::1]:38888/api/health",
		);
	});
});

describe("probeCodememViewerLiveness", () => {
	it("requires HTTP success and the codemem viewer discriminator", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(healthy));

		await expect(probeCodememViewerLiveness(target, { fetch: fetchMock })).resolves.toEqual({
			state: "live",
			degraded: false,
		});
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:38888/api/health");
	});

	it("treats unready or database-unreachable health as degraded liveness", async () => {
		for (const payload of [
			{ ...healthy, ready: false },
			{ ...healthy, database: { reachable: false } },
			{ service: "codemem-viewer" },
		]) {
			const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(payload));
			await expect(probeCodememViewerLiveness(target, { fetch: fetchMock })).resolves.toEqual({
				state: "live",
				degraded: true,
			});
		}
	});

	it("falls back to stats exactly once only when health returns 404", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(null, { status: 404 }))
			.mockResolvedValueOnce(response({ viewer_pid: 1234 }));

		await expect(probeCodememViewerLiveness(target, { fetch: fetchMock })).resolves.toEqual({
			state: "live",
			degraded: false,
		});
		expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
			"http://127.0.0.1:38888/api/health",
			"http://127.0.0.1:38888/api/stats",
		]);
		// The fallback gets its own timeout budget rather than the residual
		// budget of the health request.
		expect(fetchMock.mock.calls[1]?.[1]?.signal).not.toBe(fetchMock.mock.calls[0]?.[1]?.signal);
	});

	it.each([
		["a server error", response(null, { status: 500 })],
		["a missing viewer_pid", response({ database: {}, usage: {} })],
		["an invalid viewer_pid", response({ viewer_pid: "1234" })],
		["malformed JSON", new Response("{", { status: 200 })],
	])("reports unavailable when the legacy fallback returns %s", async (_case, statsResponse) => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(null, { status: 404 }))
			.mockResolvedValueOnce(statsResponse);

		await expect(probeCodememViewerLiveness(target, { fetch: fetchMock })).resolves.toEqual({
			state: "unavailable",
			reason: "unexpected_response",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not fall back for wrong-service, malformed, 500, or network failures", async () => {
		const cases: Array<[() => Promise<Response>, string]> = [
			[async () => response({ ...healthy, service: "other-service" }), "wrong_service"],
			[async () => new Response("{", { status: 200 }), "unexpected_response"],
			[async () => response(null, { status: 500 }), "unexpected_response"],
			[
				async () => {
					throw new Error("connection refused");
				},
				"unreachable",
			],
		];

		for (const [result, reason] of cases) {
			const fetchMock = vi.fn<typeof fetch>().mockImplementation(result);
			await expect(probeCodememViewerLiveness(target, { fetch: fetchMock })).resolves.toEqual({
				state: "unavailable",
				reason,
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		}
	});

	it("honors the caller-provided timeout and the 750ms default", async () => {
		const timeoutSignal = new AbortController().signal;
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
		try {
			const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(healthy));
			await probeCodememViewerLiveness(target, { fetch: fetchMock, timeoutMs: 25 });

			expect(timeoutSpy).toHaveBeenCalledWith(25);
			expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(timeoutSignal);

			timeoutSpy.mockClear();
			await probeCodememViewerLiveness(target, {
				fetch: vi.fn<typeof fetch>().mockResolvedValue(response(healthy)),
			});
			expect(timeoutSpy).toHaveBeenCalledWith(750);
		} finally {
			timeoutSpy.mockRestore();
		}
	});
});
