import { describe, expect, test } from "vitest";

import { __testUtils } from "../plugins/codemem.js";

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

  test("omits overlong paths instead of truncating them", () => {
    const args = ["pack", "query"];

    expect(__testUtils.appendWorkingSetFileArgs(args, ["x".repeat(401)])).toEqual([
      "pack",
      "query",
    ]);
  });
});

describe("normalizeWorkingSetPath", () => {
  test("relativizes contained POSIX absolute paths without prefix false positives", () => {
    expect(
      __testUtils.normalizeWorkingSetPath(
        "/workspace/codemem/packages/core/src/pack.ts",
        "/workspace/codemem",
      ),
    ).toBe("packages/core/src/pack.ts");
    expect(
      __testUtils.normalizeWorkingSetPath(
        "/workspace/codemem-private/secret.ts",
        "/workspace/codemem",
      ),
    ).toBeNull();
    expect(
      __testUtils.normalizeWorkingSetPath(
        "/workspace/codemem/src/../secret.ts",
        "/workspace/codemem",
      ),
    ).toBeNull();
    expect(
      __testUtils.normalizeWorkingSetPath(
        "//workspace/codemem/packages/core/src/pack.ts",
        "/workspace/codemem",
      ),
    ).toBe("packages/core/src/pack.ts");
  });

  test("handles Windows-style containment on every host", () => {
    expect(
      __testUtils.normalizeWorkingSetPath(
        "c:\\workspace\\codemem\\packages\\core\\src\\pack.ts",
        "C:\\workspace\\codemem",
      ),
    ).toBe("packages/core/src/pack.ts");
    expect(
      __testUtils.normalizeWorkingSetPath(
        "C:\\workspace\\codemem-private\\secret.ts",
        "C:\\workspace\\codemem",
      ),
    ).toBeNull();
    expect(
      __testUtils.normalizeWorkingSetPath(
        "c:\\Workspace\\Codemem\\packages\\core\\src\\pack.ts",
        "C:\\workspace\\codemem",
      ),
    ).toBe("packages/core/src/pack.ts");
    expect(
      __testUtils.normalizeWorkingSetPath(
        "\\\\server\\share\\codemem\\src\\pack.ts",
        "\\\\server\\share\\codemem",
      ),
    ).toBe("src/pack.ts");
    expect(
      __testUtils.normalizeWorkingSetPath(
        "//server/share/codemem/src/pack.ts",
        "//server/share/codemem",
      ),
    ).toBe("src/pack.ts");
  });

  test("keeps safe relative paths and omits unsafe or overlong inputs", () => {
    const normalize = (value) =>
      __testUtils.normalizeWorkingSetPath(value, "/workspace/codemem");

    expect(normalize("packages/core/src/pack.ts")).toBe("packages/core/src/pack.ts");
    expect(normalize("packages\\core\\src\\pack.ts")).toBe("packages/core/src/pack.ts");
    expect(normalize("../private/secret.ts")).toBeNull();
    expect(normalize("packages/core/../private.ts")).toBeNull();
    expect(normalize("   ")).toBeNull();
    expect(normalize("x".repeat(401))).toBeNull();
    expect(normalize({ path: "packages/core/src/pack.ts" })).toBeNull();
    expect(normalize("/workspace/codemem")).toBeNull();
    expect(
      __testUtils.normalizeWorkingSetPath(
        "C:\\workspace\\codemem\\src\\pack.ts",
        "/workspace/codemem",
      ),
    ).toBeNull();
    expect(
      __testUtils.normalizeWorkingSetPath(
        "/Workspace/codemem/src/pack.ts",
        "/workspace/codemem",
      ),
    ).toBeNull();
  });

  test("deduplicates Windows paths case-insensitively while preserving first spelling", () => {
    const paths = new Set();

    expect(
      __testUtils.addWorkingSetPath(
        paths,
        "C:\\workspace\\codemem\\Src\\App.ts",
        "C:\\workspace\\codemem",
      ),
    ).toBe("Src/App.ts");
    expect(
      __testUtils.addWorkingSetPath(
        paths,
        "c:\\workspace\\codemem\\src\\app.ts",
        "C:\\workspace\\codemem",
      ),
    ).toBe("src/app.ts");
    expect([...paths]).toEqual(["Src/App.ts"]);
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
