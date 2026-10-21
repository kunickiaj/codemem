import { type Context, Hono } from "hono";
import {
	createOwnerQualificationHandler,
	type OwnerQualificationRouteDeps,
} from "./coordinator-owner-qualification-route.js";
import type { InMemoryRequestRateLimiter } from "./request-rate-limit.js";

export const OWNER_QUALIFICATION_PATH = "/v1/admin/owner-qualifications";
const BODY_DEADLINE_MS = 5000;

function transportError(c: Context, origin: string | null): Response | null {
	const request = c.req.raw;
	const url = new URL(request.url);
	if (request.method !== "POST") return c.json({ error: "method_not_allowed" }, 405);
	if (
		url.origin !== origin ||
		url.protocol !== "https:" ||
		url.search ||
		url.hash ||
		url.username ||
		url.password ||
		request.headers.has("Origin")
	)
		return c.json({ error: "qualification_invalid_input" }, 400);
	if (request.headers.has("Transfer-Encoding"))
		return c.json({ error: "qualification_invalid_input" }, 400);
	if (
		!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
			request.headers.get("Content-Type") ?? "",
		) ||
		request.headers.has("Content-Encoding")
	)
		return c.json({ error: "invalid_content_type" }, 415);
	const length = request.headers.get("Content-Length");
	if (length !== null && !/^[0-9]{1,10}$/.test(length))
		return c.json({ error: "qualification_invalid_input" }, 400);
	if (length !== null && Number(length) > 4096) return c.json({ error: "body_too_large" }, 413);
	return null;
}

/** One fixed buffer, one deadline, and cancellation that never holds up refusal. */
async function readBody(c: Context, maxBytes: number): Promise<Uint8Array | null> {
	const request = c.req.raw;
	if (request.signal.aborted || !request.body) return null;
	const reader = request.body.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stop = () => {};
	const interrupted = new Promise<null>((resolve) => {
		stop = () => resolve(null);
		timer = setTimeout(stop, BODY_DEADLINE_MS);
		request.signal.addEventListener("abort", stop, { once: true });
		if (request.signal.aborted) stop();
	});
	try {
		return await readChunks(request, reader, interrupted, maxBytes);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
		request.signal.removeEventListener("abort", stop);
		void reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

async function readChunks(
	request: Request,
	reader: ReadableStreamDefaultReader<Uint8Array>,
	interrupted: Promise<null>,
	maxBytes: number,
): Promise<Uint8Array | null> {
	const bytes = new Uint8Array(maxBytes);
	let size = 0;
	for (;;) {
		const next = await Promise.race([reader.read(), interrupted]);
		if (!next || request.signal.aborted) return null;
		if (next.done) {
			const declared = request.headers.get("Content-Length");
			if (declared !== null && Number(declared) !== size) return null;
			return bytes.subarray(0, size);
		}
		if (!(next.value instanceof Uint8Array) || next.value.byteLength > maxBytes - size) return null;
		bytes.set(next.value, size);
		size += next.value.byteLength;
	}
}

function parseJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Private HTTP composition only: no sessions, provider discovery, or store startup. */
export function createOwnerQualificationHttp(options: {
	config: OwnerQualificationRouteDeps["config"];
	backend: OwnerQualificationRouteDeps["backend"];
	adminSecret: string | null;
	origin: string | null;
	limiter: InMemoryRequestRateLimiter;
}) {
	const captured = { ...options };
	const handler = createOwnerQualificationHandler({
		config: captured.config,
		backend: captured.backend,
		adminSecret: () => captured.adminSecret,
		readRequestBytes: readBody,
		parseJsonObject,
		rateLimitedResponse: (c, key, { authenticated }) => {
			const budget = captured.limiter.check(key, authenticated ? 20 : 60);
			if (!budget.allowed) {
				c.header("Retry-After", String(budget.retryAfterS));
				return c.json({ error: "rate_limited" }, 429);
			}
			if (!authenticated || !captured.config || !captured.backend) return null;
			return transportError(c, captured.origin);
		},
	});
	const app = new Hono();
	app.all(OWNER_QUALIFICATION_PATH, handler);
	return { fetch: (request: Request) => app.fetch(request) };
}
