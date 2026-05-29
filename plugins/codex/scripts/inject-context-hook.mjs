import process from "node:process";

async function readStdin() {
  for await (const _chunk of process.stdin) {
    // Drain stdin so Codex can close the hook process cleanly.
  }
}

await readStdin();
process.stdout.write(JSON.stringify({ continue: true }));
