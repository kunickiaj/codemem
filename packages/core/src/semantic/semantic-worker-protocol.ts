import type { AutomaticContext, MemoryFilters } from "../types.js";
import type { CandidateVersion } from "./validated-vector-index.js";

export interface RuntimeProof {
	actorId: string;
	deviceId: string;
	expectedPublicKey: string | undefined;
}

export interface RankInput {
	generationId: string;
	embedding: Float32Array;
	embeddingIdentity: string;
	filters: MemoryFilters | null;
	automaticContext: AutomaticContext | null | undefined;
	proof: RuntimeProof;
	limit: number;
}

export interface RankOutput {
	generationId: string;
	/** Diagnostic only: unrelated vector writes may advance the revision. */
	revision: number;
	models: string[];
	candidateVersions: CandidateVersion[];
	candidates: Array<{
		id: number;
		distance: number;
		contentIdentity: string;
	}>;
}

export type WorkerRequest =
	| { type: "rank"; id: number; deadlineAt: number; input: RankInput }
	| { type: "close" };

export type WorkerReply =
	| { type: "ready" }
	| { type: "result"; id: number; output: RankOutput | null }
	| { type: "error"; id: number; code: "ranking_failed" | "expired" };
