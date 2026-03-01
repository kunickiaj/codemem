export const parseSemver = (value) => {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

export const isVersionAtLeast = (currentVersion, minVersion) => {
  const current = parseSemver(currentVersion);
  const minimum = parseSemver(minVersion);
  if (!current || !minimum) return false;
  for (let i = 0; i < 3; i += 1) {
    if (current[i] > minimum[i]) return true;
    if (current[i] < minimum[i]) return false;
  }
  return true;
};

export const resolveUpgradeGuidance = ({ runner, runnerFrom }) => {
  const normalizedRunner = String(runner || "").trim();
  const normalizedFrom = String(runnerFrom || "").trim();

  if (normalizedRunner === "uv") {
    return {
      mode: "uv-dev",
      action: "In your codemem repo, pull latest changes and run `uv sync`, then restart OpenCode.",
      note: "detected dev repo mode",
    };
  }

  if (normalizedRunner === "uvx") {
    if (normalizedFrom.startsWith("git+") || normalizedFrom.includes(".git")) {
      return {
        mode: "uvx-git",
        action: "Update CODEMEM_RUNNER_FROM to a newer git ref/source, then restart OpenCode.",
        note: "detected uvx git mode",
      };
    }
    return {
      mode: "uvx-custom",
      action: "Update CODEMEM_RUNNER_FROM to a newer source, then restart OpenCode.",
      note: "detected uvx custom source mode",
    };
  }

  return {
    mode: "generic",
    action: "Run `uv tool install --upgrade codemem`, then restart OpenCode.",
    note: "fallback guidance",
  };
};

export const parseBackendUpdatePolicy = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "notify";
  if (["notify", "auto", "off"].includes(normalized)) {
    return normalized;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return "auto";
  }
  if (["0", "false", "no"].includes(normalized)) {
    return "off";
  }
  return "notify";
};

const isPinnedGitSource = (runnerFrom) => {
  const source = String(runnerFrom || "").trim();
  if (!source) return false;
  if (!(source.startsWith("git+") || source.includes(".git"))) {
    return false;
  }
  const withoutQuery = source.replace(/[?#].*$/, "");
  if (withoutQuery.includes(".git@")) {
    return true;
  }
  if (!withoutQuery.startsWith("git+")) {
    return false;
  }
  const urlValue = withoutQuery.slice(4);
  try {
    const parsed = new URL(urlValue);
    const path = String(parsed.pathname || "");
    if (path.includes(".git@")) {
      return true;
    }
    return /@[^/]+$/.test(path);
  } catch {
    return /@[^/]+$/.test(withoutQuery);
  }
};

export const resolveAutoUpdatePlan = ({ runner, runnerFrom }) => {
  const normalizedRunner = String(runner || "").trim();
  const source = String(runnerFrom || "").trim();

  if (normalizedRunner === "uv") {
    return {
      allowed: false,
      reason: "dev-runner",
      command: null,
      commandText: null,
    };
  }

  if (normalizedRunner === "uvx") {
    if (!source) {
      return {
        allowed: false,
        reason: "missing-source",
        command: null,
        commandText: null,
      };
    }
    if (isPinnedGitSource(source)) {
      return {
        allowed: false,
        reason: "pinned-source",
        command: null,
        commandText: null,
      };
    }
    return {
      allowed: true,
      reason: null,
      command: ["uvx", "--refresh", "--from", source, "codemem", "version"],
      commandText: "uvx --refresh --from <source> codemem version",
    };
  }

  return {
    allowed: true,
    reason: null,
    command: ["uv", "tool", "install", "--upgrade", "codemem"],
    commandText: "uv tool install --upgrade codemem",
  };
};
