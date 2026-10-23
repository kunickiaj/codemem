import type { AutomaticContext, MemoryFilters, SemanticExecutionOptions } from "../types.js";
import type { SemanticSearchResult } from "../vectors.js";

export interface SemanticSearchInput {
	query: string;
	limit: number;
	filters: MemoryFilters | null;
	automaticContext: AutomaticContext | null | undefined;
}

export interface PackSemanticExecutor {
	search(
		input: SemanticSearchInput,
		options?: SemanticExecutionOptions,
	): Promise<SemanticSearchResult[]>;
	close(): Promise<void>;
}

const identityErrorBrand = Symbol.for("codemem.semantic-identity-changed");

export class SemanticIdentityChangedError extends Error {
	readonly [identityErrorBrand] = true;

	constructor() {
		super("semantic_worker_identity_changed");
	}
}

/** Separate package bundles can load distinct copies of this class. */
export function isSemanticIdentityChangedError(error: unknown): boolean {
	return typeof error === "object" && error !== null && identityErrorBrand in error;
}

const closedErrorBrand = Symbol.for("codemem.semantic-store-closed");

export class SemanticStoreClosedError extends Error {
	readonly [closedErrorBrand] = true;

	constructor() {
		super("semantic_store_closed");
	}
}

export function isSemanticStoreClosedError(error: unknown): boolean {
	return typeof error === "object" && error !== null && closedErrorBrand in error;
}

const executorOverride = Symbol.for("codemem.semantic-executor-test-override");
type ExecutorOverrideStore = { [executorOverride]?: PackSemanticExecutor };

/** Internal test injection only: no runtime flag or package export. */
export function attachSemanticExecutorForTesting(
	store: object,
	executor: PackSemanticExecutor,
): void {
	if ((store as ExecutorOverrideStore)[executorOverride])
		throw new Error("semantic_executor_already_attached");
	Object.defineProperty(store, executorOverride, { value: executor });
}

export function getSemanticExecutorOverride(store: object): PackSemanticExecutor | undefined {
	return (store as ExecutorOverrideStore)[executorOverride];
}
