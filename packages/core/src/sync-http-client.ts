/**
 * Sync HTTP client: JSON request helper using Node.js built-in fetch.
 *
 * Async counterpart to the synchronous Python http.client implementation.
 * Ported from codemem/sync/http_client.py.
 */

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a peer address into a base URL.
 *
 * Adds `http://` when no scheme is present, trims whitespace and trailing slashes.
 */
export function buildBaseUrl(address: string): string {
	const trimmed = address.trim().replace(/\/+$/, "");
	if (!trimmed) return "";
	// Check for an existing scheme (e.g. http://, https://)
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
	return `http://${trimmed}`;
}

// ---------------------------------------------------------------------------
// JSON request
// ---------------------------------------------------------------------------

export interface RequestJsonOptions {
	headers?: Record<string, string>;
	body?: Record<string, unknown>;
	bodyBytes?: Uint8Array;
	timeoutS?: number;
}

/**
 * Send an HTTP request and parse the JSON response.
 *
 * Returns `[statusCode, parsedBody]`. The body is null when the response
 * has no content. Non-JSON responses are returned as `{ error: "non_json_response: ..." }`.
 */
export async function requestJson(
	method: string,
	url: string,
	options: RequestJsonOptions = {},
): Promise<[status: number, body: Record<string, unknown> | null]> {
	const { headers, body, timeoutS = 3 } = options;
	let { bodyBytes } = options;

	if (bodyBytes == null && body != null) {
		bodyBytes = new TextEncoder().encode(JSON.stringify(body));
	}

	const requestHeaders: Record<string, string> = {
		Accept: "application/json",
	};
	if (bodyBytes != null) {
		requestHeaders["Content-Type"] = "application/json";
		requestHeaders["Content-Length"] = String(bodyBytes.byteLength);
	}
	if (headers) {
		Object.assign(requestHeaders, headers);
	}
	const requestBody = (bodyBytes ?? null) as RequestInit["body"] | null;

	const response = await fetch(url, {
		method,
		headers: requestHeaders,
		body: requestBody,
		signal: AbortSignal.timeout(timeoutS * 1000),
	});

	const raw = await response.text();
	if (!raw) return [response.status, null];

	let payload: unknown;
	try {
		payload = JSON.parse(raw);
	} catch {
		const snippet = raw.slice(0, 240).trim();
		return [
			response.status,
			{ error: snippet ? `non_json_response: ${snippet}` : "non_json_response" },
		];
	}

	if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
		return [response.status, payload as Record<string, unknown>];
	}
	return [
		response.status,
		{ error: `unexpected_json_type: ${Array.isArray(payload) ? "array" : typeof payload}` },
	];
}
