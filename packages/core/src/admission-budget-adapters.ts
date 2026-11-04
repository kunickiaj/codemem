import {
	type AdmissionBudgetKey,
	buildAdmissionBudgetReservationStatement,
	readAdmissionBudgetReservationReceipt,
} from "./admission-budget.js";
import type {
	TraversalSignalDeviceReservation,
	TraversalSignalIngressReservation,
} from "./peer-traversal-coordinator-decision.js";
import type {
	RelayAdmissionBudgetStatus,
	RelayAdmissionDeviceReservation,
	RelayAdmissionIngressReservation,
} from "./relay-admission-decision.js";

export interface AdmissionBudgetAdapterOptions {
	readonly database: {
		readonly writeReturning: (
			sql: string,
			bindings: readonly (string | number | null)[],
		) => Promise<unknown>;
	};
}
type Writer = AdmissionBudgetAdapterOptions["database"]["writeReturning"];
type Stage = "ingress" | "device";

function captureWriter(options: AdmissionBudgetAdapterOptions): Writer | null {
	try {
		const { database } = options;
		const { writeReturning } = database;
		return typeof writeReturning === "function" ? writeReturning.bind(database) : null;
	} catch {
		return null;
	}
}

function freshExecId(): string {
	return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function scopesFor(
	key: AdmissionBudgetKey,
	stage: Stage,
	deviceId: string,
): readonly AdmissionBudgetKey[] | null {
	// Validate the realm and relay audience even for device writes, whose stored
	// identity intentionally excludes the audience. This statement never executes.
	if (
		key.groupId === "" ||
		!buildAdmissionBudgetReservationStatement({ ...key, execId: "0".repeat(32) })
	)
		return null;
	if (stage === "ingress")
		return [
			key,
			{ ...key, groupId: "" },
			{
				authorityId: key.authorityId,
				pool: "authority",
				audienceId: "",
				groupId: "",
				deviceId: "",
			},
		];
	const device: AdmissionBudgetKey = { ...key, pool: "device", audienceId: "", deviceId };
	if (key.pool === "relay-registration")
		return [{ ...device, pool: "device-registration" }, device];
	return [device];
}

async function reserveScopes(
	writer: Writer,
	keys: readonly AdmissionBudgetKey[],
): Promise<RelayAdmissionBudgetStatus> {
	// Compile every key before the first write. Invalid downstream scopes must not
	// consume an earlier scope, and caller mutation cannot redirect later writes.
	const statements = keys.map((key) =>
		buildAdmissionBudgetReservationStatement({ ...key, execId: freshExecId() }),
	);
	if (statements.some((statement) => statement === null)) return "unknown";
	for (const statement of statements) {
		if (!statement) return "unknown";
		const row = await writer(statement.sql, statement.bindings);
		const receipt = readAdmissionBudgetReservationReceipt(row, statement);
		if (!receipt) return "unknown";
		if (receipt.status === "denied") return "denied";
	}
	return "reserved";
}

async function reserveRelay(
	writer: Writer | null,
	reservation: RelayAdmissionIngressReservation | RelayAdmissionDeviceReservation,
	stage: Stage,
): Promise<RelayAdmissionBudgetStatus> {
	try {
		if (!writer) return "unknown";
		const { namespace, expected } = reservation;
		const { authorityId, groupId, relayAudienceId } = namespace;
		const kind = expected.kind;
		if (kind !== "registration" && kind !== "admission") return "unknown";
		let deviceId = "";
		if (stage === "device" && "deviceId" in reservation) deviceId = reservation.deviceId;
		const scopes = scopesFor(
			{
				authorityId,
				groupId,
				audienceId: relayAudienceId,
				pool: kind === "registration" ? "relay-registration" : "relay-route",
				deviceId: "",
			},
			stage,
			deviceId,
		);
		if (!scopes) return "unknown";
		return await reserveScopes(writer, scopes);
	} catch {
		return "unknown";
	}
}

/** Shared ingress scopes for a relay packet whose group is unknown or unconfigured. */
export interface RelayAdmissionSharedIngressReservation {
	readonly authorityId: string;
	readonly relayAudienceId: string;
	readonly expected: RelayAdmissionIngressReservation["expected"];
}

async function reserveRelaySharedIngress(
	writer: Writer | null,
	reservation: RelayAdmissionSharedIngressReservation,
): Promise<RelayAdmissionBudgetStatus> {
	try {
		if (!writer) return "unknown";
		const { authorityId, relayAudienceId, expected } = reservation;
		const kind = expected.kind;
		if (kind !== "registration" && kind !== "admission") return "unknown";
		// Only the (authority, audience) bucket at group '' and the authority bucket.
		// No per-group bucket is written before a configured group is known.
		const shared: AdmissionBudgetKey = {
			authorityId,
			pool: kind === "registration" ? "relay-registration" : "relay-route",
			audienceId: relayAudienceId,
			groupId: "",
			deviceId: "",
		};
		const authority: AdmissionBudgetKey = {
			authorityId,
			pool: "authority",
			audienceId: "",
			groupId: "",
			deviceId: "",
		};
		return await reserveScopes(writer, [shared, authority]);
	} catch {
		return "unknown";
	}
}

async function reserveTraversal(
	writer: Writer | null,
	reservation: TraversalSignalIngressReservation | TraversalSignalDeviceReservation,
	stage: Stage,
): Promise<RelayAdmissionBudgetStatus> {
	try {
		if (!writer) return "unknown";
		const { namespace } = reservation;
		const { authorityId, groupId } = namespace;
		let deviceId = "";
		if (stage === "device" && "deviceId" in reservation) deviceId = reservation.deviceId;
		const scopes = scopesFor(
			{ authorityId, groupId, audienceId: "", pool: "traversal", deviceId: "" },
			stage,
			deviceId,
		);
		if (!scopes) return "unknown";
		return await reserveScopes(writer, scopes);
	} catch {
		return "unknown";
	}
}

/** Private capacity callbacks only. The decision operation authenticates devices.
 * Trusted storage owns execution provenance and settlement. Uncertain writes stop
 * charging without refund, retry or readback. This factory installs no schema. */
export function createAdmissionBudgetAdapters(options: AdmissionBudgetAdapterOptions) {
	const writer = captureWriter(options);
	return Object.freeze({
		relay: Object.freeze({
			reserveIngress: (reservation: RelayAdmissionIngressReservation) =>
				reserveRelay(writer, reservation, "ingress"),
			reserveSharedIngress: (reservation: RelayAdmissionSharedIngressReservation) =>
				reserveRelaySharedIngress(writer, reservation),
			reserveVerifiedDevice: (reservation: RelayAdmissionDeviceReservation) =>
				reserveRelay(writer, reservation, "device"),
		}),
		traversal: Object.freeze({
			reserveIngress: (reservation: TraversalSignalIngressReservation) =>
				reserveTraversal(writer, reservation, "ingress"),
			reserveVerifiedDevice: (reservation: TraversalSignalDeviceReservation) =>
				reserveTraversal(writer, reservation, "device"),
		}),
	});
}
