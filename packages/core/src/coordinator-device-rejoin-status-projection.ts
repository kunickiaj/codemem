import { isAuthControllerId } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend } from "./coordinator-auth-link.js";
import type { RejoinReceipt } from "./coordinator-device-rejoin-finalize.js";
import {
	type DeviceRejoinStatusInput,
	type DeviceRejoinStatusScope,
	readVerifiedDeviceRejoinStatus,
} from "./coordinator-device-rejoin-status.js";

type Destination = [string, number | null];
type NonDestination = [string, "archived" | "grant_revoked" | "excluded" | "identity_changed"];
export interface DeviceRejoinConfirmationView {
	destinations: Destination[];
	non_destinations: NonDestination[];
}
interface ProjectionRow {
	state: string;
	created_at_ms: number;
	expires_at_ms: number;
	identity_id: string;
	binding_id: string;
	destinations_json: string | null;
	non_destinations_json: string | null;
	own_tombstones_json: string;
	alias_removal_seqs_json: string;
	finalized_at_ms: number | null;
	final_receipt_json: string | null;
}
export type DeviceRejoinStatusProjection =
	| { kind: "unavailable" }
	| { kind: "authenticated_deadline_elapsed" }
	| { kind: "authenticated_expired" }
	| {
			kind: "live";
			body: {
				state: string;
				expires_at_ms: number;
				confirmation_view?: DeviceRejoinConfirmationView;
				receipt?: RejoinReceipt;
			};
	  };

function integer(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseArray(value: string | null): unknown[] {
	if (value === null) throw new Error("device_rejoin_projection_invalid");
	const parsed: unknown = JSON.parse(value);
	if (!Array.isArray(parsed)) throw new Error("device_rejoin_projection_invalid");
	return parsed;
}

function binaryOrderKey(value: string): string {
	return Array.from(new TextEncoder().encode(value), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function orderedGroups<T extends [string, unknown]>(
	rows: unknown[],
	valid: (v: unknown) => boolean,
) {
	let previous: string | undefined;
	for (const row of rows) {
		if (
			!Array.isArray(row) ||
			row.length !== 2 ||
			!isAuthControllerId(row[0]) ||
			(previous !== undefined && binaryOrderKey(previous) >= binaryOrderKey(row[0])) ||
			!valid(row[1])
		)
			throw new Error("device_rejoin_projection_invalid");
		previous = row[0];
	}
	return rows as T[];
}

function confirmationView(row: ProjectionRow): DeviceRejoinConfirmationView {
	const destinations = orderedGroups<Destination>(
		parseArray(row.destinations_json),
		(value) => value === null || (integer(value) && value > 0),
	);
	const nonDestinations = orderedGroups<NonDestination>(
		parseArray(row.non_destinations_json),
		(value) =>
			typeof value === "string" &&
			["archived", "grant_revoked", "excluded", "identity_changed"].includes(value),
	);
	const all = [...destinations, ...nonDestinations].map(([group]) => group);
	if (destinations.length === 0 || new Set(all).size !== all.length)
		throw new Error("device_rejoin_projection_invalid");
	return { destinations, non_destinations: nonDestinations };
}

function removalSequences(row: ProjectionRow): number[] {
	const own = parseArray(row.own_tombstones_json);
	const aliases = parseArray(row.alias_removal_seqs_json);
	if (
		own.length === 0 ||
		own.some(
			(tuple) =>
				!Array.isArray(tuple) ||
				tuple.length !== 4 ||
				!integer(tuple[0]) ||
				tuple[0] === 0 ||
				!isAuthControllerId(tuple[1]) ||
				typeof tuple[2] !== "string" ||
				tuple[2].length === 0 ||
				typeof tuple[3] !== "string" ||
				tuple[3].length === 0,
		) ||
		aliases.some((seq) => !integer(seq) || seq === 0)
	)
		throw new Error("device_rejoin_projection_invalid");
	const sequences = [...own.map((tuple) => (tuple as unknown[])[0]), ...aliases] as number[];
	if (new Set(sequences).size !== sequences.length)
		throw new Error("device_rejoin_projection_invalid");
	return sequences.sort((a, b) => a - b);
}

function receipt(
	row: ProjectionRow,
	view: DeviceRejoinConfirmationView,
	scope: DeviceRejoinStatusScope,
	input: DeviceRejoinStatusInput,
): RejoinReceipt {
	if (
		!isAuthControllerId(row.identity_id) ||
		!isAuthControllerId(row.binding_id) ||
		!integer(row.finalized_at_ms) ||
		row.finalized_at_ms < row.created_at_ms ||
		row.finalized_at_ms >= row.expires_at_ms ||
		row.finalized_at_ms > scope.now
	)
		throw new Error("device_rejoin_projection_invalid");
	const expected: RejoinReceipt = {
		attempt_id: scope.attemptId,
		device_id: input.deviceId,
		identity_id: row.identity_id,
		binding_id: row.binding_id,
		group_ids: view.destinations.map(([group]) => group),
		lifted_removal_seqs: removalSequences(row),
		finalized_at_ms: row.finalized_at_ms,
	};
	// The finalizer stores exactly this serialization. Never forward arbitrary stored keys.
	if (row.final_receipt_json !== JSON.stringify(expected))
		throw new Error("device_rejoin_projection_invalid");
	return expected;
}

function project(
	row: ProjectionRow,
	scope: DeviceRejoinStatusScope,
	input: DeviceRejoinStatusInput,
): DeviceRejoinStatusProjection {
	if (
		!integer(row.created_at_ms) ||
		!integer(row.expires_at_ms) ||
		row.created_at_ms > scope.now ||
		row.expires_at_ms !== row.created_at_ms + 600_000
	)
		return { kind: "unavailable" };
	const body: Extract<DeviceRejoinStatusProjection, { kind: "live" }>["body"] = {
		state: row.state,
		expires_at_ms: row.expires_at_ms,
	};
	if (row.state === "confirmed" || row.state === "finalized") {
		body.confirmation_view = confirmationView(row);
		if (row.state === "finalized")
			body.receipt = receipt(row, body.confirmation_view, scope, input);
	} else if (!["pending", "browser_claimed", "oidc_verified", "failed"].includes(row.state)) {
		return { kind: "unavailable" };
	}
	return { kind: "live", body };
}

/** Authenticate first. Non-live results are internal policy gates, never HTTP responses. */
export async function readLiveDeviceRejoinStatus(
	backend: Pick<AuthLinkBackend, "first">,
	currentScope: DeviceRejoinStatusScope,
	proof: DeviceRejoinStatusInput,
): Promise<DeviceRejoinStatusProjection> {
	const scope = { ...currentScope };
	const input = { ...proof };
	const verified = await readVerifiedDeviceRejoinStatus(backend, scope, input);
	if (!verified || !integer(verified.expiresAtMs)) return { kind: "unavailable" };
	if (verified.deadlineElapsed) return { kind: "authenticated_deadline_elapsed" };
	if (verified.state === "expired") return { kind: "authenticated_expired" };
	// Receipt storage is not even selected until proof and the strict live boundary pass.
	const row = await backend.first<ProjectionRow>({
		sql: `SELECT state, created_at_ms, expires_at_ms, identity_id, binding_id,
 destinations_json, non_destinations_json, own_tombstones_json, alias_removal_seqs_json,
 finalized_at_ms, final_receipt_json FROM coordinator_device_rejoin_attempts
 WHERE coordinator_id = ? AND attempt_id = ? AND device_id = ?
 AND origin = ? AND issuer = ? AND auth_config_revision = ?
 AND expires_at_ms = ? AND expires_at_ms > ? AND state = ?`,
		values: [
			scope.coordinatorId,
			scope.attemptId,
			input.deviceId,
			scope.origin,
			scope.issuer,
			scope.authConfigRevision,
			verified.expiresAtMs,
			scope.now,
			verified.state,
		],
	});
	if (!row) return { kind: "unavailable" };
	try {
		return project(row, scope, input);
	} catch {
		return { kind: "unavailable" };
	}
}
