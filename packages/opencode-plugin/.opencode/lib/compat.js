export const parseSemver = (value) => {
  const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-.*)?$/);
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

  if (normalizedRunner === "node") {
    return {
      mode: "node-dev",
      action: "In your codemem repo, pull latest changes and run `pnpm build`, then restart OpenCode.",
      note: "detected TS dev mode",
    };
  }

  if (normalizedRunner === "codemem") {
    return {
      mode: "global",
      action:
        "Run `npm install -g codemem` to update the CLI and its optional semantic runtime, then restart OpenCode. On Linux, prefix with `ONNXRUNTIME_NODE_INSTALL=skip` to avoid the unused GPU provider download.",
      note: "detected global codemem runner mode",
    };
  }

  if (normalizedRunner === "npx") {
    return {
      mode: "npx",
      action:
        "Run `npm install -g codemem` to update the CLI and its optional semantic runtime, then restart OpenCode. On Linux, prefix with `ONNXRUNTIME_NODE_INSTALL=skip` to avoid the unused GPU provider download.",
      note: "detected npx runner mode",
    };
  }

  if (normalizedRunner === "uv") {
    return {
      mode: "repo-dev",
      action: "In your codemem repo, pull latest changes and run `pnpm install` and `pnpm build`, then restart OpenCode.",
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
    action: "Update codemem using your normal install method, then restart OpenCode.",
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

const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org/";

const createNpmUpdatePlan = (targetVersion) => {
	const command = [
		"npm",
		"install",
		"-g",
		"--registry",
		PUBLIC_NPM_REGISTRY,
		`--@codemem:registry=${PUBLIC_NPM_REGISTRY}`,
		`codemem@${targetVersion}`,
		`@codemem/embeddings@${targetVersion}`,
	];
	return { allowed: true, reason: null, command, commandText: command.join(" ") };
};

export const resolveAutoUpdatePlan = ({
	runner,
	runnerFrom,
	runnerFromExplicit = false,
	targetVersion = "latest",
	platform = process.platform,
}) => {
	const normalizedRunner = String(runner || "").trim();
	const source = String(runnerFrom || "").trim();
	const normalizedTargetVersion = String(targetVersion || "").trim();
	if (platform === "win32") {
		return { allowed: false, reason: "unsupported-platform", command: null, commandText: null };
	}
	if (normalizedTargetVersion !== "latest" && !/^\d+\.\d+\.\d+$/.test(normalizedTargetVersion)) {
		return { allowed: false, reason: "invalid-version", command: null, commandText: null };
	}
	if (isPinnedGitSource(source) || /^codemem@(?!latest$|next$|\*$)[^\s]+$/i.test(source)) {
		return {
			allowed: false,
			reason: "pinned-source",
			command: null,
			commandText: null,
		};
	}

  if (normalizedRunner === "node") {
    return {
      allowed: false,
      reason: "dev-runner",
      command: null,
      commandText: null,
    };
  }

	if (normalizedRunner === "npx") {
		if (!runnerFromExplicit || !/^(?:codemem|codemem@(?:latest|next|\*))$/i.test(source)) {
			return {
				allowed: false,
				reason: !runnerFromExplicit ? "implicit-pinned-source" : "custom-source",
				command: null,
				commandText: null,
			};
		}
		return createNpmUpdatePlan(normalizedTargetVersion);
  }

  if (normalizedRunner === "uv") {
    return {
      allowed: false,
      reason: "dev-runner",
      command: null,
      commandText: null,
    };
  }

  if (normalizedRunner === "uvx") {
    return {
      allowed: false,
      reason: !source ? "missing-source" : isPinnedGitSource(source) ? "pinned-source" : "custom-source",
      command: null,
      commandText: null,
    };
  }

	if (normalizedRunner === "codemem") {
		return createNpmUpdatePlan(normalizedTargetVersion);
	}

	return { allowed: false, reason: "unknown-runner", command: null, commandText: null };
};
