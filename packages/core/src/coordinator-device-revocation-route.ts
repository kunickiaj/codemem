import type { Context, Hono } from "hono";
import { isAuthControllerId } from "./coordinator-auth-controller.js";
import {
	COORDINATOR_DEVICE_REVOCATION_MAX_BODY_BYTES,
	createCoordinatorDeviceRevocationHandler,
} from "./coordinator-device-revocation-handler.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";

/** Server composition only. The route always uses the runtime's concrete DB factory. */
export interface CoordinatorDeviceRevocationContext {
	coordinatorId: string;
}

function failure(error: string, status: number): Response {
	return Response.json(
		{ error },
		{
			status,
			headers: {
				"Cache-Control": "no-store",
				"Referrer-Policy": "no-referrer",
				"X-Content-Type-Options": "nosniff",
			},
		},
	);
}

function transportAdmission(request: Request): Response | null {
	if (request.method !== "POST") return failure("method_not_allowed", 405);
	const url = new URL(request.url);
	if (url.search || url.username || url.password) return failure("revocation_invalid_input", 400);
	if (
		!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? "")
	)
		return failure("unsupported_media_type", 415);
	if (request.headers.has("Content-Encoding")) return failure("unsupported_media_type", 415);
	const length = request.headers.get("Content-Length");
	if (length !== null) {
		if (request.headers.has("Transfer-Encoding")) return failure("revocation_invalid_input", 400);
		if (!/^[0-9]{1,10}$/.test(length)) return failure("revocation_invalid_input", 400);
		if (Number(length) > COORDINATOR_DEVICE_REVOCATION_MAX_BODY_BYTES)
			return failure("body_too_large", 413);
	}
	return null;
}

export function registerCoordinatorDeviceRevocationRoutes(
	app: Hono,
	options: {
		context?: CoordinatorDeviceRevocationContext;
		configuredCoordinatorIds: readonly unknown[];
		storeFactory: () => CoordinatorStore;
		adminSecret: () => string | null;
		rateLimitedResponse: (c: Context, key: string, authenticated: boolean) => Response | null;
	},
): void {
	const selectedId = options.context?.coordinatorId;
	const trustedCoordinatorId =
		isAuthControllerId(selectedId) &&
		options.configuredCoordinatorIds.every((id) => id === selectedId)
			? selectedId
			: null;
	const storeFactory = options.storeFactory;
	const adminSecret = options.adminSecret;
	const rateLimitedResponse = options.rateLimitedResponse;
	for (const [path, action] of [
		["/v1/admin/devices/revoke-preview", "preview"],
		["/v1/admin/devices/revoke", "commit"],
	] as const) {
		app.all(path, async (c) => {
			let selectedStore: CoordinatorStore | undefined;
			try {
				// Capture credentials before crypto/body awaits. The factory and ID were pinned
				// at composition; opening the DB is deferred until authenticated input is valid.
				const secret = adminSecret();
				const limited = rateLimitedResponse(c, c.req.path, false);
				if (limited) return limited;
				const selected = () => (selectedStore ??= storeFactory());
				const handler = createCoordinatorDeviceRevocationHandler({
					trustedCoordinatorId,
					adminSecret: secret,
					store: {
						getEnrollment: (...args) => selected().getEnrollment(...args),
						createDeviceRevocation: (...args) => selected().createDeviceRevocation(...args),
					},
					beforeBody: (request) =>
						rateLimitedResponse(c, "admin", true) ?? transportAdmission(request),
				});
				return await handler(action, c.req.raw);
			} catch {
				return failure("device_revocation_incomplete", 503);
			} finally {
				// Only the per-request selected store is owned here, never browser/runtime stores.
				if (selectedStore) {
					try {
						await selectedStore.close();
					} catch {
						/* No backend details in responses. */
					}
				}
			}
		});
	}
}
