import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executePhase } from "./prompt-path.js";
import { parseSubprocessLog, subprocessActivitySettled } from "./prompt-path-lib.js";
import type { PhaseRequest, PhaseResponse } from "./prompt-path-process.js";

async function main(): Promise<void> {
	const request = JSON.parse(readFileSync(0, "utf8")) as PhaseRequest;
	const result = await executePhase(request);
	const counterLog = readFileSync(join(request.tempRoot, "subprocess.log"), "utf8");
	const activity = parseSubprocessLog(counterLog);
	if (
		!subprocessActivitySettled(activity) ||
		!Object.entries(activity.counts).every(
			([key, value]) => result.subprocesses[key as keyof typeof result.subprocesses] === value,
		)
	)
		throw new Error("phase activity did not settle before shutdown");
	const response: PhaseResponse = { result, counterLog };
	// Disposal cannot await every queued ledger callback. Exit before the next phase.
	process.stdout.write(JSON.stringify(response), () => process.exit(0));
}

main().catch(() => {
	process.stderr.write("prompt-path phase failed before producing a safe aggregate\n");
	process.exit(1);
});
