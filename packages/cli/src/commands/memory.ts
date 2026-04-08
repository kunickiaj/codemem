/**
 * Memory management CLI commands — show, forget, remember, inject.
 *
 * Ports codemem/commands/memory_cmds.py (show_cmd, forget_cmd, remember_cmd).
 * Inject is deprecated in favor of `codemem pack`.
 */

import * as p from "@clack/prompts";
import {
	compareMemoryRoleReports,
	getExtractionBenchmarkProfile,
	getInjectionEvalScenarioPack,
	getInjectionEvalScenarioPrompts,
	getMemoryRoleReport,
	getRawEventRelinkPlan,
	getRawEventRelinkReport,
	getSessionExtractionEval,
	getSessionExtractionEvalScenario,
	loadObserverConfig,
	MemoryStore,
	ObserverClient,
	replayBatchExtraction,
	replayBatchExtractionWithTierRouting,
	resolveDbPath,
	resolveProject,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addDbOption,
	addJsonOption,
	type DbOpts,
	emitDeprecationWarning,
	emitJsonError,
	type JsonOpts,
	resolveDbOpt,
} from "../shared-options.js";
import { buildPackRequestOptions, collectWorkingSetFile } from "./pack-shared.js";

/** Parse a strict positive integer, rejecting prefixes like "12abc". */
function parseStrictPositiveId(value: string): number | null {
	if (!/^\d+$/.test(value.trim())) return null;
	const n = Number(value.trim());
	return Number.isFinite(n) && n >= 1 && Number.isInteger(n) ? n : null;
}

function showMemoryAction(idStr: string, opts: DbOpts & JsonOpts): void {
	const memoryId = parseStrictPositiveId(idStr);
	if (memoryId === null) {
		if (opts.json) {
			emitJsonError("invalid_id", `Invalid memory ID: ${idStr}`);
		} else {
			p.log.error(`Invalid memory ID: ${idStr}`);
			process.exitCode = 1;
		}
		return;
	}
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		const item = store.get(memoryId);
		if (!item) {
			if (opts.json) {
				emitJsonError("not_found", `Memory ${memoryId} not found`);
			} else {
				p.log.error(`Memory ${memoryId} not found`);
				process.exitCode = 1;
			}
			return;
		}
		if (opts.json) {
			console.log(JSON.stringify(item, null, 2));
		} else {
			// Human-readable format
			console.log(`#${item.id} [${item.kind}] ${item.title}`);
			if (item.subtitle) console.log(`  ${item.subtitle}`);
			console.log(`  created: ${item.created_at}  confidence: ${item.confidence}`);
			if (item.tags_text) console.log(`  tags: ${item.tags_text}`);
			if (item.body_text) {
				const preview =
					item.body_text.length > 300 ? `${item.body_text.slice(0, 300)}…` : item.body_text;
				console.log(`\n${preview}`);
			}
		}
	} finally {
		store.close();
	}
}

function forgetMemoryAction(idStr: string, opts: DbOpts & JsonOpts): void {
	const memoryId = parseStrictPositiveId(idStr);
	if (memoryId === null) {
		if (opts.json) {
			emitJsonError("invalid_id", `Invalid memory ID: ${idStr}`);
		} else {
			p.log.error(`Invalid memory ID: ${idStr}`);
			process.exitCode = 1;
		}
		return;
	}
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	try {
		store.forget(memoryId);
		if (opts.json) {
			console.log(JSON.stringify({ id: memoryId, status: "forgotten" }));
		} else {
			p.log.success(`Memory ${memoryId} marked inactive`);
		}
	} finally {
		store.close();
	}
}

interface RememberMemoryOptions extends DbOpts, JsonOpts {
	kind: string;
	title: string;
	body: string;
	tags?: string[];
	project?: string;
}

async function rememberMemoryAction(opts: RememberMemoryOptions): Promise<void> {
	const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
	let sessionId: number | null = null;
	try {
		const project = resolveProject(process.cwd(), opts.project ?? null);
		sessionId = store.startSession({
			cwd: process.cwd(),
			project,
			user: process.env.USER ?? "unknown",
			toolVersion: "manual",
			metadata: { manual: true },
		});
		const memId = store.remember(sessionId, opts.kind, opts.title, opts.body, 0.5, opts.tags);
		await store.flushPendingVectorWrites();
		store.endSession(sessionId, { manual: true });
		if (opts.json) {
			console.log(JSON.stringify({ id: memId }));
		} else {
			p.log.success(`Stored memory ${memId}`);
		}
	} catch (err) {
		if (sessionId !== null) {
			try {
				store.endSession(sessionId, { manual: true, error: true });
			} catch {
				// ignore — already in error path
			}
		}
		const message = err instanceof Error ? err.message : String(err);
		if (opts.json) {
			emitJsonError("remember_failed", message);
		} else {
			p.log.error(`Failed to store memory: ${message}`);
			process.exitCode = 1;
		}
	} finally {
		store.close();
	}
}

function createShowMemoryCommand(): Command {
	const cmd = new Command("show")
		.configureHelp(helpStyle)
		.description("Show a memory item")
		.argument("<id>", "memory ID");
	addDbOption(cmd);
	addJsonOption(cmd);
	cmd.action(showMemoryAction);
	return cmd;
}

function createForgetMemoryCommand(): Command {
	const cmd = new Command("forget")
		.configureHelp(helpStyle)
		.description("Deactivate a memory item")
		.argument("<id>", "memory ID");
	addDbOption(cmd);
	addJsonOption(cmd);
	cmd.action(forgetMemoryAction);
	return cmd;
}

function createRememberMemoryCommand(): Command {
	const cmd = new Command("remember")
		.configureHelp(helpStyle)
		.description("Manually add a memory item")
		.requiredOption("-k, --kind <kind>", "memory kind (discovery, decision, feature, bugfix, etc.)")
		.requiredOption("-t, --title <title>", "memory title")
		.requiredOption("-b, --body <body>", "memory body text")
		.option("--tags <tags...>", "tags (space-separated)")
		.option("--project <project>", "project name (defaults to git repo root)");
	addDbOption(cmd);
	addJsonOption(cmd);
	cmd.action(rememberMemoryAction);
	return cmd;
}

function createInjectMemoryCommand(): Command {
	const cmd = new Command("inject")
		.configureHelp(helpStyle)
		.description("Build raw memory context text for manual prompt injection")
		.argument("<context>", "context string to search for")
		.option("-n, --limit <n>", "max items", "10")
		.option("--budget <tokens>", "token budget")
		.option("--token-budget <tokens>", "token budget")
		.option(
			"--working-set-file <path>",
			"recently modified file path used as ranking hint",
			collectWorkingSetFile,
			[],
		)
		.option("--project <project>", "project identifier (defaults to git repo root)")
		.option("--all-projects", "search across all projects")
		.allowUnknownOption(true)
		.allowExcessArguments(true);
	addDbOption(cmd);
	cmd.action(
		async (
			context: string,
			opts: DbOpts & {
				limit?: string;
				budget?: string;
				tokenBudget?: string;
				workingSetFile?: string[];
				project?: string;
				allProjects?: boolean;
			},
		) => {
			emitDeprecationWarning("codemem memory inject", "codemem pack");
			const store = new MemoryStore(resolveDbPath(resolveDbOpt(opts)));
			try {
				const { limit, budget, filters } = buildPackRequestOptions(opts, {
					envProject: process.env.CODEMEM_PROJECT,
				});
				const pack = await store.buildMemoryPackAsync(context, limit, budget, filters);
				console.log(pack.pack_text ?? "");
			} finally {
				store.close();
			}
		},
	);
	return cmd;
}

function createMemoryRoleReportCommand(): Command {
	const cmd = new Command("role-report")
		.configureHelp(helpStyle)
		.description("Analyze inferred memory roles in a DB snapshot")
		.option("--project <project>", "project identifier (defaults to git repo root)")
		.option("--all-projects", "analyze across all projects")
		.option(
			"--probe <query>",
			"run a retrieval probe query against the snapshot",
			(value, prev: string[]) => [...prev, value],
			[],
		)
		.option(
			"--scenario <id>",
			"run a named injection-first eval scenario pack (can be repeated)",
			(value, prev: string[]) => [...prev, value],
			[],
		)
		.option("--inactive", "include inactive memories");
	addDbOption(cmd);
	addJsonOption(cmd);
	cmd.action(
		(
			opts: DbOpts &
				JsonOpts & {
					project?: string;
					allProjects?: boolean;
					probe?: string[];
					scenario?: string[];
					inactive?: boolean;
				},
		) => {
			const project =
				opts.allProjects === true
					? null
					: opts.project?.trim() ||
						process.env.CODEMEM_PROJECT?.trim() ||
						resolveProject(process.cwd(), null);
			const invalidScenario = (opts.scenario ?? []).find(
				(id) => getInjectionEvalScenarioPack(id) == null,
			);
			if (invalidScenario) {
				throw new Error(`Unknown eval scenario pack: ${invalidScenario}`);
			}
			const probes = [
				...(opts.probe ?? []),
				...getInjectionEvalScenarioPrompts(opts.scenario ?? []),
			];
			const result = getMemoryRoleReport(resolveDbOpt(opts), {
				project,
				allProjects: opts.allProjects === true,
				includeInactive: opts.inactive === true,
				probes,
			});

			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			p.intro("codemem memory role-report");
			p.log.info(
				[
					`Memories: ${result.totals.memories}`,
					`Active: ${result.totals.active}`,
					`Sessions: ${result.totals.sessions}`,
				].join("\n"),
			);
			p.log.info("Counts by role:");
			for (const [role, count] of Object.entries(result.counts_by_role)) {
				p.log.message(`  ${role.padEnd(10)} ${String(count)}`);
			}
			p.log.info("Counts by mapping:");
			p.log.message(`  mapped      ${result.counts_by_mapping.mapped}`);
			p.log.message(`  unmapped    ${result.counts_by_mapping.unmapped}`);
			p.log.info("Summary lineages:");
			p.log.message(`  session_summary         ${result.summary_lineages.session_summary}`);
			p.log.message(`  legacy_metadata_summary ${result.summary_lineages.legacy_metadata_summary}`);
			p.log.message(`  summary_mapped          ${result.summary_mapping.mapped}`);
			p.log.message(`  summary_unmapped        ${result.summary_mapping.unmapped}`);
			p.log.info("Project quality:");
			for (const [bucket, count] of Object.entries(result.project_quality)) {
				p.log.message(`  ${bucket.padEnd(12)} ${String(count)}`);
			}
			p.log.info("Session classes:");
			for (const [bucket, count] of Object.entries(result.session_class_buckets)) {
				p.log.message(`  ${bucket.padEnd(20)} ${String(count)}`);
			}
			p.log.info("Summary dispositions:");
			for (const [bucket, count] of Object.entries(result.summary_disposition_buckets)) {
				p.log.message(`  ${bucket.padEnd(20)} ${String(count)}`);
			}
			if (result.probe_results.length > 0) {
				p.log.info("Probe results:");
				for (const probe of result.probe_results) {
					p.log.message(`  query: ${probe.query}`);
					if (probe.scenario_id) {
						p.log.message(
							`    scenario: ${probe.scenario_id} (${probe.scenario_category ?? "unknown"})${probe.scenario_title ? ` — ${probe.scenario_title}` : ""}`,
						);
					}
					p.log.message(`    mode: ${probe.mode}`);
					p.log.message(
						`    top roles: durable=${probe.top_role_counts.durable} recap=${probe.top_role_counts.recap} ephemeral=${probe.top_role_counts.ephemeral} general=${probe.top_role_counts.general}`,
					);
					p.log.message(
						`    top mapping: mapped=${probe.top_mapping_counts.mapped} unmapped=${probe.top_mapping_counts.unmapped}`,
					);
					p.log.message(
						`    burden: recap_share=${probe.top_burden.recap_share.toFixed(2)} unmapped_share=${probe.top_burden.unmapped_share.toFixed(2)} recap_unmapped_share=${probe.top_burden.recap_unmapped_share.toFixed(2)}`,
					);
					if (probe.simulated_demoted_unmapped_recap) {
						p.log.message(
							`    simulated demote-unmapped-recap burden: recap_share=${probe.simulated_demoted_unmapped_recap.top_burden.recap_share.toFixed(2)} unmapped_share=${probe.simulated_demoted_unmapped_recap.top_burden.unmapped_share.toFixed(2)} recap_unmapped_share=${probe.simulated_demoted_unmapped_recap.top_burden.recap_unmapped_share.toFixed(2)}`,
						);
					}
					if (probe.simulated_demoted_unmapped_recap_and_ephemeral) {
						p.log.message(
							`    simulated demote-unmapped-recap+ephemeral burden: recap_share=${probe.simulated_demoted_unmapped_recap_and_ephemeral.top_burden.recap_share.toFixed(2)} unmapped_share=${probe.simulated_demoted_unmapped_recap_and_ephemeral.top_burden.unmapped_share.toFixed(2)} recap_unmapped_share=${probe.simulated_demoted_unmapped_recap_and_ephemeral.top_burden.recap_unmapped_share.toFixed(2)}`,
						);
					}
					if (probe.scenario_score) {
						p.log.message(
							`    scenario score: mode_match=${probe.scenario_score.mode_match ? "yes" : "no"} top1_primary=${probe.scenario_score.primary_in_top1 ? "yes" : "no"} top3_primary=${probe.scenario_score.primary_in_top3_count} top1_anti=${probe.scenario_score.anti_signal_in_top1 ? "yes" : "no"} primary=${probe.scenario_score.primary_match_count} anti=${probe.scenario_score.anti_signal_count} recap=${probe.scenario_score.recap_count} unmapped_recap=${probe.scenario_score.unmapped_recap_count} chatter=${probe.scenario_score.administrative_chatter_count} net=${probe.scenario_score.score}`,
						);
					}
					for (const item of probe.items.slice(0, 5)) {
						p.log.message(
							`    [${item.id}] (${item.kind}/${item.role}/${item.mapping}/${item.session_class}/${item.summary_disposition}) ${item.title} — ${item.role_reason}`,
						);
					}
				}
			}
			p.outro("done");
		},
	);
	return cmd;
}

function createMemoryRoleCompareCommand(): Command {
	const cmd = new Command("role-compare")
		.configureHelp(helpStyle)
		.description("Compare inferred memory-role and probe metrics across two DB snapshots")
		.argument("<baseline_db>", "baseline sqlite database path")
		.argument("<candidate_db>", "candidate sqlite database path")
		.option("--project <project>", "project identifier (defaults to git repo root)")
		.option("--all-projects", "analyze across all projects")
		.option(
			"--probe <query>",
			"run a retrieval probe query against both snapshots",
			(value, prev: string[]) => [...prev, value],
			[],
		)
		.option(
			"--scenario <id>",
			"run a named injection-first eval scenario pack (can be repeated)",
			(value, prev: string[]) => [...prev, value],
			[],
		)
		.option("--inactive", "include inactive memories");
	addJsonOption(cmd);
	cmd.action(
		(
			baselineDb: string,
			candidateDb: string,
			opts: JsonOpts & {
				project?: string;
				allProjects?: boolean;
				probe?: string[];
				scenario?: string[];
				inactive?: boolean;
			},
		) => {
			const project =
				opts.allProjects === true
					? null
					: opts.project?.trim() ||
						process.env.CODEMEM_PROJECT?.trim() ||
						resolveProject(process.cwd(), null);
			const invalidScenario = (opts.scenario ?? []).find(
				(id) => getInjectionEvalScenarioPack(id) == null,
			);
			if (invalidScenario) {
				throw new Error(`Unknown eval scenario pack: ${invalidScenario}`);
			}
			const probes = [
				...(opts.probe ?? []),
				...getInjectionEvalScenarioPrompts(opts.scenario ?? []),
			];
			const result = compareMemoryRoleReports(baselineDb, candidateDb, {
				project,
				allProjects: opts.allProjects === true,
				includeInactive: opts.inactive === true,
				probes,
			});

			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			p.intro("codemem memory role-compare");
			p.log.info(
				[
					`Baseline sessions: ${result.baseline.totals.sessions}`,
					`Candidate sessions: ${result.candidate.totals.sessions}`,
					`Delta sessions: ${result.delta.totals.sessions}`,
					`Mapped delta: ${result.delta.counts_by_mapping.mapped}`,
					`Unmapped delta: ${result.delta.counts_by_mapping.unmapped}`,
					`Summary mapped delta: ${result.delta.summary_mapping.mapped}`,
					`Summary unmapped delta: ${result.delta.summary_mapping.unmapped}`,
				].join("\n"),
			);
			p.log.info("Role deltas:");
			for (const [role, count] of Object.entries(result.delta.counts_by_role)) {
				p.log.message(`  ${role.padEnd(10)} ${String(count)}`);
			}
			p.log.info("Session class deltas:");
			for (const [bucket, count] of Object.entries(result.delta.session_class_buckets)) {
				p.log.message(`  ${bucket.padEnd(20)} ${String(count)}`);
			}
			p.log.info("Summary disposition deltas:");
			for (const [bucket, count] of Object.entries(result.delta.summary_disposition_buckets)) {
				p.log.message(`  ${bucket.padEnd(20)} ${String(count)}`);
			}
			if (result.probe_comparisons.length > 0) {
				p.log.info("Probe comparisons:");
				for (const probe of result.probe_comparisons) {
					p.log.message(`  query: ${probe.query}`);
					p.log.message(
						`    modes: baseline=${probe.baseline_mode ?? "-"} candidate=${probe.candidate_mode ?? "-"}`,
					);
					p.log.message(
						`    overlap: shared_top_keys=${probe.shared_item_keys.length} baseline_top=${probe.baseline_item_ids.slice(0, 5).join(",") || "-"} candidate_top=${probe.candidate_item_ids.slice(0, 5).join(",") || "-"}`,
					);
					if (probe.delta_top_burden) {
						p.log.message(
							`    burden delta: recap_share=${probe.delta_top_burden.recap_share.toFixed(2)} unmapped_share=${probe.delta_top_burden.unmapped_share.toFixed(2)} recap_unmapped_share=${probe.delta_top_burden.recap_unmapped_share.toFixed(2)}`,
						);
					}
					if (probe.delta_top_mapping_counts) {
						p.log.message(
							`    mapping delta: mapped=${probe.delta_top_mapping_counts.mapped} unmapped=${probe.delta_top_mapping_counts.unmapped}`,
						);
					}
					if (probe.baseline_scenario_score || probe.candidate_scenario_score) {
						p.log.message(
							`    scenario scores: baseline=${probe.baseline_scenario_score?.score ?? "-"} candidate=${probe.candidate_scenario_score?.score ?? "-"}`,
						);
					}
					if (probe.delta_scenario_score) {
						p.log.message(
							`    scenario delta: mode_match=${probe.delta_scenario_score.mode_match ?? "-"} top1_primary=${probe.delta_scenario_score.primary_in_top1 ?? "-"} top3_primary=${probe.delta_scenario_score.primary_in_top3_count ?? "-"} top1_anti=${probe.delta_scenario_score.anti_signal_in_top1 ?? "-"} primary=${probe.delta_scenario_score.primary_match_count ?? "-"} anti=${probe.delta_scenario_score.anti_signal_count ?? "-"} recap=${probe.delta_scenario_score.recap_count ?? "-"} unmapped_recap=${probe.delta_scenario_score.unmapped_recap_count ?? "-"} chatter=${probe.delta_scenario_score.administrative_chatter_count ?? "-"} net=${probe.delta_scenario_score.score ?? "-"}`,
						);
					}
				}
			}
			p.outro("done");
		},
	);
	return cmd;
}

function createMemoryExtractionReportCommand(): Command {
	const cmd = new Command("extraction-report")
		.configureHelp(helpStyle)
		.description("Score extracted memories for a session against a built-in extraction eval rubric")
		.option("--session-id <id>", "session ID to evaluate")
		.option("--batch-id <id>", "raw-event flush batch ID to evaluate")
		.requiredOption("--scenario <id>", "built-in extraction eval scenario ID")
		.option("--inactive", "include inactive memories");
	addDbOption(cmd);
	addJsonOption(cmd);
	cmd.action(
		(
			opts: DbOpts &
				JsonOpts & {
					sessionId: string;
					batchId?: string;
					scenario: string;
					inactive?: boolean;
				},
		) => {
			const sessionIdInput = opts.sessionId?.trim() ?? "";
			const batchIdInput = opts.batchId?.trim() ?? "";
			const hasSessionId = sessionIdInput.length > 0;
			const hasBatchId = batchIdInput.length > 0;
			if (hasSessionId === hasBatchId) {
				throw new Error("Provide exactly one of --session-id or --batch-id");
			}
			const sessionId = hasSessionId ? parseStrictPositiveId(sessionIdInput) : null;
			if (hasSessionId && sessionId === null) {
				throw new Error(`Invalid session ID: ${sessionIdInput || opts.sessionId}`);
			}
			const batchId = hasBatchId ? parseStrictPositiveId(batchIdInput) : null;
			if (hasBatchId && batchId === null) {
				throw new Error(`Invalid batch ID: ${batchIdInput || opts.batchId}`);
			}
			const scenarioId = opts.scenario?.trim() ?? "";
			const scenario = getSessionExtractionEvalScenario(scenarioId);
			if (!scenario) {
				throw new Error(`Unknown extraction eval scenario: ${scenarioId || opts.scenario}`);
			}
			const result =
				batchId != null
					? getSessionExtractionEval(resolveDbOpt(opts), {
							batchId,
							scenarioId: scenario.id,
							includeInactive: opts.inactive === true,
						})
					: getSessionExtractionEval(resolveDbOpt(opts), {
							sessionId: sessionId as number,
							scenarioId: scenario.id,
							includeInactive: opts.inactive === true,
						});

			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			p.intro("codemem memory extraction-report");
			p.log.info(
				[
					`Scenario: ${result.scenario.id} — ${result.scenario.title}`,
					`Target: ${result.target.type}${result.target.batchId != null ? ` #${result.target.batchId}` : ""}`,
					`Session: ${result.session.id} (${result.session.project ?? "no-project"})`,
					`Session class: ${result.session.sessionClass}`,
					`Summary disposition: ${result.session.summaryDisposition}`,
				].join("\n"),
			);
			p.log.info(
				[
					`Pass: ${result.pass ? "yes" : "no"}`,
					`Summary count: ${result.counts.summaries}`,
					`Observation count: ${result.counts.observations}`,
					`Summary thread coverage: ${result.coverage.summaryThreadCoverage}`,
					`Observation thread coverage: ${result.coverage.observationThreadCoverage}`,
					`Total thread coverage: ${result.coverage.totalThreadCoverage}`,
					`Duplicate observation threads: ${result.coverage.duplicateObservationThreads}`,
				].join("\n"),
			);
			if (result.failureReasons.length > 0) {
				p.log.warn("Failure reasons:");
				for (const reason of result.failureReasons) {
					p.log.message(`  - ${reason}`);
				}
			}
			p.log.info("Thread coverage:");
			for (const thread of result.threads) {
				p.log.message(
					`  ${thread.id.padEnd(22)} summary=${thread.summaryMatch ? "yes" : "no"} observations=${thread.observationMatch ? "yes" : "no"}`,
				);
			}
			p.outro("done");
		},
	);
	return cmd;
}

function createMemoryExtractionReplayCommand(): Command {
	const cmd = new Command("extraction-replay")
		.configureHelp(helpStyle)
		.description(
			"Re-run the observer on a historical flush batch without persisting, then score the fresh output",
		)
		.requiredOption("--batch-id <id>", "raw-event flush batch ID to replay")
		.option(
			"--transcript-budget <chars>",
			"override replay transcript budget in characters (replay only)",
		)
		.option("--observer-tier-routing", "use replay-only benchmark-backed observer tier routing")
		.option("--observer-temperature <value>", "override observer temperature for replay only")
		.option("--openai-responses", "use OpenAI Responses API for replay only")
		.option(
			"--reasoning-effort <level>",
			"set OpenAI reasoning.effort for replay only (responses path)",
		)
		.option(
			"--reasoning-summary <mode>",
			"set OpenAI reasoning.summary for replay only (responses path)",
		)
		.option(
			"--max-output-tokens <n>",
			"override OpenAI max_output_tokens for replay only (responses path)",
		)
		.requiredOption("--scenario <id>", "built-in extraction eval scenario ID");
	addDbOption(cmd);
	addJsonOption(cmd);
	cmd.action(
		async (
			opts: DbOpts &
				JsonOpts & {
					batchId: string;
					observerTierRouting?: boolean;
					openaiResponses?: boolean;
					reasoningEffort?: string;
					reasoningSummary?: string;
					maxOutputTokens?: string;
					observerTemperature?: string;
					transcriptBudget?: string;
					scenario: string;
				},
		) => {
			const batchIdInput = opts.batchId?.trim() ?? "";
			const batchId = parseStrictPositiveId(batchIdInput);
			if (batchId === null) {
				throw new Error(`Invalid batch ID: ${batchIdInput || opts.batchId}`);
			}
			const scenarioId = opts.scenario?.trim() ?? "";
			const scenario = getSessionExtractionEvalScenario(scenarioId);
			if (!scenario) {
				throw new Error(`Unknown extraction eval scenario: ${scenarioId || opts.scenario}`);
			}
			const transcriptBudgetInput = opts.transcriptBudget?.trim() ?? "";
			const transcriptBudget =
				transcriptBudgetInput.length > 0 ? parseStrictPositiveId(transcriptBudgetInput) : null;
			if (transcriptBudgetInput.length > 0 && transcriptBudget === null) {
				throw new Error(
					`Invalid transcript budget: ${transcriptBudgetInput || opts.transcriptBudget}`,
				);
			}
			const observerTemperatureInput = opts.observerTemperature?.trim() ?? "";
			let observerTemperature: number | undefined;
			if (observerTemperatureInput.length > 0) {
				const parsed = Number(observerTemperatureInput);
				if (!Number.isFinite(parsed)) {
					throw new Error(
						`Invalid observer temperature: ${observerTemperatureInput || opts.observerTemperature}`,
					);
				}
				observerTemperature = parsed;
			}
			const maxOutputTokensInput = opts.maxOutputTokens?.trim() ?? "";
			const maxOutputTokens =
				maxOutputTokensInput.length > 0 ? parseStrictPositiveId(maxOutputTokensInput) : null;
			if (maxOutputTokensInput.length > 0 && maxOutputTokens === null) {
				throw new Error(
					`Invalid max output tokens: ${maxOutputTokensInput || opts.maxOutputTokens}`,
				);
			}
			const observerConfig = loadObserverConfig();
			const observerConfigWithOverrides = {
				...observerConfig,
				observerTemperature: observerTemperature ?? observerConfig.observerTemperature,
				observerOpenAIUseResponses: opts.openaiResponses === true,
				observerReasoningEffort: opts.reasoningEffort?.trim() || null,
				observerReasoningSummary: opts.reasoningSummary?.trim() || null,
				observerMaxOutputTokens: maxOutputTokens ?? observerConfig.observerMaxTokens,
			};
			const observer = new ObserverClient(observerConfigWithOverrides);
			const result =
				opts.observerTierRouting === true
					? await replayBatchExtractionWithTierRouting(
							resolveDbOpt(opts),
							observerConfigWithOverrides,
							{
								batchId,
								scenarioId: scenario.id,
								transcriptBudget: transcriptBudget ?? undefined,
							},
						)
					: await replayBatchExtraction(resolveDbOpt(opts), observer, {
							batchId,
							scenarioId: scenario.id,
							transcriptBudget: transcriptBudget ?? undefined,
						});

			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			p.intro("codemem memory extraction-replay");
			p.log.info(
				[
					`Scenario: ${result.scenario.id} — ${result.scenario.title}`,
					`Batch: ${result.target.batchId}`,
					`Session: ${result.target.sessionId}`,
					`Observer: ${result.observer.provider}/${result.observer.model}`,
					`Tier: ${result.observer.tier ?? "manual"}`,
					`OpenAI Responses: ${result.observer.openaiUseResponses ? "yes" : "no"}`,
					`Reasoning effort: ${result.observer.reasoningEffort ?? "none"}`,
					`Classification: ${result.classification.status}`,
					`Pass: ${result.evaluation.pass ? "yes" : "no"}`,
				].join("\n"),
			);
			if (result.classification.reason) {
				p.log.message(`Classification reason: ${result.classification.reason}`);
			}
			if (result.evaluation.failureReasons.length > 0) {
				p.log.warn("Failure reasons:");
				for (const reason of result.evaluation.failureReasons) {
					p.log.message(`  - ${reason}`);
				}
			}
			p.log.info(
				[
					`Fresh summaries: ${result.evaluation.counts.summaries}`,
					`Fresh observations: ${result.evaluation.counts.observations}`,
					`Summary thread coverage: ${result.evaluation.coverage.summaryThreadCoverage}`,
					`Observation thread coverage: ${result.evaluation.coverage.observationThreadCoverage}`,
					`Total thread coverage: ${result.evaluation.coverage.totalThreadCoverage}`,
				].join("\n"),
			);
			p.outro("done");
		},
	);
	return cmd;
}

function createMemoryExtractionBenchmarkCommand(): Command {
	const cmd = new Command("extraction-benchmark")
		.configureHelp(helpStyle)
		.description(
			"Run the formal extraction replay benchmark set and print a cost/quality scoreboard",
		)
		.requiredOption("--benchmark <id>", "benchmark profile id")
		.option("--observer-provider <provider>", "override observer provider for this benchmark run")
		.option("--observer-model <model>", "override observer model for this benchmark run")
		.option("--observer-tier-routing", "use replay-only benchmark-backed observer tier routing")
		.option("--openai-responses", "use OpenAI Responses API for this benchmark run")
		.option(
			"--reasoning-effort <level>",
			"set OpenAI reasoning.effort for this benchmark run (responses path)",
		)
		.option(
			"--reasoning-summary <mode>",
			"set OpenAI reasoning.summary for this benchmark run (responses path)",
		)
		.option(
			"--max-output-tokens <n>",
			"override OpenAI max_output_tokens for this benchmark run (responses path)",
		)
		.option(
			"--observer-temperature <value>",
			"override observer temperature for this benchmark run",
		)
		.option(
			"--transcript-budget <chars>",
			"override replay transcript budget in characters for this benchmark run",
		);
	addDbOption(cmd);
	addJsonOption(cmd);
	cmd.action(
		async (
			opts: DbOpts &
				JsonOpts & {
					benchmark: string;
					observerProvider?: string;
					observerModel?: string;
					observerTierRouting?: boolean;
					openaiResponses?: boolean;
					reasoningEffort?: string;
					reasoningSummary?: string;
					maxOutputTokens?: string;
					observerTemperature?: string;
					transcriptBudget?: string;
				},
		) => {
			const benchmarkId = opts.benchmark?.trim() ?? "";
			const benchmark = getExtractionBenchmarkProfile(benchmarkId);
			if (!benchmark) {
				throw new Error(`Unknown extraction benchmark: ${benchmarkId || opts.benchmark}`);
			}
			const transcriptBudgetInput = opts.transcriptBudget?.trim() ?? "";
			const transcriptBudget =
				transcriptBudgetInput.length > 0 ? parseStrictPositiveId(transcriptBudgetInput) : null;
			if (transcriptBudgetInput.length > 0 && transcriptBudget === null) {
				throw new Error(
					`Invalid transcript budget: ${transcriptBudgetInput || opts.transcriptBudget}`,
				);
			}
			const observerTemperatureInput = opts.observerTemperature?.trim() ?? "";
			let observerTemperature: number | undefined;
			if (observerTemperatureInput.length > 0) {
				const parsed = Number(observerTemperatureInput);
				if (!Number.isFinite(parsed)) {
					throw new Error(
						`Invalid observer temperature: ${observerTemperatureInput || opts.observerTemperature}`,
					);
				}
				observerTemperature = parsed;
			}
			const maxOutputTokensInput = opts.maxOutputTokens?.trim() ?? "";
			const maxOutputTokens =
				maxOutputTokensInput.length > 0 ? parseStrictPositiveId(maxOutputTokensInput) : null;
			if (maxOutputTokensInput.length > 0 && maxOutputTokens === null) {
				throw new Error(
					`Invalid max output tokens: ${maxOutputTokensInput || opts.maxOutputTokens}`,
				);
			}
			const observerConfig = loadObserverConfig();
			const observerConfigWithOverrides = {
				...observerConfig,
				observerProvider: opts.observerProvider?.trim() || observerConfig.observerProvider,
				observerModel: opts.observerModel?.trim() || observerConfig.observerModel,
				observerTemperature: observerTemperature ?? observerConfig.observerTemperature,
				observerOpenAIUseResponses: opts.openaiResponses === true,
				observerReasoningEffort: opts.reasoningEffort?.trim() || null,
				observerReasoningSummary: opts.reasoningSummary?.trim() || null,
				observerMaxOutputTokens: maxOutputTokens ?? observerConfig.observerMaxTokens,
			};
			const observer = new ObserverClient(observerConfigWithOverrides);
			const runs = [] as Array<{
				batchId: number;
				sessionId: number;
				label: string;
				purpose: "shape_quality" | "replay_robustness";
				complexity: string;
				scenarioId: string;
				expectedTier: string | null;
				analysis: {
					eventSpan: number;
					promptCount: number;
					toolCount: number;
					transcriptLength: number;
				};
				status: "pass" | "shape_fail" | "observer_no_output";
				reason: string;
				tier: string;
				provider: string;
				model: string;
				openaiUseResponses: boolean;
				reasoningEffort: string | null;
				reasoningSummary: string | null;
				maxOutputTokens: number;
				temperature: number | null;
				summaries: number;
				observations: number;
				repairApplied: boolean;
			}>;
			for (const batch of benchmark.batches) {
				const scenarioId = batch.scenarioId ?? benchmark.scenarioId;
				const result =
					opts.observerTierRouting === true
						? await replayBatchExtractionWithTierRouting(
								resolveDbOpt(opts),
								observerConfigWithOverrides,
								{
									batchId: batch.batchId,
									scenarioId,
									transcriptBudget: transcriptBudget ?? undefined,
								},
							)
						: await replayBatchExtraction(resolveDbOpt(opts), observer, {
								batchId: batch.batchId,
								scenarioId,
								transcriptBudget: transcriptBudget ?? undefined,
							});
				runs.push({
					batchId: batch.batchId,
					sessionId: batch.sessionId,
					label: batch.label,
					purpose: batch.purpose,
					complexity: batch.complexity,
					scenarioId,
					expectedTier: batch.expectedTier ?? null,
					analysis: {
						eventSpan: result.analysis.eventSpan,
						promptCount: result.analysis.promptCount,
						toolCount: result.analysis.toolCount,
						transcriptLength: result.analysis.transcriptLength,
					},
					status: result.classification.status,
					reason: result.classification.reason,
					tier: result.observer.tier ?? "manual",
					provider: result.observer.provider,
					model: result.observer.model,
					openaiUseResponses: result.observer.openaiUseResponses,
					reasoningEffort: result.observer.reasoningEffort,
					reasoningSummary: result.observer.reasoningSummary,
					maxOutputTokens: result.observer.maxOutputTokens,
					temperature: result.observer.temperature,
					summaries: result.evaluation.counts.summaries,
					observations: result.evaluation.counts.observations,
					repairApplied: result.observer.repairApplied,
				});
			}
			const summary = {
				total: runs.length,
				shapeQualityTotal: runs.filter((run) => run.purpose === "shape_quality").length,
				shapeQualityPasses: runs.filter(
					(run) => run.purpose === "shape_quality" && run.status === "pass",
				).length,
				shapeQualityFails: runs.filter(
					(run) => run.purpose === "shape_quality" && run.status === "shape_fail",
				).length,
				expectedTierTotal: runs.filter((run) => run.expectedTier != null).length,
				expectedTierMatches: runs.filter(
					(run) => run.expectedTier != null && run.expectedTier === run.tier,
				).length,
				robustnessNoOutput: runs.filter((run) => run.status === "observer_no_output").length,
			};
			const uniqueObserverKeys = Array.from(
				new Set(
					runs.map(
						(run) =>
							`${run.provider}::${run.model}::${run.openaiUseResponses ? "responses" : "chat"}`,
					),
				),
			);
			const observerSummary =
				opts.observerTierRouting === true
					? {
							provider:
								uniqueObserverKeys.length === 1
									? (runs[0]?.provider ?? observer.provider)
									: "mixed",
							model: uniqueObserverKeys.length === 1 ? (runs[0]?.model ?? observer.model) : "mixed",
							tierRouting: true,
							openaiUseResponses:
								uniqueObserverKeys.length === 1
									? (runs[0]?.openaiUseResponses ?? observer.openaiUseResponses)
									: null,
							reasoningEffort:
								uniqueObserverKeys.length === 1
									? (runs[0]?.reasoningEffort ?? observer.reasoningEffort)
									: "mixed",
							reasoningSummary:
								uniqueObserverKeys.length === 1
									? (runs[0]?.reasoningSummary ?? observer.reasoningSummary)
									: "mixed",
							maxOutputTokens:
								uniqueObserverKeys.length === 1
									? (runs[0]?.maxOutputTokens ?? observer.maxOutputTokens)
									: null,
							temperature:
								uniqueObserverKeys.length === 1
									? (runs[0]?.temperature ?? observer.temperature)
									: null,
							transcriptBudget: transcriptBudget ?? null,
							selectedObservers: uniqueObserverKeys,
						}
					: {
							provider: observer.provider,
							model: observer.model,
							tierRouting: false,
							openaiUseResponses: observer.openaiUseResponses,
							reasoningEffort: observer.reasoningEffort,
							reasoningSummary: observer.reasoningSummary,
							maxOutputTokens: observer.maxOutputTokens,
							temperature: observer.temperature,
							transcriptBudget: transcriptBudget ?? null,
							selectedObservers: uniqueObserverKeys,
						};
			const output = {
				benchmark: {
					id: benchmark.id,
					title: benchmark.title,
					scenarioId: benchmark.scenarioId,
				},
				observer: observerSummary,
				summary,
				runs,
			};

			if (opts.json) {
				console.log(JSON.stringify(output, null, 2));
				return;
			}

			p.intro("codemem memory extraction-benchmark");
			p.log.info(
				[
					`Benchmark: ${benchmark.id} — ${benchmark.title}`,
					`Observer: ${observerSummary.provider}/${observerSummary.model}`,
					`Tier routing: ${opts.observerTierRouting === true ? "yes" : "no"}`,
					`OpenAI Responses: ${observerSummary.openaiUseResponses === null ? "mixed" : observerSummary.openaiUseResponses ? "yes" : "no"}`,
					`Reasoning effort: ${observerSummary.reasoningEffort ?? "none"}`,
					`Reasoning summary: ${observerSummary.reasoningSummary ?? "none"}`,
					`Max output tokens: ${observerSummary.maxOutputTokens ?? "mixed"}`,
					`Temperature: ${observerSummary.temperature ?? "mixed"}`,
					`Transcript budget override: ${transcriptBudget ?? "default"}`,
					`Shape-quality passes: ${summary.shapeQualityPasses}/${summary.shapeQualityTotal}`,
					`Shape-quality fails: ${summary.shapeQualityFails}`,
					`Expected-tier matches: ${summary.expectedTierMatches}/${summary.expectedTierTotal}`,
					`Observer no-output cases: ${summary.robustnessNoOutput}`,
				].join("\n"),
			);
			for (const run of runs) {
				p.log.message(
					`  [${run.batchId}] ${run.status.padEnd(18)} ${run.complexity.padEnd(10)} tier=${run.tier.padEnd(6)} expected=${(run.expectedTier ?? "n/a").padEnd(6)} span=${String(run.analysis.eventSpan).padEnd(3)} prompts=${run.analysis.promptCount} tools=${String(run.analysis.toolCount).padEnd(2)} transcript=${run.analysis.transcriptLength} ${run.provider}/${run.model}${run.openaiUseResponses ? " [responses]" : ""} summaries=${run.summaries} observations=${run.observations} repair=${run.repairApplied ? "yes" : "no"} — ${run.label}`,
				);
			}
			p.outro("done");
		},
	);
	return cmd;
}

function createMemoryRelinkReportCommand(): Command {
	const cmd = new Command("relink-report")
		.configureHelp(helpStyle)
		.description("Analyze dry-run raw-event session relinking and compaction opportunities")
		.option("--project <project>", "project identifier (defaults to git repo root)")
		.option("--all-projects", "analyze across all projects")
		.option("--limit <n>", "max groups to print", "25");
	addDbOption(cmd);
	addJsonOption(cmd);
	cmd.action(
		(
			opts: DbOpts &
				JsonOpts & {
					project?: string;
					allProjects?: boolean;
					limit?: string;
				},
		) => {
			const project =
				opts.allProjects === true
					? null
					: opts.project?.trim() ||
						process.env.CODEMEM_PROJECT?.trim() ||
						resolveProject(process.cwd(), null);
			const limit = Number.parseInt(opts.limit ?? "25", 10) || 25;
			const result = getRawEventRelinkReport(resolveDbOpt(opts), {
				project,
				allProjects: opts.allProjects === true,
				limit,
			});

			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			p.intro("codemem memory relink-report");
			p.log.info(
				[
					`Recoverable sessions: ${result.totals.recoverable_sessions}`,
					`Distinct stable ids: ${result.totals.distinct_stable_ids}`,
					`Groups with multiple sessions: ${result.totals.groups_with_multiple_sessions}`,
					`Groups with mapped session: ${result.totals.groups_with_mapped_session}`,
					`Groups without mapped session: ${result.totals.groups_without_mapped_session}`,
					`Active memories in groups: ${result.totals.active_memories}`,
					`Repointable active memories: ${result.totals.repointable_active_memories}`,
				].join("\n"),
			);
			p.log.info("Top relink groups:");
			for (const group of result.groups) {
				p.log.message(
					`  ${group.stable_id} -> canonical ${group.canonical_session_id} | local=${group.local_sessions} mapped=${group.mapped_sessions} unmapped=${group.unmapped_sessions} active=${group.active_memories} repointable=${group.repointable_active_memories}`,
				);
			}
			p.outro("done");
		},
	);
	return cmd;
}

function createMemoryRelinkPlanCommand(): Command {
	const cmd = new Command("relink-plan")
		.configureHelp(helpStyle)
		.description("Emit dry-run raw-event relink remediation actions")
		.option("--project <project>", "project identifier (defaults to git repo root)")
		.option("--all-projects", "analyze across all projects")
		.option("--limit <n>", "max groups to include", "25");
	addDbOption(cmd);
	addJsonOption(cmd);
	cmd.action(
		(
			opts: DbOpts &
				JsonOpts & {
					project?: string;
					allProjects?: boolean;
					limit?: string;
				},
		) => {
			const project =
				opts.allProjects === true
					? null
					: opts.project?.trim() ||
						process.env.CODEMEM_PROJECT?.trim() ||
						resolveProject(process.cwd(), null);
			const limit = Number.parseInt(opts.limit ?? "25", 10) || 25;
			const result = getRawEventRelinkPlan(resolveDbOpt(opts), {
				project,
				allProjects: opts.allProjects === true,
				limit,
			});

			if (opts.json) {
				console.log(JSON.stringify(result, null, 2));
				return;
			}

			p.intro("codemem memory relink-plan");
			p.log.info(
				[
					`Groups: ${result.totals.groups}`,
					`Eligible groups: ${result.totals.eligible_groups}`,
					`Skipped groups: ${result.totals.skipped_groups}`,
					`Actions: ${result.totals.actions}`,
					`Bridge creations: ${result.totals.bridge_creations}`,
					`Memory repoints: ${result.totals.memory_repoints}`,
					`Session compactions: ${result.totals.session_compactions}`,
				].join("\n"),
			);
			p.log.info("Planned actions:");
			for (const action of result.actions.slice(0, 15)) {
				p.log.message(
					`  ${action.action} ${action.stable_id} -> canonical ${action.canonical_session_id} | sessions=${action.session_ids.join(",") || "-"} memories=${action.memory_count} reason=${action.reason}`,
				);
			}
			if (result.skipped_groups.length > 0) {
				p.log.info("Skipped groups:");
				for (const group of result.skipped_groups.slice(0, 10)) {
					p.log.message(`  ${group.stable_id} | blockers=${group.blockers.join(",")}`);
				}
			}
			p.outro("done");
		},
	);
	return cmd;
}

export const showMemoryCommand = createShowMemoryCommand();
export const forgetMemoryCommand = createForgetMemoryCommand();
export const rememberMemoryCommand = createRememberMemoryCommand();

export const memoryCommand = new Command("memory")
	.configureHelp(helpStyle)
	.description("Memory item management");

memoryCommand.addCommand(createShowMemoryCommand());
memoryCommand.addCommand(createForgetMemoryCommand());
memoryCommand.addCommand(createRememberMemoryCommand());
memoryCommand.addCommand(createInjectMemoryCommand());
memoryCommand.addCommand(createMemoryRoleReportCommand());
memoryCommand.addCommand(createMemoryRoleCompareCommand());
memoryCommand.addCommand(createMemoryExtractionReportCommand());
memoryCommand.addCommand(createMemoryExtractionReplayCommand());
memoryCommand.addCommand(createMemoryExtractionBenchmarkCommand());
memoryCommand.addCommand(createMemoryRelinkReportCommand());
memoryCommand.addCommand(createMemoryRelinkPlanCommand());
