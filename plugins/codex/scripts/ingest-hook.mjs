import process from "node:process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

let payload = await readStdin();
if (!payload.trim()) {
  process.exit(0);
}

function normalizePayloadText(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    const hasTimestamp =
      (typeof parsed.timestamp === "string" && parsed.timestamp.trim() !== "") ||
      (typeof parsed.ts === "string" && parsed.ts.trim() !== "");
    if (hasTimestamp) return raw;
    return JSON.stringify({
      ...parsed,
      timestamp: new Date().toISOString(),
      codemem_generated_event_nonce: randomUUID()
    });
  } catch {
    return raw;
  }
}

payload = normalizePayloadText(payload);
let spooled = false;

if (["1", "true", "yes", "on"].includes((process.env.CODEMEM_PLUGIN_IGNORE ?? "").toLowerCase())) {
  process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || dirname(scriptDir);

function resolvePinnedVersion() {
  try {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
    return typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : "latest";
  } catch {
    return "latest";
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    input: payload,
    encoding: "utf8",
    stdio: ["pipe", "ignore", "ignore"],
    timeout: 2000
  });
  return result.status === 0;
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function spoolPayload() {
  if (spooled) return;
  try {
    const dir = expandHome(process.env.CODEMEM_CODEX_HOOK_SPOOL_DIR?.trim() || "~/.codemem/codex-hook-spool");
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.hook-tmp-${process.pid}-${Date.now()}-${randomInt(1000, 10000)}.json`);
    const finalPath = join(dir, `hook-${Math.floor(Date.now() / 1000)}-${process.pid}-${randomInt(1000, 10000)}.json`);
    writeFileSync(tmpPath, payload, "utf8");
    renameSync(tmpPath, finalPath);
    spooled = true;
  } catch {
    // Best-effort last resort only.
  }
}

if (run("codemem", ["codex-hook-ingest"])) {
  process.exit(0);
}

// If the package-manager fallback cold-starts or gets killed by Codex's hook
// timeout, this payload is already durable. A later drain deduplicates it if
// the fallback succeeds too.
spoolPayload();

if (run("npx", ["-y", `codemem@${resolvePinnedVersion()}`, "codex-hook-ingest"])) {
  process.exit(0);
}

// Hook ingestion is best-effort. Never fail the active Codex session because
// the local CLI or npm fallback is unavailable.
spoolPayload();
process.exit(0);
