import {
	buildTraversalNonceStatement,
	buildTraversalStateStatement,
	readTraversalStateReceipt,
	type TraversalSignalWriteOptions,
} from "./peer-traversal-coordinator-attempt-write.js";
import {
	decodeTraversalSignalPacket,
	encodeTraversalSignalPacket,
	TRAVERSAL_SIGNAL_PATH_SUFFIX,
	type TraversalSignalPhase,
} from "./peer-traversal-signal-codec.js";
import { verifyTraversalSignalProof } from "./peer-traversal-signal-proof.js";
import {
	RELAY_ADMISSION_CLOCK_SQL as CLOCK,
	readRelayAdmissionNonceReceipt,
} from "./relay-admission-clock.js";
import type { RelayAdmissionBudgetStatus } from "./relay-admission-decision.js";
import {
	captureRelayAdmissionParticipants,
	RELAY_ADMISSION_CAPTURE_PARTICIPANTS_SQL,
} from "./relay-admission-participant-nonce.js";
import { readRelayAdmissionReadinessStamp } from "./relay-admission-readiness.js";

type Bindings = readonly (string | number | null)[];
export interface TraversalSignalDecisionOptions {
	readonly packet: unknown;
	readonly expectedPhase: TraversalSignalPhase;
	readonly deviceHeader: string;
	readonly externalPathname: string;
	readonly namespace: { readonly authorityId: string; readonly groupId: string };
	readonly ingressKey: string;
}
export interface TraversalSignalIngressReservation {
	readonly namespace: { readonly authorityId: string; readonly groupId: string };
	readonly ingressKey: string;
	readonly phase: TraversalSignalPhase;
}
export interface TraversalSignalDeviceReservation extends TraversalSignalIngressReservation {
	readonly deviceId: string;
	readonly keyId: string;
}
export interface TraversalSignalDecisionDependencies {
	readonly database: {
		/** Returns an array of raw rows, never a backend envelope. */
		query(sql: string, bindings: Bindings): Promise<unknown>;
		/** Executes once and returns only its singular raw RETURNING row. */
		writeReturning(sql: string, bindings: Bindings): Promise<unknown>;
	};
	readonly budgets?: {
		readonly reserveIngress?: (
			reservation: TraversalSignalIngressReservation,
		) => Promise<RelayAdmissionBudgetStatus>;
		readonly reserveVerifiedDevice?: (
			reservation: TraversalSignalDeviceReservation,
		) => Promise<RelayAdmissionBudgetStatus>;
	};
}
export interface TraversalSignalDecision {
	readonly v: 1;
	readonly ok: true;
	readonly phase: TraversalSignalPhase;
	readonly sessionId: string;
	readonly packetDigest: string;
	readonly requestNonce: string;
	readonly decidedAtMs: number;
	readonly attemptNotAfter: number;
	readonly remainingMs: number;
	readonly policyRevision: number;
	readonly readyObservedAtMs: number;
}

// Read-only optimization. Both conditional writes independently repeat final eligibility.
const PREFLIGHT_SQL = `SELECT p.authority_id AS authorityId, r.group_id AS groupId,
 p.policy_revision AS policyRevision, ${CLOCK} AS decidedAtMs
 FROM traversal_authority_policy p
 JOIN traversal_realms r ON r.authority_id = p.authority_id AND r.group_id = ?2
 JOIN traversal_readiness ha ON ha.authority_id = p.authority_id
  AND ha.scope = 'authority' AND ha.group_id = ''
 JOIN traversal_readiness hr ON hr.authority_id = p.authority_id
  AND hr.scope = 'realm' AND hr.group_id = ?2
 WHERE p.authority_id = ?1 AND p.operator_state = 'enabled' AND r.operator_state = 'enabled'
 AND r.changed_revision <= p.policy_revision
 AND ha.state = 'ready' AND hr.state = 'ready' AND hr.revision <= ha.revision
 AND MAX(ha.observed_at_ms, hr.observed_at_ms) <= ${CLOCK} + 10000
 AND MIN(ha.observed_at_ms, hr.observed_at_ms) + 50000 > ${CLOCK}
 AND typeof(${CLOCK}) = 'integer' AND ${CLOCK} BETWEEN 0 AND 9007199254740991
 AND ?3 <= ${CLOCK} + 5000 AND ${CLOCK} < ?4
 AND ?5 - ${CLOCK} > 0 AND ?5 - ${CLOCK} <= 60000`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExternalPath(value: unknown): value is string {
	if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return false;
	if (!value.endsWith(TRAVERSAL_SIGNAL_PATH_SUFFIX)) return false;
	return !Array.from(value).some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return (
			code <= 32 ||
			(code >= 127 && code <= 159) ||
			(code >= 0xd800 && code <= 0xdfff) ||
			"?#\\".includes(character)
		);
	});
}

function capturePorts(deps: TraversalSignalDecisionDependencies) {
	const { database, budgets } = deps;
	const reserveIngress = budgets?.reserveIngress;
	const reserveVerifiedDevice = budgets?.reserveVerifiedDevice;
	const { query, writeReturning } = database;
	if (
		typeof query !== "function" ||
		typeof writeReturning !== "function" ||
		typeof reserveIngress !== "function" ||
		typeof reserveVerifiedDevice !== "function"
	)
		return null;
	return {
		query: query.bind(database),
		writeReturning: writeReturning.bind(database),
		reserveIngress: reserveIngress.bind(budgets),
		reserveVerifiedDevice: reserveVerifiedDevice.bind(budgets),
	};
}

function captureInputs(
	options: TraversalSignalDecisionOptions,
	deps: TraversalSignalDecisionDependencies,
) {
	const {
		packet: rawPacket,
		expectedPhase,
		deviceHeader,
		externalPathname,
		namespace,
		ingressKey,
	} = options;
	if (!isRecord(namespace)) return null;
	const keys = Reflect.ownKeys(namespace);
	if (keys.length !== 2 || !keys.includes("authorityId") || !keys.includes("groupId")) return null;
	const ownedNamespace = Object.freeze({
		authorityId: namespace.authorityId,
		groupId: namespace.groupId,
	});
	const check = decodeTraversalSignalPacket(rawPacket);
	const body = check.value;
	if (
		body.phase !== expectedPhase ||
		body.authorityId !== ownedNamespace.authorityId ||
		body.groupId !== ownedNamespace.groupId
	)
		return null;
	const actorDeviceId =
		body.phase === "offer-check" || body.phase === "answer"
			? body.targetDeviceId
			: body.sourceDeviceId;
	if (
		deviceHeader !== actorDeviceId ||
		!isExternalPath(externalPathname) ||
		typeof ingressKey !== "string" ||
		ingressKey.length === 0
	)
		return null;
	const ports = capturePorts(deps);
	if (!ports) return null;
	return {
		check,
		packet: Object.freeze(encodeTraversalSignalPacket(check)),
		expectedPhase,
		namespace: ownedNamespace,
		deviceHeader,
		externalPathname,
		reservation: Object.freeze({ namespace: ownedNamespace, ingressKey, phase: expectedPhase }),
		...ports,
	};
}

type CapturedInputs = NonNullable<ReturnType<typeof captureInputs>>;

function validWindow(input: CapturedInputs, now: number): boolean {
	if (!Number.isSafeInteger(now) || now < 0) return false;
	const body = input.check.value;
	if (body.createdAt * 1000 > now + 5000 || now >= body.admitBefore * 1000) return false;
	const remaining = body.attemptNotAfter * 1000 - now;
	return remaining > 0 && remaining <= 60000;
}

async function preflight(input: CapturedInputs): Promise<number | null> {
	const { namespace, check } = input;
	const rows = await input.query(
		PREFLIGHT_SQL,
		Object.freeze([
			namespace.authorityId,
			namespace.groupId,
			check.value.createdAt * 1000,
			check.value.admitBefore * 1000,
			check.value.attemptNotAfter * 1000,
		]),
	);
	if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) return null;
	const { authorityId, groupId, policyRevision, decidedAtMs } = rows[0];
	if (
		authorityId !== namespace.authorityId ||
		groupId !== namespace.groupId ||
		typeof policyRevision !== "number" ||
		!Number.isSafeInteger(policyRevision) ||
		policyRevision <= 0 ||
		typeof decidedAtMs !== "number" ||
		!validWindow(input, decidedAtMs)
	)
		return null;
	return policyRevision;
}

async function verifyParticipants(input: CapturedInputs) {
	const body = input.check.value;
	const rows = await input.query(
		RELAY_ADMISSION_CAPTURE_PARTICIPANTS_SQL,
		Object.freeze([input.namespace.groupId, body.sourceDeviceId, body.targetDeviceId]),
	);
	const participants = await captureRelayAdmissionParticipants(rows, {
		groupId: input.namespace.groupId,
		sourceDeviceId: body.sourceDeviceId,
		targetDeviceId: body.targetDeviceId,
	});
	if (
		!participants?.target ||
		participants.source.keyId !== body.sourceKeyId ||
		participants.target.keyId !== body.targetKeyId
	)
		return null;
	const actor =
		body.phase === "offer-check" || body.phase === "answer"
			? participants.target
			: participants.source;
	const proof = await verifyTraversalSignalProof({
		packet: input.packet,
		expectedPhase: input.expectedPhase,
		signer: { deviceId: actor.device_id, publicKey: actor.public_key },
		deviceHeader: input.deviceHeader,
		externalPathname: input.externalPathname,
	});
	if (!proof) return null;
	return { proof, participants };
}

function freshExecId(): string {
	return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function captureNonceRow(row: unknown) {
	if (!isRecord(row)) return null;
	const {
		deviceId,
		nonce,
		attemptId,
		decidedAtMs,
		createdAt,
		readinessRevision,
		readinessObservedAtMs,
		policyRevision,
	} = row;
	return Object.freeze({
		deviceId,
		nonce,
		attemptId,
		decidedAtMs,
		createdAt,
		readinessRevision,
		readinessObservedAtMs,
		policyRevision,
	});
}

async function consumeNonce(input: CapturedInputs, options: TraversalSignalWriteOptions) {
	const statement = await buildTraversalNonceStatement(options);
	if (!statement) return false;
	const row = captureNonceRow(await input.writeReturning(statement.sql, statement.bindings));
	if (!row || row.policyRevision !== options.policyRevision) return false;
	const receipt = readRelayAdmissionNonceReceipt(row, statement.association);
	if (!receipt || !validWindow(input, receipt.decidedAtMs)) return false;
	return readRelayAdmissionReadinessStamp(row, receipt) !== null;
}

async function writeDecision(
	input: CapturedInputs,
	options: TraversalSignalWriteOptions,
): Promise<TraversalSignalDecision | null> {
	if (!(await consumeNonce(input, options))) return null;
	const execId = freshExecId();
	if (execId === options.execId) return null;
	const statement = await buildTraversalStateStatement({ ...options, execId });
	if (!statement) return null;
	const row = await input.writeReturning(statement.sql, statement.bindings);
	const state = readTraversalStateReceipt(row, statement);
	if (!state || !validWindow(input, state.receipt.decidedAtMs)) return null;
	const { proof, policyRevision } = options;
	return Object.freeze({
		v: 1,
		ok: true,
		phase: proof.value.phase,
		sessionId: proof.value.sessionId,
		packetDigest: proof.packetDigest,
		requestNonce: proof.nonce,
		decidedAtMs: state.receipt.decidedAtMs,
		attemptNotAfter: proof.value.attemptNotAfter,
		remainingMs: proof.value.attemptNotAfter * 1000 - state.receipt.decidedAtMs,
		policyRevision,
		readyObservedAtMs: state.readiness.observedAtMs,
	});
}

/** Private, unwired composition. Trusted ports own durable budgets, execution provenance
 * and settlement within the request lifetime. Shape checks cannot prove commit.
 * Unknown write outcomes deny without retry or readback, including after state advances.
 */
export async function decideTraversalSignal(
	options: TraversalSignalDecisionOptions,
	deps: TraversalSignalDecisionDependencies,
): Promise<TraversalSignalDecision | null> {
	try {
		const input = captureInputs(options, deps);
		if (!input || (await input.reserveIngress(input.reservation)) !== "reserved") return null;
		const policyRevision = await preflight(input);
		if (policyRevision === null) return null;
		const verified = await verifyParticipants(input);
		if (!verified) return null;
		if (
			(await input.reserveVerifiedDevice(
				Object.freeze({
					...input.reservation,
					deviceId: verified.proof.signer.deviceId,
					keyId: verified.proof.signer.keyId,
				}),
			)) !== "reserved"
		)
			return null;
		return await writeDecision(input, {
			...verified,
			namespace: input.namespace,
			policyRevision,
			execId: freshExecId(),
		});
	} catch {
		return null;
	}
}
