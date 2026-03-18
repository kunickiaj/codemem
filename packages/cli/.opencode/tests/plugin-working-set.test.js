import { describe, expect, test } from "bun:test";

import { __testUtils } from "../plugin/codemem.js";

describe("appendWorkingSetFileArgs", () => {
  test("adds one CLI flag per path", () => {
    const args = ["pack", "query"];
    const updated = __testUtils.appendWorkingSetFileArgs(args, [
      "src/a.py",
      "src/b.py",
    ]);
    expect(updated).toEqual([
      "pack",
      "query",
      "--working-set-file",
      "src/a.py",
      "--working-set-file",
      "src/b.py",
    ]);
  });
});

describe("extractApplyPatchPaths", () => {
  test("extracts file paths from apply_patch payload", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Update File: codemem/store/search.py",
      "@@",
      "*** Add File: .opencode/tests/new.test.js",
      "*** End Patch",
    ].join("\n");
    expect(__testUtils.extractApplyPatchPaths(patchText)).toEqual([
      "codemem/store/search.py",
      ".opencode/tests/new.test.js",
    ]);
  });
});
