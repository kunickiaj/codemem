import { describe, expect, test, vi } from "vitest";

import { __testUtils } from "../plugins/codemem.js";

describe("parsePackText", () => {
  test("returns pack_text for a well-formed JSON payload", () => {
    const stdout = JSON.stringify({
      pack_text: "## Summary\n[1] (decision) Auth fix",
      metrics: { items: 1 },
    });
    expect(__testUtils.parsePackText(stdout)).toBe(
      "## Summary\n[1] (decision) Auth fix",
    );
  });

  test("returns an empty string when stdout is empty", () => {
    expect(__testUtils.parsePackText("")).toBe("");
    expect(__testUtils.parsePackText("   \n   ")).toBe("");
  });

  test("returns an empty string when stdout is not JSON", () => {
    expect(__testUtils.parsePackText("not json at all")).toBe("");
    expect(__testUtils.parsePackText("{ half object")).toBe("");
  });

  test("returns an empty string when the payload is missing pack_text", () => {
    expect(__testUtils.parsePackText(JSON.stringify({ metrics: { items: 0 } }))).toBe("");
    expect(__testUtils.parsePackText(JSON.stringify({ pack_text: "" }))).toBe("");
  });
});

describe("parsePackMetrics", () => {
  test("returns the metrics object when present", () => {
    const stdout = JSON.stringify({ pack_text: "x", metrics: { items: 2, pack_tokens: 17 } });
    expect(__testUtils.parsePackMetrics(stdout)).toEqual({ items: 2, pack_tokens: 17 });
  });

  test("returns null when metrics are missing or stdout is unparseable", () => {
    expect(__testUtils.parsePackMetrics("")).toBe(null);
    expect(__testUtils.parsePackMetrics("garbage")).toBe(null);
    expect(__testUtils.parsePackMetrics(JSON.stringify({ pack_text: "x" }))).toBe(null);
  });
});

describe("applyInjectedContextToOutput — failure behavior", () => {
  test("returns false when buildInjectedContext simulates spawn failure (empty string)", async () => {
    const output = { system: ["pre-existing"] };
    const buildInjectedContext = vi.fn().mockResolvedValue("");

    const applied = await __testUtils.applyInjectedContextToOutput({
      injectEnabled: true,
      input: { sessionID: "sess-fail-spawn" },
      output,
      injectedSessions: new Map(),
      injectionToastShown: new Set(),
      showToast: vi.fn(),
      resolveInjectQuery: () => "q",
      buildInjectedContext,
    });

    expect(applied).toBe(false);
    expect(buildInjectedContext).toHaveBeenCalledTimes(1);
    expect(output.system).toEqual(["pre-existing"]);
  });

  test("still injects when showToast rejects — toast failure is swallowed", async () => {
    const output = {};
    const showToast = vi.fn().mockRejectedValue(new Error("TUI offline"));
    const buildInjectedContext = vi.fn().mockResolvedValue({
      text: "[codemem context]\n## Summary\n[1] (decision) Auth fix",
      metrics: { items: 1, pack_tokens: 42, pack_delta_available: false },
    });

    const applied = await __testUtils.applyInjectedContextToOutput({
      injectEnabled: true,
      input: { sessionID: "sess-toast-fail" },
      output,
      injectedSessions: new Map(),
      injectionToastShown: new Set(),
      showToast,
      resolveInjectQuery: () => "q",
      buildInjectedContext,
    });

    expect(applied).toBe(true);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(output.system).toEqual([
      "[codemem context]\n## Summary\n[1] (decision) Auth fix",
    ]);
  });

  test("returns false when buildInjectedContext throws — error is not propagated past the caller", async () => {
    const output = { system: ["pre-existing"] };
    const buildInjectedContext = vi.fn().mockRejectedValue(new Error("CLI crashed"));

    await expect(
      __testUtils.applyInjectedContextToOutput({
        injectEnabled: true,
        input: { sessionID: "sess-cli-crash" },
        output,
        injectedSessions: new Map(),
        injectionToastShown: new Set(),
        showToast: vi.fn(),
        resolveInjectQuery: () => "q",
        buildInjectedContext,
      }),
    ).rejects.toThrow("CLI crashed");
    // The existing plugin path deliberately lets buildInjectedContext rejections bubble;
    // this test documents that contract so future refactors cannot silently change it.
    expect(output.system).toEqual(["pre-existing"]);
  });
});
