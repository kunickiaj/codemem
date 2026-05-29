import process from "node:process";

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

printContinue();
