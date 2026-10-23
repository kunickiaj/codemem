import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	buildViewerIdentityTarget,
	dispatchFileContextTransport,
	MemoryStore,
	parseFileContextTransportRequest,
	resolveDbPath,
} from "@codemem/core";
import { type DbOpts, resolveDbOpt } from "../shared-options.js";

/** Internal packaged-hook transport. Normal CLI invocation keeps its original guards/output. */
export function runClaudeFileContextTransport(payload: Record<string, unknown>, opts: DbOpts) {
	const parsed = parseFileContextTransportRequest(payload);
	if (!parsed.success) throw new Error("invalid file-context transport request");
	let request = parsed.data;
	const ignored = ["1", "true", "yes", "on"].includes(
		String(process.env.CODEMEM_PLUGIN_IGNORE ?? "")
			.trim()
			.toLowerCase(),
	);
	if (ignored) {
		return {
			ok: true,
			attempt_id: request.attempt_id,
			request_id: request.request_id,
			result: { continue: true },
			delivery_pending: false,
		};
	}
	const disabled = (value: string | undefined) =>
		["0", "false", "off"].includes(
			String(value ?? "")
				.trim()
				.toLowerCase(),
		);
	if (disabled(process.env.CODEMEM_RETRIEVAL_LEDGER))
		request = { ...request, ledger_enabled: false };
	if (request.action === "lookup" && disabled(process.env.CODEMEM_FILE_CONTEXT)) {
		const { relative_path: _path, project: _project, file_mtime_ms: _mtime, ...base } = request;
		request = { ...base, action: "skip", reason: "file_context_disabled" };
	}
	const dbPath = resolveDbPath(resolveDbOpt(opts));
	if (
		resolve(dbPath) !== resolve(request.db_path) ||
		!isDeepStrictEqual(buildViewerIdentityTarget(), request.identity_target)
	) {
		throw new Error("file-context target mismatch");
	}
	const store = new MemoryStore(dbPath);
	try {
		if (!store.hasCurrentIdentity()) throw new Error("file-context identity changed");
		return dispatchFileContextTransport(store, request);
	} finally {
		try {
			store.close();
		} catch {
			/* Cleanup must not replace valid context. */
		}
	}
}
