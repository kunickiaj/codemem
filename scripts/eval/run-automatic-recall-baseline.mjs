import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "scripts/eval/automatic-recall-pre-policy.json"), "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const frozen = manifest.artifacts.frozen_harness_commit;
const reportPath = "scripts/eval/baselines/automatic-recall-pre-policy.json";
const report = JSON.parse(git("show", `${frozen}:${reportPath}`));
const scratch = join(root, ".tmp");
mkdirSync(scratch, { recursive: true });
const snapshot = mkdtempSync(join(scratch, "codemem-recall-baseline-"));

// Export the historical tree, not candidate files or a handwritten selector substitute.
execFileSync("tar", ["-xf", "-", "-C", snapshot], {
  input: git("archive", manifest.source.commit),
});
for (const path of ["scripts/eval/automatic-recall-pre-policy.json", reportPath, ...Object.keys(report.provenance.harness_sha256)]) {
  const bytes = git("show", `${frozen}:${path}`);
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
    const local = relative(root, dependency);
    const destination = local.startsWith("packages/") ? resolve(snapshot, local) : dependency;
    symlinkSync(destination, join(target, name), "dir");
  }
}
linkDependencies(join(root, "node_modules"), join(snapshot, "node_modules"));
for (const name of readdirSync(join(snapshot, "packages"))) {
  linkDependencies(join(root, "packages", name, "node_modules"), join(snapshot, "packages", name, "node_modules"));
}

// Git reads objects from the original clone and hashes working bytes from the snapshot.
// Keep the snapshot for inspection; never overwrite the frozen report or a user database.
console.log(`Historical source: ${manifest.source.commit}; frozen harness: ${frozen}`);
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
