import { describe, expect, it } from "vitest";
import {
	buildTraversalNonceStatement,
	buildTraversalStateStatement,
	readTraversalStateReceipt,
	type TraversalSignalWriteOptions,
	type TraversalSignalWriteStatement,
} from "./peer-traversal-coordinator-attempt-write.js";
import type { SchemaDatabase } from "./peer-traversal-coordinator-schema-common-test-fixtures.js";
import { attemptRow, insertAttempt } from "./peer-traversal-coordinator-schema-test-fixtures.js";
import {
	encodeTraversalSignalBody,
	type TraversalSignalBody,
} from "./peer-traversal-signal-codec.js";
import { verifyTraversalSignalProof } from "./peer-traversal-signal-proof.js";
import { readRelayAdmissionNonceReceipt } from "./relay-admission-clock.js";
import { captureRelayAdmissionParticipants } from "./relay-admission-participant-nonce.js";
import {
	PARTICIPANT_CREATED_AT,
	PARTICIPANT_DEVICE_INSERT,
	PARTICIPANT_GROUP_INSERT,
	PARTICIPANT_REVOCATION_INSERT,
} from "./relay-admission-participant-nonce-test-fixtures.js";
import { readRelayAdmissionReadinessStamp } from "./relay-admission-readiness.js";

export interface WriteDatabase extends SchemaDatabase {
	returning(statement: TraversalSignalWriteStatement): Promise<unknown>;
}
export interface WriteSeedOptions {
	omit?: "policy" | "realm" | "authorityHealth" | "realmHealth";
	rootState?: "enabled" | "disabled";
	realmState?: "enabled" | "disabled";
	authorityHealthOffset?: number;
	realmHealthOffset?: number;
	createdOffset?: number;
}
async function hash(bytes: Uint8Array) {
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function disposableSigner() {
	const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
	if (!("publicKey" in pair)) throw new Error("missing disposable key pair");
	const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
	const wire = new Uint8Array(51);
	new DataView(wire.buffer).setUint32(0, 11);
	wire.set(new TextEncoder().encode("ssh-ed25519"), 4);
	new DataView(wire.buffer).setUint32(15, 32);
	wire.set(raw, 19);
	return {
		privateKey: pair.privateKey,
		publicKey: `ssh-ed25519 ${btoa(String.fromCharCode(...wire))} disposable`,
		keyId: await hash(wire),
	};
}
async function signedProof(
	body: TraversalSignalBody,
	keys: {
		source: Awaited<ReturnType<typeof disposableSigner>>;
		target: Awaited<ReturnType<typeof disposableSigner>>;
	},
	nonce = "c".repeat(32),
) {
	const bodyBytes = encodeTraversalSignalBody(body);
	const path = "/v1/traversal/signal";
	const targetActor = body.phase === "offer-check" || body.phase === "answer";
	const deviceId = targetActor ? body.targetDeviceId : body.sourceDeviceId;
	const key = targetActor ? keys.target : keys.source;
	const canonical = ["POST", path, String(body.createdAt), nonce, await hash(bodyBytes)].join("\n");
	const signature = new Uint8Array(
		await crypto.subtle.sign("Ed25519", key.privateKey, new TextEncoder().encode(canonical)),
	);
	const packet = {
		body: btoa(String.fromCharCode(...bodyBytes))
			.replaceAll("+", "-")
			.replaceAll("/", "_")
			.replace(/=+$/, ""),
		timestamp: String(body.createdAt),
		nonce,
		signature: `v2:${btoa(String.fromCharCode(...signature))}`,
	};
	const proof = await verifyTraversalSignalProof({
		packet,
		expectedPhase: body.phase,
		signer: { deviceId, publicKey: key.publicKey },
		deviceHeader: deviceId,
		externalPathname: path,
	});
	if (!proof) throw new Error("disposable signed traversal fixture rejected");
	return proof;
}

/** Real disposable signatures on both runtimes. Stored fixture metadata grants no admission. */
export async function writeFixture(
	db: WriteDatabase,
	now: number,
	id: number,
	seed: WriteSeedOptions = {},
) {
	const namespace = {
		authorityId: `a75e${id.toString(16).padStart(60, "0")}`,
		groupId: `prepare-write-${id}`,
	};
	const session = (suffix: number) =>
		`${id.toString(16).padStart(24, "0")}${suffix.toString(16).padStart(8, "0")}`;
	const keys = await Promise.all([disposableSigner(), disposableSigner()]);
	const source = keys[0];
	const target = keys[1];
	if (!source || !target) throw new Error("missing fixture keys");
	const rows = [source, target].map((key, index) => ({
		group_id: namespace.groupId,
		device_id: `prepare-${id}-${index}`,
		public_key: key.publicKey,
		fingerprint: String(index).repeat(64),
		identity_id: null,
		enabled: 1,
	}));
	const first = rows[0];
	const second = rows[1];
	if (!first || !second) throw new Error("missing fixture rows");
	const participants = await captureRelayAdmissionParticipants(rows, {
		groupId: namespace.groupId,
		sourceDeviceId: first.device_id,
		targetDeviceId: second.device_id,
	});
	if (!participants) throw new Error("participant capture rejected fixture");
	const createdAt = Math.floor(now / 1000) + (seed.createdOffset ?? 0);
	const body: TraversalSignalBody = {
		...namespace,
		sourceDeviceId: first.device_id,
		targetDeviceId: second.device_id,
		sourceKeyId: source.keyId,
		targetKeyId: target.keyId,
		sessionId: session(0),
		messageADigest: "d".repeat(64),
		createdAt,
		admitBefore: createdAt + 30,
		attemptNotAfter: createdAt + 55,
		phase: "prepare",
	};
	const sign = (value: TraversalSignalBody, nonce?: string) =>
		signedProof(value, { source, target }, nonce);
	const options: TraversalSignalWriteOptions = {
		proof: await sign(body),
		participants,
		namespace,
		policyRevision: 1,
		execId: session(100),
	};
	const pair = { source, target };
	const f = { db, now, authority: namespace.authorityId, options, rows, sign, session, keys: pair };
	await seedWrites(f, seed);
	return f;
}
export type WriteFixture = Awaited<ReturnType<typeof writeFixture>>;
type Create = (options?: WriteSeedOptions) => Promise<WriteFixture>;
async function seedWrites(f: WriteFixture, options: WriteSeedOptions) {
	const { authorityId, groupId } = f.options.namespace;
	await f.db.run(PARTICIPANT_GROUP_INSERT, [groupId, PARTICIPANT_CREATED_AT]);
	for (const row of f.rows)
		await f.db.run(PARTICIPANT_DEVICE_INSERT, [...Object.values(row), PARTICIPANT_CREATED_AT]);
	if (options.omit === "policy") return;
	await f.db.run("INSERT INTO traversal_authority_policy VALUES (?1,1,?2)", [
		authorityId,
		options.rootState ?? "enabled",
	]);
	if (options.omit !== "realm")
		await f.db.run("INSERT INTO traversal_realms VALUES (?1,?2,?3,1)", [
			authorityId,
			groupId,
			options.realmState ?? "enabled",
		]);
	if (options.omit === "authorityHealth") return;
	await f.db.run("INSERT INTO traversal_readiness VALUES (?1,'authority','',1,'ready',?2)", [
		authorityId,
		f.now + (options.authorityHealthOffset ?? 0),
	]);
	if (options.omit === "realm" || options.omit === "realmHealth") return;
	await f.db.run("INSERT INTO traversal_readiness VALUES (?1,'realm',?2,1,'ready',?3)", [
		authorityId,
		groupId,
		f.now + (options.realmHealthOffset ?? 0),
	]);
}
export const BUILDERS = [
	["nonce", buildTraversalNonceStatement],
	["state", buildTraversalStateStatement],
] as const;
export async function compileWrites(f: WriteFixture) {
	const nonce = await buildTraversalNonceStatement({ ...f.options, execId: f.session(101) });
	const state = await buildTraversalStateStatement({ ...f.options, execId: f.session(102) });
	if (!nonce || !state) throw new Error("valid PREPARE compilation rejected");
	return { nonce, state };
}
async function rawAttempt(
	f: WriteFixture,
	suffix = 0,
	changes: Parameters<typeof attemptRow>[1] = {},
) {
	const body = f.options.proof.value;
	await insertAttempt(
		f.db,
		attemptRow(f, {
			session_id: f.session(suffix),
			group_id: body.groupId,
			source_device_id: body.sourceDeviceId,
			target_device_id: body.targetDeviceId,
			source_key_id: body.sourceKeyId,
			target_key_id: body.targetKeyId,
			...changes,
		}),
	);
}
const stateRows = (f: WriteFixture) =>
	f.db.all("SELECT * FROM traversal_attempts WHERE authority_id=?1", [f.authority]);
const nonceRows = (f: WriteFixture) =>
	f.db.all("SELECT * FROM request_nonces WHERE device_id=?1", [f.rows[0]?.device_id ?? ""]);

export function registerWriteScenarios(create: Create) {
	describe("PREPARE conditional nonce and state writes", () => {
		registerValidWrites(create);
		registerReplay(create);
		registerParticipantDrift(create);
		registerMetadataDenials(create);
		registerRevocations(create);
		registerOtherRaces(create);
		registerQuotas(create);
		registerCompetingWrites(create);
		registerReceipts(create);
		registerInvalidInputs(create);
		registerStaticSql(create);
	});
}
function registerValidWrites(create: Create) {
	it("returns own nonce/readiness and stored state execution, digests and SQL clock", async () => {
		const f = await create();
		const { nonce, state } = await compileWrites(f);

		const nonceRow = await f.db.returning(nonce);
		const stateRow = await f.db.returning(state);
		const receipt = readRelayAdmissionNonceReceipt(nonceRow, nonce.association);
		const parsed = readTraversalStateReceipt(stateRow, state);

		expect(receipt).not.toBeNull();
		if (!receipt || !parsed) throw new Error("missing owned receipts");
		expect(readRelayAdmissionReadinessStamp(nonceRow, receipt)).toMatchObject({
			revision: 1,
			state: "ready",
			observedAtMs: f.now,
		});
		expect(parsed).toMatchObject({
			receipt: { ...state.association },
			readiness: { revision: 1, state: "ready", observedAtMs: f.now },
			updatedAtMs: parsed.receipt.decidedAtMs,
		});
		expect(nonce.association.attemptId).not.toBe(state.association.attemptId);
		const body = f.options.proof.value;
		expect(await stateRows(f)).toEqual([
			{
				session_id: body.sessionId,
				authority_id: body.authorityId,
				group_id: body.groupId,
				source_device_id: body.sourceDeviceId,
				source_key_id: body.sourceKeyId,
				target_device_id: body.targetDeviceId,
				target_key_id: body.targetKeyId,
				message_a_digest: body.messageADigest,
				prepare_created_at: body.createdAt,
				attempt_not_after: body.attemptNotAfter,
				policy_revision: 1,
				prepare_digest: f.options.proof.packetDigest,
				created_at_ms: parsed.receipt.decidedAtMs,
				updated_at_ms: parsed.updatedAtMs,
				phase: 1,
				offer_digest: null,
				answer_digest: null,
				last_request_digest: f.options.proof.packetDigest,
				last_nonce: f.options.proof.nonce,
				exec_id: state.association.attemptId,
			},
		]);
	});
}
function registerReplay(create: Create) {
	it("denies a shared-device nonce replay with a fresh execution before any state exists", async () => {
		const f = await create();
		const { nonce } = await compileWrites(f);
		await f.db.returning(nonce);
		const replay = await buildTraversalNonceStatement({ ...f.options, execId: f.session(103) });
		if (!replay) throw new Error("replay must compile, then fail the shared ledger check");

		const row = await f.db.returning(replay);

		expect(row).toBeNull();
		expect(readRelayAdmissionNonceReceipt(row, replay.association)).toBeNull();
		expect(await nonceRows(f)).toHaveLength(1);
		expect(await stateRows(f)).toEqual([]);
	});
}
const TUPLE_COLUMNS = [
	"group_id",
	"device_id",
	"public_key",
	"fingerprint",
	"identity_id",
	"enabled",
] as const;
function registerParticipantDrift(create: Create) {
	it.each([0, 1].flatMap((index) => TUPLE_COLUMNS.map((column) => ({ index, column }))))(
		"denies both writes after participant $index.$column changes",
		async ({ index, column }) => {
			const f = await create();
			const statements = await compileWrites(f);
			const row = f.rows[index];
			if (!row) throw new Error("missing participant");
			const value = column === "enabled" ? 0 : "changed";
			// Identifiers come only from the literal six-column allowlist.
			await f.db.run(
				`UPDATE enrolled_devices SET ${column}=?1 WHERE group_id=?2 AND device_id=?3`,
				[value, row.group_id, row.device_id],
			);

			const results = await Promise.all([
				f.db.returning(statements.nonce),
				f.db.returning(statements.state),
			]);

			expect(results).toEqual([null, null]);
			expect(await nonceRows(f)).toEqual([]);
			expect(await stateRows(f)).toEqual([]);
		},
	);
}
const METADATA_DENIALS: WriteSeedOptions[] = [
	{ omit: "policy" },
	{ omit: "realm" },
	{ omit: "authorityHealth" },
	{ omit: "realmHealth" },
	{ rootState: "disabled" },
	{ realmState: "disabled" },
	{ authorityHealthOffset: -50001 },
	{ realmHealthOffset: -50001 },
	{ authorityHealthOffset: 20000 },
	{ realmHealthOffset: 20000 },
	{ createdOffset: -30 },
	{ createdOffset: -56 },
	{ createdOffset: 15 },
];
function registerMetadataDenials(create: Create) {
	it.each(METADATA_DENIALS)(
		"denies both writes for missing/disabled/stale metadata or time %j",
		async (options) => {
			const f = await create(options);
			const { nonce, state } = await compileWrites(f);

			const results = await Promise.all([f.db.returning(nonce), f.db.returning(state)]);

			expect(results).toEqual([null, null]);
			expect(await nonceRows(f)).toEqual([]);
			expect(await stateRows(f)).toEqual([]);
		},
	);
}
function registerRevocations(create: Create) {
	it.each([0, 1].flatMap((index) => ["device_id", "ed25519_key"].map((kind) => ({ index, kind }))))(
		"denies both writes for global $kind revocation on participant $index",
		async ({ index, kind }) => {
			const f = await create();
			const { nonce, state } = await compileWrites(f);
			const participant =
				index === 0 ? f.options.participants.source : f.options.participants.target;
			if (!participant) throw new Error("missing participant");
			await f.db.run(PARTICIPANT_REVOCATION_INSERT, [
				kind,
				kind === "device_id" ? participant.device_id : participant.keyId,
			]);

			const rows = await Promise.all([f.db.returning(nonce), f.db.returning(state)]);

			expect(rows).toEqual([null, null]);
		},
	);
}
function registerOtherRaces(create: Create) {
	it.each(["archive", "policy", "authorityHealth", "realmHealth", "session"] as const)(
		"rechecks %s before each independent write",
		async (change) => {
			const f = await create();
			const { nonce, state } = await compileWrites(f);
			await changeGuard(f, change);

			const results = await Promise.all([f.db.returning(nonce), f.db.returning(state)]);

			expect(results).toEqual([null, null]);
			expect(await nonceRows(f)).toEqual([]);
		},
	);
	it.each(["revocation", "policy", "target"] as const)(
		"denies state after %s changes between the committed nonce and state writes",
		async (change) => {
			const f = await create();
			const { nonce, state } = await compileWrites(f);
			expect(
				readRelayAdmissionNonceReceipt(await f.db.returning(nonce), nonce.association),
			).not.toBeNull();
			await changeBetweenWrites(f, change);

			const row = await f.db.returning(state);

			expect(row).toBeNull();
			expect(readTraversalStateReceipt(row, state)).toBeNull();
			expect(await nonceRows(f)).toHaveLength(1);
			expect(await stateRows(f)).toEqual([]);
		},
	);
}
async function changeGuard(
	f: WriteFixture,
	change: "archive" | "policy" | "authorityHealth" | "realmHealth" | "session",
) {
	if (change === "session") return rawAttempt(f);
	if (change === "archive")
		return f.db.run("UPDATE groups SET archived_at='archived' WHERE group_id=?1", [
			f.options.namespace.groupId,
		]);
	if (change === "policy")
		return f.db.run(
			"UPDATE traversal_authority_policy SET policy_revision=2 WHERE authority_id=?1",
			[f.authority],
		);
	await f.db.run(
		"UPDATE traversal_readiness SET revision=2,state=?2 WHERE authority_id=?1 AND scope='authority'",
		[f.authority, change === "realmHealth" ? "ready" : "paused"],
	);
	if (change === "realmHealth")
		await f.db.run(
			"UPDATE traversal_readiness SET revision=2,state='tripped' WHERE authority_id=?1 AND scope='realm'",
			[f.authority],
		);
}
async function changeBetweenWrites(f: WriteFixture, change: "revocation" | "policy" | "target") {
	if (change === "policy") return changeGuard(f, "policy");
	if (change === "revocation")
		return f.db.run(PARTICIPANT_REVOCATION_INSERT, ["device_id", f.options.proof.signer.deviceId]);
	return f.db.run("UPDATE enrolled_devices SET enabled=0 WHERE group_id=?1 AND device_id=?2", [
		f.options.namespace.groupId,
		f.options.proof.value.targetDeviceId,
	]);
}
function registerQuotas(create: Create) {
	it.each(["pair", "source", "target"] as const)(
		"leaves the nonce consumed when the atomic %s quota rejects the state insert",
		async (quota) => {
			const f = await create();
			const { nonce, state } = await compileWrites(f);
			const count = quota === "pair" ? 1 : 4;
			for (let i = 1; i <= count; i++) {
				const changes =
					quota === "source"
						? { target_device_id: `other-target-${i}` }
						: { source_device_id: `other-source-${i}` };
				await rawAttempt(f, i, quota === "pair" ? {} : changes);
			}
			const receipt = readRelayAdmissionNonceReceipt(
				await f.db.returning(nonce),
				nonce.association,
			);

			const result = f.db.returning(state);

			expect(receipt).not.toBeNull();
			await expect(result).rejects.toThrow();
			expect(await nonceRows(f)).toHaveLength(1);
			expect(await stateRows(f)).toHaveLength(count);
		},
	);
}
function registerCompetingWrites(create: Create) {
	it("returns one owned state winner whose execution ID is actually stored", async () => {
		const f = await create();
		const { nonce, state } = await compileWrites(f);
		await f.db.returning(nonce);
		const competing = await buildTraversalStateStatement({ ...f.options, execId: f.session(103) });
		if (!competing) throw new Error("missing competing statement");

		const rows = await Promise.all([f.db.returning(state), f.db.returning(competing)]);
		const parsed = rows
			.map((row, index) => readTraversalStateReceipt(row, index === 0 ? state : competing))
			.filter((row) => row !== null);

		expect(parsed).toHaveLength(1);
		expect((await stateRows(f)).map((row) => row.exec_id)).toEqual(
			parsed.map((row) => row.receipt.attemptId),
		);
	});
}
function registerReceipts(create: Create) {
	it("rejects missing, foreign, malformed and multiple state receipts without accepting an envelope", async () => {
		const f = await create();
		const { state } = await compileWrites(f);
		const row = await f.db.returning(state);
		if (typeof row !== "object" || row === null) throw new Error("missing raw state row");
		const corrupt = [
			null,
			undefined,
			[],
			[row],
			[row, row],
			{ results: [row] },
			{ ...row, updatedAtMs: Number(Reflect.get(row, "decidedAtMs")) + 1 },
			...Object.entries({
				attemptId: f.session(200),
				deviceId: "foreign",
				nonce: "0".repeat(32),
				sessionId: f.session(201),
				phase: 2,
				packetDigest: "0".repeat(64),
				policyRevision: 2,
				updatedAtMs: -1,
				decidedAtMs: null,
				createdAt: "invalid",
				readinessRevision: 0,
				readinessObservedAtMs: 0,
			}).map(([field, value]) => ({ ...row, [field]: value })),
		];

		const results = corrupt.map((value) => readTraversalStateReceipt(value, state));

		expect(readTraversalStateReceipt(row, state)).not.toBeNull();
		expect(results).toEqual(corrupt.map(() => null));
	});
}

const INVALID_INPUTS = [
	"target",
	"sourceKey",
	"targetKey",
	"targetPin",
	"signerDevice",
	"signerPin",
	"signerKey",
	"authority",
	"group",
	"bodyValue",
	"bodyBytes",
	"digest",
	"nonce",
	"exec",
	"execNull",
	"revision",
	"revisionNull",
	"proofNull",
] as const;
function registerInvalidInputs(create: Create) {
	it.each(INVALID_INPUTS)("compiles neither statement for invalid %s", async (change) => {
		const f = await create();
		corruptInput(f.options, change);

		const statements = await Promise.all(BUILDERS.map(([, build]) => build(f.options)));

		expect(statements).toEqual([null, null]);
		expect(await nonceRows(f)).toEqual([]);
		expect(await stateRows(f)).toEqual([]);
	});
}
function corruptInput(o: TraversalSignalWriteOptions, change: (typeof INVALID_INPUTS)[number]) {
	if (["target", "sourceKey", "targetKey", "targetPin"].includes(change)) {
		corruptParticipant(o, change);
		return;
	}
	const mutations: Partial<Record<(typeof INVALID_INPUTS)[number], () => unknown>> = {
		signerDevice: () => Object.assign(o.proof.signer, { deviceId: "foreign" }),
		signerPin: () =>
			Object.assign(o.proof.signer, { publicKey: o.participants.target?.public_key }),
		signerKey: () => Object.assign(o.proof.signer, { keyId: "0".repeat(64) }),
		authority: () => Object.assign(o.namespace, { authorityId: "0".repeat(64) }),
		group: () => Object.assign(o.namespace, { groupId: "foreign" }),
		bodyValue: () => Object.assign(o.proof.value, { messageADigest: "0".repeat(64) }),
		bodyBytes: () => o.proof.bodyBytes.fill(0),
		digest: () => Object.assign(o.proof, { packetDigest: "0".repeat(64) }),
		nonce: () => Object.assign(o.proof, { nonce: "invalid" }),
		exec: () => Object.assign(o, { execId: "A".repeat(32) }),
		execNull: () => Object.assign(o, { execId: null }),
		revision: () => Object.assign(o, { policyRevision: 0 }),
		revisionNull: () => Object.assign(o, { policyRevision: null }),
		proofNull: () => Object.assign(o, { proof: null }),
	};
	mutations[change]?.();
}
function corruptParticipant(
	o: TraversalSignalWriteOptions,
	change: (typeof INVALID_INPUTS)[number],
) {
	const { source, target } = o.participants;
	if (change === "target")
		Object.assign(o, { participants: Object.freeze({ source, target: null }) });
	if (change === "sourceKey")
		Object.assign(o, {
			participants: Object.freeze({
				source: Object.freeze({ ...source, keyId: "0".repeat(64) }),
				target,
			}),
		});
	if (change === "targetKey" || change === "targetPin")
		Object.assign(o, {
			participants: Object.freeze({
				source,
				target: Object.freeze({
					...target,
					...(change === "targetKey"
						? { keyId: "0".repeat(64) }
						: { public_key: source.public_key }),
				}),
			}),
		});
}
function registerStaticSql(create: Create) {
	it("keeps SQL static, binds digests instead of bodies and executes nothing while compiling", async () => {
		const f = await create();
		const other = await create();

		const first = await compileWrites(f);
		const second = await compileWrites(other);

		for (const name of ["nonce", "state"] as const) {
			expect(first[name].sql).toBe(second[name].sql);
			expect(first[name].bindings).not.toContain(
				new TextDecoder().decode(f.options.proof.bodyBytes),
			);
			expect(first[name].expected).toEqual({
				sessionId: f.options.proof.value.sessionId,
				packetDigest: f.options.proof.packetDigest,
				phase: 1,
				policyRevision: 1,
			});
		}
		expect(await nonceRows(f)).toEqual([]);
		expect(await stateRows(f)).toEqual([]);
	});
}
