import {
	dispatchFileContextTransport,
	FILE_CONTEXT_TRANSPORT_MAX_BYTES,
	type MemoryStore,
	parseFileContextTransportRequest,
} from "@codemem/core";
import { Hono } from "hono";
import { parseJsonObjectBody } from "../helpers.js";
import { validateViewerTarget } from "./target-validation.js";

export function fileContextRoutes(getStore: () => MemoryStore) {
	const app = new Hono();
	app.post("/api/file-context", async (c) => {
		const body = await parseJsonObjectBody(c, FILE_CONTEXT_TRANSPORT_MAX_BYTES);
		if (body instanceof Response) return body;
		const parsed = parseFileContextTransportRequest(body);
		if (!parsed.success) {
			return c.json(
				{ error: { code: "invalid_request", message: "invalid file-context request" } },
				400,
			);
		}
		try {
			const store = getStore();
			const target = validateViewerTarget(store, body, {
				requireCurrentIdentity: true,
				requirePairedTargets: true,
			});
			if (!target.ok) return c.json(target.body, target.status);
			const response = dispatchFileContextTransport(store, parsed.data);
			if (!response.ok)
				return c.json(
					{ error: { code: "invalid_request", message: "delivery does not match attempt" } },
					400,
				);
			return c.json(response);
		} catch {
			return c.json(
				{ error: { code: "file_context_failed", message: "file context unavailable" } },
				503,
			);
		}
	});
	return app;
}
