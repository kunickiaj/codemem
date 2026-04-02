import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createArtifactDir, writeArtifact } from "./artifacts.js";
import { ComposeManager } from "./compose.js";

export interface ScenarioContext {
	artifactsDir: string;
	compose: ComposeManager;
	keepStackOnFailure: boolean;
	recordNote(name: string, contents: string): void;
	captureFailure(error: unknown): void;
}

function projectNameForScenario(name: string): string {
	return `codemem-e2e-${name.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;
}

export function createScenarioContext(name: string): ScenarioContext {
	const artifactsDir = createArtifactDir(name);
	mkdirSync(resolve(artifactsDir, "db"), { recursive: true });
	const compose = new ComposeManager({
		composeFile: resolve("docker-compose.e2e.yml"),
		artifactsDir,
		projectName: projectNameForScenario(name),
	});
	return {
		artifactsDir,
		compose,
		keepStackOnFailure: process.env.CODEMEM_E2E_KEEP_STACK === "1",
		recordNote(noteName: string, contents: string) {
			writeArtifact(artifactsDir, noteName, contents);
		},
		captureFailure(error: unknown) {
			const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
			writeArtifact(artifactsDir, "failure.txt", message);
		},
	};
}
