import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { __testUtils } from "../plugins/codemem.js";

describe("opencode adapter event mapping", () => {
  test("maps user_prompt to prompt adapter envelope", () => {
    const event = {
      type: "user_prompt",
      prompt_text: "Summarize the latest changes",
      prompt_number: 2,
      timestamp: "2026-03-02T20:00:00Z",
    };

    const mapped = __testUtils.buildOpencodeAdapterEvent({
      sessionID: "sess-1",
      event,
    });

    expect(mapped).not.toBeNull();
    expect(mapped?.source).toBe("opencode");
    expect(mapped?.event_type).toBe("prompt");
    expect(mapped?.payload).toEqual({
      text: "Summarize the latest changes",
      prompt_number: 2,
    });
  });

  test("maps tool.execute.after to tool_result with error status", () => {
    const event = {
      type: "tool.execute.after",
      tool: "bash",
      args: { command: "uv run pytest" },
      result: "failed",
      error: "1 test failed",
      timestamp: "2026-03-02T20:00:01Z",
    };

    const mapped = __testUtils.buildOpencodeAdapterEvent({
      sessionID: "sess-2",
      event,
    });

    expect(mapped).not.toBeNull();
    expect(mapped?.event_type).toBe("tool_result");
    expect(mapped?.payload?.tool_name).toBe("bash");
    expect(mapped?.payload?.status).toBe("error");
  });

  test("attachAdapterEvent keeps unknown event unchanged", () => {
    const unknown = { type: "assistant_usage", usage: { input_tokens: 12 } };
    const attached = __testUtils.attachAdapterEvent({
      sessionID: "sess-3",
      event: unknown,
    });

    expect(attached).toEqual(unknown);
    expect(attached).not.toHaveProperty("_adapter");
  });

  test("attachAdapterEvent annotates mapped events", () => {
    const event = {
      type: "assistant_message",
      assistant_text: "Done.",
      timestamp: "2026-03-02T20:00:02Z",
    };

    const attached = __testUtils.attachAdapterEvent({
      sessionID: "sess-4",
      event,
    });

    expect(attached).toHaveProperty("_adapter");
    expect(attached._adapter.event_type).toBe("assistant");
    expect(attached._adapter.payload.text).toBe("Done.");
  });

  test("builds deterministic adapter event ids with explicit timestamp", () => {
    const event = {
      type: "assistant_message",
      assistant_text: "Deterministic",
      timestamp: "2026-03-02T20:00:05Z",
    };

    const first = __testUtils.buildOpencodeAdapterEvent({
      sessionID: "sess-det",
      event,
    });
    const second = __testUtils.buildOpencodeAdapterEvent({
      sessionID: "sess-det",
      event,
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first?.event_id).toBe(second?.event_id);
  });

  test("keeps adapter event ids within schema length", () => {
    const longSession = "sess-" + "x".repeat(500);
    const event = {
      type: "user_prompt",
      prompt_text: "Validate id length",
      timestamp: "2026-03-02T20:00:00Z",
    };
    const mapped = __testUtils.buildOpencodeAdapterEvent({
      sessionID: longSession,
      event,
    });

    expect(mapped).not.toBeNull();
    expect(mapped?.event_id.length).toBeLessThanOrEqual(128);
  });

  test("selectRawEventId prefers existing payload id", () => {
    const selected = __testUtils.selectRawEventId({
      payload: { _raw_event_id: "stable-id-1" },
      nextEventId: () => "generated-id",
    });

    expect(selected).toBe("stable-id-1");
  });

  test("buildRawEventEnvelope uses generated id when raw id is absent", () => {
    const envelope = __testUtils.buildRawEventEnvelope({
      sessionID: "sess-5",
      type: "assistant_message",
      payload: {
        _adapter: { event_id: "adapter-stable-id" },
      },
      cwd: "/tmp/worktree",
      project: "codemem",
      startedAt: "2026-03-02T20:00:00Z",
      nowMs: 12345,
      nowMono: 678.9,
      nextEventId: () => "generated-id",
    });

    expect(envelope.event_id).toBe("generated-id");
    expect(envelope.session_stream_id).toBe("sess-5");
    expect(envelope.session_id).toBe("sess-5");
    expect(envelope.opencode_session_id).toBe("sess-5");
    expect(envelope.event_type).toBe("assistant_message");
  });

  test("buildRawEventEnvelope reuses payload _raw_event_id when present", () => {
    const envelope = __testUtils.buildRawEventEnvelope({
      sessionID: "sess-5",
      type: "assistant_message",
      payload: { _raw_event_id: "stable-raw-id" },
      cwd: "/tmp/worktree",
      project: "codemem",
      startedAt: "2026-03-02T20:00:00Z",
      nowMs: 12345,
      nowMono: 678.9,
      nextEventId: () => "generated-id",
    });

    expect(envelope.event_id).toBe("stable-raw-id");
  });

  test("parsePositiveInt falls back for invalid values", () => {
    expect(__testUtils.parsePositiveInt("200", 10)).toBe(200);
    expect(__testUtils.parsePositiveInt("0", 10)).toBe(10);
    expect(__testUtils.parsePositiveInt("-5", 10)).toBe(10);
    expect(__testUtils.parsePositiveInt("NaN", 10)).toBe(10);
  });

  test("trimEventQueue drops enqueued events first", () => {
    const events = [
      { _raw_event_id: "a", _raw_enqueued: false },
      { _raw_event_id: "b", _raw_enqueued: true },
    ];

    __testUtils.trimEventQueue({
      events,
      maxEvents: 1,
    });

    expect(events.length).toBe(1);
    expect(events[0]._raw_event_id).toBe("a");
  });

  test("trimEventQueue preserves unsent events under pressure", () => {
    const events = [
      { _raw_event_id: "a", _raw_enqueued: false },
      { _raw_event_id: "b", _raw_enqueued: false },
    ];
    let pressured = false;

    __testUtils.trimEventQueue({
      events,
      maxEvents: 1,
      onUnsentPressure: () => {
        pressured = true;
      },
    });

    expect(events.length).toBe(2);
    expect(pressured).toBe(true);
  });

  test("trimEventQueue enforces hard cap for unsent pressure", () => {
    const events = [
      { _raw_event_id: "a", _raw_enqueued: false },
      { _raw_event_id: "b", _raw_enqueued: false },
      { _raw_event_id: "c", _raw_enqueued: false },
    ];
    let dropped = null;

    __testUtils.trimEventQueue({
      events,
      maxEvents: 1,
      hardMaxEvents: 2,
      onForcedDrop: (event) => {
        dropped = event?._raw_event_id || null;
      },
    });

    expect(events.length).toBe(2);
    expect(dropped).toBe("a");
  });

  test("buildRunnerArgs returns empty for direct codemem runner", () => {
    const args = __testUtils.buildRunnerArgs({
      runner: "codemem",
      runnerFrom: "/some/path",
      runnerFromExplicit: false,
    });

    expect(args).toEqual([]);
  });

  test("buildRunnerArgs pins npx to backend version", () => {
    const args = __testUtils.buildRunnerArgs({
      runner: "npx",
      runnerFrom: "/some/path",
      runnerFromExplicit: false,
    });

    expect(args).toEqual(["-y", `codemem@${__testUtils.PINNED_BACKEND_VERSION}`]);
  });

  test("pinned backend version matches package version", () => {
    const packageJsonPath = resolve(import.meta.dir, "..", "..", "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

    expect(__testUtils.PINNED_BACKEND_VERSION).toBe(packageJson.version);
  });
});
