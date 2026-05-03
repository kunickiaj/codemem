import { describe, expect, test, vi } from "vitest";

import { __testUtils } from "../plugins/codemem.js";

describe("buildInjectQuery", () => {
  test("combines prompts, project, and recent modified file basenames", () => {
    const query = __testUtils.buildInjectQuery({
      firstPrompt: "fix auth callback",
      lastPromptText: "add regression coverage",
      projectName: "codemem",
      filesModified: [
        "packages/core/src/pack.ts",
        "packages/cli/.opencode/plugins/codemem.js",
      ],
    });

    expect(query).toBe(
      "fix auth callback add regression coverage codemem pack.ts codemem.js",
    );
  });

  test("omits trivial or duplicate latest prompt and falls back to recent work", () => {
    expect(
      __testUtils.buildInjectQuery({
        firstPrompt: "same prompt",
        lastPromptText: "same prompt",
        projectName: "",
        filesModified: [],
      }),
    ).toBe("same prompt");

    expect(
      __testUtils.buildInjectQuery({
        firstPrompt: null,
        lastPromptText: "todo",
        projectName: "",
        filesModified: [],
      }),
    ).toBe("recent work");
  });

  test("caps query length at 500 characters", () => {
    const query = __testUtils.buildInjectQuery({
      firstPrompt: "x".repeat(490),
      lastPromptText: "y".repeat(40),
      projectName: "codemem",
      filesModified: [],
    });

    expect(query).toHaveLength(500);
  });
});

describe("buildPackArgs", () => {
  test("includes limit, token budget, and recent working set files", () => {
    const args = __testUtils.buildPackArgs({
      query: "fix auth",
      filesModified: [
        "a.ts",
        "b.ts",
        "c.ts",
        "d.ts",
        "e.ts",
        "f.ts",
        "g.ts",
        "h.ts",
        "i.ts",
        "   ",
      ],
      injectLimit: 4,
      injectTokenBudget: 250,
    });

    expect(args).toEqual([
      "pack",
      "fix auth",
      "--json",
      "--limit",
      "4",
      "--token-budget",
      "250",
      "--working-set-file",
      "c.ts",
      "--working-set-file",
      "d.ts",
      "--working-set-file",
      "e.ts",
      "--working-set-file",
      "f.ts",
      "--working-set-file",
      "g.ts",
      "--working-set-file",
      "h.ts",
      "--working-set-file",
      "i.ts",
    ]);
  });

  test("omits non-positive limit and budget values", () => {
    const args = __testUtils.buildPackArgs({
      query: "recent work",
      filesModified: [],
      injectLimit: 0,
      injectTokenBudget: null,
    });

    expect(args).toEqual(["pack", "recent work", "--json"]);
  });
});

describe("applyInjectedContextToOutput", () => {
  test("recomputes pack on every call and toasts once per session", async () => {
    const injectionToastShown = new Set();
    const buildInjectedContext = vi
      .fn()
      .mockResolvedValueOnce({
        text: "[codemem context]\nfirst turn",
        metrics: { items: 1, pack_tokens: 42, pack_delta_available: false },
      })
      .mockResolvedValueOnce({
        text: "[codemem context]\nsecond turn",
        metrics: { items: 2, pack_tokens: 88, pack_delta_available: false },
      });
    const showToast = vi.fn().mockResolvedValue(undefined);
    const resolveInjectQuery = vi.fn().mockReturnValue("auth fix codemem");

    const firstOutput = {};
    const firstApplied = await __testUtils.applyInjectedContextToOutput({
      injectEnabled: true,
      input: { sessionID: "sess-1" },
      output: firstOutput,
      injectionToastShown,
      showToast,
      resolveInjectQuery,
      buildInjectedContext,
    });

    const secondOutput = { system: [] };
    const secondApplied = await __testUtils.applyInjectedContextToOutput({
      injectEnabled: true,
      input: { sessionID: "sess-1" },
      output: secondOutput,
      injectionToastShown,
      showToast,
      resolveInjectQuery,
      buildInjectedContext,
    });

    expect(firstApplied).toBe(true);
    expect(secondApplied).toBe(true);
    expect(firstOutput.system).toEqual(["[codemem context]\nfirst turn"]);
    expect(secondOutput.system).toEqual(["[codemem context]\nsecond turn"]);
    expect(buildInjectedContext).toHaveBeenCalledTimes(2);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  test("rebuilds injected context when query changes across turns", async () => {
    const injectionToastShown = new Set();
    const buildInjectedContext = vi
      .fn()
      .mockResolvedValueOnce({ text: "[codemem context]\nfirst" })
      .mockResolvedValueOnce({ text: "[codemem context]\nsecond" });
    const resolveInjectQuery = vi
      .fn()
      .mockReturnValueOnce("first query")
      .mockReturnValueOnce("second query");

    const firstOutput = {};
    await __testUtils.applyInjectedContextToOutput({
      injectEnabled: true,
      input: { sessionID: "sess-2" },
      output: firstOutput,
      injectionToastShown,
      showToast: null,
      resolveInjectQuery,
      buildInjectedContext,
    });

    const secondOutput = {};
    await __testUtils.applyInjectedContextToOutput({
      injectEnabled: true,
      input: { sessionID: "sess-2" },
      output: secondOutput,
      injectionToastShown,
      showToast: null,
      resolveInjectQuery,
      buildInjectedContext,
    });

    expect(buildInjectedContext).toHaveBeenCalledTimes(2);
    expect(firstOutput.system).toEqual(["[codemem context]\nfirst"]);
    expect(secondOutput.system).toEqual(["[codemem context]\nsecond"]);
  });

  test("returns false and leaves output untouched when injection yields no text", async () => {
    const output = { system: ["existing"] };

    const applied = await __testUtils.applyInjectedContextToOutput({
      injectEnabled: true,
      input: { sessionID: "sess-3" },
      output,
      injectionToastShown: new Set(),
      showToast: vi.fn(),
      resolveInjectQuery: () => "recent work",
      buildInjectedContext: vi.fn().mockResolvedValue(""),
    });

    expect(applied).toBe(false);
    expect(output.system).toEqual(["existing"]);
  });

  test("turn N+1 empty rebuild does not leak turn N's pack and does not re-toast", async () => {
    const injectionToastShown = new Set();
    const buildInjectedContext = vi
      .fn()
      .mockResolvedValueOnce({
        text: "[codemem context]\nturn1",
        metrics: { items: 1, pack_tokens: 42, pack_delta_available: false },
      })
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce({
        text: "[codemem context]\nturn3",
        metrics: { items: 1, pack_tokens: 50, pack_delta_available: false },
      });
    const showToast = vi.fn().mockResolvedValue(undefined);
    const resolveInjectQuery = vi.fn().mockReturnValue("auth fix codemem");

    const firstOutput = {};
    const firstApplied = await __testUtils.applyInjectedContextToOutput({
      injectEnabled: true,
      input: { sessionID: "sess-leak" },
      output: firstOutput,
      injectionToastShown,
      showToast,
      resolveInjectQuery,
      buildInjectedContext,
    });

    const secondOutput = { system: ["pre-existing"] };
    const secondApplied = await __testUtils.applyInjectedContextToOutput({
      injectEnabled: true,
      input: { sessionID: "sess-leak" },
      output: secondOutput,
      injectionToastShown,
      showToast,
      resolveInjectQuery,
      buildInjectedContext,
    });

    const thirdOutput = {};
    const thirdApplied = await __testUtils.applyInjectedContextToOutput({
      injectEnabled: true,
      input: { sessionID: "sess-leak" },
      output: thirdOutput,
      injectionToastShown,
      showToast,
      resolveInjectQuery,
      buildInjectedContext,
    });

    expect(firstApplied).toBe(true);
    expect(firstOutput.system).toEqual(["[codemem context]\nturn1"]);
    expect(secondApplied).toBe(false);
    expect(secondOutput.system).toEqual(["pre-existing"]);
    expect(thirdApplied).toBe(true);
    expect(thirdOutput.system).toEqual(["[codemem context]\nturn3"]);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  test("returns false immediately when injection is disabled", async () => {
    const buildInjectedContext = vi.fn();

    const applied = await __testUtils.applyInjectedContextToOutput({
      injectEnabled: false,
      input: { sessionID: "sess-4" },
      output: {},
      injectionToastShown: new Set(),
      showToast: null,
      resolveInjectQuery: () => "ignored",
      buildInjectedContext,
    });

    expect(applied).toBe(false);
    expect(buildInjectedContext).not.toHaveBeenCalled();
  });
});
