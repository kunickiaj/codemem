import type { MemoryStore } from "@codemem/core";

export interface CodememMcpServerOptions {
	defaultProject?: string | null;
	resolveDefaultProject?: () => string | null;
	envProject?: string | null;
	captureRetrievalLedger?: boolean;
	retrievalLedgerScopeId?: string;
	/** Stateless transports retain request-level retry dedupe; sessions count each dispatched call. */
	retrievalLedgerIdentityMode?: "session" | "stateless";
}

export interface ToolRegistrationContext {
	store: MemoryStore;
	defaultProject: () => string | null;
	envProject: () => string | null;
	captureRetrievalLedger: boolean;
	retrievalLedgerScopeId: string;
	retrievalLedgerIdentityMode: "session" | "stateless";
}
