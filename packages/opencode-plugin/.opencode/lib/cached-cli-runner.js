import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const executeFile = (...args) => promisify(execFile)(...args);
const PROBE_PATH = fileURLToPath(new URL("./cli-runner-probe.js", import.meta.url));
const MAX_OUTPUT_BYTES = 16 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const BOOTSTRAP_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 30_000;

const readManifest = (path) => {
  if (statSync(path).size > 64 * 1024) throw new Error("manifest_unavailable");
  return JSON.parse(readFileSync(path, "utf8"));
};

const isContainedPath = (root, path) => {
  const child = relative(root, path);
  return !!child && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

const containedFile = (root, path) => {
  const canonicalPath = realpathSync(path);
  if (!isContainedPath(realpathSync(root), canonicalPath) || !statSync(canonicalPath).isFile()) {
    throw new Error("entrypoint_unavailable");
  }
  return canonicalPath;
};

const fileStamp = (path) => {
  const canonicalPath = realpathSync(path);
  const stat = statSync(canonicalPath);
  if (!stat.isFile()) throw new Error("entrypoint_unavailable");
  return [canonicalPath, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
};

const candidateStamp = (candidate) => JSON.stringify(candidate.files.map(fileStamp));

export const isCachedCliCurrent = (candidate) => {
  try {
    return candidateStamp(candidate) === candidate.stamp;
  } catch {
    return false;
  }
};

const readEmbeddings = (entrypoint, version) => {
  // Use Node's lookup paths without requiring the package's private manifest
  // subpath to be exported. Exclude CJS global folders, which ESM cannot import.
  const paths = createRequire(entrypoint).resolve.paths("@codemem/embeddings") || [];
  const manifestPath = paths.filter((path) => isContainedPath(dirname(path), entrypoint))
    .map((path) => join(path, "@codemem/embeddings/package.json")).find(existsSync);
  const manifest = readManifest(manifestPath);
  if (manifest.name !== "@codemem/embeddings" || manifest.version !== version) {
    throw new Error("embeddings_unavailable");
  }
  const exported = manifest.exports?.["."]?.import;
  if (typeof exported !== "string") throw new Error("embeddings_unavailable");
  const entry = containedFile(dirname(manifestPath), resolve(dirname(manifestPath), exported));
  return [manifestPath, entry];
};

const readCandidate = (manifestPath, { nodePath, executable, expectedVersion }) => {
  const manifest = readManifest(manifestPath);
  if (manifest.name !== "codemem" || typeof manifest.version !== "string"
    || typeof manifest.bin?.codemem !== "string") throw new Error("package_unavailable");
  if (expectedVersion && manifest.version !== expectedVersion) throw new Error("version_mismatch");
  const entrypoint = containedFile(dirname(manifestPath), resolve(dirname(manifestPath), manifest.bin.codemem));
  // POSIX package bins are symlinks. Windows command shims are not JS files;
  // resolve their package metadata instead of parsing or executing the shim.
  if (executable && !executable.endsWith(".cmd") && realpathSync(executable) !== entrypoint) {
    throw new Error("entrypoint_mismatch");
  }
  const files = [nodePath, manifestPath, entrypoint];
  if (executable) files.push(executable);
  if (expectedVersion) files.push(...readEmbeddings(entrypoint, expectedVersion));
  const candidate = { command: realpathSync(nodePath), args: [entrypoint], version: manifest.version, files,
    manifestPath, executable };
  return { ...candidate, stamp: candidateStamp(candidate) };
};

const pathCandidateManifests = ({ path, selectedOnly }) => {
  const candidates = [];
  for (const directory of String(path || "").slice(0, 32_768).split(delimiter).slice(0, 128)) {
    if (!isAbsolute(directory)) continue;
    const executable = join(directory, process.platform === "win32" ? "codemem.cmd" : "codemem");
    if (selectedOnly && !existsSync(executable)) continue;
    try {
      const anchor = realpathSync(executable);
      const manifestPath = createRequire(anchor).resolve("codemem/package.json");
      candidates.push({ manifestPath, executable });
    } catch { /* Check only named executable files, never enumerate cache directories. */ }
    // Do not bypass a selected shim for another CLI later on PATH or in the
    // plugin's dependencies. Keep its legacy invocation if it cannot be resolved.
    if (selectedOnly) return candidates;
  }
  return candidates;
};

const candidateManifests = ({ path, bootstrap, selectedOnly }) => {
  const candidates = pathCandidateManifests({ path, selectedOnly });
  if (!bootstrap && !selectedOnly) {
    try { candidates.push({ manifestPath: createRequire(import.meta.url).resolve("codemem/package.json") }); }
    catch { /* The plugin need not depend on the CLI package. */ }
  }
  return candidates;
};

export const probeCliCandidate = async ({ path, nodePath, expectedVersion, bootstrap = false, selectedOnly = false }) => {
  const deadline = Date.now() + 4_000;
  for (const location of candidateManifests({ path, bootstrap, selectedOnly }).slice(0, 8)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      const candidate = readCandidate(location.manifestPath, { nodePath, expectedVersion, executable: location.executable });
      const result = await executeFile(candidate.command, [...candidate.args, "--version"], {
        timeout: remaining, maxBuffer: MAX_OUTPUT_BYTES, killSignal: "SIGKILL",
      });
      if (result.stdout.trim() === candidate.version && isCachedCliCurrent(candidate)) return candidate;
    } catch { /* An unusable candidate must not select an unverified command. */ }
  }
  return null;
};

const runProbe = async ({ command, args, cwd, env, timeout, execute, expectedVersion }) => {
  try {
    const result = await execute(command, args, {
      cwd, env, timeout, maxBuffer: MAX_OUTPUT_BYTES, killSignal: "SIGKILL",
    });
    const candidate = JSON.parse(result.stdout);
    if (!candidate || !isAbsolute(candidate.command) || candidate.args?.length !== 1
      || !isAbsolute(candidate.args[0]) || !Array.isArray(candidate.files)
      || candidate.files.length > 6 || !isCachedCliCurrent(candidate)) return null;
    const verified = readCandidate(candidate.manifestPath, {
      nodePath: candidate.command, executable: candidate.executable, expectedVersion,
    });
    if (verified.version !== candidate.version || verified.args[0] !== candidate.args[0]
      || verified.stamp !== candidate.stamp) return null;
    return verified;
  } catch {
    return null;
  }
};

const warnOnce = (warn) => {
  let warned = false;
  return (reason) => {
    if (warned) return;
    warned = true;
    try { void Promise.resolve(warn(reason)).catch(() => {}); } catch { /* best effort */ }
  };
};

const resolveDefaultCli = async ({ runner, pin, cwd, env, isCompatibleVersion, warn, execute }) => {
  const probe = (command, args, timeout, expectedVersion) =>
    runProbe({ command, args, timeout, cwd, env, execute, expectedVersion });
  const probeArgs = [PROBE_PATH];
  if (runner === "codemem") probeArgs.push("--selected");
  const installed = await probe("node", probeArgs, PROBE_TIMEOUT_MS);
  if (installed && isCompatibleVersion(installed.version, pin)) return installed;
  if (installed) warn("channel_or_version_mismatch");
  // A compatible PATH command may be a version-manager or package-manager shim.
  // Failure to optimize it must not replace the selected backend with the pin.
  if (runner !== "npx") return null;
  // npm exec documents the requested packages' bins on child PATH. The shipped
  // probe reads that PATH; it does not infer npm's private cache layout.
  const bootstrapped = await probe("npx", [
    "-y", "--package", `codemem@${pin}`, "--package", `@codemem/embeddings@${pin}`,
    "node", PROBE_PATH, pin,
  ], BOOTSTRAP_TIMEOUT_MS, pin);
  if (bootstrapped?.version === pin) return bootstrapped;
  warn("resolution_unavailable");
  return null;
};

export const createCachedCliRunner = ({
  runner, runnerArgs, explicit, pin, cwd, env = process.env,
  isCompatibleVersion, warn = () => {}, now = Date.now, execute = executeFile,
}) => {
  let cached = null;
  let pending = null;
  let retryAt = 0;
  let generation = 0;
  const report = warnOnce(warn);

  const invalidate = () => { cached = null; pending = null; retryAt = 0; generation += 1; };
  const resolveInvocation = async () => {
    if (pending) return pending;
    if (cached && isCachedCliCurrent(cached)) return cached;
    cached = null;
    if (now() < retryAt) return null;
    const startedGeneration = generation;
    const resolution = resolveDefaultCli({ runner, pin, cwd, env, isCompatibleVersion, warn: report, execute })
      .catch(() => null)
      .then((candidate) => {
        if (startedGeneration !== generation) return null;
        cached = candidate;
        if (!candidate) retryAt = now() + RETRY_DELAY_MS;
        return candidate;
      })
      .finally(() => { if (pending === resolution) pending = null; });
    pending = resolution;
    return resolution;
  };

  const command = (args) => {
    if (explicit) return [runner, ...runnerArgs, ...args];
    return resolveInvocation().then((invocation) => {
      if (!invocation) {
        if (runner === "codemem") return [runner, ...runnerArgs, ...args];
        return null;
      }
      return [invocation.command, ...invocation.args, ...args];
    });
  };
  return { command, invalidate };
};
