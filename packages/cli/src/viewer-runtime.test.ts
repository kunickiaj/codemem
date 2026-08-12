import { describe, expect, it, vi } from "vitest";
import {
	isLoopbackHost,
	observeViewerRuntime,
	parseViewerPidRecord,
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
