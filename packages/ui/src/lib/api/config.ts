/* Observer/config endpoints — observer connectivity status, and the
 * load/save cycle for the settings tab's editable config. saveConfig
 * keeps its own JSON-parse fallback so partial failures still surface
 * the raw response body as an error message. */

import type { ReadRequestOptions } from "../read-request";
import { fetchJson, payloadError } from "./internal";

export async function loadObserverStatus(options: ReadRequestOptions = {}): Promise<unknown> {
	return fetchJson("/api/observer-status", options);
}

export async function loadConfig(options: ReadRequestOptions = {}): Promise<unknown> {
	return fetchJson("/api/config", options);
}

export async function saveConfig(payload: Record<string, unknown>): Promise<unknown> {
	const resp = await fetch("/api/config", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});
	const text = await resp.text();
	let parsed: unknown = null;
	if (text) {
		try {
			parsed = JSON.parse(text);
		} catch {}
	}
	if (!resp.ok) {
		const message = payloadError(parsed) || text || "request failed";
		throw new Error(message);
	}
	return parsed;
}
