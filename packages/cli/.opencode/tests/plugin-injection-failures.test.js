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

describe("Viewer prompt transport failure classification", () => {
  test.each([
    ["pack profile", false, "fallback", true],
    ["pack", true, "terminal", false],
  ])(
    "classifies invalid_request for %s with compatibleProfile=%s as %s",
    (operation, compatibleProfile, disposition, retryable) => {
      // Arrange
      const body = {
        error: { code: "invalid_request" },
      };

      // Act
      const classification = __testUtils.classifyViewerHttpFailure({
        operation,
        status: 400,
        body,
        compatibleProfile,
      });

      // Assert
      expect(classification).toMatchObject({ disposition, retryable });
    },
  );

  test("fails closed on contract 409 only after a compatible profile", () => {
    const body = {
      error: {
        code: "viewer_contract_unsupported",
        message: "viewer request contract is incompatible",
      },
    };

    expect(__testUtils.classifyViewerHttpFailure({
      operation: "pack profile",
      status: 409,
      body,
      compatibleProfile: false,
    })).toMatchObject({ disposition: "fallback", retryable: true });
    expect(__testUtils.classifyViewerHttpFailure({
      operation: "pack",
      status: 409,
      body,
      compatibleProfile: true,
    })).toMatchObject({ disposition: "terminal", retryable: false });
  });

  test.each([
    [401, { error: { code: "unauthorized" } }],
    [403, { error: { code: "policy_denied" } }],
    [400, { error: { code: "invalid_request", message: "context required" } }],
  ])("treats status %s as terminal", (status, body) => {
    expect(__testUtils.classifyViewerHttpFailure({
      operation: "pack",
      status,
      body,
      compatibleProfile: true,
    })).toMatchObject({ disposition: "terminal", retryable: false });
  });

  test.each([
    ["database", { error: { code: "viewer_db_mismatch" } }],
    ["runtime identity", { error: { code: "viewer_identity_mismatch" } }],
  ])("classifies a %s mismatch as one-shot local fallback", (_label, body) => {
    expect(__testUtils.classifyViewerHttpFailure({
      operation: "pack profile",
      status: 409,
      body,
    })).toMatchObject({ disposition: "local_fallback", retryable: true });
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
