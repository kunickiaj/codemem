import {
	D1CoordinatorStore,
	type D1DatabaseLike,
	type InMemoryRequestRateLimiter,
} from "@codemem/core/internal/cloudflare-coordinator";

const CAPABILITY_PATH = "/v1/admin/owner-enrollment-capabilities";
const GRANT_PATH = "/v1/admin/identity-group-grants";
const MAX_BYTES = 16 * 1024;

interface OwnerAdminOptions {
	coordinatorId: string;
	adminSecret: string | null;
	db: D1DatabaseLike;
	limiter: InMemoryRequestRateLimiter;
	issueCapability: (start: unknown) => Promise<string | null>;
}

export function isOwnerAdminPath(path: string): boolean {
	return path === CAPABILITY_PATH || path === GRANT_PATH;
}

function response(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

async function authenticate(request: Request, secret: string | null): Promise<boolean> {
	const supplied = request.headers.get("X-Codemem-Coordinator-Admin");
	if (!secret || !supplied || supplied.length > 8192) return false;
	const digest = (value: string) =>
		globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	const [expected, actual] = await Promise.all([digest(secret), digest(supplied)]);
	const key = await globalThis.crypto.subtle.importKey(
		"raw",
		expected,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
	const signature = await globalThis.crypto.subtle.sign("HMAC", key, expected);
	return globalThis.crypto.subtle.verify("HMAC", key, signature, actual);
}

export async function readOwnerJsonRequest(
	request: Pick<Request, "body">,
): Promise<Record<string, unknown> | null> {
	const reader = request.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			length += next.value.byteLength;
			if (length > MAX_BYTES) {
				void reader.cancel().catch(() => undefined);
				return null;
			}
			chunks.push(next.value);
		}
		const bytes = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} finally {
		reader.releaseLock();
	}
}

async function performAction(
	path: string,
	body: Record<string, unknown>,
	options: OwnerAdminOptions,
): Promise<Response> {
	if (path === CAPABILITY_PATH) {
		if (!Object.hasOwn(body, "start")) return response({ error: "invalid_request" }, 400);
		const capability = await options.issueCapability(body.start);
		return capability
			? response({ capability })
			: response({ error: "enrollment_unavailable" }, 409);
	}
	if (typeof body.attestation_id !== "string") return response({ error: "invalid_request" }, 400);
	const result = await new D1CoordinatorStore(
		options.db,
	).issueIdentityGroupGrantFromControllerAttestation({
		coordinatorId: options.coordinatorId,
		attestationId: body.attestation_id,
	});
	return response(result, result.kind === "rejected" ? 409 : 200);
}

/** Explicit operator operations only; Google sign-in never invokes these. */
export async function handleOwnerAdmin(
	request: Request,
	options: OwnerAdminOptions,
): Promise<Response> {
	try {
		const url = new URL(request.url);
		if (!isOwnerAdminPath(url.pathname)) return response({ error: "not_found" }, 404);
		if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);
		if (url.search || request.headers.has("Origin"))
			return response({ error: "invalid_request" }, 400);
		if (!(await authenticate(request, options.adminSecret)))
			return response({ error: "unauthorized" }, 401);
		if (!options.limiter.check(JSON.stringify(["owner-admin", options.coordinatorId]), 20).allowed)
			return response({ error: "rate_limited" }, 429);
		if (
			!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
				request.headers.get("Content-Type") ?? "",
			)
		)
			return response({ error: "invalid_content_type" }, 415);
		const body = await readOwnerJsonRequest(request);
		if (!body || Object.keys(body).length !== 1) return response({ error: "invalid_request" }, 400);
		return await performAction(url.pathname, body, options);
	} catch {
		return response({ error: "enrollment_unavailable" }, 503);
	}
}
