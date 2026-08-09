#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReleaseEvalRunResult } from "./release/orchestrator.js";

type ReleaseEvalCommandResult = Pick<
	ReleaseEvalRunResult,
	"runId" | "detailedPath" | "sanitizedPath"
> & { summary: Pick<ReleaseEvalRunResult["summary"], "status" | "scope"> };

type Arguments =
	| { command: "synthetic"; outputPath?: string }
	| {
			command: "run";
			manifestPath: string;
			outputPath?: string;
			retrievalCorpusPath?: string;
			injectionCorpusPath?: string;
	  };

function usage(): string {
	return [
		"Usage:",
		"  pnpm run eval:release -- synthetic [--output <path>]",
		"  pnpm run eval:release -- run --manifest <path> [--retrieval-corpus <path>] [--injection-corpus <path>] [--output <path>]",
	].join("\n");
}

export function parseReleaseEvalArguments(argv: string[]): Arguments {
	const normalized = argv[0] === "--" ? argv.slice(1) : argv;
	const [command, ...rest] = normalized;
	if (command !== "run" && command !== "synthetic") throw new TypeError(usage());
	let manifestPath: string | undefined;
	let outputPath: string | undefined;
	let retrievalCorpusPath: string | undefined;
	let injectionCorpusPath: string | undefined;
	for (let index = 0; index < rest.length; index += 2) {
		const flag = rest[index];
		const value = rest[index + 1];
		if (
			flag !== "--manifest" &&
			flag !== "--output" &&
			flag !== "--retrieval-corpus" &&
			flag !== "--injection-corpus"
		)
			throw new TypeError(`Unknown argument: ${flag}\n${usage()}`);
		if (!value || value.startsWith("--")) throw new TypeError(`${flag} requires a path`);
		if (flag === "--manifest") {
			if (manifestPath) throw new TypeError("--manifest may be supplied only once");
			manifestPath = value;
		} else if (flag === "--output") {
			if (outputPath) throw new TypeError("--output may be supplied only once");
			outputPath = value;
		} else if (flag === "--retrieval-corpus") {
			if (retrievalCorpusPath) throw new TypeError("--retrieval-corpus may be supplied only once");
			retrievalCorpusPath = value;
		} else {
			if (injectionCorpusPath) throw new TypeError("--injection-corpus may be supplied only once");
			injectionCorpusPath = value;
		}
	}
	if (command === "run") {
		if (!manifestPath) throw new TypeError(`run requires --manifest <path>\n${usage()}`);
		return {
			command,
			manifestPath,
			...(outputPath ? { outputPath } : {}),
			...(retrievalCorpusPath ? { retrievalCorpusPath } : {}),
			...(injectionCorpusPath ? { injectionCorpusPath } : {}),
		};
	}
	if (manifestPath || retrievalCorpusPath || injectionCorpusPath)
		throw new TypeError("synthetic does not accept corpus or manifest paths");
	return { command, ...(outputPath ? { outputPath } : {}) };
}

export interface ReleaseEvalMainDependencies {
	repositoryRoot(): string;
	runSynthetic(input: {
		repositoryRoot: string;
		outputPath?: string;
	}): Promise<ReleaseEvalCommandResult>;
	run(input: {
		repositoryRoot: string;
		manifestPath: string;
		outputPath?: string;
		retrievalCorpusPath?: string;
		injectionCorpusPath?: string;
	}): Promise<ReleaseEvalCommandResult>;
	writeStdout(value: string): void;
}

async function defaultDependencies(): Promise<ReleaseEvalMainDependencies> {
	const { runReleaseEval, runSyntheticReleaseEval } = await import("./release/orchestrator.js");
	return {
		repositoryRoot: () => resolve(process.cwd()),
		runSynthetic: runSyntheticReleaseEval,
		run: runReleaseEval,
		writeStdout: (value) => process.stdout.write(value),
	};
}

export async function main(
	argv = process.argv.slice(2),
	dependencies?: ReleaseEvalMainDependencies,
): Promise<void> {
	const args = parseReleaseEvalArguments(argv);
	const deps = dependencies ?? (await defaultDependencies());
	const repositoryRoot = deps.repositoryRoot();
	const result =
		args.command === "synthetic"
			? await deps.runSynthetic({ repositoryRoot, outputPath: args.outputPath })
			: await deps.run({
					repositoryRoot,
					manifestPath: args.manifestPath,
					outputPath: args.outputPath,
					retrievalCorpusPath: args.retrievalCorpusPath,
					injectionCorpusPath: args.injectionCorpusPath,
				});
	deps.writeStdout(
		`${JSON.stringify({ status: result.summary.status, scope: result.summary.scope, run_id: result.runId, detailed_report: result.detailedPath, sanitized_summary: result.sanitizedPath }, null, 2)}\n`,
	);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
	main().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
