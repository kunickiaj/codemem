import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "scripts/eval/automatic-recall-pre-policy.json"), "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
// Frozen harness bytes are committed copies; squash merges make the original
// harness commit unreachable, and shallow CI checkouts never had it.
const frozenDir = join(root, manifest.artifacts.frozen_harness_directory);
const reportPath = "scripts/eval/baselines/automatic-recall-pre-policy.json";
const report = JSON.parse(readFileSync(join(frozenDir, reportPath), "utf8"));
const scratch = join(root, ".tmp");
mkdirSync(scratch, { recursive: true });
const snapshot = mkdtempSync(join(scratch, "codemem-recall-baseline-"));

// Export the historical tree, not candidate files or a handwritten selector substitute.
// The historical commit is on main; CI must fetch full history for it.
execFileSync("tar", ["-xf", "-", "-C", snapshot], {
  input: git("archive", manifest.source.commit),
});
for (const path of ["scripts/eval/automatic-recall-pre-policy.json", reportPath, ...Object.keys(report.provenance.harness_sha256)]) {
  const bytes = readFileSync(join(frozenDir, path));
  const expected = report.provenance.harness_sha256[path];
  if (expected && createHash("sha256").update(bytes).digest("hex") !== expected) {
    throw new Error(`Frozen harness digest mismatch: ${path}`);
  }
  mkdirSync(dirname(join(snapshot, path)), { recursive: true });
  writeFileSync(join(snapshot, path), bytes);
}

// Reuse installed external dependencies, but redirect workspace packages into the historical tree.
function linkDependencies(source, target) {
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    if (name.startsWith("@")) {
      linkDependencies(join(source, name), join(target, name));
      continue;
    }
    if (name.startsWith(".")) continue;
    const dependency = realpathSync(join(source, name));
    const destination = workspacePackageSegments(dependency)
      ? join(snapshot, ...workspacePackageSegments(dependency))
      : dependency;
    symlinkSync(destination, join(target, name), "dir");
  }
}

// Platform-independent containment check: path.relative yields backslashes on
// Windows, so a string prefix test would keep candidate Core linked into the
// historical snapshot and silently invalidate the baseline.
function workspacePackageSegments(dependency) {
  const local = relative(root, dependency);
  if (!local || local.startsWith("..") || isAbsolute(local)) return null;
  const segments = local.split(sep);
  return segments[0] === "packages" && segments.length > 1 ? segments : null;
}

// Fail loudly if any workspace dependency would still resolve into the candidate checkout.
function assertNoCandidateWorkspaceLinks(dir) {
  for (const name of readdirSync(dir)) {
    const entry = join(dir, name);
    if (name.startsWith("@")) {
      assertNoCandidateWorkspaceLinks(entry);
      continue;
    }
    if (name.startsWith(".")) continue;
    if (workspacePackageSegments(realpathSync(entry))) {
      throw new Error(`Historical snapshot still links candidate workspace package: ${name}`);
    }
  }
}
linkDependencies(join(root, "node_modules"), join(snapshot, "node_modules"));
assertNoCandidateWorkspaceLinks(join(snapshot, "node_modules"));
for (const name of readdirSync(join(snapshot, "packages"))) {
  linkDependencies(join(root, "packages", name, "node_modules"), join(snapshot, "packages", name, "node_modules"));
  if (existsSync(join(snapshot, "packages", name, "node_modules"))) {
    assertNoCandidateWorkspaceLinks(join(snapshot, "packages", name, "node_modules"));
  }
}

// Git reads objects from the original clone and hashes working bytes from the snapshot.
// Keep the snapshot for inspection; never overwrite the frozen report or a user database.
console.log(
  `Historical source: ${manifest.source.commit}; frozen harness: ${manifest.artifacts.frozen_harness_commit} (${manifest.artifacts.frozen_harness_directory})`,
);
console.log(`Baseline snapshot: ${snapshot}`);
execFileSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "run",
  "packages/core/src/automatic-recall-pre-policy.eval.test.ts",
  "packages/viewer-server/src/routes/automatic-recall.test.ts"], {
  cwd: snapshot,
  stdio: "inherit",
  env: {
    ...process.env,
    GIT_DIR: git("rev-parse", "--absolute-git-dir").toString().trim(),
    GIT_WORK_TREE: snapshot,
    CODEMEM_EMBEDDING_DISABLED: "1",
  },
});
