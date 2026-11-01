import {
	RELAY_ADMISSION_CLOCK_SQL,
	type RelayAdmissionNonceReceipt,
	readRelayAdmissionNonceReceipt,
} from "./relay-admission-clock.js";
import {
	decodeRelayCheckPacket,
	encodeRelayCheckPacket,
	getRelayAdmissionTimeBudget,
	type RelayCheckPacket,
} from "./relay-admission-codec.js";
import {
	buildRelayAdmissionNonceStatement,
	captureRelayAdmissionParticipants,
	RELAY_ADMISSION_CAPTURE_PARTICIPANTS_SQL,
	type RelayAdmissionNamespace,
} from "./relay-admission-participant-nonce.js";
import {
	type RelayProofExpectation,
	type VerifiedRelayCheckProof,
	verifyRelayCheckProof,
} from "./relay-admission-proof.js";
import {
	type RelayAdmissionReadinessStamp,
	readRelayAdmissionReadinessStamp,
} from "./relay-admission-readiness.js";

type Bindings = readonly (string | number | null)[];
export type RelayAdmissionBudgetStatus = "reserved" | "denied" | "unknown";
export interface RelayAdmissionIngressReservation {
	readonly namespace: RelayAdmissionNamespace;
	/** Trusted transport classification, never a signed caller identity. */
	readonly ingressKey: string;
	readonly expected: RelayProofExpectation;
}
export interface RelayAdmissionDeviceReservation extends RelayAdmissionIngressReservation {
	readonly deviceId: string;
	readonly keyId: string;
}
export interface RelayAdmissionDecisionDependencies {
	readonly database: {
		/** Returns only an array of raw rows, never a backend result envelope. */
		query(sql: string, bindings: Bindings): Promise<unknown>;
		/** Executes once and returns only its singular raw INSERT RETURNING row. */
		insertReturning(sql: string, bindings: Bindings): Promise<unknown>;
	};
	/** Dedicated durable authorization capabilities. In-memory implementations are test-only. */
	readonly budgets?: {
		readonly reserveIngress?: (
			reservation: RelayAdmissionIngressReservation,
		) => Promise<RelayAdmissionBudgetStatus>;
		readonly reserveVerifiedDevice?: (
			reservation: RelayAdmissionDeviceReservation,
		) => Promise<RelayAdmissionBudgetStatus>;
	};
}
export interface RelayAdmissionDecisionOptions {
	readonly packet: unknown;
	readonly expected: RelayProofExpectation;
	readonly deviceHeader: string;
	/** Trusted external URL context, including any configured base-path prefix. */
	readonly externalPathname: string;
	readonly namespace: RelayAdmissionNamespace;
	readonly ingressKey: string;
}
interface DecisionBinding {
	readonly packet: RelayCheckPacket;
	readonly proof: VerifiedRelayCheckProof;
	readonly receipt: RelayAdmissionNonceReceipt;
	readonly readiness: RelayAdmissionReadinessStamp;
	readonly policyRevision: number;
}
export type RelayAdmissionDecision = DecisionBinding &
	(
		| { readonly kind: "admission"; readonly remainingMs: number }
		| { readonly kind: "registration"; readonly socketExpiresInMs: 900000 }
	);

// Read-only optimization. The nonce compiler independently repeats all final gates.
const PREFLIGHT_SQL = `SELECT p.authority_id AS authorityId, r.group_id AS groupId,
 a.audience_id AS relayAudienceId, p.policy_revision AS policyRevision,
 ${RELAY_ADMISSION_CLOCK_SQL} AS decidedAtMs
 FROM relay_admission_authority_policy p
 JOIN relay_admission_audiences a ON a.authority_id = p.authority_id AND a.audience_id = ?3
 JOIN relay_admission_realms r ON r.authority_id = p.authority_id AND r.group_id = ?2
 JOIN relay_admission_readiness ha ON ha.authority_id = p.authority_id
  AND ha.scope = 'authority' AND ha.group_id = ''
 JOIN relay_admission_readiness hr ON hr.authority_id = p.authority_id
  AND hr.scope = 'realm' AND hr.group_id = ?2
 WHERE p.authority_id = ?1 AND p.operator_state = 'enabled'
 AND a.state = 'enabled' AND r.operator_state = 'enabled'
 AND a.changed_revision <= p.policy_revision AND r.changed_revision <= p.policy_revision
 AND ha.state = 'ready' AND hr.state = 'ready' AND hr.revision <= ha.revision
 AND MAX(ha.observed_at_ms, hr.observed_at_ms) <= ${RELAY_ADMISSION_CLOCK_SQL} + 10000
 AND MIN(ha.observed_at_ms, hr.observed_at_ms) + 50000 > ${RELAY_ADMISSION_CLOCK_SQL}
 AND ${RELAY_ADMISSION_CLOCK_SQL} >= 0
 AND ?4 <= ${RELAY_ADMISSION_CLOCK_SQL} + 5000 AND ${RELAY_ADMISSION_CLOCK_SQL} < ?5
 AND (?6 IS NULL OR (?6 - ${RELAY_ADMISSION_CLOCK_SQL} > 0
  AND ?6 - ${RELAY_ADMISSION_CLOCK_SQL} <= 60000))`;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: unknown, fields: readonly string[]): boolean {
	if (!isRecord(value)) return false;
	const keys = Reflect.ownKeys(value);
	return keys.length === fields.length && fields.every((field) => keys.includes(field));
}

function captureExpectation(value: RelayProofExpectation): RelayProofExpectation | null {
	const kind = value.kind;
	if (kind === "registration" && exactFields(value, ["kind"])) return Object.freeze({ kind });
	if (kind !== "admission" || !exactFields(value, ["kind", "role"])) return null;
	const role = value.role;
	if (role !== "source" && role !== "relay" && role !== "responder") return null;
	return Object.freeze({ kind, role });
}

function isExternalPath(value: unknown): value is string {
	if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return false;
	if (!value.endsWith("/v1/relay/admission-check")) return false;
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

function capturePorts(deps: RelayAdmissionDecisionDependencies) {
	const { database, budgets } = deps;
	const reserveIngress = budgets?.reserveIngress;
	const reserveVerifiedDevice = budgets?.reserveVerifiedDevice;
	const { query, insertReturning } = database;
	if (
		typeof query !== "function" ||
		typeof insertReturning !== "function" ||
		typeof reserveIngress !== "function" ||
		typeof reserveVerifiedDevice !== "function"
	)
		return null;
	return {
		query: query.bind(database),
		insertReturning: insertReturning.bind(database),
		reserveIngress: reserveIngress.bind(budgets),
		reserveVerifiedDevice: reserveVerifiedDevice.bind(budgets),
	};
}

function matchesContext(
	check: ReturnType<typeof decodeRelayCheckPacket>,
	namespace: RelayAdmissionNamespace,
	expected: RelayProofExpectation,
): boolean {
	const body = check.value;
	if (
		body.authorityId !== namespace.authorityId ||
		body.groupId !== namespace.groupId ||
		body.relayAudienceId !== namespace.relayAudienceId ||
		check.kind !== expected.kind
	)
		return false;
	if (check.kind === "registration") return true;
	return expected.kind === "admission" && check.value.role === expected.role;
}

function captureInputs(
	options: RelayAdmissionDecisionOptions,
	deps: RelayAdmissionDecisionDependencies,
) {
	const {
		packet: rawPacket,
		expected,
		deviceHeader,
		externalPathname,
		namespace,
		ingressKey,
	} = options;
	const expectation = captureExpectation(expected);
	if (!expectation || !exactFields(namespace, ["authorityId", "groupId", "relayAudienceId"]))
		return null;
	const ownedNamespace = Object.freeze({
		authorityId: namespace.authorityId,
		groupId: namespace.groupId,
		relayAudienceId: namespace.relayAudienceId,
	});
	const check = decodeRelayCheckPacket(rawPacket);
	if (!matchesContext(check, ownedNamespace, expectation)) return null;
	let sourceDeviceId: string;
	let targetDeviceId: string | undefined;
	if (check.kind === "admission") {
		sourceDeviceId = check.value.sourceDeviceId;
		targetDeviceId = check.value.targetDeviceId;
	} else sourceDeviceId = check.value.deviceId;
	if (
		deviceHeader !== sourceDeviceId ||
		!isExternalPath(externalPathname) ||
		typeof ingressKey !== "string" ||
		ingressKey.length === 0
	)
		return null;
	const ports = capturePorts(deps);
	if (!ports) return null;
	const packet = Object.freeze(encodeRelayCheckPacket(check));
	return {
		check,
		packet,
		expected: expectation,
		namespace: ownedNamespace,
		deviceHeader,
		externalPathname,
		sourceDeviceId,
		targetDeviceId,
		reservation: Object.freeze({ namespace: ownedNamespace, ingressKey, expected: expectation }),
		...ports,
	};
}

type CapturedInputs = NonNullable<ReturnType<typeof captureInputs>>;

function validWindow(check: CapturedInputs["check"], now: number): boolean {
	if (!Number.isSafeInteger(now) || now < 0) return false;
	if (check.value.createdAt * 1000 > now + 5000 || now >= check.value.admitBefore * 1000)
		return false;
	if (check.kind === "registration") return true;
	const remaining = check.value.routeNotAfter * 1000 - now;
	return remaining > 0 && remaining <= 60_000;
}

async function preflight(input: CapturedInputs): Promise<number | null> {
	const { check, namespace } = input;
	let routeDeadline: number | null = null;
	if (check.kind === "admission") routeDeadline = check.value.routeNotAfter * 1000;
	const rows = await input.query(
		PREFLIGHT_SQL,
		Object.freeze([
			namespace.authorityId,
			namespace.groupId,
			namespace.relayAudienceId,
			check.value.createdAt * 1000,
			check.value.admitBefore * 1000,
			routeDeadline,
		]),
	);
	if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) return null;
	const { authorityId, groupId, relayAudienceId, policyRevision, decidedAtMs } = rows[0];
	if (
		authorityId !== namespace.authorityId ||
		groupId !== namespace.groupId ||
		relayAudienceId !== namespace.relayAudienceId ||
		typeof policyRevision !== "number" ||
		!Number.isSafeInteger(policyRevision) ||
		policyRevision <= 0 ||
		typeof decidedAtMs !== "number" ||
		!validWindow(check, decidedAtMs)
	)
		return null;
	return policyRevision;
}

function captureReturningRow(row: unknown) {
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

function finishDecision(
	input: CapturedInputs,
	proof: VerifiedRelayCheckProof,
	row: ReturnType<typeof captureReturningRow>,
	association: Parameters<typeof readRelayAdmissionNonceReceipt>[1],
	policyRevision: number,
): RelayAdmissionDecision | null {
	if (!row || row.policyRevision !== policyRevision) return null;
	const receipt = readRelayAdmissionNonceReceipt(row, association);
	if (!receipt || !validWindow(input.check, receipt.decidedAtMs)) return null;
	const readiness = readRelayAdmissionReadinessStamp(row, receipt);
	if (!readiness) return null;
	Object.freeze(proof.value);
	Object.freeze(proof.signer);
	const binding = {
		packet: input.packet,
		proof: Object.freeze(proof),
		receipt: Object.freeze(receipt),
		readiness: Object.freeze(readiness),
		policyRevision,
	};
	if (proof.kind === "registration")
		return Object.freeze({ ...binding, kind: "registration", socketExpiresInMs: 900000 });
	const budget = getRelayAdmissionTimeBudget(proof.value, receipt.decidedAtMs);
	return Object.freeze({ ...binding, kind: "admission", remainingMs: budget.remainingMs });
}

/** Private, unwired composition. Trusted ports must provide durable admission budgets.
 * A returned value does not activate an API or prove production health/UTC clock bounds.
 * Unknown execution outcomes deny without retry, even if the nonce may have committed.
 */
export async function decideRelayAdmission(
	options: RelayAdmissionDecisionOptions,
	deps: RelayAdmissionDecisionDependencies,
): Promise<RelayAdmissionDecision | null> {
	try {
		const input = captureInputs(options, deps);
		if (!input || (await input.reserveIngress(input.reservation)) !== "reserved") return null;
		const policyRevision = await preflight(input);
		if (policyRevision === null) return null;
		const rows = await input.query(
			RELAY_ADMISSION_CAPTURE_PARTICIPANTS_SQL,
			Object.freeze([input.namespace.groupId, input.sourceDeviceId, input.targetDeviceId ?? null]),
		);
		const participants = await captureRelayAdmissionParticipants(rows, {
			groupId: input.namespace.groupId,
			sourceDeviceId: input.sourceDeviceId,
			targetDeviceId: input.targetDeviceId,
		});
		if (!participants) return null;
		const proof = await verifyRelayCheckProof({
			packet: input.packet,
			expected: input.expected,
			signer: { deviceId: input.sourceDeviceId, publicKey: participants.source.public_key },
			deviceHeader: input.deviceHeader,
			externalPathname: input.externalPathname,
		});
		if (
			!proof ||
			(await input.reserveVerifiedDevice(
				Object.freeze({
					...input.reservation,
					deviceId: proof.signer.deviceId,
					keyId: proof.signer.keyId,
				}),
			)) !== "reserved"
		)
			return null;
		const attemptId = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		const statement = buildRelayAdmissionNonceStatement({
			check: proof,
			participants,
			namespace: input.namespace,
			policyRevision,
			attemptId,
		});
		if (!statement) return null;
		const row = captureReturningRow(await input.insertReturning(statement.sql, statement.bindings));
		return finishDecision(input, proof, row, statement.association, policyRevision);
	} catch {
		return null;
	}
}
