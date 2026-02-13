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
        action: `Update CODEMEM_RUNNER_FROM to a newer git ref/source (current: ${normalizedFrom || "<unset>"}), then restart OpenCode.`,
        note: "detected uvx git mode",
      };
    }
    return {
      mode: "uvx-custom",
      action: `Update CODEMEM_RUNNER_FROM to a newer source (current: ${normalizedFrom || "<unset>"}), then restart OpenCode.`,
      note: "detected uvx custom source mode",
    };
  }

  return {
    mode: "generic",
    action: "Run `uv tool install --upgrade codemem`, then restart OpenCode.",
    note: "fallback guidance",
  };
};
