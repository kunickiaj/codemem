// Contract parity between the plain-JS OpenCode plugin viewer monitor and the
// shared TypeScript probe in @codemem/core (resolved to source via the
// vitest alias in .opencode/vitest.config.ts). The plugin cannot import core
// at runtime, so this test pins its hand-written copy to the core contract.
import { probeCodememViewerLiveness } from "@codemem/core";
import { describe, expect, test, vi } from "vitest";

import { __testUtils } from "../plugins/codemem.js";

const HEALTH_URL = "http://127.0.0.1:38888/api/health";
const LEGACY_URL = "http://127.0.0.1:38888/api/raw-events/status?limit=1";

const response = ({ status = 200, body = null } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json:
    body instanceof Error
      ? vi.fn().mockRejectedValue(body)
      : vi.fn().mockResolvedValue(body),
});

const jsonResponse = (body, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const probeCore = async (fetchResult) => {
  const fetchMock = vi.fn().mockImplementation(fetchResult);
  const result = await probeCodememViewerLiveness(
    { host: "127.0.0.1", port: 38_888 },
    { fetch: fetchMock },
  );
  return { live: result.state === "live", urls: fetchMock.mock.calls.map((call) => call[0]) };
};

const probePlugin = async (fetchResult) => {
  const fetchMock = vi.fn().mockImplementation(fetchResult);
  const monitor = __testUtils.createViewerHealthMonitor({
    viewerHealthUrl: HEALTH_URL,
    legacyStatusUrl: LEGACY_URL,
    isActive: () => true,
    restartViewer: vi.fn(),
    logLine: vi.fn().mockResolvedValue(undefined),
    fetchFn: fetchMock,
    timeoutSignal: vi.fn(() => ({ bounded: true })),
  });
  await monitor.check();
  return {
    live: monitor.state().consecutiveFailures === 0,
    urls: fetchMock.mock.calls.map((call) => call[0]),
  };
};

describe("plugin monitor stays in parity with the core probe contract", () => {
  test.each([
    ["healthy viewer", { service: "codemem-viewer", ready: true, database: { reachable: true } }, true],
    ["degraded viewer (ready=false)", { service: "codemem-viewer", ready: false }, true],
    ["viewer without readiness fields", { service: "codemem-viewer" }, true],
    ["wrong service", { service: "other-service", ready: true }, false],
    ["non-object payload", 42, false],
  ])("health payload: %s → live=%s in both clients, without fallback", async (_case, body, expected) => {
    const core = await probeCore(async () => jsonResponse(body));
    expect(core.live).toBe(expected);
    expect(core.urls).toEqual(["http://127.0.0.1:38888/api/health"]);

    const plugin = await probePlugin(async () => response({ body }));
    expect(plugin.live).toBe(expected);
    expect(plugin.urls).toEqual([HEALTH_URL]);
  });

  test("server error (500) → not live in both clients, without fallback", async () => {
    const core = await probeCore(async () => jsonResponse(null, 500));
    expect(core.live).toBe(false);
    expect(core.urls).toEqual(["http://127.0.0.1:38888/api/health"]);

    const plugin = await probePlugin(async () => response({ status: 500 }));
    expect(plugin.live).toBe(false);
    expect(plugin.urls).toEqual([HEALTH_URL]);
  });

  test("network failure → not live in both clients, without fallback", async () => {
    const reject = async () => {
      throw new Error("connection refused");
    };
    const core = await probeCore(reject);
    expect(core.live).toBe(false);
    expect(core.urls).toHaveLength(1);

    const plugin = await probePlugin(reject);
    expect(plugin.live).toBe(false);
    expect(plugin.urls).toHaveLength(1);
  });

  test("malformed health JSON → not live in both clients, without fallback", async () => {
    const core = await probeCore(async () => new Response("{", { status: 200 }));
    expect(core.live).toBe(false);
    expect(core.urls).toHaveLength(1);

    const plugin = await probePlugin(async () => response({ body: new SyntaxError("bad JSON") }));
    expect(plugin.live).toBe(false);
    expect(plugin.urls).toHaveLength(1);
  });

  test("404 with each client's identifying legacy evidence → live after one fallback", async () => {
    const coreResponses = [jsonResponse(null, 404), jsonResponse({ viewer_pid: 1234 })];
    const core = await probeCore(async () => coreResponses.shift());
    expect(core.live).toBe(true);
    expect(core.urls).toEqual([
      "http://127.0.0.1:38888/api/health",
      "http://127.0.0.1:38888/api/stats",
    ]);

    const pluginResponses = [
      response({ status: 404 }),
      response({ body: { ingest: { available: true } } }),
    ];
    const plugin = await probePlugin(async () => pluginResponses.shift());
    expect(plugin.live).toBe(true);
    expect(plugin.urls).toEqual([HEALTH_URL, LEGACY_URL]);
  });

  test("404 with unidentifiable legacy payloads → not live in both clients", async () => {
    const coreResponses = [jsonResponse(null, 404), jsonResponse({ unrelated: true })];
    const core = await probeCore(async () => coreResponses.shift());
    expect(core.live).toBe(false);
    expect(core.urls).toHaveLength(2);

    const pluginResponses = [response({ status: 404 }), response({ body: { unrelated: true } })];
    const plugin = await probePlugin(async () => pluginResponses.shift());
    expect(plugin.live).toBe(false);
    expect(plugin.urls).toHaveLength(2);
  });
});

describe("raw-event ingest preflight", () => {
  test("is bounded by a 5-second abort signal", async () => {
    const boundedSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(boundedSignal);
    try {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(response({ body: { ingest: { available: true } } }));

      await __testUtils.fetchRawEventsStatus(LEGACY_URL, fetchFn);

      expect(timeoutSpy).toHaveBeenCalledWith(5_000);
      expect(fetchFn).toHaveBeenCalledWith(
        LEGACY_URL,
        expect.objectContaining({ method: "GET", signal: boundedSignal }),
      );
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
