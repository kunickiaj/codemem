import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const packIndex = args.indexOf("pack");
const payload = JSON.parse(process.env.CODEMEM_FAKE_PACK_JSON || "{}");
if (packIndex < 0) {
	process.stdout.write("0.40.0\n");
} else {
	const tracePath = process.env.CODEMEM_FAKE_TRACE_PATH;
	if (tracePath)
		appendFileSync(
			tracePath,
			`${JSON.stringify({ args: args.slice(packIndex), query: args[packIndex + 1] ?? null, memory_ids: Array.isArray(payload.memory_ids) ? payload.memory_ids : [] })}\n`,
		);
	if (payload.outcome === "exit_error") {
		process.stderr.write("fixed fake pack failure\n");
		process.exitCode = 7;
	} else if (payload.outcome === "malformed") process.stdout.write("{malformed");
	else
		process.stdout.write(
			`${JSON.stringify({ pack_text: payload.outcome === "empty" ? "" : String(payload.pack_text ?? ""), metrics: { total_items: Array.isArray(payload.memory_ids) ? payload.memory_ids.length : 0 } })}\n`,
		);
}
