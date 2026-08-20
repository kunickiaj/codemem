import { resolve } from "node:path";
import { buildViewerIdentityTarget } from "@codemem/core";

export function rawEventTarget(dbPath: string) {
	return {
		db_path: resolve(dbPath),
		identity_target: buildViewerIdentityTarget(),
	};
}

export function isViewerTargetConflict(status: number, body: unknown): boolean {
	if (status !== 409 || body == null || typeof body !== "object" || Array.isArray(body))
		return false;
	const error = (body as Record<string, unknown>).error;
	if (error == null || typeof error !== "object" || Array.isArray(error)) return false;
	return ["viewer_db_mismatch", "viewer_identity_mismatch", "viewer_contract_unsupported"].includes(
		String((error as Record<string, unknown>).code ?? ""),
	);
}
