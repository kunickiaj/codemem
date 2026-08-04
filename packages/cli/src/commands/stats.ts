import * as p from "@clack/prompts";
import { getAttributionDiagnostics, MemoryStore, resolveDbPath } from "@codemem/core";
import { Command, Option } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addDbOption,
	addJsonOption,
	type DbOpts,
	emitJsonError,
	type JsonOpts,
	resolveDbOpt,
} from "../shared-options.js";

function fmtPct(n: number): string {
	return `${Math.round(n * 100)}%`;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000_000) return `~${(n / 1_000_000_000).toFixed(1)}B`;
	if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `~${(n / 1_000).toFixed(0)}K`;
	return `${n}`;
}

const statsCmd = new Command("stats")
	.configureHelp(helpStyle)
	.description("Show database statistics");

addDbOption(statsCmd);
addJsonOption(statsCmd);
statsCmd.addOption(new Option("-a, --attribution", "show local retrieval attribution diagnostics"));

function renderAttributionDiagnostics(
	report: ReturnType<typeof getAttributionDiagnostics>,
): string {
	const evidence = report.evidenceCompleteness;
	return [
		"Retrieval attribution diagnostics (local, bounded)",
		`Lifecycle: ${report.lifecycle.requestedAttempts} requested, ${report.lifecycle.selectedAttempts} selected, ${report.lifecycle.handedOffAttempts} handed off`,
		`Exposures: ${report.lifecycle.selectedExposures} selected, ${report.lifecycle.handedOffExposures} handed off`,
		`Evidence: ${[
			`${evidence.assessedAttempts} assessed`,
			`${evidence.unassessedAttempts} unassessed`,
			`${evidence.assessedKnownAttempts} known`,
			`${evidence.assessedUnknownAttempts} unknown`,
			`${evidence.assessmentStatusIndeterminateAttempts} status indeterminate`,
			`${evidence.assessmentDetailsIncompleteAttempts} details incomplete`,
			`${evidence.assessmentRowsInvalid} invalid rows`,
			`${evidence.assessmentRowsOmittedByLimit} omitted by limit`,
		].join(", ")}`,
		`Latency: ${report.overhead.latencySampleCount} samples, ${report.overhead.averageLatencyMs ?? "unknown"} ms average`,
		`Steering: ${report.sourceLocationSteering.assessmentCount} source-location assessments, ${report.sourceLocationSteering.matchedPathCount} matched paths`,
		`Findings: ${report.findings.stale} stale, ${report.findings.harmful} harmful`,
		"Limitations:",
		...report.limitations.map((limitation) => `- ${limitation}`),
	].join("\n");
}

export const statsCommand = statsCmd.action(
	(opts: DbOpts & JsonOpts & { attribution?: boolean }) => {
		const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
		try {
			if (opts.attribution) {
				const report = getAttributionDiagnostics(store.db);
				console.log(
					opts.json ? JSON.stringify(report, null, 2) : renderAttributionDiagnostics(report),
				);
				return;
			}
			const result = store.stats();
			if (opts.json) {
				// lgtm[js/clear-text-logging] This is intentional CLI stdout for `--json`, not an application log.
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			const db = result.database;
			const sizeMb = (db.size_bytes / 1_048_576).toFixed(1);

			p.intro("codemem stats");

			p.log.info([`Path:        ${db.path}`, `Size:        ${sizeMb} MB`].join("\n"));

			p.log.success(
				[
					`Sessions:    ${db.sessions.toLocaleString()}`,
					`Memories:    ${db.active_memory_items.toLocaleString()} active / ${db.memory_items.toLocaleString()} total`,
					`Tags:        ${db.tags_filled.toLocaleString()} filled (${fmtPct(db.tags_coverage)} of active)`,
					`Artifacts:   ${db.artifacts.toLocaleString()}`,
					`Vectors:     ${db.vector_rows.toLocaleString()} (${fmtPct(db.vector_coverage)} coverage)`,
					`Raw events:  ${db.raw_events.toLocaleString()}`,
				].join("\n"),
			);

			if (result.usage.events.length > 0) {
				const lines = result.usage.events.map((e: (typeof result.usage.events)[number]) => {
					const parts = [`${e.event}: ${e.count.toLocaleString()}`];
					if (e.tokens_read > 0) parts.push(`read ${fmtTokens(e.tokens_read)} tokens`);
					if (e.tokens_saved > 0) parts.push(`est. saved ${fmtTokens(e.tokens_saved)} tokens`);
					return `  ${parts.join(", ")}`;
				});

				const t = result.usage.totals;
				lines.push("");
				lines.push(
					`  Total: ${t.events.toLocaleString()} events, read ${fmtTokens(t.tokens_read)} tokens, est. saved ${fmtTokens(t.tokens_saved)} tokens`,
				);

				p.log.step(`Usage\n${lines.join("\n")}`);
			}

			p.outro("done");
		} catch (error) {
			const message = error instanceof Error ? error.message : "Stats failed";
			if (opts.json) {
				emitJsonError("stats_failed", message);
			} else {
				p.log.error(message);
				process.exitCode = 1;
			}
			return;
		} finally {
			store.close();
		}
	},
);
