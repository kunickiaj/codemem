import { describe, expect, test } from "bun:test";

import {
  isVersionAtLeast,
  parseBackendUpdatePolicy,
  parseSemver,
  resolveAutoUpdatePlan,
  resolveUpgradeGuidance,
} from "../lib/compat.js";

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

describe("parseBackendUpdatePolicy", () => {
  test("defaults to notify", () => {
    expect(parseBackendUpdatePolicy("")).toBe("notify");
    expect(parseBackendUpdatePolicy(undefined)).toBe("notify");
  });

  test("supports explicit modes", () => {
    expect(parseBackendUpdatePolicy("notify")).toBe("notify");
    expect(parseBackendUpdatePolicy("auto")).toBe("auto");
    expect(parseBackendUpdatePolicy("off")).toBe("off");
  });

  test("maps boolean-like values", () => {
    expect(parseBackendUpdatePolicy("1")).toBe("auto");
    expect(parseBackendUpdatePolicy("true")).toBe("auto");
    expect(parseBackendUpdatePolicy("0")).toBe("off");
    expect(parseBackendUpdatePolicy("false")).toBe("off");
  });
});

describe("resolveAutoUpdatePlan", () => {
  test("blocks auto-update in uv dev mode", () => {
    const plan = resolveAutoUpdatePlan({ runner: "uv", runnerFrom: "/tmp/codemem" });
    expect(plan.allowed).toBe(false);
    expect(plan.reason).toBe("dev-runner");
  });

  test("returns uvx refresh command for unpinned git source", () => {
    const plan = resolveAutoUpdatePlan({
      runner: "uvx",
      runnerFrom: "git+https://github.com/kunickiaj/codemem.git",
    });
    expect(plan.allowed).toBe(true);
    expect(plan.command).toEqual([
      "uvx",
      "--refresh",
      "--from",
      "git+https://github.com/kunickiaj/codemem.git",
      "codemem",
      "version",
    ]);
  });

  test("blocks auto-update for pinned git source", () => {
    const plan = resolveAutoUpdatePlan({
      runner: "uvx",
      runnerFrom: "git+https://github.com/kunickiaj/codemem.git@v0.14.0",
    });
    expect(plan.allowed).toBe(false);
    expect(plan.reason).toBe("pinned-source");
  });

  test("allows unpinned ssh git source", () => {
    const plan = resolveAutoUpdatePlan({
      runner: "uvx",
      runnerFrom: "git+ssh://git@github.com/kunickiaj/codemem.git",
    });
    expect(plan.allowed).toBe(true);
  });

  test("blocks pinned ssh git source", () => {
    const plan = resolveAutoUpdatePlan({
      runner: "uvx",
      runnerFrom: "git+ssh://git@github.com/kunickiaj/codemem.git@v0.14.1",
    });
    expect(plan.allowed).toBe(false);
    expect(plan.reason).toBe("pinned-source");
  });

  test("blocks auto-update when uvx source missing", () => {
    const plan = resolveAutoUpdatePlan({ runner: "uvx", runnerFrom: "" });
    expect(plan.allowed).toBe(false);
    expect(plan.reason).toBe("missing-source");
  });

  test("allows unpinned git source with query string", () => {
    const plan = resolveAutoUpdatePlan({
      runner: "uvx",
      runnerFrom: "git+https://github.com/kunickiaj/codemem.git?subdirectory=plugin",
    });
    expect(plan.allowed).toBe(true);
  });

  test("blocks pinned git source with fragment", () => {
    const plan = resolveAutoUpdatePlan({
      runner: "uvx",
      runnerFrom: "git+https://github.com/kunickiaj/codemem.git@v0.14.1#egg=codemem",
    });
    expect(plan.allowed).toBe(false);
    expect(plan.reason).toBe("pinned-source");
  });
});
