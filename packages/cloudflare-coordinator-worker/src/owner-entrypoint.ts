import {
	type D1DatabaseLike,
	type InMemoryRequestRateLimiter,
	issueOwnerEnrollmentAdmission,
	type OwnerEnrollmentAdmissionKey,
	type OwnerEnrollmentAdmissionPin,
	verifyOwnerEnrollmentAdmission,
} from "@codemem/core/internal/cloudflare-coordinator";
import { handleOwnerAdmin, isOwnerAdminPath, readOwnerJsonRequest } from "./owner-admin.js";

type Start = Parameters<typeof issueOwnerEnrollmentAdmission>[2];
const START_FIELDS = [
	"attemptId",
	"deviceId",
	"publicKey",
	"loopbackRedirect",
	"browserStartCode",
	"signature",
];

function captureStart(value: unknown): Start | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const fields = value as Record<string, unknown>;
	if (
		Object.keys(fields).length !== START_FIELDS.length ||
		START_FIELDS.some((name) => typeof fields[name] !== "string")
	)
		return null;
	return fields as unknown as Start;
}

interface OwnerEntrypointOptions {
	key: OwnerEnrollmentAdmissionKey;
	pin: OwnerEnrollmentAdmissionPin;
	limiter: InMemoryRequestRateLimiter;
	adminSecret: string | null;
	db: D1DatabaseLike;
}

function response(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			"Referrer-Policy": "no-referrer",
		},
	});
}

async function admitStart(
	request: Request,
	options: OwnerEntrypointOptions,
): Promise<Response | null> {
	if (
		request.method !== "POST" ||
		new URL(request.url).search ||
		!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? "")
	)
		return response({ error: "invalid_request" }, 400);
	const authorization = request.headers.get("Authorization");
	if (!authorization?.startsWith("Bearer ") || authorization.length > 88)
		return response({ error: "enrollment_unavailable" }, 403);
	const start = captureStart(await readOwnerJsonRequest(request.clone()));
	if (
		!start ||
		!(await verifyOwnerEnrollmentAdmission(
			options.key,
			authorization.slice(7),
			options.pin,
			start,
			Date.now(),
		))
	)
		return response({ error: "enrollment_unavailable" }, 403);
	return null;
}

/** Pin reads and admission run before SDK discovery, storage writes, or provider calls. */
export async function handleOwnerEntrypoint(
	request: Request,
	options: OwnerEntrypointOptions,
): Promise<Response | null> {
	try {
		const url = new URL(request.url);
		if (
			url.pathname !== "/v1/auth/owner-config" &&
			url.pathname !== "/v1/auth/owner-attempts" &&
			!isOwnerAdminPath(url.pathname)
		)
			return null;
		if (
			url.origin !== options.pin.origin ||
			url.username ||
			url.password ||
			url.hash ||
			(request.headers.has("Origin") && request.headers.get("Origin") !== options.pin.origin)
		)
			return response({ error: "invalid_request" }, 400);
		if (url.pathname === "/v1/auth/owner-config") {
			if (request.method !== "GET" || url.search)
				return response({ error: "invalid_request" }, 400);
			return response(options.pin);
		}
		if (isOwnerAdminPath(url.pathname))
			return handleOwnerAdmin(request, {
				...options,
				coordinatorId: options.pin.coordinatorId,
				issueCapability: async (raw) => {
					const start = captureStart(raw);
					if (!start) return null;
					try {
						return await issueOwnerEnrollmentAdmission(options.key, options.pin, start, {
							nowMs: Date.now(),
							ttlMs: 600_000,
						});
					} catch {
						return null;
					}
				},
			});
		if (url.pathname === "/v1/auth/owner-attempts") return await admitStart(request, options);
		return null;
	} catch {
		return response({ error: "enrollment_unavailable" }, 400);
	}
}
