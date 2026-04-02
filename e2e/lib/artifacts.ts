import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface CommandRecord {
	command: string;
	status: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
}

function slugify(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "step";
}

export function createArtifactDir(scenario: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = resolve(".tmp", "e2e-artifacts", `${timestamp}-${slugify(scenario)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function writeArtifact(dir: string, name: string, contents: string): string {
	const filePath = join(dir, name);
	writeFileSync(filePath, contents, "utf8");
	return filePath;
}

export function writeCommandArtifact(dir: string, name: string, record: CommandRecord): string {
	return writeArtifact(dir, `${slugify(name)}.json`, JSON.stringify(record, null, 2));
}
