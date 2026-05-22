import type { MemoryStore } from "@codemem/core";

export interface CodememMcpServerOptions {
	defaultProject?: string | null;
	resolveDefaultProject?: () => string | null;
	envProject?: string | null;
}

export interface ToolRegistrationContext {
	store: MemoryStore;
	defaultProject: () => string | null;
	envProject: () => string | null;
}
