import { runCoordinatorScenario } from "../scenarios/coordinator.js";
import { runDirectSyncScenario } from "../scenarios/direct-sync.js";
import { runSmokeScenario } from "../scenarios/smoke.js";
import { createScenarioContext } from "../lib/scenario-context.js";

const scenarios = {
	coordinator: runCoordinatorScenario,
	directSync: runDirectSyncScenario,
	smoke: runSmokeScenario,
} as const;

type ScenarioName = keyof typeof scenarios;

function printUsage(): void {
	console.log("Usage: pnpm run e2e -- <scenario>");
	console.log("Scenarios:");
	for (const name of Object.keys(scenarios)) {
		console.log(`  - ${name}`);
	}
}

async function main(): Promise<void> {
	const scenarioName = (process.argv[2] ?? "smoke") as ScenarioName | "list" | "--help" | "-h";
	if (scenarioName === "list") {
		printUsage();
		return;
	}
	if (scenarioName === "--help" || scenarioName === "-h") {
		printUsage();
		return;
	}
	const scenario = scenarios[scenarioName as ScenarioName];
	if (!scenario) {
		printUsage();
		throw new Error(`Unknown scenario: ${scenarioName}`);
	}

	const ctx = createScenarioContext(scenarioName);
	console.log(`Running E2E scenario '${scenarioName}'`);
	console.log(`Artifacts: ${ctx.artifactsDir}`);
	try {
		await scenario(ctx);
		console.log(`Scenario '${scenarioName}' passed. Artifacts: ${ctx.artifactsDir}`);
	} catch (error) {
		ctx.captureFailure(error);
		ctx.compose.logs("99-compose-logs-on-failure", true);
		if (!ctx.keepStackOnFailure) {
			ctx.compose.down("98-compose-down-on-failure", true);
		}
		console.error(`Scenario '${scenarioName}' failed. Artifacts: ${ctx.artifactsDir}`);
		throw error;
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	process.exitCode = 1;
});
