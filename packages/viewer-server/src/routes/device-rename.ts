import {
	coordinatorListDevicesAction,
	coordinatorListGroupsAction,
	coordinatorRenameDeviceAction,
	type MemoryStore,
	normalizeHumanPresentationName,
	readCoordinatorSyncConfig,
} from "@codemem/core";
import { Hono } from "hono";

type CoordinatorConfig = ReturnType<typeof readCoordinatorSyncConfig>;

async function enrolledGroups(config: CoordinatorConfig, deviceId: string): Promise<string[]> {
	const remoteUrl = config.syncCoordinatorUrl || null;
	const adminSecret = config.syncCoordinatorAdminSecret || null;
	if (!remoteUrl || !adminSecret) throw new Error("coordinator_unavailable");
	const groups = await coordinatorListGroupsAction({ remoteUrl, adminSecret });
	if (groups.length > 25) throw new Error("coordinator_evidence_too_large");
	const devices = (
		await Promise.all(
			groups.map((group) =>
				coordinatorListDevicesAction({
					groupId: group.group_id,
					includeDisabled: true,
					remoteUrl,
					adminSecret,
				}),
			),
		)
	).flat();
	if (devices.length > 500) throw new Error("coordinator_evidence_too_large");
	const matches = devices.filter((device) => device.device_id === deviceId);
	const keys = new Set(matches.map((device) => `${device.public_key}:${device.fingerprint}`));
	if (keys.size > 1) throw new Error("device_enrollment_conflict");
	return [...new Set(matches.map((device) => device.group_id))].sort();
}

async function renameEnrolledGroups(
	config: CoordinatorConfig,
	groups: string[],
	deviceId: string,
	name: string,
): Promise<number> {
	let renamed = 0;
	for (const groupId of groups) {
		try {
			const updated = await coordinatorRenameDeviceAction({
				groupId,
				deviceId,
				displayName: name,
				remoteUrl: config.syncCoordinatorUrl || null,
				adminSecret: config.syncCoordinatorAdminSecret || null,
			});
			if (!updated) break;
			renamed += 1;
		} catch {
			break;
		}
	}
	return renamed;
}

type RenameResult =
	| { ok: true; display_name: string }
	| { ok: false; error: string; status: 409 | 503; renamedGroupCount?: number };

async function renameDevice(
	store: MemoryStore,
	deviceId: string,
	name: string,
	provenance: string,
): Promise<RenameResult> {
	const config = readCoordinatorSyncConfig();
	if (provenance === "coordinator_enrollment" && !config.syncCoordinatorUrl) {
		return { ok: false, error: "coordinator_device_names_unavailable", status: 503 };
	}
	let groups: string[] = [];
	if (config.syncCoordinatorUrl) {
		try {
			groups = await enrolledGroups(config, deviceId);
		} catch (error) {
			if (error instanceof Error && error.message === "device_enrollment_conflict") {
				return { ok: false, error: "device_enrollment_conflict", status: 409 };
			}
			return { ok: false, error: "coordinator_device_names_unavailable", status: 503 };
		}
		if (provenance === "coordinator_enrollment" && groups.length === 0) {
			return { ok: false, error: "device_enrollment_unavailable", status: 409 };
		}
	}
	const renamedGroupCount = await renameEnrolledGroups(config, groups, deviceId, name);
	if (renamedGroupCount !== groups.length) {
		return {
			ok: false,
			error: "coordinator_device_rename_incomplete",
			status: 503,
			renamedGroupCount,
		};
	}
	const changed = store.db.transaction(() => {
		const result = store.db
			.prepare(
				"UPDATE identity_devices SET display_name = ?, updated_at = ? WHERE device_id = ? AND status = 'active'",
			)
			.run(name, new Date().toISOString(), deviceId);
		if (result.changes) {
			store.db
				.prepare("UPDATE sync_peers SET name = ? WHERE peer_device_id = ?")
				.run(name, deviceId);
		}
		return result.changes;
	})();
	if (!changed) return { ok: false, error: "device_not_found", status: 409 };
	return { ok: true, display_name: name };
}

export function deviceRenameRoutes(getStore: () => MemoryStore) {
	const pendingDevices = new Set<string>();
	return new Hono().post("/api/sync/recipient-policy/v1/devices/:device_id/rename", async (c) => {
		const store = getStore();
		const deviceId = String(c.req.param("device_id") ?? "").trim();
		const binding = store.db
			.prepare("SELECT provenance FROM identity_devices WHERE device_id = ? AND status = 'active'")
			.get(deviceId) as { provenance: string } | undefined;
		if (!binding) return c.json({ error: "device_not_found" }, 404);
		let body: Record<string, unknown>;
		try {
			body = await c.req.json<Record<string, unknown>>();
		} catch {
			return c.json({ error: "invalid_json" }, 400);
		}
		let name: string;
		try {
			name = normalizeHumanPresentationName(String(body.display_name ?? ""), "display_name");
		} catch {
			return c.json({ error: "display_name_invalid" }, 400);
		}
		if (pendingDevices.has(deviceId)) return c.json({ error: "device_rename_busy" }, 409);
		pendingDevices.add(deviceId);
		try {
			const result = await renameDevice(store, deviceId, name, binding.provenance);
			if (!result.ok) return c.json(result, result.status);
			return c.json(result);
		} catch {
			return c.json({ error: "device_rename_failed" }, 503);
		} finally {
			pendingDevices.delete(deviceId);
		}
	});
}
