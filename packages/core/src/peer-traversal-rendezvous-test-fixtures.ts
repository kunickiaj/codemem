import type { Duplex } from "node:stream";
import Database from "better-sqlite3";
import { expect } from "vitest";
import { createTraversalSignalCarrier } from "./peer-traversal-carrier.js";
import {
	type WriteDatabase,
	type WriteFixture,
	writeFixture,
} from "./peer-traversal-coordinator-attempt-write-test-fixtures.js";
import {
	requestTraversalSignalDecision,
	type TraversalDecisionLease,
	type TraversalSignalClientRequest,
} from "./peer-traversal-coordinator-client.js";
import { decideTraversalSignal } from "./peer-traversal-coordinator-decision.js";
import { decisionHarness } from "./peer-traversal-coordinator-decision-test-fixtures.js";
import { TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS } from "./peer-traversal-coordinator-schema.js";
import type { Value } from "./peer-traversal-coordinator-schema-common-test-fixtures.js";
import {
	acceptTraversalNoiseResponder,
	prepareTraversalNoiseInitiator,
} from "./peer-traversal-noise.js";
import { verifyTraversalSignalChain } from "./peer-traversal-signal-chain.js";
import {
	encodeTraversalSignalPacket,
	type TraversalSignalPacket,
	type TraversalSignalPhase,
} from "./peer-traversal-signal-codec.js";
import type { VerifiedTraversalSignalProof } from "./peer-traversal-signal-proof.js";
import { TraversalByteStream } from "./peer-traversal-stream.js";
import { channelPair } from "./peer-traversal-stream-test-fixtures.js";
import { RELAY_ADMISSION_CLOCK_SQL } from "./relay-admission-clock.js";
import { PARTICIPANT_TEST_SCHEMA_SQL } from "./relay-admission-participant-nonce-test-fixtures.js";

type Side = "source" | "target";
const PATH = "/v1/traversal/signal";
const cleanups: (() => unknown | Promise<unknown>)[] = [];
export async function cleanupRendezvous() {
	for (const close of cleanups.splice(0).reverse()) await close();
}
let sequence = 0x7a0000;
async function databaseFixture() {
	const native = new Database(":memory:");
	cleanups.push(() => native.close());
	native.pragma("foreign_keys=ON");
	native.exec(PARTICIPANT_TEST_SCHEMA_SQL);
	for (const sql of TRAVERSAL_COORDINATOR_SCHEMA_STATEMENTS) native.exec(sql);
	const bind = (values: readonly Value[]) =>
		Object.fromEntries(values.map((value, index) => [index + 1, value]));
	const run = (sql: string, values: readonly Value[] = []) => native.prepare(sql).run(bind(values));
	const db: WriteDatabase = {
		run: async (sql, values) => run(sql, values),
		all: async (sql, values = []) =>
			native.prepare(sql).all(bind(values)) as Record<string, Value>[],
		batch: async (statements) =>
			native.transaction(() => {
				for (const entry of statements) run(entry.sql, entry.values);
			})(),
		returning: async (statement) =>
			native.prepare(statement.sql).get(bind(statement.bindings)) ?? null,
	};
	const row = native.prepare(`SELECT ${RELAY_ADMISSION_CLOCK_SQL} AS now`).get() as { now: number };
	return writeFixture(db, row.now, ++sequence);
}

function memoryChannels(trace: string[]) {
	const channels = channelPair({ deferredDelivery: true });
	for (const [index, channel] of channels.entries()) {
		const send = channel.send.bind(channel);
		channel.send = (bytes) => {
			if (channel.sent.length === 0) trace.push(index === 0 ? "wire:A" : "wire:B");
			send(bytes);
		};
	}
	return channels;
}

async function noiseIdentities(store: WriteFixture) {
	const sourceIdentity = {
		key: new Uint8Array(await crypto.subtle.exportKey("pkcs8", store.keys.source.privateKey)),
		expectedPin: store.options.participants.source.public_key,
	};
	const target = store.options.participants.target;
	if (!target) throw new Error("missing target identity");
	const targetIdentity = {
		key: new Uint8Array(await crypto.subtle.exportKey("pkcs8", store.keys.target.privateKey)),
		expectedPin: target.public_key,
	};
	cleanups.push(() => {
		sourceIdentity.key.fill(0);
		targetIdentity.key.fill(0);
	});
	return { sourceIdentity, targetIdentity };
}

function trackNoise(
	prepared: ReturnType<typeof prepareTraversalNoiseInitiator>,
	raw: TraversalByteStream[],
	noise: { plain: Duplex[]; inbound: ReturnType<typeof acceptTraversalNoiseResponder> | undefined },
) {
	cleanups.push(async () => {
		prepared.cancel();
		for (const stream of [...noise.plain, ...raw]) stream.destroy();
		await Promise.allSettled([prepared.authenticated, ...(noise.inbound ? [noise.inbound] : [])]);
		await Promise.allSettled(raw.map((stream) => stream.disposed));
	});
}

export async function rendezvousFixture(
	options: { denyPhase?: TraversalSignalPhase; lateOwnReply?: boolean } = {},
) {
	const store = await databaseFixture();
	const trace: string[] = [];
	const deadlineMs = performance.now() + 10000;
	const { sourceIdentity, targetIdentity } = await noiseIdentities(store);
	const prepared = prepareTraversalNoiseInitiator({
		localIdentity: sourceIdentity,
		expectedRemotePin: targetIdentity.expectedPin,
		deadlineMs,
	});
	void prepared.authenticated.catch(() => {});
	cleanups.push(() => prepared.cancel());
	const channels = memoryChannels(trace);
	const raw: TraversalByteStream[] = [];
	const noise = {
		inbound: undefined as ReturnType<typeof acceptTraversalNoiseResponder> | undefined,
		plain: [] as Duplex[],
	};
	trackNoise(prepared, raw, noise);
	const carrier = createTraversalSignalCarrier({
		sessionId: Buffer.from(prepared.sessionId).toString("hex"),
		deadlineMs,
	});
	if (!carrier) throw new Error("valid carrier fixture rejected");
	cleanups.push(() => carrier.close());
	const opening = await prepared.opening;
	sourceIdentity.key.fill(0);
	expect(opening.bytes).toHaveLength(34);
	expect(channels.map((channel) => channel.sent.length)).toEqual([0, 0]);
	const proof = await store.sign({
		...store.options.proof.value,
		phase: "prepare",
		sessionId: Buffer.from(prepared.sessionId).toString("hex"),
		messageADigest: opening.digest,
	});
	Object.assign(store.options, { proof });
	const leases: Partial<Record<Side, TraversalDecisionLease>> = {};
	const f = {
		store,
		trace,
		deadlineMs,
		sourceIdentity,
		targetIdentity,
		prepared,
		opening,
		channels,
		raw,
		noise,
		carrier,
		leases,
		options,
		sourcePackets: [] as TraversalSignalPacket[],
	};
	return { ...f, sourceSend: sendFor(f, "source"), targetSend: sendFor(f, "target") };
}
export type Rendezvous = Awaited<ReturnType<typeof rendezvousFixture>>;
function liveDeadline(f: Rendezvous, side: Side): number {
	const lease = f.leases[side];
	if (!lease) throw new Error("missing own lease");
	const deadline = Math.min(f.deadlineMs, lease.deadlineMs);
	if (performance.now() >= deadline) throw new Error("own lease expired");
	return deadline;
}
function sendFor(
	f: { store: WriteFixture; trace: string[]; options: { denyPhase?: TraversalSignalPhase } },
	side: Side,
) {
	const deviceId =
		side === "source"
			? f.store.options.participants.source.device_id
			: f.store.options.participants.target?.device_id;
	return async (request: TraversalSignalClientRequest) => {
		expect(request.method).toBe("POST");
		expect(Reflect.has(request, "packet")).toBe(false);
		expect(request.deviceHeader).toBe(deviceId);
		expect(request.namespace).toEqual(f.store.options.namespace);
		expect(request.externalPathname).toBe(PATH);
		expect(Array.isArray(JSON.parse(new TextDecoder().decode(request.bodyBytes)))).toBe(true);
		f.trace.push(`${side}:send:${request.expectedPhase}`);
		// Only this in-process boundary adapts RAW POST bytes to the private coordinator's packet API.
		const packet = {
			body: Buffer.from(request.bodyBytes).toString("base64url"),
			timestamp: request.timestamp,
			nonce: request.nonce,
			signature: request.signature,
		};
		const h = decisionHarness(f.store);
		if (request.expectedPhase === f.options.denyPhase)
			h.deps.budgets.reserveIngress.mockResolvedValue("denied");
		const decision = await decideTraversalSignal(
			{
				packet,
				expectedPhase: request.expectedPhase,
				deviceHeader: deviceId ?? "",
				namespace: f.store.options.namespace,
				externalPathname: PATH,
				ingressKey: "in-process-test",
			},
			h.deps,
		);
		return {
			status: 200,
			bodyBytes: new TextEncoder().encode(JSON.stringify(decision ?? { v: 1, ok: false })),
		};
	};
}
async function own(f: Rendezvous, side: Side, proof: VerifiedTraversalSignalProof) {
	let now = performance.now();
	const late = f.options.lateOwnReply && proof.value.phase === "answer-check";
	const send = side === "source" ? f.sourceSend : f.targetSend;
	// The injected clock affects this negative client call only. Noise retains real performance.now().
	const deadlineMs = late ? now + 1000 : f.deadlineMs;
	const reply = await requestTraversalSignalDecision(
		{
			packet: encodeTraversalSignalPacket(proof),
			expectedPhase: proof.value.phase,
			localDeviceId: proof.signer.deviceId,
			namespace: f.store.options.namespace,
			externalPathname: PATH,
			deadlineMs,
			previousLease: f.leases[side],
		},
		{
			send: async (request: TraversalSignalClientRequest) => {
				const response = await send(request);
				if (late) now = deadlineMs + 1;
				return response;
			},
			...(late ? { now: () => now } : {}),
		},
	);
	if (!reply) throw new Error(`own ${proof.value.phase} denied`);
	f.leases[side] = reply;
	f.trace.push(`${side}:own:${proof.value.phase}`);
	return reply;
}
const tamper = (packet: TraversalSignalPacket) => ({
	...packet,
	signature: `v2:${btoa(String.fromCharCode(...new Uint8Array(64)))}`,
});
async function checked(f: Rendezvous, phase: "offer" | "answer", packets: readonly unknown[]) {
	const source = f.store.options.participants.source;
	const target = f.store.options.participants.target;
	if (!target) throw new Error("missing target");
	const prefix = await verifyTraversalSignalChain({
		packets,
		expectedPhase: phase,
		externalPathname: PATH,
		expected: {
			...f.store.options.namespace,
			source: { deviceId: source.device_id, publicKey: source.public_key },
			target: { deviceId: target.device_id, publicKey: target.public_key },
			sessionId: Buffer.from(f.prepared.sessionId).toString("hex"),
			messageADigest: f.opening.digest,
		},
	});
	if (!prefix) throw new Error(`invalid ${phase} prefix`);
	return prefix.proofs;
}

// Gather/apply are trace-only stubs. This fixture models no RTC engine, network origin or NAT behavior.
export async function sourceOffer(f: Rendezvous, options: { substitute?: boolean } = {}) {
	const prepare = f.store.options.proof;
	await own(f, "source", prepare);
	liveDeadline(f, "source");
	f.trace.push("source:gather");
	const offer = await f.store.sign(
		{
			...prepare.value,
			phase: "offer",
			prepareDigest: prepare.packetDigest,
			descriptionBytes: new TextEncoder().encode("opaque offer"),
		},
		f.store.session(601),
	);
	await own(f, "source", offer);
	liveDeadline(f, "source");
	f.sourcePackets.push(encodeTraversalSignalPacket(prepare), encodeTraversalSignalPacket(offer));
	expect(
		f.carrier.publish({
			v: 1,
			type: "traversal-offer",
			packets: [
				f.sourcePackets[0],
				options.substitute ? tamper(encodeTraversalSignalPacket(offer)) : f.sourcePackets[1],
			],
		}),
	).toBe(true);
}
export async function targetAnswer(f: Rendezvous, options: { substitute?: boolean } = {}) {
	const envelope = f.carrier.take("traversal-offer");
	if (!envelope) throw new Error("missing offer");
	const prefix = await checked(f, "offer", envelope.packets);
	const prepare = prefix[0];
	const offer = prefix[1];
	if (!prepare || !offer) throw new Error("missing offer prefix proof");
	f.trace.push("target:checked-offer");
	const check = await f.store.sign(
		{
			...prepare.value,
			phase: "offer-check",
			prepareDigest: prepare.packetDigest,
			offerDigest: offer.packetDigest,
		},
		f.store.session(602),
	);
	await own(f, "target", check);
	liveDeadline(f, "target");
	f.trace.push("target:apply-offer", "target:gather");
	const answer = await f.store.sign(
		{
			...prepare.value,
			phase: "answer",
			prepareDigest: prepare.packetDigest,
			offerDigest: offer.packetDigest,
			descriptionBytes: new TextEncoder().encode("opaque answer"),
		},
		f.store.session(603),
	);
	await own(f, "target", answer);
	expect(f.channels.map((channel) => channel.sent.length)).toEqual([0, 0]);
	acceptResponder(f);
	const packet = encodeTraversalSignalPacket(answer);
	liveDeadline(f, "target");
	expect(
		f.carrier.publish({
			v: 1,
			type: "traversal-answer",
			packets: [encodeTraversalSignalPacket(check), options.substitute ? tamper(packet) : packet],
		}),
	).toBe(true);
}
function acceptResponder(f: Rendezvous) {
	const targetRaw = new TraversalByteStream({
		channel: f.channels[1],
		side: "target",
		deadlineMs: liveDeadline(f, "target"),
	});
	f.raw.push(targetRaw);
	liveDeadline(f, "target");
	f.trace.push("target:accept-noise");
	f.noise.inbound = acceptTraversalNoiseResponder({
		stream: targetRaw,
		sessionId: f.prepared.sessionId,
		verifiedMessageADigest: f.opening.digest,
		localIdentity: f.targetIdentity,
		expectedRemotePin: f.sourceIdentity.expectedPin,
		deadlineMs: liveDeadline(f, "target"),
	});
	void f.noise.inbound.catch(() => {});
	f.targetIdentity.key.fill(0);
	expect(f.channels[1].sent).toEqual([]);
}
export async function sourceRelease(f: Rendezvous) {
	const envelope = f.carrier.take("traversal-answer");
	if (!envelope) throw new Error("missing answer");
	const prefix = await checked(f, "answer", [...f.sourcePackets, ...envelope.packets]);
	const prepare = prefix[0];
	const offer = prefix[1];
	const answer = prefix[3];
	if (!prepare || !offer || !answer) throw new Error("missing answer prefix proof");
	f.trace.push("source:checked-answer");
	const check = await f.store.sign(
		{
			...prepare.value,
			phase: "answer-check",
			prepareDigest: prepare.packetDigest,
			offerDigest: offer.packetDigest,
			answerDigest: answer.packetDigest,
		},
		f.store.session(604),
	);
	await own(f, "source", check);
	expect(f.channels.map((channel) => channel.sent.length)).toEqual([0, 0]);
	liveDeadline(f, "source");
	f.trace.push("source:apply-answer");
	const sourceRaw = new TraversalByteStream({
		channel: f.channels[0],
		side: "source",
		deadlineMs: liveDeadline(f, "source"),
	});
	f.raw.push(sourceRaw);
	liveDeadline(f, "source");
	f.prepared.attachAndRelease(sourceRaw);
	if (!f.noise.inbound) throw new Error("missing Noise responder");
	const peers = await Promise.all([f.prepared.authenticated, f.noise.inbound]);
	for (const peer of peers) {
		peer.duplex.on("error", () => {});
		f.noise.plain.push(peer.duplex);
	}
	return peers;
}
