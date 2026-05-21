/**
 * Sync HTTP client: JSON request helper using Node.js built-in fetch.
 *
 * Async counterpart to the synchronous Python http.client implementation.
 * Ported from codemem/sync/http_client.py.
 */

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

function stripTrailingSlashes(value: string): string {
	let end = value.length;
	while (end > 0 && value.charCodeAt(end - 1) === 47) end--;
	return end === value.length ? value : value.slice(0, end);
}

function hasUrlScheme(value: string): boolean {
	const separator = value.indexOf("://");
	if (separator <= 0) return false;
	const first = value.charCodeAt(0);
	if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122))) return false;
	for (let i = 1; i < separator; i++) {
		const code = value.charCodeAt(i);
		const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
		const isDigit = code >= 48 && code <= 57;
		if (!isLetter && !isDigit && code !== 43 && code !== 45 && code !== 46) return false;
	}
	return true;
}

/**
 * Normalize a peer address into a base URL.
 *
 * Adds `http://` when no scheme is present, trims whitespace and trailing slashes.
 */
export function buildBaseUrl(address: string): string {
	const trimmed = stripTrailingSlashes(address.trim());
	if (!trimmed) return "";
	// Check for an existing scheme (e.g. http://, https://)
	if (hasUrlScheme(trimmed)) return trimmed;
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
