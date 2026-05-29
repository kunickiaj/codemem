import process from "node:process";
import { spawn } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function printContinue(extra = {}) {
  process.stdout.write(JSON.stringify({ continue: true, ...extra }));
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

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function spoolPayload(raw) {
  try {
    const dir = expandHome(process.env.CODEMEM_CODEX_HOOK_SPOOL_DIR?.trim() || "~/.codemem/codex-hook-spool");
    mkdirSync(dir, { recursive: true });
    const tmpPath = join(dir, `.hook-tmp-${process.pid}-${Date.now()}-${randomInt(1000, 10000)}.json`);
    const finalPath = join(dir, `hook-${Math.floor(Date.now() / 1000)}-${process.pid}-${randomInt(1000, 10000)}.json`);
    writeFileSync(tmpPath, normalizePayloadText(raw), "utf8");
    renameSync(tmpPath, finalPath);
  } catch {
    // Best-effort last resort only.
  }
}

const payload = await readStdin();
if (!payload.trim()) {
  printContinue();
  process.exit(0);
}

if (["1", "true", "yes", "on"].includes((process.env.CODEMEM_PLUGIN_IGNORE ?? "").toLowerCase())) {
  printContinue();
  process.exit(0);
}

if (["1", "true", "yes", "on"].includes((process.env.CODEMEM_CODEX_PLUGIN_SMOKE ?? "").toLowerCase())) {
  printContinue({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "CODEMEM_CODEX_PLUGIN_SMOKE: codemem Codex plugin hook executed."
    }
  });
  process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
try {
  const child = spawn(process.execPath, [join(scriptDir, "ingest-hook.mjs")], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    env: process.env
  });
  child.stdin.end(payload);
  child.unref();
} catch {
  spoolPayload(payload);
}

// Context injection lands in codemem codex-hook-inject; until then, keep the
// prompt path non-blocking and stdout-clean.
printContinue();
