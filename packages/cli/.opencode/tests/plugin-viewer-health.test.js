import { describe, expect, test, vi } from "vitest";

import { __testUtils } from "../plugins/codemem.js";

const HEALTH_URL = "http://127.0.0.1:38888/api/health";
const LEGACY_URL = "http://127.0.0.1:38888/api/raw-events/status?limit=1";

const response = ({ status = 200, body = { service: "codemem-viewer", ready: true } } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: vi.fn().mockResolvedValue(body),
});

const createMonitor = ({ fetchFn, recoverViewer = vi.fn().mockResolvedValue({ exitCode: 0 }), now } = {}) => {
  const logLine = vi.fn().mockResolvedValue(undefined);
  const timeoutSignal = vi.fn(() => ({ bounded: true }));
  const monitor = __testUtils.createViewerHealthMonitor({
    viewerHealthUrl: HEALTH_URL,
    legacyStatusUrl: LEGACY_URL,
    isActive: () => true,
    recoverViewer,
    logLine,
    fetchFn,
    now,
    timeoutSignal,
  });
  return { logLine, monitor, recoverViewer, timeoutSignal };
};

describe("OpenCode viewer health monitor", () => {
  test.each([true, false])("treats ready=%s codemem viewer responses as live", async (ready) => {
    const fetchFn = vi.fn().mockResolvedValue(response({ body: { service: "codemem-viewer", ready } }));
    const { monitor, recoverViewer, timeoutSignal } = createMonitor({ fetchFn });

    await monitor.check();

    expect(monitor.state().consecutiveFailures).toBe(0);
    expect(recoverViewer).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(timeoutSignal).toHaveBeenCalledWith(5_000);
  });

  test("rejects a successful response from the wrong service without fallback", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({ body: { service: "other-service" } }));
    const { monitor } = createMonitor({ fetchFn });

    await monitor.check();

    expect(monitor.state().consecutiveFailures).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("rejects malformed health JSON without fallback", async () => {
    const malformed = response();
    malformed.json.mockRejectedValue(new SyntaxError("bad JSON"));
    const fetchFn = vi.fn().mockResolvedValue(malformed);
    const { monitor } = createMonitor({ fetchFn });

    await monitor.check();

    expect(monitor.state().consecutiveFailures).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("falls back once to raw-event status only when health returns 404", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response({ status: 404 }))
      .mockResolvedValueOnce(
        response({ body: { totals: { pending: 0 }, ingest: { available: true } } }),
      );
    const { monitor, timeoutSignal } = createMonitor({ fetchFn });

    await monitor.check();

    expect(monitor.state().consecutiveFailures).toBe(0);
    expect(fetchFn).toHaveBeenNthCalledWith(1, HEALTH_URL, expect.objectContaining({ method: "GET" }));
    expect(fetchFn).toHaveBeenNthCalledWith(2, LEGACY_URL, expect.objectContaining({ method: "GET" }));
    expect(timeoutSignal).toHaveBeenNthCalledWith(1, 5_000);
    expect(timeoutSignal).toHaveBeenNthCalledWith(2, 5_000);
  });

  test("rejects a 404 fallback response that does not look like the viewer", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(response({ status: 404 }))
      .mockResolvedValueOnce(response({ body: { unrelated: true } }));
    const { monitor } = createMonitor({ fetchFn });

    await monitor.check();

    expect(monitor.state().consecutiveFailures).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["server error", () => Promise.resolve(response({ status: 500 }))],
    ["network failure", () => Promise.reject(new Error("connection refused"))],
    ["timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
  ])("does not fall back after %s", async (_label, fetchResult) => {
    const fetchFn = vi.fn(fetchResult);
    const { monitor } = createMonitor({ fetchFn });

    await monitor.check();

    expect(monitor.state().consecutiveFailures).toBe(1);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("recovers after two failures and enforces the five-minute cooldown", async () => {
    let nowMs = 5 * 60_000;
    const fetchFn = vi.fn().mockResolvedValue(response({ status: 500 }));
    const recoverViewer = vi.fn().mockResolvedValue({ exitCode: 1 });
    const { monitor } = createMonitor({ fetchFn, recoverViewer, now: () => nowMs });

    await monitor.check();
    expect(recoverViewer).not.toHaveBeenCalled();
    await monitor.check();
    expect(recoverViewer).toHaveBeenCalledTimes(1);

    nowMs += 60_000;
    await monitor.check();
    expect(recoverViewer).toHaveBeenCalledTimes(1);

    nowMs += 4 * 60_000;
    await monitor.check();
    expect(recoverViewer).toHaveBeenCalledTimes(2);
  });

  test("resets failures after a successful recovery start and logs it", async () => {
    const fetchFn = vi.fn().mockResolvedValue(response({ status: 500 }));
    const recoverViewer = vi.fn().mockResolvedValue({ exitCode: 0 });
    const { logLine, monitor } = createMonitor({ fetchFn, now: () => 10 * 60_000, recoverViewer });

    await monitor.check();
    await monitor.check();

    expect(recoverViewer).toHaveBeenCalledTimes(1);
    expect(monitor.state().consecutiveFailures).toBe(0);
    expect(logLine).toHaveBeenCalledWith(
      "viewer.health start succeeded (exit=0)"
    );

    fetchFn.mockResolvedValue(response());
    await monitor.check();
    expect(monitor.state().consecutiveFailures).toBe(0);
  });

  test("logs recovery after transient failures clear on their own", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(response({ status: 500 }))
      .mockResolvedValueOnce(response());
    const { logLine, monitor } = createMonitor({ fetchFn });

    await monitor.check();
    await monitor.check();

    expect(monitor.state().consecutiveFailures).toBe(0);
    expect(logLine).toHaveBeenCalledWith("viewer.health recovered after 1 failure(s)");
  });

  test("does not recover when stopped while a probe was in flight", async () => {
    const activeValues = [true, true, false];
    const isActive = vi.fn(() => activeValues.shift() ?? false);
    const fetchFn = vi.fn().mockResolvedValue(response({ status: 500 }));
    const recoverViewer = vi.fn();
    const logLine = vi.fn().mockResolvedValue(undefined);
    const monitor = __testUtils.createViewerHealthMonitor({
      viewerHealthUrl: HEALTH_URL,
      legacyStatusUrl: LEGACY_URL,
      isActive,
      recoverViewer,
      logLine,
      fetchFn,
      now: () => 10 * 60_000,
      timeoutSignal: vi.fn(() => ({ bounded: true })),
    });

    await monitor.check();
    await monitor.check();

    expect(recoverViewer).not.toHaveBeenCalled();
  });

  test("unrefs its interval and clears monitor state when stopped", () => {
    const intervalHandle = { unref: vi.fn() };
    const setIntervalFn = vi.fn(() => intervalHandle);
    const clearIntervalFn = vi.fn();
    const monitor = __testUtils.createViewerHealthMonitor({
      viewerHealthUrl: HEALTH_URL,
      legacyStatusUrl: LEGACY_URL,
      isActive: () => true,
      recoverViewer: vi.fn(),
      logLine: vi.fn(),
      fetchFn: vi.fn(),
      setIntervalFn,
      clearIntervalFn,
    });

    monitor.start();
    monitor.stop();

    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(intervalHandle.unref).toHaveBeenCalledOnce();
    expect(clearIntervalFn).toHaveBeenCalledWith(intervalHandle);
    expect(monitor.state()).toEqual({
      consecutiveFailures: 0,
      lastRestartAttempt: 0,
      running: false,
    });
  });
});
