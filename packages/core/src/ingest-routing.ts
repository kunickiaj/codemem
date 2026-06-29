/**
 * Capture-time artifact routing for observer observations.
 *
 * This module is deliberately pure: it classifies already-parsed observer
 * observations and returns kept observations plus telemetry suppression counts.
 */

import type { ParsedObservation } from "./ingest-types.js";
import { classifyMemoryWorthiness, type MemoryWorthinessReason } from "./memory-quality.js";

export interface CaptureDerivationMarker {
	candidate: boolean;
	candidate_reasons?: MemoryWorthinessReason[];
	evaluated_extractor_version: "v1";
}

export type CaptureRoutedObservation = ParsedObservation & {
	derivation?: CaptureDerivationMarker;
};

export interface CaptureRoutingContext {
	project?: string | null;
	sessionMinutes?: number | null;
}

export interface CaptureRoutingResult {
	kept: CaptureRoutedObservation[];
	suppressedTelemetry: {
		count: number;
		reasons: string[];
	};
}

function observationBodyText(obs: ParsedObservation): string {
	const bodyParts: string[] = [];
	if (obs.narrative) bodyParts.push(obs.narrative);
	if (obs.facts.length > 0) {
		bodyParts.push(obs.facts.map((fact) => `- ${fact}`).join("\n"));
	}
	return bodyParts.join("\n\n");
}

export function routeObservationsForCapture(
	observations: ParsedObservation[],
	ctx: CaptureRoutingContext,
): CaptureRoutingResult {
	const kept: CaptureRoutedObservation[] = [];
	const reasons: string[] = [];

	for (const obs of observations) {
		const bodyText = observationBodyText(obs);
		const result = classifyMemoryWorthiness({
			kind: obs.kind.trim().toLowerCase(),
			title: obs.title || obs.narrative,
			body_text: bodyText,
			metadata: { source: "observer" },
			project: ctx.project,
			session_minutes: ctx.sessionMinutes,
		});

		if (result.artifact === "telemetry" && result.action === "suppress") {
			reasons.push(...result.reasons);
			continue;
		}

		const candidate = result.artifact === "derived_fact";
		kept.push({
			...obs,
			derivation: {
				candidate,
				...(candidate ? { candidate_reasons: result.reasons } : {}),
				evaluated_extractor_version: "v1",
			},
		});
	}

	return {
		kept,
		suppressedTelemetry: {
			count: observations.length - kept.length,
			reasons,
		},
	};
}
