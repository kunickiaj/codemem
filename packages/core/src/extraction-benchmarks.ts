export interface ExtractionBenchmarkBatch {
	batchId: number;
	sessionId: number;
	label: string;
	purpose: "shape_quality" | "replay_robustness";
	complexity: "simple" | "working" | "rich" | "robustness";
	scenarioId?: string;
	expectedTier?: "simple" | "rich";
	expectedSummaryDisposition: "required" | "optional" | "skip";
	observationPolicy?: "scenario" | "zero";
	notes: string;
	/** Human-reviewed durable-fact labels; omitted profiles are treated as unreviewed. */
	review?: ExtractionBenchmarkReview;
}

export type ExtractionBenchmarkLabelDisposition = "required" | "optional" | "forbidden";

export interface ExtractionBenchmarkLabel {
	id: string;
	title: string;
	disposition: ExtractionBenchmarkLabelDisposition;
	keywordGroups: string[][];
	reviewerNotes: string;
	sourceEvidence: string;
}

export type ExtractionBenchmarkReview =
	| {
			status: "reviewed";
			reviewerNotes: string;
			labels: ExtractionBenchmarkLabel[];
	  }
	| {
			status: "unreviewed";
			reviewerNotes: string;
	  };

export interface ExtractionBenchmarkProfile {
	id: string;
	title: string;
	description: string;
	scenarioId: string;
	recommendedTruthModel: {
		provider: string;
		model: string;
		notes: string;
	};
	cheapCandidate: {
		provider: string;
		model: string;
		temperature: number;
		notes: string;
	};
	modelCandidates: ExtractionBenchmarkModelCandidate[];
	batches: ExtractionBenchmarkBatch[];
}

export interface ExtractionBenchmarkModelCandidate {
	provider: string;
	model: string;
	role: "simple_baseline" | "rich_baseline" | "quality_ceiling" | "cost_matched_challenger";
	reasoningEffort: "none";
	notes: string;
}

const UNREVIEWED_BATCH: ExtractionBenchmarkReview = {
	status: "unreviewed",
	reviewerNotes: "No durable-fact review has been recorded for this batch.",
};

const REVIEWED_BATCHES: Readonly<Record<number, ExtractionBenchmarkReview>> = {
	28350: {
		status: "reviewed",
		reviewerNotes:
			"This non-development image-generation interaction contains no durable codemem project fact and should be skipped.",
		labels: [],
	},
	28344: {
		status: "reviewed",
		reviewerNotes:
			"This batch only reads a handoff and acknowledges it; it contains no completed work or durable learning and should be skipped.",
		labels: [],
	},
	28262: {
		status: "reviewed",
		reviewerNotes:
			"The requested validation could not be performed because no shell was available; there is no durable result to retain.",
		labels: [],
	},
	28301: {
		status: "reviewed",
		reviewerNotes:
			"A clean re-review found no remaining concerns. The result belongs in the session summary, while review narration must not become a typed durable observation.",
		labels: [
			{
				id: "clean-review-workflow",
				title: "Clean review and ship narration is routine workflow",
				disposition: "forbidden",
				keywordGroups: [["ship", "ship it", "review passed", "no concerns"]],
				reviewerNotes:
					"Do not manufacture a durable project fact from a routine clean review with no findings.",
				sourceEvidence:
					"The replay concludes that all seven previously raised concerns were fixed and reports SHIP, without identifying a new reusable technical constraint.",
			},
		],
	},
	28275: {
		status: "reviewed",
		reviewerNotes:
			"The batch implements reviewed-label aggregate scoring and actual-usage cost accounting for model evaluation.",
		labels: [
			{
				id: "reviewed-quality-and-usage-cost",
				title: "Model evaluation uses reviewed quality and actual usage cost",
				disposition: "required",
				keywordGroups: [
					["reviewed", "human-reviewed", "review labels"],
					["quality", "recall", "scoring"],
					["usage", "token usage", "actual tokens"],
					["cost", "pricing"],
				],
				reviewerNotes:
					"Capture both halves of the implementation: quality aggregates are restricted to reviewed cases and cost is calculated from provider-reported token usage.",
				sourceEvidence:
					"The replay reports implemented reviewed-only aggregate quality and actual-usage cost scoring, followed by 24 passing tests.",
			},
		],
	},
	28256: {
		status: "reviewed",
		reviewerNotes:
			"The batch establishes zero-observation shape semantics and preserves parser/repair diagnostics for auditable replay.",
		labels: [
			{
				id: "zero-observation-shape-policy",
				title: "Working and rich batches may validly emit zero observations",
				disposition: "required",
				keywordGroups: [
					["working", "rich"],
					["zero observations", "no observations", "0 observations"],
					["valid", "allowed", "no minimum"],
				],
				reviewerNotes:
					"Retain the semantic correction that complexity does not impose a minimum observation count.",
				sourceEvidence:
					"The replay reports that working/rich scenarios allow zero observations, routine requires exactly zero, and simple allows at most one.",
			},
			{
				id: "auditable-parser-repair-diagnostics",
				title: "Replay preserves initial, repaired, and structural diagnostics",
				disposition: "required",
				keywordGroups: [
					["initial", "original"],
					["repair", "repaired"],
					["diagnostics", "structural diagnostics", "parser diagnostics"],
				],
				reviewerNotes:
					"Capture preservation of both attempts and diagnostics such as nesting, unknown fields, unsupported kinds, and data loss.",
				sourceEvidence:
					"The replay explicitly lists preserved initial/repaired parsed output and diagnostics for malformed structure and data loss.",
			},
		],
	},
	28264: {
		status: "reviewed",
		reviewerNotes:
			"The batch adds normalized elapsed-time/token-usage telemetry and separately establishes the per-invocation state needed for concurrency safety.",
		labels: [
			{
				id: "normalized-observer-telemetry",
				title: "Observer responses normalize elapsed time and provider token usage",
				disposition: "required",
				keywordGroups: [
					["elapsed", "elapsedms", "latency"],
					["usage", "token usage"],
					["openai", "anthropic", "provider"],
				],
				reviewerNotes:
					"Capture the additive elapsed-time and normalized provider-usage response fields; unavailable sidecar/SSE usage remains null rather than inferred.",
				sourceEvidence:
					"The exact replay input reports ObserverResponse elapsedMs/usage support for OpenAI and Anthropic paths and null usage when provider telemetry is unavailable.",
			},
			{
				id: "per-invocation-telemetry-state",
				title: "Telemetry state is scoped per invocation to avoid concurrency races",
				disposition: "required",
				keywordGroups: [
					["per invocation", "per-invocation", "per-call", "call result"],
					["race", "shared mutable state", "concurrent", "overlapping"],
				],
				reviewerNotes:
					"Keep concurrency safety separate from provider normalization so models are not rewarded for merging two durable facts into one oversized observation.",
				sourceEvidence:
					"The exact replay input says shared mutable last-usage state can race across concurrent observe calls and that usage must travel with each invocation result.",
			},
		],
	},
	18530: {
		status: "reviewed",
		reviewerNotes:
			"The dependency version check resolves the immediate question but produces no durable project change or constraint.",
		labels: [
			{
				id: "routine-dependency-version-check",
				title: "Routine dependency latest-version check is not durable memory",
				disposition: "forbidden",
				keywordGroups: [["better-sqlite3"], ["12.8.0", "latest version", "up to date"]],
				reviewerNotes:
					"The user abandoned the thread after confirming the package version; do not promote the transient lookup to a typed observation.",
				sourceEvidence:
					"The replay checks whether better-sqlite3 is current, confirms 12.8.0/latest, identifies the warning as upstream noise, and makes no change.",
			},
		],
	},
	18490: {
		status: "reviewed",
		reviewerNotes: "The compact CI diagnosis identifies one exact failing recall-pack behavior.",
		labels: [
			{
				id: "legacy-summary-leaks-into-recall-pack",
				title: "Legacy summaries leaked into non-summary recall packs",
				disposition: "required",
				keywordGroups: [
					["legacy summary", "legacy summary rows"],
					["non-summary", "recall pack"],
					["leak", "included", "injected"],
				],
				reviewerNotes: "Capture the exact behavioral failure, not generic CI narration.",
				sourceEvidence:
					"The replay identifies pack.test.ts:432 and reports Legacy summary appearing under Summary in a non-summary recall pack.",
			},
		],
	},
	18494: {
		status: "reviewed",
		reviewerNotes:
			"This independent compact session diagnoses the same legacy-summary recall-pack regression.",
		labels: [
			{
				id: "legacy-summary-leaks-into-recall-pack",
				title: "Legacy summaries leaked into non-summary recall packs",
				disposition: "required",
				keywordGroups: [
					["legacy summary", "legacy summary rows"],
					["non-summary", "recall pack"],
					["leak", "included", "injected"],
				],
				reviewerNotes: "Capture the exact behavioral failure, not generic CI narration.",
				sourceEvidence:
					"The replay independently identifies the buildMemoryPack test failure and the unexpected Legacy summary output.",
			},
		],
	},
	18524: {
		status: "reviewed",
		reviewerNotes:
			"The documentation research produces a concrete migration pattern from prebuild-install to prebuildify/node-gyp-build.",
		labels: [
			{
				id: "prebuildify-node-gyp-build-migration",
				title: "Native packages should bundle Node-API prebuilds with source fallback",
				disposition: "required",
				keywordGroups: [
					["prebuildify"],
					["napi", "node-api"],
					["node-gyp-build"],
					["prebuilds", "bundled prebuilds"],
					["fallback", "source build", "node-gyp"],
				],
				reviewerNotes:
					"Retain the complete packaging/runtime pattern, including publishing prebuilds and preserving source-build fallback.",
				sourceEvidence:
					"The replay's authoritative-doc research recommends prebuildify --napi, bundled prebuilds/**, node-gyp-build at runtime, and source fallback.",
			},
		],
	},
	18525: {
		status: "reviewed",
		reviewerNotes:
			"The investigation tentatively locates the warning in the better-sqlite3 dependency chain but intentionally stops before implementation.",
		labels: [
			{
				id: "prebuild-warning-transitive-source",
				title: "The prebuild-install warning likely comes through better-sqlite3",
				disposition: "optional",
				keywordGroups: [
					["prebuild-install", "prebuild warning"],
					["better-sqlite3"],
					["transitive", "dependency"],
				],
				reviewerNotes:
					"This was a useful but tentative source attribution, so it is optional rather than required ground truth.",
				sourceEvidence:
					"The replay traces the install warning to a likely transitive better-sqlite3 path and asks whether to continue with a fix or spike.",
			},
		],
	},
	18460: {
		status: "reviewed",
		reviewerNotes:
			"The durable lesson is the stale TypeScript incremental-cache fix; later Graphite/PR-body workflow is noise.",
		labels: [
			{
				id: "tsbuildinfo-clean-build-output",
				title: "TypeScript incremental state must be cleaned with build outputs",
				disposition: "required",
				keywordGroups: [
					["tsbuildinfofile", "tsbuildinfo", "incremental cache"],
					["dist", "build output"],
					["clean", "cleaned", "remove stale"],
					["tsc --build", "typescript build", "ci"],
				],
				reviewerNotes:
					"Capture that tsBuildInfoFile belongs under dist and CI should clean before the root build to prevent stale cache success.",
				sourceEvidence:
					"The replay recommends moving tsBuildInfoFile into dist and cleaning before root tsc --build so stale incremental state cannot survive output cleanup.",
			},
			{
				id: "graphite-pr-body-workflow",
				title: "Graphite and PR-body updates are routine workflow",
				disposition: "forbidden",
				keywordGroups: [
					["graphite", "gt submit"],
					["pr body", "pull request body", "ready for review"],
				],
				reviewerNotes:
					"Later branch-management and PR-description narration is not a durable technical observation.",
				sourceEvidence:
					"The latter replay events switch from the cache fix to Graphite submission and PR-body/ready-state workflow.",
			},
		],
	},
	18502: {
		status: "reviewed",
		reviewerNotes:
			"This rich planning batch defines injection-first memory, causal context, progressive disclosure, and a derived graph direction.",
		labels: [
			{
				id: "injection-first-causal-memory",
				title: "Track 3 optimizes automatic injection for rediscovery reduction",
				disposition: "required",
				keywordGroups: [
					["injection-first", "automatic injection"],
					["rediscovery", "rework", "scouting"],
				],
				reviewerNotes:
					"Capture the product goal visible in the exact replay prompt: automatic injection should reduce rediscovery, scouting, and repeated work.",
				sourceEvidence:
					"The exact truncated replay input contains the injection-first Track 3 goal and reduced rediscovery/scouting language; causal/progressive-disclosure details from the full raw batch are outside that prompt and are intentionally excluded.",
			},
			{
				id: "derived-readonly-relationship-graph",
				title: "A future graph layer should be derived and read-only first",
				disposition: "required",
				keywordGroups: [
					["graph", "knowledge graph"],
					["derived"],
					["read-only", "read only"],
					["relationship", "edges", "connected"],
				],
				reviewerNotes:
					"Retain the constraint that graph relationships augment retrieval but do not become the source of truth initially.",
				sourceEvidence:
					"The replay creates a tracked exploration based on silk-graph and specifies derived, read-only edges over existing memories/metadata.",
			},
		],
	},
	18506: {
		status: "reviewed",
		reviewerNotes:
			"The batch diagnoses rich-session under-extraction and implements fixes in both observer context and active-session flushing.",
		labels: [
			{
				id: "observer-transcript-omission",
				title: "Observer under-extraction was caused by omitted transcript context",
				disposition: "required",
				keywordGroups: [
					["transcript", "conversation transcript"],
					["observer", "observer prompt"],
					["missing", "omitted", "not sent", "never sent"],
					["under-extraction", "lossy", "weak memories"],
				],
				reviewerNotes:
					"Capture the root cause and the fix: pass a bounded head-and-tail transcript into ObserverContext/prompt.",
				sourceEvidence:
					"The replay traces a 150+ event quality failure to the pipeline building a transcript but never sending it to the observer, then adds bounded head/tail transcript context.",
			},
			{
				id: "bounded-active-session-flushing",
				title: "Active sessions flush in bounded batches without endless debounce",
				disposition: "required",
				keywordGroups: [
					["active session", "active auto-flush"],
					["batch limit", "bounded", "batch size"],
					["debounce", "flush"],
				],
				reviewerNotes:
					"Retain the complementary ingestion fix that prevents active streams from accumulating one giant observer batch.",
				sourceEvidence:
					"The replay reports active auto-flush respecting the worker batch limit, reducing the default batch size, and preventing debounce from resetting forever.",
			},
		],
	},
	18446: {
		status: "reviewed",
		reviewerNotes:
			"This batch is mostly repeated patch intent with no completed durable outcome; either a concise summary or a low-signal skip is acceptable.",
		labels: [
			{
				id: "repeated-patch-intent",
				title: "Repeated implementation intent is not a durable observation",
				disposition: "forbidden",
				keywordGroups: [["will patch", "going to patch", "implement next", "patch intent"]],
				reviewerNotes:
					"Do not turn repeated statements of intended work into durable completed-work memory.",
				sourceEvidence:
					"The replay repeats plans to patch and implementation narration without evidence of a completed technical outcome in the batch.",
			},
		],
	},
	18503: {
		status: "reviewed",
		reviewerNotes:
			"Known review identified one durable TypeScript regression lesson and one routine Graphite workflow topic that must not become durable memory.",
		labels: [
			{
				id: "stable-session-reuse-regression",
				title: "TypeScript must preserve stable session reuse",
				disposition: "required",
				keywordGroups: [
					["typescript", "ts implementation", "ts rewrite"],
					["stable session", "stable-session"],
					["reuse", "reused", "reusing"],
					["regression", "failure mode", "bug"],
				],
				reviewerNotes:
					"Capture the reusable regression lesson: the TypeScript path must retain stable-session reuse rather than creating a fresh session for each event or flush.",
				sourceEvidence:
					"Replay input names #607 / 10d324c5 as the stable-session reuse fix and links the missing behavior to fragmented micro-sessions.",
			},
			{
				id: "graphite-branch-hygiene",
				title: "Graphite branch hygiene is routine workflow",
				disposition: "forbidden",
				keywordGroups: [
					["graphite", "graphite stack"],
					["branch hygiene", "branch cleanup", "stack hygiene"],
				],
				reviewerNotes:
					"Branch cleanup and stack-management narration is routine workflow telemetry, not a durable project fact.",
				sourceEvidence:
					"Replay input contains Graphite branch cleanup narration, but no reusable product constraint or technical learning from that workflow.",
			},
		],
	},
	18432: {
		status: "reviewed",
		reviewerNotes:
			"Known review identified the transparent repair implementation and a separate limitation of relinking as required durable lessons.",
		labels: [
			{
				id: "transparent-relink-startup",
				title: "Raw-event relink repair runs transparently at startup",
				disposition: "required",
				keywordGroups: [
					["relink", "relinking"],
					["transparent", "internal", "quietly"],
					["startup", "prepareviewerdatabase", "viewer preparation"],
				],
				reviewerNotes:
					"Capture the product behavior evidenced by this replay: safe raw-event relinking is wired into startup/viewer preparation rather than exposed as a user-operated repair step.",
				sourceEvidence:
					"The replay request asks for a transparent repair path, and tool/test output shows prepareViewerDatabase invoking the internal relink executor.",
			},
			{
				id: "relinking-does-not-fix-recap-dominance",
				title: "Relinking does not fix recap dominance",
				disposition: "required",
				keywordGroups: [
					["relink", "relinking"],
					["recap dominance", "summary dominance", "recap-heavy retrieval"],
				],
				reviewerNotes:
					"Keep this distinct from transparent repair: even after relinking, retrieval can remain dominated by recap/summary artifacts.",
				sourceEvidence:
					"The exact truncated replay input contains relinking and recap-dominance evidence. The full raw batch's separate unmapped-burden phrase is outside the prompt and is intentionally excluded.",
			},
		],
	},
};

function benchmarkReview(batchId: number): ExtractionBenchmarkReview {
	return REVIEWED_BATCHES[batchId] ?? UNREVIEWED_BATCH;
}

function balancedShapeBatch(
	batchId: number,
	sessionId: number,
	label: string,
	complexity: "simple" | "working" | "rich",
	expectedSummaryDisposition: "required" | "optional" | "skip",
	notes: string,
	observationPolicy: "scenario" | "zero" = "scenario",
): ExtractionBenchmarkBatch {
	return {
		batchId,
		sessionId,
		label,
		purpose: "shape_quality",
		complexity,
		scenarioId: observationPolicy === "zero" ? "routine-batch-shape" : `${complexity}-batch-shape`,
		expectedTier: complexity === "rich" ? "rich" : "simple",
		expectedSummaryDisposition,
		observationPolicy,
		notes,
		review: benchmarkReview(batchId),
	};
}

const EXTRACTION_BENCHMARK_PROFILES: ExtractionBenchmarkProfile[] = [
	{
		id: "balanced-observer-quality-v1",
		title: "Balanced observer quality benchmark v1",
		description:
			"Primary reviewed observer-model benchmark: six simple, six working, and six rich shape cases, plus one separately reported replay-robustness case. It balances positive durable facts, optional facts, forbidden workflow noise, and valid low-signal skips.",
		scenarioId: "working-batch-shape",
		recommendedTruthModel: {
			provider: "openai",
			model: "gpt-5.4",
			notes:
				"Use as the current production baseline while the larger reviewed corpus is calibrated; do not treat it as immutable ground truth.",
		},
		cheapCandidate: {
			provider: "openai",
			model: "gpt-5.4-mini",
			temperature: 0.2,
			notes:
				"Simple-tier baseline to compare with Luna once the same transport and repeated-run protocol are available.",
		},
		modelCandidates: [
			{
				provider: "openai",
				model: "gpt-5.4-mini",
				role: "simple_baseline",
				reasoningEffort: "none",
				notes: "Current simple-tier baseline.",
			},
			{
				provider: "openai",
				model: "gpt-5.4",
				role: "rich_baseline",
				reasoningEffort: "none",
				notes: "Current rich-tier baseline.",
			},
			{
				provider: "openai",
				model: "gpt-5.5",
				role: "quality_ceiling",
				reasoningEffort: "none",
				notes: "Higher-cost quality reference.",
			},
			{
				provider: "openai",
				model: "gpt-5.6-terra",
				role: "cost_matched_challenger",
				reasoningEffort: "none",
				notes:
					"Fast rich-tier finalist; require repeated runs because the earlier 18446 failure proved stochastic.",
			},
		],
		batches: [
			balancedShapeBatch(
				18530,
				166430,
				"Abandoned dependency-version check",
				"simple",
				"required",
				"Small completed lookup: summarize the interaction but avoid manufacturing a typed observation.",
				"zero",
			),
			balancedShapeBatch(
				18490,
				166412,
				"Compact CI regression diagnosis A",
				"simple",
				"required",
				"Small batch with one exact durable failure diagnosis.",
			),
			balancedShapeBatch(
				18494,
				166413,
				"Compact CI regression diagnosis B",
				"simple",
				"required",
				"Independent compact session covering the same exact regression.",
			),
			balancedShapeBatch(
				28350,
				169290,
				"Non-development image workflow",
				"simple",
				"skip",
				"Negative control with no durable software-project content.",
				"zero",
			),
			balancedShapeBatch(
				28344,
				169289,
				"Handoff read and acknowledgement",
				"simple",
				"skip",
				"Negative control for context-only acknowledgement without completed work.",
				"zero",
			),
			balancedShapeBatch(
				28262,
				169278,
				"Blocked validation request",
				"simple",
				"skip",
				"Negative control where validation could not run and produced no durable result.",
				"zero",
			),
			balancedShapeBatch(
				18524,
				166429,
				"Native prebuild migration research",
				"working",
				"required",
				"Moderate documentation-research batch with one reusable packaging recommendation.",
			),
			balancedShapeBatch(
				18525,
				166430,
				"Transitive warning investigation",
				"working",
				"required",
				"Moderate investigation with tentative optional evidence and no implementation.",
			),
			balancedShapeBatch(
				18460,
				166400,
				"TypeScript cache fix plus PR workflow",
				"working",
				"required",
				"Mixed durable build-system lesson and forbidden routine workflow narration.",
			),
			balancedShapeBatch(
				28301,
				169286,
				"Clean eval-fix re-review",
				"working",
				"required",
				"Review-only control: a summary is useful, but zero typed observations is correct.",
				"zero",
			),
			balancedShapeBatch(
				28275,
				169282,
				"Reviewed quality and cost scoring implementation",
				"working",
				"required",
				"Tool-heavy implementation tail with an auditable scoring outcome.",
			),
			balancedShapeBatch(
				28256,
				169270,
				"Replay parser and shape-semantics implementation",
				"working",
				"required",
				"Tool-heavy implementation tail with two distinct durable eval semantics.",
			),
			balancedShapeBatch(
				18503,
				166405,
				"Stable-session regression investigation",
				"rich",
				"required",
				"Flagship multi-thread case with durable regression evidence and workflow noise.",
			),
			balancedShapeBatch(
				18502,
				166405,
				"Injection-first and graph architecture planning",
				"rich",
				"required",
				"Rich product-design case with causal retrieval and graph constraints.",
			),
			balancedShapeBatch(
				18506,
				166405,
				"Rich-session under-extraction root cause and fix",
				"rich",
				"required",
				"Rich diagnosis/implementation case spanning observer context and flush behavior.",
			),
			balancedShapeBatch(
				18432,
				166392,
				"Transparent relink repair and limitation",
				"rich",
				"required",
				"High-volume snapshot with two separate durable repair lessons.",
			),
			balancedShapeBatch(
				18446,
				166392,
				"Repeated patch-intent case",
				"rich",
				"optional",
				"Hard low-signal rich batch where either a concise summary or explicit skip is acceptable.",
				"zero",
			),
			balancedShapeBatch(
				28264,
				169280,
				"Cross-provider observer telemetry implementation",
				"rich",
				"required",
				"Rich implementation case with provider normalization and concurrency constraints.",
			),
			{
				batchId: 18476,
				sessionId: 166405,
				label: "Replay no-output robustness case",
				purpose: "replay_robustness",
				complexity: "robustness",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				expectedSummaryDisposition: "optional",
				notes:
					"Report separately from the 18 shape cases; observer no-output is a transport/replay robustness result, not a shape-quality miss.",
				review: benchmarkReview(18476),
			},
		],
	},
	{
		id: "rich-batch-shape-v1",
		title: "Rich batch shape benchmark v1",
		description:
			"Benchmark set for comparing observer models on rich-batch extraction shape. Shape-quality batches are used for observation/summary output quality. Replay-robustness batches are tracked separately and should not be counted as shape failures when the observer returns no output.",
		scenarioId: "rich-batch-shape",
		recommendedTruthModel: {
			provider: "openai",
			model: "gpt-5.4",
			notes:
				"Current best-performing benchmark model across the rich-batch set; use as the acceptance baseline for cheaper candidates.",
		},
		cheapCandidate: {
			provider: "openai",
			model: "gpt-5.4-mini",
			temperature: 0.2,
			notes:
				"Current cheapest promising candidate. It can pass some hard batches at temperature 0.2, but remains less reliable than full gpt-5.4.",
		},
		modelCandidates: [
			{
				provider: "openai",
				model: "gpt-5.4-mini",
				role: "simple_baseline",
				reasoningEffort: "none",
				notes: "Retain as the frequent/simple-tier cost baseline.",
			},
			{
				provider: "openai",
				model: "gpt-5.4",
				role: "rich_baseline",
				reasoningEffort: "none",
				notes: "Current rich-tier production baseline and primary comparison for Terra.",
			},
			{
				provider: "openai",
				model: "gpt-5.5",
				role: "quality_ceiling",
				reasoningEffort: "none",
				notes: "Higher-cost reference for quality headroom, not the default candidate.",
			},
			{
				provider: "openai",
				model: "gpt-5.6-terra",
				role: "cost_matched_challenger",
				reasoningEffort: "none",
				notes: "Leading rich-tier challenger because it is price-matched with GPT-5.4.",
			},
		],
		batches: [
			{
				batchId: 18503,
				sessionId: 166405,
				label: "Track 3 / release / qd7h under-extraction batch",
				purpose: "shape_quality",
				complexity: "rich",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				expectedSummaryDisposition: "required",
				notes:
					"Flagship hard case: historically under-extracted batch with multiple meaningful subthreads.",
				review: benchmarkReview(18503),
			},
			{
				batchId: 18502,
				sessionId: 166405,
				label: "Same session prelude rich batch",
				purpose: "shape_quality",
				complexity: "rich",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				expectedSummaryDisposition: "required",
				notes:
					"Useful adjacent batch from the same long session; helps avoid overfitting to 18503 alone.",
				review: benchmarkReview(18502),
			},
			{
				batchId: 18506,
				sessionId: 166405,
				label: "Same session later rich batch",
				purpose: "shape_quality",
				complexity: "rich",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				expectedSummaryDisposition: "required",
				notes:
					"Later large batch from the same session; currently passes on stronger models and validates generalization within the stream.",
				review: benchmarkReview(18506),
			},
			{
				batchId: 18432,
				sessionId: 166392,
				label: "Large snapshot batch with mixed success",
				purpose: "shape_quality",
				complexity: "rich",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				expectedSummaryDisposition: "required",
				notes:
					"High-volume snapshot batch used to compare budget and model sensitivity outside the Track 3 stream.",
				review: benchmarkReview(18432),
			},
			{
				batchId: 18446,
				sessionId: 166392,
				label: "Hard failing snapshot batch",
				purpose: "shape_quality",
				complexity: "rich",
				scenarioId: "routine-batch-shape",
				expectedTier: "rich",
				expectedSummaryDisposition: "optional",
				observationPolicy: "zero",
				notes:
					"Useful stubborn case: some models return summary-only or nothing; stronger models plus repair can recover it.",
				review: benchmarkReview(18446),
			},
			{
				batchId: 18476,
				sessionId: 166405,
				label: "Replay no-output robustness case",
				purpose: "replay_robustness",
				complexity: "robustness",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				expectedSummaryDisposition: "optional",
				notes:
					"Stored extraction passes shape, but replay may return no raw output at all. Track separately as observer/replay robustness, not shape quality.",
				review: benchmarkReview(18476),
			},
		],
	},
	{
		id: "mixed-batch-routing-v1",
		title: "Mixed-complexity routing benchmark v1",
		description:
			"Benchmark set for validating whether replay-only tier routing stays cheap on simpler batches while still escalating richer batches to the stronger observer path.",
		scenarioId: "working-batch-shape",
		recommendedTruthModel: {
			provider: "openai",
			model: "gpt-5.4",
			notes:
				"Use the stronger model as the truth baseline when validating that richer batches genuinely benefit from escalation.",
		},
		cheapCandidate: {
			provider: "openai",
			model: "gpt-5.4-mini",
			temperature: 0.2,
			notes:
				"Cheaper path that should remain selected for simpler batches unless routing thresholds are too aggressive.",
		},
		modelCandidates: [
			{
				provider: "openai",
				model: "gpt-5.4-mini",
				role: "simple_baseline",
				reasoningEffort: "none",
				notes: "Simple-tier routing baseline.",
			},
			{
				provider: "openai",
				model: "gpt-5.4",
				role: "rich_baseline",
				reasoningEffort: "none",
				notes: "Rich-tier routing baseline.",
			},
		],
		batches: [
			{
				batchId: 18530,
				sessionId: 166430,
				label: "Tiny prompt-only batch",
				purpose: "shape_quality",
				complexity: "simple",
				scenarioId: "routine-batch-shape",
				expectedTier: "simple",
				expectedSummaryDisposition: "required",
				observationPolicy: "zero",
				notes: "Very small batch that should clearly remain on the cheap/simple tier.",
				review: benchmarkReview(18530),
			},
			{
				batchId: 18490,
				sessionId: 166412,
				label: "Compact low-tool batch",
				purpose: "shape_quality",
				complexity: "simple",
				scenarioId: "simple-batch-shape",
				expectedTier: "simple",
				expectedSummaryDisposition: "required",
				notes: "Small batch with low tool count that should not trigger the rich tier.",
				review: benchmarkReview(18490),
			},
			{
				batchId: 18494,
				sessionId: 166413,
				label: "Compact short-session batch",
				purpose: "shape_quality",
				complexity: "simple",
				scenarioId: "simple-batch-shape",
				expectedTier: "simple",
				expectedSummaryDisposition: "required",
				notes: "Short-session compact batch chosen for genuinely low-complexity characteristics.",
				review: benchmarkReview(18494),
			},
			{
				batchId: 18524,
				sessionId: 166429,
				label: "Moderate small-tool working batch",
				purpose: "shape_quality",
				complexity: "working",
				scenarioId: "working-batch-shape",
				expectedTier: "simple",
				expectedSummaryDisposition: "required",
				notes: "Moderate batch that should remain cheap unless thresholds are too aggressive.",
				review: benchmarkReview(18524),
			},
			{
				batchId: 18525,
				sessionId: 166430,
				label: "Moderate prompt-heavy batch",
				purpose: "shape_quality",
				complexity: "working",
				scenarioId: "working-batch-shape",
				expectedTier: "simple",
				expectedSummaryDisposition: "required",
				notes: "Moderate batch with some prompt/tool activity but still below rich-batch scale.",
				review: benchmarkReview(18525),
			},
			{
				batchId: 18460,
				sessionId: 166400,
				label: "Cross-session moderate batch",
				purpose: "shape_quality",
				complexity: "working",
				scenarioId: "working-batch-shape",
				expectedTier: "simple",
				expectedSummaryDisposition: "required",
				notes:
					"Cross-session moderate batch to verify the simple tier remains viable outside the main stream.",
				review: benchmarkReview(18460),
			},
			{
				batchId: 18503,
				sessionId: 166405,
				label: "Track 3 / release / qd7h under-extraction batch",
				purpose: "shape_quality",
				complexity: "rich",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				expectedSummaryDisposition: "required",
				notes: "Flagship hard case that should still escalate to the rich tier.",
				review: benchmarkReview(18503),
			},
			{
				batchId: 18432,
				sessionId: 166392,
				label: "Large snapshot rich batch",
				purpose: "shape_quality",
				complexity: "rich",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				expectedSummaryDisposition: "required",
				notes: "High-volume snapshot batch that should continue escalating.",
				review: benchmarkReview(18432),
			},
			{
				batchId: 18476,
				sessionId: 166405,
				label: "Replay no-output robustness case",
				purpose: "replay_robustness",
				complexity: "robustness",
				scenarioId: "rich-batch-shape",
				expectedTier: "rich",
				expectedSummaryDisposition: "optional",
				notes:
					"Known no-output replay robustness case retained to make sure routing does not hide robustness failures.",
				review: benchmarkReview(18476),
			},
		],
	},
];

export function getExtractionBenchmarkProfile(id: string): ExtractionBenchmarkProfile | null {
	const normalized = id.trim().toLowerCase();
	const profile = EXTRACTION_BENCHMARK_PROFILES.find((candidate) => candidate.id === normalized);
	return profile ? cloneProfile(profile) : null;
}

export function listExtractionBenchmarkProfiles(): ExtractionBenchmarkProfile[] {
	return EXTRACTION_BENCHMARK_PROFILES.map(cloneProfile);
}

function cloneReview(review: ExtractionBenchmarkReview): ExtractionBenchmarkReview {
	if (review.status === "unreviewed") return { ...review };
	return {
		...review,
		labels: review.labels.map((label) => ({
			...label,
			keywordGroups: label.keywordGroups.map((group) => [...group]),
		})),
	};
}

function cloneProfile(profile: ExtractionBenchmarkProfile): ExtractionBenchmarkProfile {
	return {
		...profile,
		recommendedTruthModel: { ...profile.recommendedTruthModel },
		cheapCandidate: { ...profile.cheapCandidate },
		modelCandidates: profile.modelCandidates.map((candidate) => ({ ...candidate })),
		batches: profile.batches.map((batch) => ({
			...batch,
			...(batch.review ? { review: cloneReview(batch.review) } : {}),
		})),
	};
}
