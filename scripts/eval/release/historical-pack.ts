import { realpath, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import type { CommandExecutor } from "./historical-observer.js";
import { exactKeys, jsonObject, parseJson } from "./json-shape.js";
import { isPathInside, isPathOutside } from "./path-safety.js";
import type {
	HistoricalPackRequestV1,
	HistoricalPackSuccessV1,
	HistoricalPackTraceV1,
	JsonValue,
} from "./types.js";

export interface HistoricalPackDriverInput {
	execute: CommandExecutor;
	nodeExecutable: string;
	driverPath: string;
	worktreePath: string;
	repositoryRoot: string;
	request: HistoricalPackRequestV1;
	tsxImportPath?: string;
	dependencyRoot?: string;
	prepareDependencies?(worktreePath: string, dependencyRoot: string): Promise<void>;
	realpath?(path: string): Promise<string>;
}

async function prepareDependencies(worktreePath: string, dependencyRoot: string): Promise<void> {
	const target = await realpath(resolve(dependencyRoot, "packages/core/node_modules"));
	const link = resolve(worktreePath, "packages/core/node_modules");
	const existing = await realpath(link).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (existing === target) return;
	if (existing)
		throw new TypeError("Historical pack dependency link points outside the current workspace");
	await symlink(target, link, process.platform === "win32" ? "junction" : "dir");
}

function positiveIds(value: unknown, path: string): number[] {
	if (!Array.isArray(value) || value.some((id) => !Number.isSafeInteger(id) || Number(id) <= 0))
		throw new TypeError(`${path} must contain positive integer IDs`);
	return value.map(Number);
}

function trace(value: unknown, path: string): HistoricalPackTraceV1 {
	const input = jsonObject(value, path);
	exactKeys(input, ["probe_id", "mode", "retrieval", "assembly"], path);
	if (
		typeof input.probe_id !== "string" ||
		!["default", "task", "recall"].includes(String(input.mode))
	)
		throw new TypeError(`${path} has invalid identity`);
	const retrieval = jsonObject(input.retrieval, `${path}.retrieval`);
	exactKeys(retrieval, ["candidates"], `${path}.retrieval`);
	if (!Array.isArray(retrieval.candidates))
		throw new TypeError(`${path}.retrieval.candidates must be an array`);
	const candidates = retrieval.candidates.map((entry, index) => {
		const candidate = jsonObject(entry, `${path}.retrieval.candidates[${index}]`);
		const keys = Object.keys(candidate).toSorted().join(",");
		if (keys !== "id,rank" && keys !== "artifact_class,id,rank")
			throw new TypeError("historical candidate has unknown fields");
		if (!Number.isSafeInteger(candidate.id) || !Number.isSafeInteger(candidate.rank))
			throw new TypeError("historical candidate has invalid rank");
		const artifact = candidate.artifact_class;
		if (
			artifact !== undefined &&
			!["session_summary", "derived_fact", "telemetry", "unknown"].includes(String(artifact))
		)
			throw new TypeError("historical candidate artifact_class is invalid");
		return {
			id: Number(candidate.id),
			rank: Number(candidate.rank),
			...(artifact
				? {
						artifact_class: artifact as
							| "session_summary"
							| "derived_fact"
							| "telemetry"
							| "unknown",
					}
				: {}),
		};
	});
	const assembly = jsonObject(input.assembly, `${path}.assembly`);
	const sections = jsonObject(assembly.sections, `${path}.assembly.sections`);
	return {
		probe_id: input.probe_id,
		mode: input.mode as HistoricalPackTraceV1["mode"],
		retrieval: { candidates },
		assembly: {
			sections: {
				summary: positiveIds(sections.summary, `${path}.summary`),
				timeline: positiveIds(sections.timeline, `${path}.timeline`),
				observations: positiveIds(sections.observations, `${path}.observations`),
			},
		},
	};
}

function parseResponse(stdout: string): HistoricalPackSuccessV1["result"] {
	const root = jsonObject(
		parseJson(stdout, "historical pack response"),
		"historical pack response",
	);
	if (root.schema_version !== 1 || typeof root.ok !== "boolean")
		throw new TypeError("unsupported historical pack response");
	if (!root.ok) throw new Error(String(jsonObject(root.error, "historical pack error").message));
	const result = jsonObject(root.result, "historical pack result");
	if (
		!Array.isArray(result.traces) ||
		!Array.isArray(result.materialized_items) ||
		!Number.isSafeInteger(result.usage_row_count)
	)
		throw new TypeError("historical pack result has invalid collections");
	const materialized = result.materialized_items.map((entry, index) => {
		const item = jsonObject(entry, `historical pack item[${index}]`);
		exactKeys(
			item,
			["id", "memory_key", "kind", "title", "body_text", "metadata"],
			`historical pack item[${index}]`,
		);
		if (
			!Number.isSafeInteger(item.id) ||
			[item.memory_key, item.kind, item.title, item.body_text].some(
				(part) => typeof part !== "string",
			)
		)
			throw new TypeError("historical pack item has invalid fields");
		return {
			id: Number(item.id),
			memory_key: item.memory_key as string,
			kind: item.kind as string,
			title: item.title as string,
			body_text: item.body_text as string,
			metadata: jsonObject(item.metadata, "historical pack metadata") as Record<string, JsonValue>,
		};
	});
	return {
		traces: result.traces.map((value, index) => trace(value, `historical pack trace[${index}]`)),
		materialized_items: materialized,
		usage_row_count: Number(result.usage_row_count),
	};
}

export async function runHistoricalPackDriver(
	input: HistoricalPackDriverInput,
): Promise<HistoricalPackSuccessV1["result"]> {
	const resolveRealPath = input.realpath ?? realpath;
	const storePath = resolve(input.request.store_path);
	const [root, worktree, parent] = await Promise.all([
		resolveRealPath(input.repositoryRoot),
		resolveRealPath(input.worktreePath),
		resolveRealPath(dirname(storePath)),
	]);
	const actualStorePath = resolve(parent, basename(storePath));
	if (!isPathInside(root, actualStorePath) || !isPathOutside(worktree, actualStorePath))
		throw new TypeError(
			"Historical pack store must be inside the repository and outside the subject worktree",
		);
	await (input.prepareDependencies ?? prepareDependencies)(worktree, input.dependencyRoot ?? root);
	const tsx = input.tsxImportPath ?? createRequire(resolve(root, "package.json")).resolve("tsx");
	const execution = await input.execute(
		input.nodeExecutable,
		[
			"--import",
			tsx,
			input.driverPath,
			resolve(worktree, "packages/core/src/store.ts"),
			resolve(worktree, "packages/core/src/pack.ts"),
		],
		{
			cwd: root,
			stdin: `${JSON.stringify({ ...input.request, store_path: actualStorePath })}\n`,
			env: {
				PATH: process.env.PATH,
				CODEMEM_CONFIG: resolve(parent, "no-local-config.json"),
				CODEMEM_EMBEDDING_DISABLED: "1",
				CODEMEM_MEMORY_CROSS_SESSION_DEDUP_WINDOW_MS: "0",
			},
		},
	);
	if (execution.exitCode !== 0)
		throw new Error(`Historical pack driver failed: ${execution.stderr.trim()}`);
	return parseResponse(execution.stdout);
}
