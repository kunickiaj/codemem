import { describe, expect, test } from "bun:test";

import { buildInjectionToastMessage } from "../plugin/codemem.js";

describe("buildInjectionToastMessage", () => {
  test("includes delta counts when present", () => {
    const message = buildInjectionToastMessage({
      items: 3,
      pack_tokens: 210,
      avoided_work_tokens: 4000,
      avoided_work_known_items: 1,
      avoided_work_unknown_items: 0,
      pack_delta_available: true,
      added_ids: [11, 22],
      removed_ids: [7],
    });

    expect(message).toContain("codemem injected");
    expect(message).toContain("3 items");
    expect(message).toContain("~210 tokens");
    expect(message).toContain("avoided work ~4000 tokens");
    expect(message).toContain("delta +2/-1");
  });

  test("omits delta segment when unavailable", () => {
    const message = buildInjectionToastMessage({
      items: 1,
      pack_tokens: 50,
      pack_delta_available: false,
      added_ids: [11],
      removed_ids: [7],
    });

    expect(message).toContain("codemem injected");
    expect(message).not.toContain("delta +");
  });

  test("omits avoided-work segment when breakdown metrics are missing", () => {
    const message = buildInjectionToastMessage({
      items: 2,
      pack_tokens: 100,
      avoided_work_tokens: 4000,
    });

    expect(message).not.toContain("avoided work ~");
  });

  test("omits avoided-work segment when unknown breakdown exceeds known", () => {
    const message = buildInjectionToastMessage({
      items: 2,
      pack_tokens: 100,
      avoided_work_tokens: 4000,
      avoided_work_known_items: 1,
      avoided_work_unknown_items: 3,
    });

    expect(message).not.toContain("avoided work ~");
  });

  test("handles non-finite and negative numeric values defensively", () => {
    const message = buildInjectionToastMessage({
      items: Number.NaN,
      pack_tokens: Number.POSITIVE_INFINITY,
      avoided_work_tokens: -10,
      avoided_work_known_items: -1,
      avoided_work_unknown_items: 2,
      pack_delta_available: true,
      added_ids: -5,
      removed_ids: Number.NaN,
    });

    expect(message).toBe("codemem injected · delta +0/-0");
    expect(message).not.toContain(" items");
    expect(message).not.toContain("~");
    expect(message).not.toContain("avoided work");
  });

  test("handles undefined metrics defensively", () => {
    expect(buildInjectionToastMessage(undefined)).toBe("codemem injected");
  });
});
