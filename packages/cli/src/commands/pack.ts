import * as p from "@clack/prompts";
import type { PackTrace } from "@codemem/core";
import { MemoryStore, resolveDbPath } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addDbOption,
	addJsonOption,
	type DbOpts,
	emitJsonError,
	type JsonOpts,
	resolveDbOpt,
} from "../shared-options.js";
import { addPackRequestOptions, buildPackRequestOptions, PackUsageError } from "./pack-shared.js";

type PackCommandOptions = DbOpts &
	JsonOpts & {
		limit: string;
		budget?: string;
		tokenBudget?: string;
		workingSetFile?: string[];
		project?: string;
		allProjects?: boolean;
		compact?: boolean;
		compactDetail?: string;
	};

function describeCandidate(candidate: PackTrace["retrieval"]["candidates"][number]): string[] {
	const scoreParts = [
		candidate.scores.combined_score != null
			? `combined=${candidate.scores.combined_score.toFixed(2)}`
			: null,
		candidate.scores.base_score != null ? `base=${candidate.scores.base_score.toFixed(2)}` : null,
		candidate.scores.text_overlap > 0 ? `text=${candidate.scores.text_overlap}` : null,
		candidate.scores.tag_overlap > 0 ? `tag=${candidate.scores.tag_overlap}` : null,
		candidate.scores.working_set_overlap > 0
			? `working_set=${candidate.scores.working_set_overlap.toFixed(2)}`
			: null,
	]
		.filter(Boolean)
		.join(" ");

	const lines = [`${candidate.rank}. [${candidate.id}] (${candidate.kind}) ${candidate.title}`];
	if (candidate.section) lines.push(`   - section: ${candidate.section}`);
	if (candidate.reasons.length > 0) lines.push(`   - reasons: ${candidate.reasons.join(", ")}`);
	if (scoreParts) lines.push(`   - scores: ${scoreParts}`);
	if (candidate.preview) lines.push(`   - preview: ${candidate.preview}`);
	return lines;
}

export function renderPackTrace(trace: PackTrace): string {
	const workingSet =
		trace.inputs.working_set_files.length > 0
			? trace.inputs.working_set_files.join(", ")
			: "(none)";
	const lines = [
		"Pack trace",
		`- Query: ${trace.inputs.query}`,
		`- Project: ${trace.inputs.project ?? "(default)"}`,
		`- Working set: ${workingSet}`,
		`- Mode: ${trace.mode.selected}`,
		`- Mode reasons: ${trace.mode.reasons.join(", ") || "(none)"}`,
		`- Token budget: ${trace.inputs.token_budget ?? "(none)"}`,
		"",
	];

	for (const disposition of ["selected", "dropped", "deduped", "trimmed"] as const) {
		const group = trace.retrieval.candidates.filter(
			(candidate) => candidate.disposition === disposition,
		);
		if (group.length === 0) continue;
		lines.push(disposition.charAt(0).toUpperCase() + disposition.slice(1));
		for (const candidate of group) {
			lines.push(...describeCandidate(candidate));
		}
		lines.push("");
	}

	lines.push("Assembly");
	lines.push(`- deduped ids: ${trace.assembly.deduped_ids.join(", ") || "(none)"}`);
	lines.push(`- trimmed ids: ${trace.assembly.trimmed_ids.join(", ") || "(none)"}`);
	lines.push(`- trim reasons: ${trace.assembly.trim_reasons.join(", ") || "(none)"}`);
	lines.push(
		`- section counts: summary=${trace.output.section_counts.summary} timeline=${trace.output.section_counts.timeline} observations=${trace.output.section_counts.observations}`,
	);
	lines.push(`- estimated tokens: ${trace.output.estimated_tokens}`);
	lines.push(`- truncated: ${trace.output.truncated ? "yes" : "no"}`);
	lines.push("");
	lines.push("Final pack");
	lines.push(trace.output.pack_text);
	return lines.join("\n");
}

async function withStore(
	opts: PackCommandOptions,
	errorCode: string,
	run: (store: MemoryStore) => Promise<void>,
): Promise<void> {
	let store: MemoryStore | null = null;
	try {
		store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
		await run(store);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const usageError = error instanceof PackUsageError;
		if (opts.json) {
			emitJsonError(usageError ? "usage_error" : errorCode, message, usageError ? 2 : 1);
			return;
		}
		p.log.error(message);
		process.exitCode = usageError ? 2 : 1;
	} finally {
		store?.close();
	}
}

async function packAction(context: string, opts: PackCommandOptions): Promise<void> {
	await withStore(opts, "pack_failed", async (store) => {
		const { limit, budget, filters, renderOptions } = buildPackRequestOptions(opts, {
			envProject: process.env.CODEMEM_PROJECT,
		});
		const result = await store.buildMemoryPackAsync(context, limit, budget, filters, renderOptions);

		if (opts.json) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}

		p.intro(`Memory pack for "${context}"`);

		if (result.items.length === 0) {
			p.log.warn("No relevant memories found.");
			p.outro("done");
			return;
		}

		const metrics = result.metrics;
		p.log.info(
			`${metrics.total_items} items, ~${metrics.pack_tokens} tokens` +
				(metrics.fallback_used ? " (fallback)" : "") +
				`  [fts:${metrics.sources.fts} sem:${metrics.sources.semantic} fuzzy:${metrics.sources.fuzzy}]`,
		);

		for (const item of result.items) {
			p.log.step(`#${item.id}  ${item.kind}  ${item.title}`);
		}

		p.note(result.pack_text, "pack_text");
		p.outro("done");
	});
}

async function traceAction(context: string, opts: PackCommandOptions): Promise<void> {
	await withStore(opts, "pack_trace_failed", async (store) => {
		const { limit, budget, filters, renderOptions } = buildPackRequestOptions(opts, {
			envProject: process.env.CODEMEM_PROJECT,
		});
		const trace = await store.buildMemoryPackTraceAsync(
			context,
			limit,
			budget,
			filters,
			renderOptions,
		);

		if (opts.json) {
			console.log(JSON.stringify(trace, null, 2));
			return;
		}

		console.log(renderPackTrace(trace));
	});
}

const packCmd = addPackRequestOptions(
	new Command("pack")
		.enablePositionalOptions()
		.configureHelp(helpStyle)
		.description("Build a context-aware memory pack")
		.argument("<context>", "context string to search for"),
);

addDbOption(packCmd);
addJsonOption(packCmd);
packCmd.action(packAction);

const traceCmd = addPackRequestOptions(
	new Command("trace")
		.configureHelp(helpStyle)
		.description("Trace retrieval and assembly for a memory pack")
		.argument("<context>", "context string to trace"),
);

addDbOption(traceCmd);
addJsonOption(traceCmd);
traceCmd.action(traceAction);
packCmd.addCommand(traceCmd);

export const packCommand = packCmd;
