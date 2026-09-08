import { describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { __testUtils as utils } from "../plugins/codemem.js";

const user = (id, text = "substantive request", sessionID = "session") => ({
  info: { id, sessionID, role: "user" },
  parts: [{ id: `${id}-text`, type: "text", text }],
});
const block = (entry, text) => ({
  id: `codemem-context-${entry.info.id}`,
  sessionID: entry.info.sessionID,
  messageID: entry.info.id,
  type: "text", synthetic: true, text,
});
const setup = (overrides = {}) => ({
  injectEnabled: true, input: {}, injectionToastShown: new Set(),
  resolveInjectQuery: ({ lastPromptText }) => lastPromptText,
  buildInjectedContext: vi.fn().mockResolvedValue({ text: "[codemem context]\nabc" }),
  messageInjectionCache: new Map(), ...overrides,
});
const apply = (options, messages) => utils.applyInjectedContextToMessages({ ...options, output: { messages } });

const structuredPack = (contents) => {
  let text = "## Summary\n";
  const rendered_items = contents.map(([id, body]) => {
    const start = text.length;
    text += `[${id}] ${body}`;
    const end = text.length;
    text += "\n";
    return { id, fingerprint: createHash("sha256").update(body).digest("hex"), spans: [{ start, end }] };
  });
  return {
    pack_text: text, rendered_items,
    metrics: { total_items: rendered_items.length },
    items: rendered_items.map(({ id }) => ({ id })),
    item_ids: rendered_items.map(({ id }) => id),
  };
};

describe("retained memory deduplication", () => {
  test("metadata coverage distinguishes missing, invalid, and recovered retained blocks", () => {
    const entry = user("metadata");
    const part = block(entry, "[codemem context]\nfacts");
    entry.parts.push(part);
    expect(utils.retainedMetadataGaps([entry])).toEqual({ missingRetainedMetadata: true, invalidRetainedMetadata: false });
    part.metadata = { codemem: { v: 1, digest: "invalid", items: [] } };
    expect(utils.retainedMetadataGaps([entry])).toEqual({ missingRetainedMetadata: false, invalidRetainedMetadata: true });
    const cached = { ...part, metadata: { codemem: {
      v: 1, digest: createHash("sha256").update(part.text).digest("hex"), items: [{ id: 1, fingerprint: "a".repeat(64) }],
    } } };
    const cache = new Map([["metadata", { parts: [cached] }]]);
    expect(utils.retainedMetadataGaps([entry], cache)).toEqual({ missingRetainedMetadata: false, invalidRetainedMetadata: false });
    expect(utils.retainedMetadataGaps([])).toEqual({ missingRetainedMetadata: false, invalidRetainedMetadata: false });
  });

  test("keeps validated cached recall metadata when the host strips it from identical text", async () => {
    const pack = structuredPack([[1, "facts"]]);
    const text = `[codemem context]\n${pack.pack_text}`;
    const recall = { v: 1, digest: createHash("sha256").update(text).digest("hex"), items: pack.rendered_items };
    const options = setup({ buildInjectedContext: vi.fn().mockResolvedValueOnce({ text, recall }) });
    const first = user("one");
    await apply(options, [first]);
    const replay = JSON.parse(JSON.stringify(first));
    delete replay.parts.at(-1).metadata;
    const hostBytes = JSON.stringify(replay);
    options.buildInjectedContext.mockImplementationOnce((_query, context) => {
      expect(utils.filterRetainedPack(JSON.stringify(pack), pack.pack_text, context.retainedItems).text).toBe("");
      return { text: "", duplicates: 1, skipReason: "unchanged_memories" };
    });
    await apply(options, [replay, user("two")]);
    expect(JSON.stringify(replay)).toBe(hostBytes);
    expect(options.messageInjectionCache.get("session").get("one").parts[0].metadata.codemem).toEqual(recall);
    replay.parts.at(-1).text += " changed";
    expect(utils.retainedMemoryFingerprints([replay], options.messageInjectionCache.get("session")).size).toBe(0);
  });

  test("working-context digest reads only bounded tool scalars, never outputs or cyclic bodies", () => {
    const tool = { id: "part-tool", type: "tool", callID: "call-one", state: { status: "completed" } };
    const fail = () => { throw new Error("payload accessed"); };
    for (const key of ["result", "body", "args", "output"]) {
      Object.defineProperty(tool, key, { enumerable: true, get: fail });
      Object.defineProperty(tool.state, key, { enumerable: true, get: fail });
    }
    tool.state.cycle = tool;
    const messages = [{ info: { id: "assistant" }, parts: [tool] }];
    const digest = utils.workingContextDigest(messages, ["src/a.ts"]);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(utils.workingContextDigest(messages, ["src/a.ts"])).toBe(digest);
    tool.callID = "call-two";
    expect(utils.workingContextDigest(messages, ["src/a.ts"])).not.toBe(digest);
    expect(utils.workingContextDigest(messages, ["src/b.ts"])).not.toBe(digest);
  });

  test("partial or skewed rendered metadata never suppresses unlisted new facts", () => {
    const pack = structuredPack([[1, "old facts"], [2, "new facts"], [3, "more new facts"]]);
    const retained = new Set([`1:${pack.rendered_items[0].fingerprint}`]);
    pack.rendered_items = pack.rendered_items.slice(0, 1);
    expect(utils.filterRetainedPack(JSON.stringify(pack), pack.pack_text, retained)).toMatchObject({ text: pack.pack_text, duplicates: 0 });
    pack.metrics.total_items = 1;
    expect(utils.filterRetainedPack(JSON.stringify(pack), pack.pack_text, retained).text).toBe(pack.pack_text);
    pack.items = [{ id: 999 }];
    expect(utils.filterRetainedPack(JSON.stringify(pack), pack.pack_text, retained).text).toBe(pack.pack_text);
  });

  test.each(["continue", "Proceed.", "go on", "keep going!"])("recognizes only evidenced continuation: %s", (prompt) => {
    const first = user("one");
    const part = block(first, "[codemem context]\nfacts");
    part.metadata = { codemem: { v: 1, digest: createHash("sha256").update(part.text).digest("hex"), workingContext: "same" } };
    first.parts.push(part);
    const messages = [first, user("two", prompt)];
    expect(utils.isContinuationOnly(prompt, messages, "same")).toBe(true);
    expect(utils.isContinuationOnly(prompt, messages, "changed")).toBe(false);
    expect(utils.isContinuationOnly(prompt, [user("two", prompt)], "same")).toBe(false);
  });

  test.each(["recall", "remember that?", "why?", "fix auth", "continue with Redis", "yes", "ok"])("keeps substantive, explicit or ambiguous short prompt eligible: %s", (prompt) => {
    expect(utils.isContinuationOnly(prompt, [user("one"), user("two", prompt)], "same")).toBe(false);
  });

  test("omits unchanged items, keeps changed facts and new items without parsing prose", () => {
    const first = structuredPack([[1, "old facts"]]);
    const retained = new Set([`1:${first.rendered_items[0].fingerprint}`]);
    const mixed = structuredPack([[1, "old facts"], [2, "## Summary\n[1] looks like a header"]]);
    const filtered = utils.filterRetainedPack(JSON.stringify(mixed), mixed.pack_text, retained);
    expect(filtered.duplicates).toBe(1);
    expect(filtered.items.map((item) => item.id)).toEqual([2]);
    expect(filtered.text).toContain("[1] looks like a header");
    expect(filtered.text).not.toContain("old facts");
    const changed = structuredPack([[1, "new facts"]]);
    expect(utils.filterRetainedPack(JSON.stringify(changed), changed.pack_text, retained).duplicates).toBe(0);
    expect(utils.filterRetainedPack(JSON.stringify(first), first.pack_text, retained).text).toBe("");
  });

  test("reconstructs fingerprint eligibility from actual retained parts only", () => {
    const pack = structuredPack([[1, "facts"]]);
    const entry = user("one");
    const text = `[codemem context]\n${pack.pack_text}`;
    const part = block(entry, text);
    part.metadata = { codemem: {
      v: 1, digest: createHash("sha256").update(text).digest("hex"), items: pack.rendered_items,
    } };
    entry.parts.push(part);
    expect(utils.retainedMemoryFingerprints([entry]).size).toBe(1);
    expect(utils.retainedMemoryFingerprints([]).size).toBe(0);
    const reconstructed = JSON.parse(JSON.stringify(entry));
    expect(utils.retainedMemoryFingerprints([reconstructed]).size).toBe(1);
    reconstructed.parts.at(-1).text += " changed";
    expect(utils.retainedMemoryFingerprints([reconstructed]).size).toBe(0);
    delete part.metadata;
    expect(utils.retainedMemoryFingerprints([entry]).size).toBe(0);
  });

  test("legacy and malformed renderer metadata never falsely suppress memories", () => {
    const pack = structuredPack([[1, "facts"]]);
    const retained = new Set([`1:${pack.rendered_items[0].fingerprint}`]);
    pack.rendered_items[0].spans[0].end = 999999;
    expect(utils.filterRetainedPack(JSON.stringify(pack), pack.pack_text, retained).text).toBe(pack.pack_text);
    expect(utils.filterRetainedPack("{}", pack.pack_text, retained).text).toBe(pack.pack_text);
    expect(utils.filterRetainedPack("null", pack.pack_text, retained).text).toBe(pack.pack_text);
    pack.rendered_items = [null];
    expect(utils.filterRetainedPack(JSON.stringify(pack), pack.pack_text, retained).text).toBe(pack.pack_text);
  });
});

describe("retained automatic recall lifecycle", () => {
  test("compaction adopts no-session host parts and replays them on an ordinary transform", async () => {
    const first = user("one");
    delete first.info.sessionID;
    const retained = block(first, "[codemem context]\nretained during compaction");
    delete retained.sessionID;
    first.parts.push(retained);
    const options = setup({ input: { sessionID: "session" }, compactionInjectionSkips: new Map([["session", Date.now() + 10000]]) });
    await apply(options, [first]);
    const replay = user("one");
    delete replay.info.sessionID;
    await apply(options, [replay]);
    expect(replay.parts.at(-1).text).toBe(retained.text);
    expect(options.buildInjectedContext).not.toHaveBeenCalled();
  });

  test.each(["unchanged_memories", "continuation_only"])("updates the existing retrieval attempt for %s instead of recording another", async (skipReason) => {
    const records = new Map();
    const recordSkipped = vi.fn();
    const confirmDelivery = vi.fn((id, status) => { records.get(id).status = status; });
    const buildInjectedContext = vi.fn(() => {
      records.set("attempt", { status: "not_attempted" });
      return { text: "", attemptId: "attempt", skipReason, duplicates: 1 };
    });
    await apply(setup({ recordSkipped, confirmDelivery, buildInjectedContext }), [user("one")]);
    expect(records.size).toBe(1);
    expect(records.get("attempt").status).toBe("unknown");
    expect(recordSkipped).not.toHaveBeenCalled();
    expect(confirmDelivery).toHaveBeenCalledExactlyOnceWith("attempt", "unknown");
  });

  test.each([undefined, "", "0", "-1", "1.5", "8000oops", "Infinity", "9007199254740992"])("uses retained default for invalid value %s", (value) => {
    expect(utils.resolveRetainedTokenBudget(value)).toBe(Infinity);
  });

  test("accepts positive safe integer retained overrides", () => {
    expect(utils.resolveRetainedTokenBudget("1200")).toBe(1200);
  });

  test("default does not cap retained history above 8000 tokens", async () => {
    const first = user("one");
    first.parts.push(block(first, "x".repeat(33000)));
    const options = setup();
    await apply(options, [first, user("two")]);
    expect(options.buildInjectedContext).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ tokenBudget: 800 }));
    expect(first.parts.at(-1).text).toBe("x".repeat(33000));
  });

  test("measurements reconcile actual blocks and never count replay as new delivery", async () => {
    const recordMeasurement = vi.fn();
    const options = setup({ recordMeasurement });
    const entry = user("one");
    await apply(options, [entry]);
    await apply(options, [entry]);
    await apply({ ...options, messageInjectionCache: new Map() }, [entry]);
    expect(recordMeasurement.mock.calls.map(([value]) => value)).toEqual([
      { new_tokens: 6, retained_tokens: 6, duplicates_omitted: 0, reason: "delivered" },
      { new_tokens: 0, retained_tokens: 6, duplicates_omitted: 0, reason: "replay" },
      { new_tokens: 0, retained_tokens: 6, duplicates_omitted: 0, reason: "replay" },
    ]);
  });

  test("failed delivery reports zero new tokens and measurement failures cannot block recall", async () => {
    const recordMeasurement = vi.fn();
    const entry = user("one");
    Object.freeze(entry.parts);
    await expect(apply(setup({ recordMeasurement }), [entry])).rejects.toThrow();
    expect(recordMeasurement).toHaveBeenCalledWith({ new_tokens: 0, retained_tokens: 0, duplicates_omitted: 0, reason: "delivery_failed" });
    const retry = user("one");
    await apply(setup({ recordMeasurement: () => { throw new Error("unavailable"); } }), [retry]);
    expect(retry.parts).toHaveLength(2);
  });

  test("zero-injection measurements use bounded reasons and contain no prompt content", async () => {
    const recordMeasurement = vi.fn();
    const options = setup({ recordMeasurement, retainedTokenBudget: 1 });
    await apply(options, [user("one", "private prompt /sensitive/path")]);
    expect(recordMeasurement).toHaveBeenCalledWith({ new_tokens: 0, retained_tokens: 0, duplicates_omitted: 0, reason: "allowance_exhausted" });
    expect(JSON.stringify(recordMeasurement.mock.calls)).not.toContain("private");
  });

  test("counts full blocks, caps remaining allowance and never charges replay", async () => {
    const options = setup({ retainedTokenBudget: 12 });
    const first = user("one");
    await apply(options, [first]);
    const bytes = first.parts.at(-1).text;
    const used = utils.estimateTokens(bytes);
    const second = user("two");
    await apply(options, [first, second]);
    expect(options.buildInjectedContext.mock.calls[1][1].tokenBudget).toBe(12 - used);
    await apply(options, [first, second]);
    expect(options.buildInjectedContext).toHaveBeenCalledTimes(2);
    expect(first.parts.at(-1).text).toBe(bytes);
    expect(utils.countRetainedInjectionTokens([first, second])).toBe(used * 2);
  });

  test("exhaustion and lowered ceilings preserve reconstructed latest bytes", async () => {
    const first = user("one");
    first.parts.push(block(first, "[codemem context]\n" + "x".repeat(100)));
    const before = JSON.stringify(first);
    const options = setup({ retainedTokenBudget: 1, recordSkipped: vi.fn() });
    await apply(options, [first]);
    await apply(options, [first, user("two")]);
    expect(options.buildInjectedContext).not.toHaveBeenCalled();
    expect(JSON.stringify(first)).toBe(before);
    expect(options.recordSkipped).toHaveBeenCalledWith("allowance_exhausted", "session");
  });

  test("notification alone cannot release allowance, actual absence can", async () => {
    const options = setup({ retainedTokenBudget: 6, compactionInjectionSkips: new Map() });
    const first = user("one");
    await apply(options, [first]);
    options.compactionInjectionSkips.set("session", Date.now() + 10000);
    await apply(options, []);
    // A compaction transform with identified session must not prune replay state.
    options.input = { sessionID: "session" };
    await apply(options, []);
    await apply(options, [user("one"), user("two")]);
    expect(options.buildInjectedContext).toHaveBeenCalledTimes(1);
    await apply(options, [user("two")]);
    expect(options.buildInjectedContext).toHaveBeenCalledTimes(2);
    expect(options.messageInjectionCache.get("session").has("one")).toBe(false);
  });

  test("adopts more than 100 host blocks without stripping any or forgetting usage", async () => {
    const messages = Array.from({ length: 125 }, (_, i) => {
      const entry = user(`old-${i}`);
      entry.parts.push(block(entry, "[codemem context]\nx"));
      return entry;
    });
    const before = JSON.stringify(messages);
    const options = setup({ retainedTokenBudget: 100 });
    await apply(options, messages);
    expect(JSON.stringify(messages)).toBe(before);
    const replay = messages.map((entry) => user(entry.info.id));
    await apply(options, [...replay, user("new")]);
    expect(utils.countRetainedInjectionTokens(replay)).toBe(125 * 5);
    expect(options.buildInjectedContext).not.toHaveBeenCalled();
  });

  test("failed attachment consumes no allowance and does not cache undelivered bytes", async () => {
    const options = setup();
    const first = user("one");
    Object.freeze(first.parts);
    await expect(apply(options, [first])).rejects.toThrow();
    expect(options.messageInjectionCache.get("session").size).toBe(0);
    const retry = user("one");
    await apply(options, [retry]);
    expect(options.buildInjectedContext).toHaveBeenCalledTimes(2);
    expect(utils.countRetainedInjectionTokens([retry])).toBe(6);
  });

  test("sessions cannot share replay entries or allowance", async () => {
    const options = setup({ retainedTokenBudget: 6 });
    await apply(options, [user("one")]);
    const other = user("one", "other prompt", "other-session");
    await apply(options, [other]);
    expect(options.buildInjectedContext).toHaveBeenCalledTimes(2);
    expect(options.messageInjectionCache.size).toBe(2);
  });

  test("foreign-session blocks do not consume or inflate current-session allowance", async () => {
    const foreign = user("foreign", "old prompt", "foreign-session");
    foreign.parts.push(block(foreign, "[codemem context]\n" + "x".repeat(200)));
    const current = user("current", "new prompt", "current-session");
    const recordMeasurement = vi.fn();
    const options = setup({
      input: { sessionID: "current-session" },
      retainedTokenBudget: 12,
      recordMeasurement,
    });

    await apply(options, [current, foreign]);

    expect(options.buildInjectedContext).toHaveBeenCalledTimes(1);
    expect(options.buildInjectedContext).toHaveBeenCalledWith(
      "new prompt",
      expect.objectContaining({ sessionID: "current-session", tokenBudget: 12 }),
    );
    expect(foreign.parts.at(-1).text).toBe("[codemem context]\n" + "x".repeat(200));
    expect(current.parts.at(-1).text).toBe("[codemem context]\nabc");
    expect(recordMeasurement).toHaveBeenCalledWith({
      new_tokens: 6,
      retained_tokens: 6,
      duplicates_omitted: 0,
      reason: "delivered",
    });
  });

  test("overlapping same-message transforms deliver and charge a block only once", async () => {
    const releases = [];
    const recordMeasurement = vi.fn();
    const confirmDelivery = vi.fn();
    const recordCacheReuse = vi.fn(() => "replay-attempt");
    const options = setup({
      recordMeasurement,
      confirmDelivery,
      recordCacheReuse,
      buildInjectedContext: () => new Promise((resolve) => releases.push(resolve)),
    });
    const first = user("one");
    const second = user("one");
    const requests = [apply(options, [first]), apply(options, [second])];
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]({
      text: "[codemem context]\nfirst",
      attemptId: "winner-attempt",
    });
    await requests[0];
    releases[1]({
      text: "[codemem context]\nsecond",
      attemptId: "losing-attempt",
      duplicates: 2,
    });
    await requests[1];
    expect(second.parts.at(-1).text).toBe(first.parts.at(-1).text);
    expect(recordMeasurement.mock.calls.map(([value]) => value.reason)).toEqual([
      "delivered",
      "replay",
    ]);
    expect(recordMeasurement.mock.calls[1][0].new_tokens).toBe(0);
    expect(recordMeasurement.mock.calls[1][0].duplicates_omitted).toBe(2);
    expect(recordCacheReuse).toHaveBeenCalledTimes(1);
    expect(confirmDelivery).toHaveBeenCalledWith(
      "winner-attempt",
      "handed_off",
    );
    expect(confirmDelivery).toHaveBeenCalledWith("replay-attempt");
    expect(confirmDelivery).toHaveBeenCalledWith("losing-attempt", "unknown");
  });

  test("rejects an oversized backend result without changing history", async () => {
    const confirmDelivery = vi.fn();
    const options = setup({
      retainedTokenBudget: 6,
      confirmDelivery,
      buildInjectedContext: vi.fn().mockResolvedValue({ text: "x".repeat(100), attemptId: "rejected-attempt" }),
    });
    const entry = user("one");
    await apply(options, [entry]);
    expect(entry.parts).toHaveLength(1);
    expect(options.messageInjectionCache.get("session").size).toBe(0);
    expect(confirmDelivery).toHaveBeenCalledExactlyOnceWith("rejected-attempt", "failed");
  });
});
