import { describe, expect, it, vi } from "vitest";
import {
	isLoopbackHost,
	observeViewerRuntime,
	parseViewerPidRecord,
	probeCodememViewerLiveness,
	type ViewerPidRecord,
} from "./viewer-runtime.js";

const record: ViewerPidRecord = { pid: 1234, host: "127.0.0.1", port: 38_888 };
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

describe("viewer PID records", () => {
	it("parses structured and legacy records", () => {
		expect(parseViewerPidRecord('{"pid":1234,"host":"localhost","port":38888}')).toEqual({
			state: "valid",
			record: { pid: 1234, host: "localhost", port: 38_888 },
		});
		expect(parseViewerPidRecord("1234")).toEqual({ state: "legacy", pid: 1234 });
	});

	it("rejects malformed records and validates loopback hosts", () => {
		for (const raw of ["", "12oops", '{"pid":0,"host":"localhost","port":38888}', "{}"]) {
			expect(parseViewerPidRecord(raw).state).toBe("malformed");
		}
		expect(isLoopbackHost("127.0.0.2")).toBe(true);
		expect(isLoopbackHost("[::1]")).toBe(true);
		expect(isLoopbackHost("example.test")).toBe(false);
	});
});

describe("probeCodememViewerLiveness", () => {
	it("requires HTTP success and the codemem viewer discriminator", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(healthy));

		await expect(probeCodememViewerLiveness(record, { fetch: fetchMock })).resolves.toEqual({
			state: "live",
			degraded: false,
		});
	});

	it("treats unready or database-unreachable health as degraded liveness", async () => {
		for (const payload of [
			{ ...healthy, ready: false },
			{ ...healthy, database: { reachable: false } },
		]) {
			const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(payload));
			await expect(probeCodememViewerLiveness(record, { fetch: fetchMock })).resolves.toEqual({
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

		await expect(probeCodememViewerLiveness(record, { fetch: fetchMock })).resolves.toEqual({
			state: "live",
			degraded: false,
		});
		expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
			"http://127.0.0.1:38888/api/health",
			"http://127.0.0.1:38888/api/stats",
		]);
		expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
		expect(fetchMock.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
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

		await expect(probeCodememViewerLiveness(record, { fetch: fetchMock })).resolves.toEqual({
			state: "unavailable",
			reason: "unexpected_response",
		});
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("treats absent readiness fields as degraded liveness, not unavailability", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(response({ service: "codemem-viewer" }));

		await expect(probeCodememViewerLiveness(record, { fetch: fetchMock })).resolves.toEqual({
			state: "live",
			degraded: true,
		});
	});

	it("does not fall back for wrong-service, malformed, 500, or network failures", async () => {
		const cases: Array<() => Promise<Response>> = [
			async () => response({ ...healthy, service: "other-service" }),
			async () => new Response("{", { status: 200 }),
			async () => response(null, { status: 500 }),
			async () => {
				throw new Error("connection refused");
			},
		];

		for (const result of cases) {
			const fetchMock = vi.fn<typeof fetch>().mockImplementation(result);
			const observed = await probeCodememViewerLiveness(record, { fetch: fetchMock });
			expect(observed.state).toBe("unavailable");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		}
	});

	it("honors the caller-provided timeout", async () => {
		const timeoutSignal = new AbortController().signal;
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
		try {
			const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(healthy));
			await probeCodememViewerLiveness(record, { fetch: fetchMock, timeoutMs: 25 });

			expect(timeoutSpy).toHaveBeenCalledWith(25);
			expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(timeoutSignal);
		} finally {
			timeoutSpy.mockRestore();
		}
	});
});

describe("observeViewerRuntime", () => {
	it("accepts a valid health discriminator", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(healthy));
		await expect(
			observeViewerRuntime(
				{ state: "valid", record },
				{ fetch: fetchMock, isProcessRunning: () => true },
			),
		).resolves.toEqual({ state: "running", pid: 1234 });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:38888/api/health");
	});

	it("rejects the wrong service discriminator without fallback", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(response({ service: "something-else" }));
		await expect(
			observeViewerRuntime(
				{ state: "valid", record },
				{ fetch: fetchMock, isProcessRunning: () => true },
			),
		).resolves.toMatchObject({ state: "unknown", attention_code: "viewer_wrong_service" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("uses stats fallback only for a health 404", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(null, { status: 404 }))
			.mockResolvedValueOnce(response({ viewer_pid: 1234 }));
		await expect(
			observeViewerRuntime(
				{ state: "valid", record },
				{ fetch: fetchMock, isProcessRunning: () => true },
			),
		).resolves.toEqual({ state: "running", pid: 1234 });
		expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
			"http://127.0.0.1:38888/api/health",
			"http://127.0.0.1:38888/api/stats",
		]);
	});

	it("does not fall back on 500 or connection failure", async () => {
		for (const result of [response(null, { status: 500 }), new Error("timeout")]) {
			const fetchMock = vi.fn<typeof fetch>();
			if (result instanceof Error) fetchMock.mockRejectedValue(result);
			else fetchMock.mockResolvedValue(result);
			const observed = await observeViewerRuntime(
				{ state: "valid", record },
				{ fetch: fetchMock, isProcessRunning: () => true },
			);
			expect(observed.state).toBe(result instanceof Error ? "unreachable" : "unknown");
			expect(fetchMock).toHaveBeenCalledTimes(1);
		}
	});

	it("never fetches a non-loopback PID record", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		await expect(
			observeViewerRuntime(
				{ state: "valid", record: { ...record, host: "example.test" } },
				{ fetch: fetchMock, isProcessRunning: () => true },
			),
		).resolves.toMatchObject({ state: "unknown", attention_code: "viewer_non_loopback" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("probes the default loopback viewer when the PID record is missing", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(healthy));
		await expect(
			observeViewerRuntime(
				{ state: "missing" },
				{ fetch: fetchMock, isProcessRunning: () => null },
			),
		).resolves.toEqual({ state: "running" });
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:38888/api/health");
	});

	it("uses a configured loopback target when the PID record is missing", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(healthy));
		await expect(
			observeViewerRuntime(
				{ state: "missing" },
				{ fetch: fetchMock, isProcessRunning: () => null },
				{ host: "127.0.0.2", port: 39_999 },
			),
		).resolves.toEqual({ state: "running" });
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.2:39999/api/health");
	});

	it("uses the configured target for legacy PID records", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(healthy));
		await expect(
			observeViewerRuntime(
				{ state: "legacy", pid: 1234 },
				{ fetch: fetchMock, isProcessRunning: () => true },
				{ host: "127.0.0.2", port: 39_999 },
			),
		).resolves.toEqual({ state: "running", pid: 1234 });
		expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.2:39999/api/health");
	});

	it("keeps an unready viewer running and surfaces degraded readiness", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(
				response({ service: "codemem-viewer", ready: false, database: { reachable: false } }),
			);
		await expect(
			observeViewerRuntime(
				{ state: "valid", record },
				{ fetch: fetchMock, isProcessRunning: () => true },
			),
		).resolves.toEqual({ state: "running", pid: 1234, attention_code: "viewer_not_ready" });
	});

	it("reports a missing viewer as unreachable and malformed records as unknown", async () => {
		const deps = {
			fetch: vi.fn<typeof fetch>().mockRejectedValue(new Error("connection refused")),
			isProcessRunning: () => null,
		};
		await expect(observeViewerRuntime({ state: "missing" }, deps)).resolves.toEqual({
			state: "unreachable",
		});
		await expect(observeViewerRuntime({ state: "malformed" }, deps)).resolves.toMatchObject({
			state: "unknown",
			attention_code: "viewer_pid_malformed",
		});
	});
});
