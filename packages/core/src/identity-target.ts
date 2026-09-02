import { homedir } from "node:os";
import { resolve } from "node:path";
import { tryResolveEmbeddingRevision } from "./embeddings.js";
import { expandUserPath } from "./observer-config.js";

const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";

export const VIEWER_IDENTITY_TARGET_KEYS = [
	"device_id",
	"actor_id_present",
	"actor_id",
	"config_path",
	"runtime_root",
	"workspace_id",
	"home_dir",
	"pack_compression",
	"embedding_disabled",
	"embedding_model",
	"embedding_revision",
] as const;

export type ViewerIdentityTargetKey = (typeof VIEWER_IDENTITY_TARGET_KEYS)[number];

export interface ViewerIdentityTarget {
	device_id: string | null;
	actor_id_present: boolean;
	actor_id: string | null;
	config_path: string | null;
	runtime_root: string | null;
	workspace_id: string | null;
	home_dir: string | null;
	pack_compression: string | null;
	embedding_disabled: boolean;
	embedding_model: string;
	embedding_revision: string | null;
}

function normalizeIdentityPath(value: string | undefined): string | null {
	if (!value?.trim()) return null;
	return resolve(expandUserPath(value.trim()));
}

export function buildViewerIdentityTarget(
	env: NodeJS.ProcessEnv = process.env,
	fallbackHomeDir: string = homedir(),
): ViewerIdentityTarget {
	const embeddingModel = env.CODEMEM_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
	return {
		device_id: env.CODEMEM_DEVICE_ID?.trim() || null,
		actor_id_present: Object.hasOwn(env, "CODEMEM_ACTOR_ID"),
		actor_id: env.CODEMEM_ACTOR_ID?.trim() || null,
		config_path: normalizeIdentityPath(env.CODEMEM_CONFIG),
		runtime_root: normalizeIdentityPath(env.CODEMEM_RUNTIME_ROOT),
		workspace_id: env.CODEMEM_WORKSPACE_ID?.trim() || null,
		home_dir: normalizeIdentityPath(env.HOME || fallbackHomeDir),
		pack_compression: env.CODEMEM_PACK_COMPRESSION?.trim() || null,
		embedding_disabled: ["1", "true", "yes"].includes(
			String(env.CODEMEM_EMBEDDING_DISABLED || "").toLowerCase(),
		),
		embedding_model: embeddingModel,
		embedding_revision: tryResolveEmbeddingRevision(embeddingModel, env),
	};
}
