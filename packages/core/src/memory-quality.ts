import { isSummaryLikeMemory } from "./summary-memory.js";

export type DerivedMemoryRole = "recap" | "durable" | "ephemeral" | "general";

/**
 * Artifact class for the dual-artifact memory model
 * (see docs/plans/2026-06-28-memory-worthiness-policy.md).
 *
 * - `session_summary`: "what happened" continuity/recap.
 * - `derived_fact`: "what future work should remember" (durable).
 * - `telemetry`: "what merely occurred" (process status, not durable memory).
 * - `unknown`: legacy/ambiguous content judged by inferred role.
 */
export type MemoryArtifactClass = "session_summary" | "derived_fact" | "telemetry" | "unknown";

/** Storage/retrieval disposition within an artifact class. */
export type MemoryWorthinessAction = "store" | "store_demoted" | "suppress";

export type MemoryWorthinessReason =
	| "durable_decision"
	| "implementation_contract"
	| "modal_contract"
	| "troubleshooting_gotcha"
	| "future_actionable_location"
	| "repo_specific_policy_exception"
	| "session_summary_recap"
	| "session_summary_micro"
	| "session_summary_empty"
	| "workstream_continuity"
	| "investigation_without_durable_conclusion"
	| "temporary_workstream_state"
	| "review_telemetry_no_findings"
	| "validation_telemetry_only"
	| "duplicate_active_policy"
	| "runtime_bootstrap_noise"
	| "generic_process_narration"
	| "role_inferred_durable"
	| "role_inferred_general"
	| "role_inferred_ephemeral";

export interface DerivedMemoryRoleResult {
	role: DerivedMemoryRole;
	reason: string;
}

/**
 * Dual-artifact worthiness result.
 *
 * Signal-balance contract: a candidate is only classified as `telemetry` /
 * suppressed when NO durable keep-signal is present. Validation/review/bootstrap
 * phrasing that also carries a contract, decision, or troubleshooting lesson is
 * kept as a `derived_fact` (fixes the presence-only false negatives in review).
 */
export interface MemoryWorthinessResult {
	artifact: MemoryArtifactClass;
	action: MemoryWorthinessAction;
	reasons: MemoryWorthinessReason[];
}

export interface InferMemoryRoleInput {
	kind: string;
	title: string;
	body_text: string;
	metadata?: Record<string, unknown> | null;
	project?: string | null;
	session_minutes?: number | null;
}

function classifyProjectQuality(project: unknown): "normal" | "empty" | "garbage_like" | "unknown" {
	if (project === undefined) return "unknown";
	const value = typeof project === "string" ? project.trim() : "";
	if (!value) return "empty";
	if (value === "T" || value === "adam" || value === "opencode" || value.startsWith("fatal:")) {
		return "garbage_like";
	}
	return "normal";
}

function hasAnyMarker(text: string, markers: string[]): boolean {
	return markers.some((marker) => text.includes(marker));
}

function hasAnyPattern(text: string, patterns: RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(text));
}

function memoryText(input: InferMemoryRoleInput): string {
	return `${input.title} ${input.body_text}`.trim().toLowerCase();
}

function inferMicroSession(
	sessionMinutes: number | null | undefined,
	metadata: Record<string, unknown>,
): boolean {
	if (typeof sessionMinutes === "number") return sessionMinutes < 1;
	const sessionClass = String(metadata.session_class ?? "")
		.trim()
		.toLowerCase();
	return ["trivial_turn", "micro_low_value", "micro_high_signal"].includes(sessionClass);
}

export function inferMemoryRole(input: InferMemoryRoleInput): DerivedMemoryRoleResult {
	const metadata = input.metadata ?? {};
	const isSummary = isSummaryLikeMemory({ kind: input.kind, metadata });
	if (isSummary) {
		return {
			role: "recap",
			reason: input.kind === "session_summary" ? "session_summary_kind" : "legacy_summary_metadata",
		};
	}

	const text = `${input.title} ${input.body_text}`.toLowerCase();
	const projectQuality = classifyProjectQuality(input.project);
	const microSession = inferMicroSession(input.session_minutes, metadata);
	const nonNormalProject = projectQuality === "empty" || projectQuality === "garbage_like";
	const hasTaskMarkers = hasAnyMarker(text, [
		"task:",
		"todo",
		"need to",
		"next step",
		"follow up",
		"continue ",
	]);
	const hasRecapMarkers = hasAnyMarker(text, [
		"## request",
		"## completed",
		"## learned",
		"user asked",
		"the session",
		"the goal was",
	]);
	const hasInvestigativeMarkers = hasAnyMarker(text, [
		"identified",
		"discovered",
		"confirm",
		"confirmed",
		"verified",
		"investigate",
		"investigated",
		"determine whether",
		"clarified",
		"resolved",
	]);

	if (["decision", "bugfix", "discovery", "exploration"].includes(input.kind)) {
		if (nonNormalProject)
			return { role: "general", reason: "durable_kind_with_non_normal_project" };
		if (hasTaskMarkers && !hasInvestigativeMarkers) {
			return { role: "ephemeral", reason: "durable_kind_task_markers_without_resolution" };
		}
		return { role: "durable", reason: "durable_kind" };
	}

	if (["feature", "refactor"].includes(input.kind)) {
		if (hasRecapMarkers) return { role: "recap", reason: "implementation_kind_with_recap_markers" };
		if (microSession && hasTaskMarkers) {
			return { role: "ephemeral", reason: "micro_session_implementation_task" };
		}
		return { role: "durable", reason: "implementation_kind" };
	}

	if (input.kind === "change") {
		if (hasRecapMarkers) {
			return { role: "recap", reason: "change_with_recap_markers" };
		}
		if (microSession) return { role: "ephemeral", reason: "micro_session_change" };
		if (nonNormalProject) return { role: "general", reason: "change_with_non_normal_project" };
		if (hasInvestigativeMarkers && !hasTaskMarkers) {
			return { role: "durable", reason: "change_with_investigative_markers" };
		}
		return { role: "ephemeral", reason: "default_change_ephemeral" };
	}

	return nonNormalProject
		? { role: "general", reason: "fallback_non_normal_project" }
		: { role: "ephemeral", reason: "fallback_ephemeral" };
}

/**
 * Detect durable keep-signals in memory text.
 *
 * These are evaluated BEFORE any telemetry/bootstrap/validation suppression so a
 * candidate that embeds a contract, decision, or troubleshooting lesson is never
 * dropped just because it also mentions "CI passed", "review approved", or
 * "workspace root". Returns the matched keep reasons (empty = no keep signal).
 */
function collectKeepReasons(input: {
	kind: string;
	text: string;
	hasImplementationLocator: boolean;
}): MemoryWorthinessReason[] {
	const { kind, text, hasImplementationLocator } = input;
	const reasons: MemoryWorthinessReason[] = [];

	const hasDecisionValue = hasAnyPattern(text, [
		/\bdecided\b/,
		/\bchosen\s+because\b/,
		/\bnon-goals?\b/,
		/\bout\s+of\s+scope\b/,
		/\bpreferred\b/,
		/\btrade-?off\b/,
	]);

	// Personal/process task phrasing is NOT a durable contract ("I must finish",
	// "we should remember", "must remember to ...", "next step should run tests").
	// These are next-step/handoff state, not reusable rules.
	const personalOrTaskModal = hasAnyPattern(text, [
		/\b(?:i|we|you)\s+(?:must|should|shall|need\s+to|have\s+to)\b/,
		/\bmust\s+remember\b/,
		// next-step / pending handoff phrasing governing a modal
		/\b(?:next\s+steps?|todo|follow[\s-]?up|then|afterwards?|later)\b[^.]*\b(?:must|should|shall)\b/,
		/\b(?:must|should|shall)\b[^.]*\b(?:next|after\s+(?:the\s+)?(?:edit|change|merge|pr)\s+(?:lands?|merges?))\b/,
	]);
	// M1 / C5 fix: any modal contract `must|should|shall <verb>` counts, not an
	// enumerated verb whitelist. Require a following lowercase verb-ish token so
	// "must" at end-of-clause or before punctuation doesn't over-match.
	//
	// The personal/task guard must only strip the PERSONAL/TASK clause, not block
	// an embedded impersonal contract elsewhere in the text (Codex): e.g. "We
	// should remember that viewer-server validation requires generated static
	// files" still has a durable `requires` rule. So `requires?` always qualifies,
	// and a modal contract qualifies when it is NOT purely personal/task phrasing.
	const hasRequires = hasAnyPattern(text, [/\brequires?\b/]);
	const hasImpersonalModal = hasAnyPattern(text, [
		/\b(?:must|should|shall)\s+(?:not\s+|always\s+|never\s+)?[a-z]{2,}\b/,
	]);
	const hasModalContract = hasRequires || (hasImpersonalModal && !personalOrTaskModal);
	// C6 fix: dependency/outcome phrasing is a durable lesson.
	const hasDependencyLesson = hasAnyPattern(text, [
		/\bdepends?\s+on\b/,
		/\bdependent\s+on\b/,
		/\bonly\s+(?:after|works?\s+when|if)\b/,
		/\brelies\s+on\b/,
	]);
	const hasContractNoun = hasAnyPattern(text, [
		/\bsource\s+of\s+truth\b/,
		/\bcontract\b/,
		/\binvariant\b/,
		/\bwhen\s+changing\b/,
	]);

	// A `decision`-kind row is durable even if it doesn't use an explicit decision
	// word; otherwise a decision that also mentions "tests passed" would fall
	// through to telemetry suppression (Codex C9).
	if (hasDecisionValue || kind === "decision") {
		reasons.push("durable_decision");
	}
	// A `bugfix`/`discovery` row that records an actual fix or finding is durable
	// even if it also mentions validation telemetry. Without this, an observer row
	// like `kind=bugfix` / "Fixed the race condition; tests passed" is suppressed
	// by the validation-telemetry regex below, silently dropping a real fix in the
	// capture-routing path (Codex). Require a resolution/finding verb so bare
	// "bugfix: tests passed" with no described fix still falls through.
	//
	// STRONG fix verbs always indicate a real change and keep regardless of any
	// validation/review phrasing in the same row ("Fixed auth timeout; tests
	// passed and no remaining issues" is still a durable fix — Codex).
	const hasStrongFixVerb = hasAnyPattern(text, [
		/\bfixed\b/,
		/\bresolved\b/,
		/\broot\s+caused?\b/,
		/\bpatched\b/,
	]);
	// WEAK finding verbs (confirmed/determined/found/discovered/identified) are
	// durable only when at least one occurrence governs a SUBSTANTIVE object, not
	// a validation/review subject or a no-findings outcome. The check is
	// per-clause: "Confirmed CI passed after determining cursor drift came from
	// unstable sort" must keep on the "determining cursor drift" clause even
	// though "Confirmed CI" governs telemetry (Codex).
	const WEAK_FINDING_VERBS =
		"confirmed|determined|determining|verified|verifying|found|finding|discovered|discovering|identified|identifying|confirming";
	// A weak finding verb is SUBSTANTIVE only when it directly governs a concrete
	// object that is NOT validation/review status or a no-finding outcome. We match
	// the verb followed by a content word other than the telemetry/no-finding
	// nouns; that excludes both "confirmed CI passed" (telemetry object) and a bare
	// "Verified" with no object (e.g. a terse title), while keeping "determining
	// cursor drift came from ..." (Codex: per-clause, not whole-text).
	// Objects that do NOT make a weak finding substantive: validation/review
	// status, no-finding outcomes, and another weak finding verb (a duplicated
	// bare verb such as a terse "Verified" title followed by "verified ..." must
	// not bootstrap itself into a substantive finding).
	const NON_SUBSTANTIVE_OBJECTS = `${WEAK_FINDING_VERBS}|tests?|lint|ci|build|typecheck|tsc|checks?|review|reviewer|pr|pull\\s+request|no|nothing|none`;
	// weak verb -> optional "that" -> optional determiner -> a content word that is
	// not itself a non-substantive object. Determiners are consumed (not allowed to
	// satisfy the object) so "verified the tests" / a bare "verified verified" do
	// not bootstrap a substantive finding, while "determined cursor drift" does.
	const DETERMINERS = "the|a|an|all|our|its|their";
	const substantiveWeakFinding = new RegExp(
		`\\b(?:${WEAK_FINDING_VERBS})\\s+(?:that\\s+)?(?:(?:${DETERMINERS})\\s+)?` +
			`(?!(?:${NON_SUBSTANTIVE_OBJECTS}|${DETERMINERS})\\b)[a-z]{3,}`,
	);
	const hasSubstantiveWeakFinding = substantiveWeakFinding.test(text);
	// Bare "found no blockers / no remaining issues" review telemetry, with no
	// strong fix and no substantive finding, still suppresses.
	const isReviewNoFindings = hasAnyPattern(text, [
		/\bfound\s+(?:no|nothing|none)\b/,
		/\bno\s+(?:blockers?|findings?|remaining\s+issues?|issues?)\b/,
	]);
	const hasUsefulFindingVerb = hasStrongFixVerb || hasSubstantiveWeakFinding;
	// `isReviewNoFindings` only blocks when there is no strong fix and no
	// substantive weak finding to stand on.
	if (
		(kind === "bugfix" || kind === "discovery") &&
		hasUsefulFindingVerb &&
		(hasStrongFixVerb || hasSubstantiveWeakFinding || !isReviewNoFindings)
	) {
		reasons.push(kind === "bugfix" ? "troubleshooting_gotcha" : "durable_decision");
	}
	if (hasModalContract || hasContractNoun || hasDependencyLesson) {
		// A locator (file/module/path) makes it a concrete implementation contract;
		// otherwise it is still a durable contract/rule (M3/M4: review or workspace
		// lessons without a file path must be kept).
		reasons.push(hasImplementationLocator ? "implementation_contract" : "modal_contract");
	}
	if (
		hasAnyPattern(text, [
			/\bfails?\s+when\b/,
			/\bthrows?\s+if\b/,
			/\broot\s+cause\b/,
			// "regression" only as a durable regression bug/risk — not "regression
			// tests passed / regression suite is green" validation telemetry.
			/\bregression\b(?!\s+(?:tests?|suite|run|checks?)\b)/,
			/\bgotcha\b/,
		])
	) {
		reasons.push("troubleshooting_gotcha");
	}
	if (
		hasImplementationLocator &&
		hasAnyPattern(text, [/\binspect\b/, /\bcontinue\b/, /\blook\s+in\b/, /\bowned\s+by\b/]) &&
		hasAnyPattern(text, [/\bbecause\b/, /\bso\b/, /\bto\s+avoid\b/])
	) {
		reasons.push("future_actionable_location");
	}
	if (
		(hasModalContract || hasContractNoun) &&
		hasAnyPattern(text, [
			/\bexception\b/,
			/\bexcept\b/,
			/\brepo-specific\b/,
			/\bproject-specific\b/,
		])
	) {
		reasons.push("repo_specific_policy_exception");
	}

	return reasons;
}

/**
 * Classify a memory candidate into a dual-artifact class plus a storage action.
 *
 * Order of evaluation enforces the signal-balance contract:
 * 1. session summaries are their own artifact (telemetry words inside a summary
 *    never turn it into a dropped telemetry row);
 * 2. durable keep-signals win over telemetry/bootstrap/validation suppression;
 * 3. only then do telemetry/process patterns suppress;
 * 4. continuity/ambiguous content falls back to inferred role.
 */
export function classifyMemoryWorthiness(input: InferMemoryRoleInput): MemoryWorthinessResult {
	const metadata = input.metadata ?? {};
	const kind = String(input.kind ?? "")
		.trim()
		.toLowerCase();
	const normalizedInput = { ...input, kind };
	const text = memoryText(normalizedInput);
	const isSummary = isSummaryLikeMemory({ kind, metadata });

	// 1. Session summaries are a first-class artifact, judged on their own terms.
	if (isSummary) {
		if (!text) {
			return {
				artifact: "session_summary",
				action: "suppress",
				reasons: ["session_summary_empty"],
			};
		}
		if (inferMicroSession(input.session_minutes, metadata)) {
			return {
				artifact: "session_summary",
				action: "store_demoted",
				reasons: ["session_summary_micro"],
			};
		}
		return { artifact: "session_summary", action: "store", reasons: ["session_summary_recap"] };
	}

	const hasImplementationLocator = hasAnyPattern(text, [
		/\bpackages\/[\w./-]+/,
		/\bdocs\/[\w./-]+/,
		/\bsrc\/[\w./-]+/,
		/[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|yaml|yml)\b/,
	]);

	// 2. Keep-signals win over telemetry/bootstrap/validation (fixes M1-M4).
	const keepReasons = collectKeepReasons({ kind, text, hasImplementationLocator });
	if (keepReasons.length > 0) {
		return { artifact: "derived_fact", action: "store", reasons: keepReasons };
	}

	// 3. Telemetry/process suppression (only when no durable keep-signal exists).
	if (
		hasAnyPattern(text, [
			/\b(?:reviewer|review|re-reviewed|pull request|pr)\b.*\b(?:no blockers?|no findings?|approved|no remaining issues?)\b/,
			/\b(?:no blockers?|no findings?|approved|no remaining issues?)\b.*\b(?:reviewer|review|re-reviewed|pull request|pr)\b/,
		])
	) {
		return { artifact: "telemetry", action: "suppress", reasons: ["review_telemetry_no_findings"] };
	}
	if (
		hasAnyPattern(text, [
			/\b(?:tests?|lint|ci|build|typecheck|tsc)\b.*\b(?:passed|green|succeeded|clean)\b/,
			/\b(?:passed|green|succeeded|clean)\b.*\b(?:tests?|lint|ci|build|typecheck|tsc)\b/,
		])
	) {
		return { artifact: "telemetry", action: "suppress", reasons: ["validation_telemetry_only"] };
	}
	if (
		hasAnyPattern(text, [
			/\buse\s+(?:the\s+)?(?:task\s+)?delegation\s+workflow\b/,
			/\bload\s+code-quality\s+standards?\b/,
			/\buse\s+(?:the\s+)?graphite\s+workflow\b/,
			/\bdo\s+not\s+modify\s+unrelated\s+(?:user\s+)?changes\b/,
			/\brun\s+minimal\s+(?:relevant\s+)?checks\b/,
		])
	) {
		return { artifact: "telemetry", action: "suppress", reasons: ["duplicate_active_policy"] };
	}
	if (
		hasAnyPattern(text, [
			/\bcontext\s+files?\s+(?:were\s+)?loaded\b/,
			/\bloaded\s+(?:the\s+)?context\b/,
			/\bsession\s+started\b/,
			/\bagent\s+initialized\b/,
			/\bplugin\s+initialized\b/,
			/\bworkspace\s+root\s+(?:was\s+)?(?:set|detected|loaded|resolved)\b/,
			/\bcurrent\s+date\b/,
			/\btask\s+tracker\s+(?:was\s+)?available\b/,
		])
	) {
		return { artifact: "telemetry", action: "suppress", reasons: ["runtime_bootstrap_noise"] };
	}

	// 4. Continuity / ambiguous content -> inferred role.
	const inferred = inferMemoryRole(normalizedInput);

	if (
		(inferred.role === "ephemeral" || kind === "change") &&
		hasAnyPattern(text, [
			/\bnext\s+steps?\b/,
			/\bpending\b/,
			/\bcurrently\s+(?:blocked|working|paused)\b/,
			/\bblocked\s+on\b/,
			/\b(?:task|work|review|migration)\s+is\s+in\s+progress\b/,
		])
	) {
		return { artifact: "unknown", action: "store_demoted", reasons: ["workstream_continuity"] };
	}
	if (
		hasAnyPattern(text, [
			/\btemporary\b/,
			/\bcurrent\s+branch\b/,
			/\breview\s+pass\s+is\s+pending\b/,
		])
	) {
		return {
			artifact: "unknown",
			action: "store_demoted",
			reasons: ["temporary_workstream_state"],
		};
	}

	// Demote investigations only when they lack a durable outcome. Confirmation
	// verbs (confirmed/determined/found/learned/discovered) signal a durable
	// finding and must not be demoted (Codex C10).
	const hasDurableOutcome = hasAnyPattern(text, [
		/\bresolved\b/,
		/\bfixed\b/,
		/\bconfirmed\b/,
		/\bdetermined\b/,
		// "found" as a finding verb (found that / found the / found a / found
		// it ...), not only "found that".
		/\bfound\b/,
		/\bdiscovered\b/,
		/\blearned\b/,
	]);
	// A NO-finding outcome ("found no issues/blockers", "found nothing",
	// "confirmed no problems") is not a reusable lesson — it must not exempt the
	// investigation from demotion (Codex). Treat it as no durable outcome.
	// Limit "no-finding" to status/no-issue phrasing. A bare "found no <word>"
	// catch-all wrongly demotes durable NEGATIVE findings like "found no fallback
	// for empty embeddings" (an absence-of-mechanism discovery, not telemetry).
	// Only no-status outcomes (no issues/blockers/problems/...) count (Codex).
	const NO_STATUS =
		"issues?|blockers?|problems?|findings?|bugs?|regressions?|errors?|remaining\\s+issues?";
	const hasNoFindingOutcome = hasAnyPattern(text, [
		// "found nothing" / "found none" (bare) is a no-finding outcome; but
		// "found no <X>" only counts when <X> is a status noun, so durable negative
		// findings like "found no fallback for empty embeddings" are NOT demoted.
		/\b(?:found|confirmed|determined|discovered)\s+(?:that\s+there\s+(?:were|are|was|is)\s+)?(?:nothing|none)\b/,
		new RegExp(
			`\\b(?:found|confirmed|determined|discovered)\\s+(?:that\\s+there\\s+(?:were|are|was|is)\\s+)?no\\s+(?:${NO_STATUS})\\b`,
		),
		new RegExp(`\\bno\\s+(?:${NO_STATUS})\\b`),
		/\bnothing\s+(?:to\s+\w+|of\s+note|notable|wrong)\b/,
	]);
	const hasInvestigatedWithoutOutcome =
		hasAnyPattern(text, [/\binvestigated\b/, /\binspected\b/, /\bchecked\b/, /\blooked\s+at\b/]) &&
		(!hasDurableOutcome || hasNoFindingOutcome);
	if (hasInvestigatedWithoutOutcome) {
		return {
			artifact: "unknown",
			action: "store_demoted",
			reasons: ["investigation_without_durable_conclusion"],
		};
	}

	if (
		hasAnyPattern(text, [
			/\bwork\s+(?:was\s+)?(?:completed|investigated)\b/,
			/\bcompleted\s+(?:the\s+)?work\b/,
		]) &&
		!hasImplementationLocator
	) {
		return { artifact: "telemetry", action: "suppress", reasons: ["generic_process_narration"] };
	}

	if (inferred.role === "durable") {
		return { artifact: "derived_fact", action: "store", reasons: ["role_inferred_durable"] };
	}
	if (inferred.role === "general") {
		return { artifact: "derived_fact", action: "store", reasons: ["role_inferred_general"] };
	}
	return { artifact: "unknown", action: "store_demoted", reasons: ["role_inferred_ephemeral"] };
}
