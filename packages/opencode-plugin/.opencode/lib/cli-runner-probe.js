import { probeCliCandidate } from "./cached-cli-runner.js";

// This script runs under the PATH-selected Node, not the plugin host executable.
// npm exec supplies its package bins through PATH on the one bootstrap call.
const main = async () => {
  if (process.release?.name !== "node" || process.versions.bun) return;
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 24 || (major === 24 && minor < 15)) return;
  const selectedOnly = process.argv[2] === "--selected";
  const expectedVersion = selectedOnly ? undefined : process.argv[2];
  const candidate = await probeCliCandidate({
    path: process.env.PATH,
    nodePath: process.execPath,
    expectedVersion,
    selectedOnly,
    bootstrap: expectedVersion !== undefined,
  });
  if (candidate) process.stdout.write(JSON.stringify(candidate));
};

main().catch(() => { process.exitCode = 1; });
