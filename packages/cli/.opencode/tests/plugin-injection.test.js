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
  test("recomputes pack on every call so same-session cache hits cannot cross scopes", async () => {
    const injectionToastShown = new Set();
    const buildInjectedContext = vi
      .fn()
      .mockResolvedValueOnce({
        text: "[codemem context]\n## Summary\n[1] (decision) Authorized scope A",
        metrics: { items: 1, pack_tokens: 42, pack_delta_available: false },
      })
      .mockResolvedValueOnce({
        text: "[codemem context]\n## Summary\n[2] (decision) Authorized scope B",
        metrics: { items: 2, pack_tokens: 88, pack_delta_available: false },
      });
    const showToast = vi.fn().mockResolvedValue(undefined);
    const resolveInjectQuery = vi.fn().mockReturnValue("same prompt after scope switch");

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
    expect(firstOutput.system).toEqual([
      "[codemem context]\n## Summary\n[1] (decision) Authorized scope A",
    ]);
    expect(secondOutput.system).toEqual([
      "[codemem context]\n## Summary\n[2] (decision) Authorized scope B",
    ]);
    expect(secondOutput.system.join("\n")).not.toContain("Authorized scope A");
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

describe("applyInjectedContextToMessages", () => {
  const userEntry = (messageID, text, sessionID = "sess-messages") => ({
    info: { id: messageID, sessionID, role: "user" },
    parts: [{ id: `${messageID}-text`, sessionID, messageID, type: "text", text }],
  });

  const assistantEntry = (messageID, text, sessionID = "sess-messages") => ({
    info: { id: messageID, sessionID, role: "assistant" },
    parts: [{ id: `${messageID}-text`, sessionID, messageID, type: "text", text }],
  });

  const unidentifiedUserEntry = (text) => ({
    info: { role: "user" },
    parts: [{ id: "text", type: "text", text }],
  });

  test("appends current memory to the latest user message", async () => {
    const output = {
      messages: [userEntry("user-1", "fix prompt caching")],
    };
    const buildInjectedContext = vi.fn().mockResolvedValue({
      text: "[codemem context]\n## Summary\n[1] (decision) Message injection",
      metrics: { total_items: 1, pack_tokens: 42 },
    });
    const showToast = vi.fn().mockResolvedValue(undefined);

    const applied = await __testUtils.applyInjectedContextToMessages({
      injectEnabled: true,
      input: {},
      output,
      injectionToastShown: new Set(),
      showToast,
      resolveInjectQuery: vi.fn(({ firstPrompt, lastPromptText }) => `${firstPrompt} ${lastPromptText}`),
      buildInjectedContext,
      messageInjectionCache: new Map(),
    });

    expect(applied).toBe(true);
    expect(output.messages[0].parts).toEqual([
      { id: "user-1-text", sessionID: "sess-messages", messageID: "user-1", type: "text", text: "fix prompt caching" },
      {
        id: "codemem-context-user-1",
        sessionID: "sess-messages",
        messageID: "user-1",
        type: "text",
        text: "[codemem context]\n## Summary\n[1] (decision) Message injection",
        synthetic: true,
      },
    ]);
    expect(buildInjectedContext).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  test("preserves prior injected message blocks and only builds the new turn", async () => {
    const messageInjectionCache = new Map();
    const injectionToastShown = new Set();
    const buildInjectedContext = vi
      .fn()
      .mockResolvedValueOnce({ text: "[codemem context]\nturn one" })
      .mockResolvedValueOnce({ text: "[codemem context]\nturn two" });
    const resolveInjectQuery = vi.fn(({ firstPrompt, lastPromptText }) =>
      [firstPrompt, lastPromptText].filter(Boolean).join(" | "),
    );

    const firstOutput = { messages: [userEntry("user-1", "first prompt")] };
    await __testUtils.applyInjectedContextToMessages({
      injectEnabled: true,
      input: {},
      output: firstOutput,
      injectionToastShown,
      showToast: null,
      resolveInjectQuery,
      buildInjectedContext,
      messageInjectionCache,
    });

    const secondOutput = {
      messages: [
        userEntry("user-1", "first prompt"),
        assistantEntry("assistant-1", "done"),
        userEntry("user-2", "second prompt"),
      ],
    };
    await __testUtils.applyInjectedContextToMessages({
      injectEnabled: true,
      input: {},
      output: secondOutput,
      injectionToastShown,
      showToast: null,
      resolveInjectQuery,
      buildInjectedContext,
      messageInjectionCache,
    });

    expect(buildInjectedContext).toHaveBeenCalledTimes(2);
    expect(secondOutput.messages[0].parts.at(-1).text).toBe("[codemem context]\nturn one");
    expect(secondOutput.messages[2].parts.at(-1).text).toBe("[codemem context]\nturn two");
    expect(secondOutput.messages[0].parts.filter(__testUtils.isCodememContextPart)).toHaveLength(1);
  });

  test("deduplicates already-present codemem message parts", async () => {
    const output = {
      messages: [
        {
          info: { id: "user-1", sessionID: "sess-messages", role: "user" },
          parts: [
            { id: "user-1-text", sessionID: "sess-messages", messageID: "user-1", type: "text", text: "same prompt" },
            {
              id: "codemem-context-user-1",
              sessionID: "sess-messages",
              messageID: "user-1",
              type: "text",
              text: "[codemem context]\nexisting",
              synthetic: true,
            },
          ],
        },
      ],
    };
    const buildInjectedContext = vi.fn();

    await __testUtils.applyInjectedContextToMessages({
      injectEnabled: true,
      input: {},
      output,
      injectionToastShown: new Set(),
      showToast: null,
      resolveInjectQuery: () => "same prompt",
      buildInjectedContext,
      messageInjectionCache: new Map(),
    });

    expect(buildInjectedContext).not.toHaveBeenCalled();
    expect(output.messages[0].parts.filter(__testUtils.isCodememContextPart)).toHaveLength(1);
    expect(output.messages[0].parts.at(-1).text).toBe("[codemem context]\nexisting");
  });

  test("skips message injection once for compaction and strips codemem parts", async () => {
    const output = {
      messages: [
        {
          info: { id: "user-compact", sessionID: "sess-compact", role: "user" },
          parts: [
            {
              id: "user-compact-text",
              sessionID: "sess-compact",
              messageID: "user-compact",
              type: "text",
              text: "compact this session",
            },
            {
              id: "codemem-context-user-compact",
              sessionID: "sess-compact",
              messageID: "user-compact",
              type: "text",
              text: "[codemem context]\nold synthetic context",
              synthetic: true,
            },
          ],
        },
      ],
    };
    const buildInjectedContext = vi.fn().mockResolvedValue({ text: "[codemem context]\nnew" });
    const compactionInjectionSkips = new Map([["sess-compact", Date.now() + 1000]]);

    const applied = await __testUtils.applyInjectedContextToMessages({
      injectEnabled: true,
      input: { sessionID: "sess-compact" },
      output,
      injectionToastShown: new Set(),
      showToast: null,
      resolveInjectQuery: () => "compact this session",
      buildInjectedContext,
      messageInjectionCache: new Map(),
      compactionInjectionSkips,
    });

    expect(applied).toBe(false);
    expect(buildInjectedContext).not.toHaveBeenCalled();
    expect(compactionInjectionSkips.has("sess-compact")).toBe(false);
    expect(output.messages[0].parts).toEqual([
      {
        id: "user-compact-text",
        sessionID: "sess-compact",
        messageID: "user-compact",
        type: "text",
        text: "compact this session",
      },
    ]);
  });

  test("does not replay cached context for unidentified sessions or positional messages", async () => {
    const messageInjectionCache = new Map();
    const buildInjectedContext = vi
      .fn()
      .mockResolvedValueOnce({ text: "[codemem context]\nsession A" })
      .mockResolvedValueOnce({ text: "[codemem context]\nsession B" });
    const common = {
      injectEnabled: true,
      input: {},
      injectionToastShown: new Set(),
      showToast: null,
      resolveInjectQuery: ({ lastPromptText }) => lastPromptText,
      buildInjectedContext,
      messageInjectionCache,
    };

    const firstOutput = { messages: [unidentifiedUserEntry("same prompt")] };
    await __testUtils.applyInjectedContextToMessages({
      ...common,
      output: firstOutput,
    });

    const secondOutput = { messages: [unidentifiedUserEntry("same prompt")] };
    await __testUtils.applyInjectedContextToMessages({
      ...common,
      output: secondOutput,
    });

    expect(buildInjectedContext).toHaveBeenCalledTimes(2);
    expect(messageInjectionCache.size).toBe(0);
    expect(firstOutput.messages[0].parts.at(-1).text).toBe("[codemem context]\nsession A");
    expect(secondOutput.messages[0].parts.at(-1).text).toBe("[codemem context]\nsession B");
  });
});
