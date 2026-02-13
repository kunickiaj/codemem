import { describe, expect, test } from "bun:test";

import { isVersionAtLeast, parseSemver, resolveUpgradeGuidance } from "../lib/compat.js";

describe("parseSemver", () => {
  test("parses x.y.z versions", () => {
    expect(parseSemver("0.10.2")).toEqual([0, 10, 2]);
  });

  test("returns null for unparseable values", () => {
    expect(parseSemver("v-next")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("isVersionAtLeast", () => {
  test("compares semantic versions", () => {
    expect(isVersionAtLeast("0.10.2", "0.10.2")).toBe(true);
    expect(isVersionAtLeast("0.10.3", "0.10.2")).toBe(true);
    expect(isVersionAtLeast("0.9.9", "0.10.2")).toBe(false);
  });

  test("treats unparseable versions as incompatible", () => {
    expect(isVersionAtLeast("v-next", "0.10.2")).toBe(false);
    expect(isVersionAtLeast("0.10.2", "v-next")).toBe(false);
  });
});

describe("resolveUpgradeGuidance", () => {
  test("returns uv-dev guidance", () => {
    const guidance = resolveUpgradeGuidance({
      runner: "uv",
      runnerFrom: "/tmp/codemem",
    });
    expect(guidance.mode).toBe("uv-dev");
    expect(guidance.action).toContain("uv sync");
  });

  test("returns uvx-git guidance", () => {
    const guidance = resolveUpgradeGuidance({
      runner: "uvx",
      runnerFrom: "git+https://github.com/kunickiaj/codemem.git",
    });
    expect(guidance.mode).toBe("uvx-git");
    expect(guidance.action).toContain("CODEMEM_RUNNER_FROM");
  });

  test("returns uvx-custom guidance", () => {
    const guidance = resolveUpgradeGuidance({
      runner: "uvx",
      runnerFrom: "./local/dist",
    });
    expect(guidance.mode).toBe("uvx-custom");
  });

  test("returns generic fallback guidance", () => {
    const guidance = resolveUpgradeGuidance({
      runner: "node",
      runnerFrom: "",
    });
    expect(guidance.mode).toBe("generic");
    expect(guidance.action).toContain("uv tool install --upgrade codemem");
  });
});
