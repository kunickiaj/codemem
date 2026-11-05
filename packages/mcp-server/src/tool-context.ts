import type { MemoryStore } from "@codemem/core";

export interface CodememMcpServerOptions {
	defaultProject?: string | null;
	resolveDefaultProject?: () => string | null;
	envProject?: string | null;
	/**
	 * Caller's working directory. Replaces `process.cwd()` for the default read
	 * project, the write session's cwd, and distill's AGENTS.md lookup, so a
	 * shared server can act on behalf of a caller in another directory.
	 */
	cwd?: string;
	captureRetrievalLedger?: boolean;
	retrievalLedgerScopeId?: string;
	/** Stateless transports retain request-level retry dedupe; sessions count each dispatched call. */
	retrievalLedgerIdentityMode?: "session" | "stateless";
	/**
	 * Replaces the transport's JSON-RPC request ID in ledger identity. A server
	 * built for one in-process call sees request ID 0 every time, so without
	 * this, identical calls from one session would deduplicate as retries.
	 */
	retrievalLedgerRequestId?: string;
}

export interface ToolRegistrationContext {
	store: MemoryStore;
	defaultProject: () => string | null;
	envProject: () => string | null;
	cwd: () => string;
	captureRetrievalLedger: boolean;
	retrievalLedgerScopeId: string;
	retrievalLedgerIdentityMode: "session" | "stateless";
	retrievalLedgerRequestId?: string;
}
