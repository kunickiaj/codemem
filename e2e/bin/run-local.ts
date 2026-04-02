import { runFleetReadyScenario } from "../scenarios/fleet-ready.js";
import { runFleetSmokeScenario } from "../scenarios/fleet-smoke.js";
import { runBootstrapScenario } from "../scenarios/bootstrap.js";
import { runCoordinatorScenario } from "../scenarios/coordinator.js";
import { runDirectSyncScenario } from "../scenarios/direct-sync.js";
import { runSmokeScenario } from "../scenarios/smoke.js";
import { createScenarioContext } from "../lib/scenario-context.js";

const scenarios = {
	bootstrap: runBootstrapScenario,
	coordinator: runCoordinatorScenario,
	directSync: runDirectSyncScenario,
	fleetReady: runFleetReadyScenario,
	fleetSmoke: runFleetSmokeScenario,
	smoke: runSmokeScenario,
} as const;

const processRef = globalThis as typeof globalThis & {
	process: { env: Record<string, string | undefined>; argv: string[]; exitCode?: number };
};

type ScenarioName = keyof typeof scenarios;

interface CliOptions {
	scenarioName: ScenarioName | "list" | "--help" | "-h";
	json: boolean;
}

function parseCliArgs(argv: string[]): CliOptions {
	let scenarioName: CliOptions["scenarioName"] = "smoke";
	let json = processRef.process.env.CODEMEM_E2E_JSON === "1";
	for (const arg of argv) {
		if (arg === "--help" || arg === "-h" || arg === "list") {
			scenarioName = arg as CliOptions["scenarioName"];
			continue;
		}
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (!arg.startsWith("-")) {
			scenarioName = arg as CliOptions["scenarioName"];
		}
	}
	return { scenarioName, json };
}

function printUsage(): void {
	console.log("Usage: pnpm run e2e -- <scenario>");
	console.log("Scenarios:");
	for (const name of Object.keys(scenarios)) {
		console.log(`  - ${name}`);
	}
}

async function main(): Promise<void> {
	const { scenarioName, json } = parseCliArgs(processRef.process.argv.slice(2));
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
	if (json) {
		console.log(JSON.stringify({ status: "starting", scenario: scenarioName, artifactsDir: ctx.artifactsDir }));
	} else {
		console.log(`Running E2E scenario '${scenarioName}'`);
		console.log(`Artifacts: ${ctx.artifactsDir}`);
	}
	try {
		await scenario(ctx);
		if (json) {
			console.log(JSON.stringify({ status: "passed", scenario: scenarioName, artifactsDir: ctx.artifactsDir }));
		} else {
			console.log(`Scenario '${scenarioName}' passed. Artifacts: ${ctx.artifactsDir}`);
		}
	} catch (error) {
		ctx.captureFailure(error);
		ctx.compose.logs("99-compose-logs-on-failure", true);
		if (!ctx.keepStackOnFailure) {
			ctx.compose.down("98-compose-down-on-failure", true);
		}
		if (json) {
			console.error(
				JSON.stringify({
					status: "failed",
					scenario: scenarioName,
					artifactsDir: ctx.artifactsDir,
					error: error instanceof Error ? error.message : String(error),
				}),
			);
		} else {
			console.error(`Scenario '${scenarioName}' failed. Artifacts: ${ctx.artifactsDir}`);
		}
		throw error;
	}
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : String(error));
	processRef.process.exitCode = 1;
});
