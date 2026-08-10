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

  test("adds the hidden ledger transport only for internal callers", () => {
    expect(__testUtils.buildPackArgs({
      query: "recent work",
      filesModified: [],
      injectLimit: 10,
      injectTokenBudget: null,
      internalLedger: true,
    })).toContain("--internal-ledger");
    expect(__testUtils.buildPackArgs({
      query: "recent work",
      filesModified: [],
      injectLimit: 10,
      injectTokenBudget: null,
    })).not.toContain("--internal-ledger");
  });
});

describe("fallback command-result classification", () => {
  test("keeps a bounded redacted SQLite lock cause and marks it retryable", () => {
    // Arrange
    const commandResult = {
      exitCode: 1,
      stdout: "",
      stderr:
        "SqliteError: database is locked at /Users/example/private/customer.sqlite query=super-secret",
    };

    // Act
    const classification = __testUtils.classifyFallbackCommandResult(commandResult);

    // Assert
    expect(classification.retryable).toBe(true);
    expect(classification.cause.toLowerCase()).toContain("database is locked");
    expect(classification.cause.length).toBeLessThanOrEqual(200);
    expect(classification.cause).not.toContain("/Users/example/private/customer.sqlite");
    expect(classification.cause).not.toContain("super-secret");
  });

  test("marks a command timeout as retryable without inventing a lock cause", () => {
    // Arrange
    const commandResult = { exitCode: null, stdout: "", stderr: "timeout" };

    // Act
    const classification = __testUtils.classifyFallbackCommandResult(commandResult);

    // Assert
    expect(classification).toMatchObject({ retryable: true });
    expect(classification.cause.toLowerCase()).toContain("timeout");
    expect(classification.cause.toLowerCase()).not.toContain("locked");
  });

  test.each([
    ["validation", "Invalid raw event: sessionID is required", "validation failed"],
    ["incompatible command", "error: unknown command 'enqueue-raw-event'", "command unavailable"],
    ["missing process", "spawn codemem ENOENT", "command unavailable"],
  ])("keeps %s failures terminal", (_label, stderr, expectedCause) => {
    // Arrange
    const commandResult = { exitCode: 1, stdout: "", stderr };

    // Act
    const classification = __testUtils.classifyFallbackCommandResult(commandResult);

    // Assert
    expect(classification.retryable).toBe(false);
    expect(classification.cause).toContain(expectedCause);
  });
});

describe("prompt-pack request identity", () => {
  test("is deterministic for retries and distinct for new turns", () => {
    const base = {
      source: "opencode",
      sessionID: "sess-identity",
      requestKey: "user-1",
      surface: "message",
      promptNumber: 3,
      queryHash: __testUtils.hashPromptPackQuery("private raw prompt"),
    };

    const first = __testUtils.promptPackIdentity(base);
    const retry = __testUtils.promptPackIdentity(base);
    const nextTurn = __testUtils.promptPackIdentity({ ...base, requestKey: "user-2" });
    const firstCacheReuse = __testUtils.promptPackIdentity({
      ...base,
      requestKey: "user-1:cache:1",
    });
    const secondCacheReuse = __testUtils.promptPackIdentity({
      ...base,
      requestKey: "user-1:cache:2",
    });

    expect(retry).toEqual(first);
    expect(nextTurn.attemptId).not.toBe(first.attemptId);
    expect(nextTurn.requestId).not.toBe(first.requestId);
    expect(secondCacheReuse.attemptId).not.toBe(firstCacheReuse.attemptId);
    expect(JSON.stringify(first)).not.toContain("private raw prompt");
  });

  test("redacts the positional query from command error diagnostics", () => {
    const rendered = __testUtils.redactPackCommand("pnpm", ["run", "codemem"], [
      "pack",
      "raw private query",
      "--json",
      "--internal-ledger",
      "--working-set-file",
      "/private/worktree/secret.ts",
    ]);

    expect(rendered).toContain("pack [query-redacted] --json --internal-ledger");
    expect(rendered).not.toContain("raw private query");
    expect(rendered).not.toContain("/private/worktree/secret.ts");
    expect(rendered).toContain("--working-set-file [path-redacted]");
  });
});

describe("applyInjectedContextToOutput", () => {
  test("marks legacy-system handoff only after exact bytes are attached", async () => {
    const output = {};
    const text = "[codemem context]\nlegacy bytes";
    const confirmDelivery = vi.fn(() => {
      expect(output.system).toEqual([text]);
    });

    await __testUtils.applyInjectedContextToOutput({
      injectEnabled: true,
      input: { sessionID: "sess-system" },
      output,
      injectionToastShown: new Set(),
      showToast: null,
      resolveInjectQuery: () => "legacy query",
      buildInjectedContext: vi.fn().mockResolvedValue({ text, attemptId: "legacy-attempt" }),
      confirmDelivery,
    });

    expect(confirmDelivery).toHaveBeenCalledWith("legacy-attempt");
  });

  test("marks delivery failed when the legacy output rejects attachment", async () => {
    const confirmDelivery = vi.fn();
    await expect(__testUtils.applyInjectedContextToOutput({
      injectEnabled: true,
      input: { sessionID: "sess-frozen" },
      output: { system: Object.freeze([]) },
      injectionToastShown: new Set(),
      showToast: null,
      resolveInjectQuery: () => "frozen query",
      buildInjectedContext: vi.fn().mockResolvedValue({
        text: "[codemem context]\nfrozen",
        attemptId: "frozen-attempt",
      }),
      confirmDelivery,
    })).rejects.toThrow();
    expect(confirmDelivery).toHaveBeenCalledWith("frozen-attempt", "failed");
    expect(confirmDelivery).not.toHaveBeenCalledWith("frozen-attempt");
  });

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
      attemptId: "message-attempt",
    });
    const showToast = vi.fn().mockResolvedValue(undefined);
    const confirmDelivery = vi.fn(() => {
      expect(output.messages[0].parts.at(-1).text).toBe(
        "[codemem context]\n## Summary\n[1] (decision) Message injection",
      );
    });

    const applied = await __testUtils.applyInjectedContextToMessages({
      injectEnabled: true,
      input: {},
      output,
      injectionToastShown: new Set(),
      showToast,
      resolveInjectQuery: vi.fn(({ firstPrompt, lastPromptText }) => `${firstPrompt} ${lastPromptText}`),
      buildInjectedContext,
      messageInjectionCache: new Map(),
      confirmDelivery,
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
    expect(buildInjectedContext).toHaveBeenCalledWith(
      "fix prompt caching fix prompt caching",
      { sessionID: "sess-messages", requestKey: "user-1", surface: "message" },
    );
    expect(confirmDelivery).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledTimes(1);
  });

  test("records one new attempt when the latest message is satisfied from cache", async () => {
    const messageInjectionCache = new Map();
    const exactBytes = "[codemem context]\n## Summary\n[1] (decision) Byte stable";
    const buildInjectedContext = vi
      .fn()
      .mockResolvedValueOnce({
        text: exactBytes,
        attemptId: "original-attempt",
        queryHash: "query-hash",
        promptNumber: 1,
      });
    const confirmDelivery = vi.fn();
    const recordCacheReuse = vi.fn((cached, context) => {
      expect(cached.attemptId).toBe("original-attempt");
      expect(context.messageId).toBe("user-1");
      return "replay-attempt";
    });

    await __testUtils.applyInjectedContextToMessages({
      injectEnabled: true,
      input: {},
      output: { messages: [userEntry("user-1", "first prompt")] },
      injectionToastShown: new Set(),
      showToast: null,
      resolveInjectQuery: ({ lastPromptText }) => lastPromptText,
      buildInjectedContext,
      messageInjectionCache,
      confirmDelivery,
      recordCacheReuse,
    });
    confirmDelivery.mockClear();

    const output = { messages: [userEntry("user-1", "first prompt")] };
    await __testUtils.applyInjectedContextToMessages({
      injectEnabled: true,
      input: {},
      output,
      injectionToastShown: new Set(),
      showToast: null,
      resolveInjectQuery: ({ lastPromptText }) => lastPromptText,
      buildInjectedContext,
      messageInjectionCache,
      confirmDelivery,
      recordCacheReuse,
    });

    expect(output.messages[0].parts.at(-1).text).toBe(exactBytes);
    expect(recordCacheReuse).toHaveBeenCalledTimes(1);
    expect(confirmDelivery).toHaveBeenCalledWith("replay-attempt");
    expect(confirmDelivery).not.toHaveBeenCalledWith("original-attempt");
    expect(buildInjectedContext).toHaveBeenCalledTimes(1);
  });

  test("reattaches many historical cached parts with constant ledger callback count", async () => {
    const sessionID = "sess-many-cached";
    const sessionCache = new Map();
    const messages = [];
    for (let index = 1; index <= 100; index += 1) {
      const messageId = `user-${index}`;
      messages.push(userEntry(messageId, `prompt ${index}`, sessionID));
      sessionCache.set(messageId, {
        text: `[codemem context]\ncached ${index}`,
        attemptId: `attempt-${index}`,
        queryHash: `hash-${index}`,
        promptNumber: index,
        reuseCount: 0,
      });
    }
    const recordCacheReuse = vi.fn(() => "latest-replay-attempt");
    const confirmDelivery = vi.fn();
    const buildInjectedContext = vi.fn();

    const applied = await __testUtils.applyInjectedContextToMessages({
      injectEnabled: true,
      input: { sessionID },
      output: { messages },
      injectionToastShown: new Set(),
      showToast: null,
      resolveInjectQuery: vi.fn(),
      buildInjectedContext,
      messageInjectionCache: new Map([[sessionID, sessionCache]]),
      confirmDelivery,
      recordCacheReuse,
    });

    expect(applied).toBe(true);
    expect(buildInjectedContext).not.toHaveBeenCalled();
    expect(recordCacheReuse).toHaveBeenCalledTimes(1);
    expect(recordCacheReuse.mock.calls[0][0].attemptId).toBe("attempt-100");
    expect(confirmDelivery).toHaveBeenCalledTimes(1);
    expect(confirmDelivery).toHaveBeenCalledWith("latest-replay-attempt");
    expect(messages[0].parts.at(-1).text).toBe("[codemem context]\ncached 1");
    expect(messages.at(-1).parts.at(-1).text).toBe("[codemem context]\ncached 100");
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

  test("rebuilds the latest reconstructed part while preserving historical identity-less replay", async () => {
    // Arrange
    const messageInjectionCache = new Map();
    const output = {
      messages: [
        {
          info: { id: "user-1", sessionID: "sess-messages", role: "user" },
          parts: [
            { id: "user-1-text", sessionID: "sess-messages", messageID: "user-1", type: "text", text: "first prompt" },
            {
              id: "codemem-context-user-1",
              sessionID: "sess-messages",
              messageID: "user-1",
              type: "text",
              text: "[codemem context]\nhistorical",
              synthetic: true,
            },
          ],
        },
        {
          info: { id: "user-2", sessionID: "sess-messages", role: "user" },
          parts: [
            { id: "user-2-text", sessionID: "sess-messages", messageID: "user-2", type: "text", text: "same prompt" },
            {
              id: "codemem-context-user-2",
              sessionID: "sess-messages",
              messageID: "user-2",
              type: "text",
              text: "[codemem context]\nexisting",
              synthetic: true,
            },
          ],
        },
      ],
    };
    const buildInjectedContext = vi.fn().mockResolvedValue({
      text: "[codemem context]\nrebuilt",
      attemptId: "rebuilt-attempt",
    });
    const recordCacheReuse = vi.fn();
    const confirmDelivery = vi.fn();

    // Act
    await __testUtils.applyInjectedContextToMessages({
      injectEnabled: true,
      input: {},
      output,
      injectionToastShown: new Set(),
      showToast: null,
      resolveInjectQuery: () => "same prompt",
      buildInjectedContext,
      messageInjectionCache,
      recordCacheReuse,
      confirmDelivery,
    });

    // Assert
    expect(buildInjectedContext).toHaveBeenCalledTimes(1);
    expect(recordCacheReuse).not.toHaveBeenCalled();
    expect(output.messages[0].parts.filter(__testUtils.isCodememContextPart)).toHaveLength(1);
    expect(output.messages[0].parts.at(-1).text).toBe("[codemem context]\nhistorical");
    expect(output.messages[1].parts.filter(__testUtils.isCodememContextPart)).toHaveLength(1);
    expect(output.messages[1].parts.at(-1).text).toBe("[codemem context]\nrebuilt");
    expect(messageInjectionCache.get("sess-messages").get("user-2")).toMatchObject({
      text: "[codemem context]\nrebuilt",
      attemptId: "rebuilt-attempt",
    });
    expect(confirmDelivery).toHaveBeenCalledWith("rebuilt-attempt");
  });

  test("does not replay a reconstructed latest part when its rebuild is empty", async () => {
    // Arrange
    const messageInjectionCache = new Map();
    const output = {
      messages: [
        {
          info: { id: "user-1", sessionID: "sess-empty-rebuild", role: "user" },
          parts: [
            { id: "user-1-text", sessionID: "sess-empty-rebuild", messageID: "user-1", type: "text", text: "same prompt" },
            {
              id: "codemem-context-user-1",
              sessionID: "sess-empty-rebuild",
              messageID: "user-1",
              type: "text",
              text: "[codemem context]\nstale",
              synthetic: true,
            },
          ],
        },
      ],
    };
    const buildInjectedContext = vi.fn().mockResolvedValue({ text: "" });

    // Act
    const applied = await __testUtils.applyInjectedContextToMessages({
      injectEnabled: true,
      input: {},
      output,
      injectionToastShown: new Set(),
      showToast: null,
      resolveInjectQuery: () => "same prompt",
      buildInjectedContext,
      messageInjectionCache,
    });

    // Assert
    expect(applied).toBe(false);
    expect(buildInjectedContext).toHaveBeenCalledTimes(1);
    expect(output.messages[0].parts.filter(__testUtils.isCodememContextPart)).toHaveLength(0);
    expect(messageInjectionCache.get("sess-empty-rebuild").has("user-1")).toBe(false);
  });

  test("replays a freshly built latest cache entry without an attempt identity", async () => {
    // Arrange
    const sessionID = "sess-unattributed-build";
    const messageInjectionCache = new Map([
      [
        sessionID,
        new Map([
          [
            "user-1",
            {
              text: "[codemem context]\nfresh build",
              attemptId: null,
              requestId: null,
              queryHash: null,
              promptNumber: 0,
              reuseCount: 0,
            },
          ],
        ]),
      ],
    ]);
    const output = { messages: [userEntry("user-1", "same prompt", sessionID)] };
    const buildInjectedContext = vi.fn();

    // Act
    const applied = await __testUtils.applyInjectedContextToMessages({
      injectEnabled: true,
      input: { sessionID },
      output,
      injectionToastShown: new Set(),
      showToast: null,
      resolveInjectQuery: vi.fn(),
      buildInjectedContext,
      messageInjectionCache,
    });

    // Assert
    expect(applied).toBe(true);
    expect(buildInjectedContext).not.toHaveBeenCalled();
    expect(output.messages[0].parts.at(-1).text).toBe("[codemem context]\nfresh build");
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
