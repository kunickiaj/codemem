import { describe, expect, it } from "vitest";
import {
	buildTraversalNonceStatement,
	buildTraversalStateStatement,
	readTraversalStateReceipt,
} from "./peer-traversal-coordinator-attempt-write.js";
import type {
	WriteFixture,
	WriteSeedOptions,
} from "./peer-traversal-coordinator-attempt-write-test-fixtures.js";
import type { TraversalSignalBody } from "./peer-traversal-signal-codec.js";
import type { VerifiedTraversalSignalProof } from "./peer-traversal-signal-proof.js";
import { readRelayAdmissionNonceReceipt } from "./relay-admission-clock.js";
import { PARTICIPANT_REVOCATION_INSERT } from "./relay-admission-participant-nonce-test-fixtures.js";
import { readRelayAdmissionReadinessStamp } from "./relay-admission-readiness.js";

type Create = (options?: WriteSeedOptions) => Promise<WriteFixture>;
export const CAS_PHASES = [2, 3, 4, 5] as const;
const PHASE_NUMBER = {
	prepare: 1,
	offer: 2,
	"offer-check": 3,
	answer: 4,
	"answer-check": 5,
} as const;
const OFFER = "opaque offer 🌲";
const ANSWER = "opaque answer 🌲";

export async function phaseChain(f: WriteFixture) {
	const prepare = f.options.proof;
	const base = prepare.value;
	// Later request times are signed independently. They neither reset nor derive the fixed deadline.
	const common = (offset: number) => ({
		...base,
		createdAt: base.createdAt + offset,
		admitBefore: base.createdAt + offset + 30,
	});
	const prepareDigest = prepare.packetDigest;
	const offer = await f.sign(
		{
			...common(0),
			phase: "offer",
			prepareDigest,
			descriptionBytes: new TextEncoder().encode(OFFER),
		},
		f.session(301),
	);
	const offerDigest = offer.packetDigest;
	const check = await f.sign(
		{ ...common(-1), phase: "offer-check", prepareDigest, offerDigest },
		f.session(302),
	);
	const answer = await f.sign(
		{
			...common(-2),
			phase: "answer",
			prepareDigest,
			offerDigest,
			descriptionBytes: new TextEncoder().encode(ANSWER),
		},
		f.session(303),
	);
	const final = await f.sign(
		{
			...common(0),
			phase: "answer-check",
			prepareDigest,
			offerDigest,
			answerDigest: answer.packetDigest,
		},
		f.session(304),
	);
	return [prepare, offer, check, answer, final] as const;
}
export type PhaseChain = Awaited<ReturnType<typeof phaseChain>>;
export function phaseProof(chain: PhaseChain, phase: number) {
	const proof = chain[phase - 1];
	if (!proof) throw new Error("phase fixture out of range");
	return proof;
}
export async function phaseStatements(
	f: WriteFixture,
	proof: VerifiedTraversalSignalProof,
	execution = 0,
) {
	const phase = PHASE_NUMBER[proof.value.phase];
	const input = { ...f.options, proof };
	const nonce = await buildTraversalNonceStatement({
		...input,
		execId: f.session(1000 + phase * 10 + execution * 2),
	});
	const state = await buildTraversalStateStatement({
		...input,
		execId: f.session(1001 + phase * 10 + execution * 2),
	});
	if (!nonce || !state) throw new Error(`valid ${proof.value.phase} must compile both statements`);
	return { nonce, state };
}
export async function runPhase(f: WriteFixture, proof: VerifiedTraversalSignalProof) {
	const { nonce, state } = await phaseStatements(f, proof);
	const nonceRow = await f.db.returning(nonce);
	const receipt = readRelayAdmissionNonceReceipt(nonceRow, nonce.association);
	expect(receipt).not.toBeNull();
	if (!receipt) throw new Error("missing phase nonce receipt");
	expect(readRelayAdmissionReadinessStamp(nonceRow, receipt)).toMatchObject({
		state: "ready",
		revision: 1,
	});
	const stateRow = await f.db.returning(state);
	const parsed = readTraversalStateReceipt(stateRow, state);
	expect(parsed).not.toBeNull();
	if (!parsed) throw new Error("missing phase state receipt");
	expect(parsed.receipt).toMatchObject(state.association);
	expect(parsed.receipt.deviceId).toBe(proof.signer.deviceId);
	expect(parsed.readiness).toMatchObject({ state: "ready", revision: 1 });
	expect(state.expected.phase).toBe(PHASE_NUMBER[proof.value.phase]);
	expect(state.association.attemptId).not.toBe(nonce.association.attemptId);
	return { nonce, state, stateRow, parsed };
}
async function reach(f: WriteFixture, chain: PhaseChain, phase: number) {
	for (const proof of chain.slice(0, phase)) await runPhase(f, proof);
}
const stored = (f: WriteFixture) =>
	f.db.all("SELECT * FROM traversal_attempts WHERE authority_id=?1", [f.authority]);
async function expectDenied(f: WriteFixture, proof: VerifiedTraversalSignalProof) {
	const { nonce, state } = await phaseStatements(f, proof, 2);
	const before = await stored(f);

	const results = await Promise.all([f.db.returning(nonce), f.db.returning(state)]);

	expect(results).toEqual([null, null]);
	expect(await stored(f)).toEqual(before);
	expect(
		await f.db.all("SELECT nonce FROM request_nonces WHERE device_id=?1 AND nonce=?2", [
			proof.signer.deviceId,
			proof.nonce,
		]),
	).toEqual([]);
}

export function registerPhaseScenarios(create: Create) {
	describe("signed traversal phase CAS writes", () => {
		registerFullChain(create);
		registerWrongActors(create);
		registerOrdering(create);
		registerChainDigests(create);
		registerFixedContext(create);
		registerEligibility(create);
		registerReplay(create);
		registerCompetingCas(create);
		registerPhaseReceipts(create);
		registerStaticPhaseSql(create);
	});
}
function registerFullChain(create: Create) {
	it("runs all five actors/phases with owned receipts and preserves PREPARE time, tuple and packet digests", async () => {
		const f = await create();
		const chain = await phaseChain(f);
		const base = chain[0].value;
		let createdAtMs = 0;

		for (const proof of chain) {
			const phase = PHASE_NUMBER[proof.value.phase];
			const { state, parsed } = await runPhase(f, proof);
			if (phase === 1) createdAtMs = parsed.receipt.decidedAtMs;
			expect(await stored(f)).toEqual([
				{
					session_id: base.sessionId,
					authority_id: base.authorityId,
					group_id: base.groupId,
					source_device_id: base.sourceDeviceId,
					source_key_id: base.sourceKeyId,
					target_device_id: base.targetDeviceId,
					target_key_id: base.targetKeyId,
					message_a_digest: base.messageADigest,
					prepare_created_at: base.createdAt,
					attempt_not_after: base.attemptNotAfter,
					policy_revision: 1,
					prepare_digest: chain[0].packetDigest,
					created_at_ms: createdAtMs,
					phase,
					offer_digest: phase >= 2 ? chain[1].packetDigest : null,
					answer_digest: phase >= 4 ? chain[3].packetDigest : null,
					last_request_digest: proof.packetDigest,
					last_nonce: proof.nonce,
					exec_id: state.association.attemptId,
					updated_at_ms: parsed.receipt.decidedAtMs,
				},
			]);
		}
	});
}
function registerWrongActors(create: Create) {
	it.each(CAS_PHASES)(
		"rejects the other participant as phase %s signer before either write compiles",
		async (phase) => {
			const f = await create();
			const chain = await phaseChain(f);
			const proof = structuredClone(phaseProof(chain, phase));
			const other =
				phase === 3 || phase === 4 ? f.options.participants.source : f.options.participants.target;
			if (!other) throw new Error("missing opposite participant");
			Object.assign(proof.signer, {
				deviceId: other.device_id,
				publicKey: other.public_key,
				keyId: other.keyId,
			});

			const input = { ...f.options, proof };
			const results = await Promise.all([
				buildTraversalNonceStatement(input),
				buildTraversalStateStatement(input),
			]);

			expect(results).toEqual([null, null]);
		},
	);
}
function registerOrdering(create: Create) {
	it.each(CAS_PHASES)(
		"denies phase %s when its predecessor is absent or skipped",
		async (phase) => {
			const f = await create();
			const chain = await phaseChain(f);
			await reach(f, chain, phase - 2);

			await expectDenied(f, phaseProof(chain, phase));
		},
	);
	it.each(CAS_PHASES)(
		"denies a repeated phase %s even with a newly signed fresh nonce",
		async (phase) => {
			const f = await create();
			const chain = await phaseChain(f);
			await reach(f, chain, phase);
			const proof = await f.sign(phaseProof(chain, phase).value, f.session(500 + phase));

			await expectDenied(f, proof);
		},
	);
}
const CHAIN_DIGESTS = [
	{ phase: 2, field: "prepareDigest" },
	{ phase: 3, field: "prepareDigest" },
	{ phase: 3, field: "offerDigest" },
	{ phase: 4, field: "prepareDigest" },
	{ phase: 4, field: "offerDigest" },
	{ phase: 5, field: "prepareDigest" },
	{ phase: 5, field: "offerDigest" },
	{ phase: 5, field: "answerDigest" },
] as const;
function registerChainDigests(create: Create) {
	it.each(CHAIN_DIGESTS)(
		"denies both phase $phase writes for a valid signed wrong $field",
		async ({ phase, field }) => {
			const f = await create();
			const chain = await phaseChain(f);
			await reach(f, chain, phase - 1);
			const original = phaseProof(chain, phase);
			const body: TraversalSignalBody = { ...original.value };
			Reflect.set(body, field, "0".repeat(64));
			const proof = await f.sign(body, original.nonce);

			await expectDenied(f, proof);
		},
	);
}
function registerFixedContext(create: Create) {
	it.each(
		CAS_PHASES.flatMap((phase) =>
			["messageA", "deadline", "session"].map((field) => ({ phase, field })),
		),
	)(
		"denies valid signed phase $phase $field drift against the stored attempt",
		async ({ phase, field }) => {
			const f = await create();
			const chain = await phaseChain(f);
			await reach(f, chain, phase - 1);
			const original = phaseProof(chain, phase);
			const body = { ...original.value };
			if (field === "messageA") body.messageADigest = "0".repeat(64);
			if (field === "deadline") body.attemptNotAfter += 1;
			if (field === "session") body.sessionId = f.session(999);
			const proof = await f.sign(body, original.nonce);

			await expectDenied(f, proof);
		},
	);
}
async function changeEligibility(
	f: WriteFixture,
	proof: VerifiedTraversalSignalProof,
	change: "participant" | "policy" | "revocation",
) {
	if (change === "policy")
		return f.db.run(
			"UPDATE traversal_authority_policy SET policy_revision=2 WHERE authority_id=?1",
			[f.authority],
		);
	if (change === "revocation")
		return f.db.run(PARTICIPANT_REVOCATION_INSERT, ["ed25519_key", proof.signer.keyId]);
	return f.db.run("UPDATE enrolled_devices SET enabled=0 WHERE group_id=?1 AND device_id=?2", [
		f.options.namespace.groupId,
		f.options.proof.value.targetDeviceId,
	]);
}
const ELIGIBILITY_CASES = [2, 4].flatMap((phase) =>
	(["participant", "policy", "revocation"] as const).map((change) => ({ phase, change })),
);
function registerEligibility(create: Create) {
	it.each(ELIGIBILITY_CASES)(
		"rechecks $change before both phase $phase writes",
		async ({ phase, change }) => {
			const f = await create();
			const chain = await phaseChain(f);
			await reach(f, chain, phase - 1);
			const proof = phaseProof(chain, phase);
			await changeEligibility(f, proof, change);

			await expectDenied(f, proof);
		},
	);
	it.each(ELIGIBILITY_CASES)(
		"consumes the phase $phase nonce but denies state after $change changes",
		async ({ phase, change }) => {
			const f = await create();
			const chain = await phaseChain(f);
			await reach(f, chain, phase - 1);
			const proof = phaseProof(chain, phase);
			const { nonce, state } = await phaseStatements(f, proof);
			expect(
				readRelayAdmissionNonceReceipt(await f.db.returning(nonce), nonce.association),
			).not.toBeNull();
			const before = await stored(f);
			await changeEligibility(f, proof, change);

			const result = await f.db.returning(state);

			expect(result).toBeNull();
			expect(readTraversalStateReceipt(result, state)).toBeNull();
			expect(await stored(f)).toEqual(before);
			expect(
				await f.db.all("SELECT nonce FROM request_nonces WHERE device_id=?1 AND nonce=?2", [
					proof.signer.deviceId,
					proof.nonce,
				]),
			).toEqual([{ nonce: proof.nonce }]);
		},
	);
}
function registerReplay(create: Create) {
	it.each(CAS_PHASES)(
		"denies replayed phase %s nonce with a fresh execution before its state update",
		async (phase) => {
			const f = await create();
			const chain = await phaseChain(f);
			await reach(f, chain, phase - 1);
			const proof = phaseProof(chain, phase);
			const first = await phaseStatements(f, proof);
			const replay = await phaseStatements(f, proof, 2);
			expect(
				readRelayAdmissionNonceReceipt(await f.db.returning(first.nonce), first.nonce.association),
			).not.toBeNull();

			const result = await f.db.returning(replay.nonce);

			expect(result).toBeNull();
			expect(readRelayAdmissionNonceReceipt(result, replay.nonce.association)).toBeNull();
			expect(
				readTraversalStateReceipt(await f.db.returning(first.state), first.state),
			).not.toBeNull();
		},
	);
}
function registerCompetingCas(create: Create) {
	it.each([2, 4])(
		"allows one phase %s CAS winner with its actual stored execution ID",
		async (phase) => {
			const f = await create();
			const chain = await phaseChain(f);
			await reach(f, chain, phase - 1);
			const proof = phaseProof(chain, phase);
			const first = await phaseStatements(f, proof);
			const second = await phaseStatements(f, proof, 2);
			await f.db.returning(first.nonce);

			const rows = await Promise.all([f.db.returning(first.state), f.db.returning(second.state)]);
			const receipts = rows.map((row, index) =>
				readTraversalStateReceipt(row, index === 0 ? first.state : second.state),
			);
			const winners = receipts.filter((row) => row !== null);

			expect(rows.filter((row) => row === null)).toHaveLength(1);
			expect(winners).toHaveLength(1);
			expect((await stored(f)).map((row) => row.exec_id)).toEqual(
				winners.map((row) => row.receipt.attemptId),
			);
		},
	);
}
function registerPhaseReceipts(create: Create) {
	it("rejects old, different-phase, foreign, multiple and lost CAS receipts", async () => {
		const f = await create();
		const chain = await phaseChain(f);
		const old = await runPhase(f, chain[0]);
		const current = await runPhase(f, chain[1]);
		const row = current.stateRow;
		if (typeof row !== "object" || row === null) throw new Error("missing CAS row");
		const invalid = [
			null,
			undefined,
			old.stateRow,
			[row],
			[row, row],
			{ results: [row] },
			...Object.entries({
				phase: 3,
				sessionId: f.session(999),
				packetDigest: "0".repeat(64),
				policyRevision: 2,
				attemptId: old.state.association.attemptId,
				updatedAtMs: current.parsed.updatedAtMs + 1,
			}).map(([field, value]) => ({ ...row, [field]: value })),
		];

		const results = invalid.map((value) => readTraversalStateReceipt(value, current.state));

		expect(readTraversalStateReceipt(row, current.state)).not.toBeNull();
		expect(results).toEqual(invalid.map(() => null));
	});
}
function registerStaticPhaseSql(create: Create) {
	it.each(CAS_PHASES)(
		"binds phase %s values using static SQL without offer or answer bodies",
		async (phase) => {
			const f = await create();
			const other = await create();
			const chain = await phaseChain(f);
			const otherChain = await phaseChain(other);

			const first = await phaseStatements(f, phaseProof(chain, phase));
			const second = await phaseStatements(other, phaseProof(otherChain, phase));

			for (const name of ["nonce", "state"] as const) {
				expect(first[name].sql).toBe(second[name].sql);
				expect(first[name].expected.phase).toBe(phase);
				expect(first[name].bindings).not.toContain(OFFER);
				expect(first[name].bindings).not.toContain(ANSWER);
			}
		},
	);
}
