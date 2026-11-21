import type { Context, Hono } from "hono";
import type { DeviceAuthLinkDeps } from "./coordinator-device-auth-link.js";
import { captureRemovalCommit } from "./coordinator-device-removal-commit.js";
import { captureRemovalDeviceIds } from "./coordinator-device-removal-target.js";
import type { CoordinatorStore } from "./coordinator-store-contract.js";

// Eight 256-code-unit IDs can use six bytes per code unit when JSON-escaped.
const MAX_REMOVAL_COMMAND_BYTES = 16 * 1024;

interface RemovalCommandDeps
	extends Pick<DeviceAuthLinkDeps, "readRequestBytes" | "parseJsonObject" | "rateLimitedResponse"> {
	storeFactory(): CoordinatorStore;
	authorizeAdmin(secret: string | undefined): { ok: boolean; error: string };
}

type RemovalCommand =
	| { kind: "preview"; deviceIds: string[] }
	| { kind: "commit"; deviceIds: string[]; expectedDigest: string };

function parseRemovalCommand(
	kind: RemovalCommand["kind"],
	body: Record<string, unknown>,
): RemovalCommand | null {
	const fields = kind === "preview" ? ["device_ids"] : ["device_ids", "expected_digest"];
	if (
		Object.keys(body).length !== fields.length ||
		!fields.every((key) => Object.hasOwn(body, key))
	)
		return null;
	try {
		if (kind === "preview")
			return { kind, deviceIds: captureRemovalDeviceIds({ deviceIds: body.device_ids }) };
		if (!Array.isArray(body.device_ids) || typeof body.expected_digest !== "string") return null;
		const { deviceIds, expectedDigest } = captureRemovalCommit({
			deviceIds: body.device_ids,
			expectedDigest: body.expected_digest,
		});
		return { kind, deviceIds, expectedDigest };
	} catch {
		return null;
	}
}

async function executeRemovalCommand(
	c: Context,
	store: CoordinatorStore,
	command: RemovalCommand,
): Promise<Response> {
	try {
		if (command.kind === "preview") {
			const result = await store.previewDeviceRemoval({ deviceIds: command.deviceIds });
			if (result.kind === "rejected") {
				const { error } = result;
				return c.json({ error }, error === "removal_target_not_enrolled" ? 404 : 409);
			}
			const { kind: state, ...preview } = result;
			return c.json({ state, version: 1, ...preview });
		}
		const result = await store.removeDeviceEnrollments({
			deviceIds: command.deviceIds,
			expectedDigest: command.expectedDigest,
		});
		if (result.kind === "rejected") return c.json({ error: result.error }, 409);
		const { kind: state, ...receipt } = result;
		return c.json({ state, version: 1, ...receipt });
	} catch (error) {
		if (error instanceof Error && error.message === "device_removal_unavailable")
			return c.json({ error: "device_removal_unavailable" }, 503);
		if (error instanceof Error && error.message === "device_removal_incomplete")
			return c.json({ error: "device_removal_incomplete" }, 500);
		throw error;
	} finally {
		await store.close();
	}
}

function adminRemovalCommand(deps: RemovalCommandDeps, kind: RemovalCommand["kind"]) {
	return async (c: Context): Promise<Response> => {
		const auth = deps.authorizeAdmin(c.req.header("X-Codemem-Coordinator-Admin"));
		if (!auth.ok)
			return (
				deps.rateLimitedResponse(c, c.req.path, { authenticated: false }) ??
				c.json({ error: auth.error }, 401)
			);
		const limited = deps.rateLimitedResponse(c, "admin", { authenticated: true });
		if (limited) return limited;
		const raw = await deps.readRequestBytes(c, MAX_REMOVAL_COMMAND_BYTES);
		if (raw === null) return c.json({ error: "body_too_large" }, 413);
		const body = deps.parseJsonObject(raw);
		if (body === null) return c.json({ error: "invalid_json" }, 400);
		const command = parseRemovalCommand(kind, body);
		if (command === null) return c.json({ error: "invalid_input" }, 400);
		return executeRemovalCommand(c, deps.storeFactory(), command);
	};
}

export function registerCoordinatorDeviceRemovalCommands(app: Hono, deps: RemovalCommandDeps) {
	app.post("/v1/admin/devices/removal-preview", adminRemovalCommand(deps, "preview"));
	app.post("/v1/admin/devices/removal", adminRemovalCommand(deps, "commit"));
}
