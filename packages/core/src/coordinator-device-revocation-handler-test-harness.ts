import { expect, vi } from "vitest";
import type { CoordinatorDeviceRevocationRecord } from "./coordinator-device-revocation.js";
import {
	createCoordinatorDeviceRevocationHandler as createHandler,
	type CoordinatorDeviceRevocationHandlerOptions as Options,
} from "./coordinator-device-revocation-handler.js";
import {
	enrollRevocation,
	nonceInput,
	type RevocationFixture,
	type revocationHarness,
	revocationSideEffectTables,
} from "./coordinator-device-revocation-test-harness.js";
import {
	ACCEPTED_ALIASES,
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
	MALFORMED_KEYS,
	NODE_ONLY_ALIASES,
	publicKeyFromWire,
	wireBytes,
} from "./coordinator-ed25519-key-id-test-fixtures.js";

const secret = "fixture-operator-secret";
const coordinator = "fixture-coordinator";
type Handler = ReturnType<typeof createHandler>;
function options(f: RevocationFixture): Options {
	return { store: f.store, trustedCoordinatorId: coordinator, adminSecret: secret };
}
function body(f: RevocationFixture) {
	return { group_id: f.input.groupId, device_id: f.input.deviceId };
}
function request(data: unknown, credential: string | null = secret): Request {
	return new Request("https://coordinator.example.invalid/internal", {
		method: "POST",
		body: JSON.stringify(data),
		headers: credential === null ? {} : { "X-Codemem-Coordinator-Admin": credential },
	});
}
async function preview(f: RevocationFixture, handler = createHandler(options(f))) {
	const response = await handler("preview", request(body(f)));
	expect(response.status).toBe(200);
	return (await response.json()) as { expected_digest: string };
}
async function commit(f: RevocationFixture, handler: Handler, digest: string) {
	return handler("commit", request({ ...body(f), expected_digest: digest }));
}
async function snapshot(f: RevocationFixture) {
	return Promise.all(
		[
			...revocationSideEffectTables,
			"coordinator_device_revocations",
			"request_nonces",
			"sqlite_master",
		].map(f.rows),
	);
}
async function digest(values: unknown[]) {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(values)),
	);
	return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Inactive operator contract only: no route activation or propagation claims. */
export function registerDeviceRevocationHandlerContract(
	test: ReturnType<typeof revocationHarness>,
) {
	registerBoundary(test);
	registerContext(test);
	registerInput(test);
	registerRawBody(test);
	registerAuthentication(test);
	registerKeys(test);
	registerPreview(test);
	registerDisabled(test);
	registerDigestDrift(test);
	registerRaces(test);
	registerAtomicRace(test);
	registerOutcomes(test);
	registerOverlap(test);
	registerGlobalEffect(test);
	registerIncomplete(test);
	registerReceiptReferences(test);
	registerRetainedTime(test);
	registerMalformedReferences(test);
}
type Test = ReturnType<typeof revocationHarness>;
function receiptReferences(records: CoordinatorDeviceRevocationRecord[]) {
	return records.map(({ subject_kind, subject_value, revocation_id, created_at }) => ({
		subject_kind,
		subject_value,
		revocation_id,
		created_at,
	}));
}
type ReceiptResponse = { revocations: ReturnType<typeof receiptReferences> };
function isReceiptReference(value: unknown): value is ReceiptResponse["revocations"][number] {
	return (
		typeof value === "object" &&
		value !== null &&
		"subject_kind" in value &&
		(value.subject_kind === "device_id" || value.subject_kind === "ed25519_key") &&
		"subject_value" in value &&
		typeof value.subject_value === "string" &&
		"revocation_id" in value &&
		typeof value.revocation_id === "string" &&
		"created_at" in value &&
		typeof value.created_at === "string"
	);
}
function isReceiptResponse(value: unknown): value is ReceiptResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		"revocations" in value &&
		Array.isArray(value.revocations) &&
		value.revocations.every(isReceiptReference)
	);
}
async function receiptResponse(response: Response): Promise<ReceiptResponse> {
	const value: unknown = await response.json();
	if (!isReceiptResponse(value)) throw new Error("Malformed revocation response references");
	return value;
}
function registerBoundary(test: Test) {
	for (const credential of [null, "", "wrong", "x".repeat(8193)]) {
		test(`denies credential ${credential?.length ?? "missing"} before body, context or target`, async ({
			fixture: f,
		}) => {
			// Arrange: invalid input and absent context must not change auth precedence.
			const req = request({ actor_id: "not-authority" }, credential);
			if (!req.body) throw new Error("Missing fixture body");
			const read = vi.spyOn(req.body, "getReader");
			const get = vi.spyOn(f.store, "getEnrollment");
			const write = vi.spyOn(f.store, "createDeviceRevocation");
			const handler = createHandler({ ...options(f), trustedCoordinatorId: null });
			// Act
			const response = await handler("commit", req);
			// Assert
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: "unauthorized" });
			expect(read).not.toHaveBeenCalled();
			expect(get).not.toHaveBeenCalled();
			expect(write).not.toHaveBeenCalled();
		});
	}
	for (const adminSecret of [undefined, null, ""]) {
		test(`missing configured secret ${String(adminSecret)} has no fallback`, async ({
			fixture: f,
		}) => {
			// Arrange
			const get = vi.spyOn(f.store, "getEnrollment");
			const handler = createHandler({ ...options(f), adminSecret });
			// Act
			const response = await handler("preview", request(body(f)));
			// Assert
			expect(response.status).toBe(401);
			expect(get).not.toHaveBeenCalled();
		});
	}
}
function registerContext(test: Test) {
	for (const trustedCoordinatorId of [null, "", " context", "c".repeat(257), "bad\u200bcontext"]) {
		test(`rejects invalid server context ${JSON.stringify(trustedCoordinatorId)} before reading body`, async ({
			fixture: f,
		}) => {
			// Arrange
			const req = request({ ...body(f), coordinator_id: coordinator });
			if (!req.body) throw new Error("Missing fixture body");
			const read = vi.spyOn(req.body, "getReader");
			const get = vi.spyOn(f.store, "getEnrollment");
			// Act
			const response = await createHandler({ ...options(f), trustedCoordinatorId })("preview", req);
			// Assert
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: "revocation_unavailable" });
			expect(read).not.toHaveBeenCalled();
			expect(get).not.toHaveBeenCalled();
		});
	}
}
function registerInput(test: Test) {
	const invalid: unknown[] = [null, [], {}, { group_id: "g" }, { group_id: 1, device_id: "d" }];
	for (const field of [
		"actor_id",
		"identity_id",
		"public_key",
		"fingerprint",
		"key_id",
		"coordinator_id",
		"expected_digest",
	]) {
		invalid.push({ group_id: "g", device_id: "d", [field]: "caller-nominated" });
	}
	for (const id of ["", " d", "d ", "d".repeat(257), "d\u0000", "d\n", "d\u200b", "d\ud800"]) {
		for (const field of ["group_id", "device_id"])
			invalid.push({ group_id: "g", device_id: "d", [field]: id });
	}
	for (const [index, data] of invalid.entries()) {
		test(`invalid preview input ${index} never probes a target`, async ({ fixture: f }) => {
			// Arrange
			const get = vi.spyOn(f.store, "getEnrollment");
			// Act
			const response = await createHandler(options(f))("preview", request(data));
			// Assert
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "revocation_invalid_input" });
			expect(get).not.toHaveBeenCalled();
		});
	}
	for (const expected_digest of [
		undefined,
		null,
		"",
		"A".repeat(64),
		"a".repeat(63),
		"z".repeat(64),
	]) {
		test(`invalid commit digest ${String(expected_digest)} denies before lookup`, async ({
			fixture: f,
		}) => {
			// Arrange
			const get = vi.spyOn(f.store, "getEnrollment");
			// Act
			const response = await createHandler(options(f))(
				"commit",
				request({ ...body(f), expected_digest }),
			);
			// Assert
			expect(response.status).toBe(400);
			expect(get).not.toHaveBeenCalled();
		});
	}
}
function registerRawBody(test: Test) {
	for (const [name, raw, status] of [
		["malformed JSON", "{", 400],
		["invalid UTF8", new Uint8Array([255]), 400],
		["oversized bytes", "x".repeat(4097), 413],
		["multibyte oversized", "é".repeat(2049), 413],
	] as const) {
		test(`${name} denies before lookup`, async ({ fixture: f }) => {
			// Arrange
			const get = vi.spyOn(f.store, "getEnrollment");
			const req = new Request("https://coordinator.example.invalid", {
				method: "POST",
				body: raw,
				headers: { "X-Codemem-Coordinator-Admin": secret },
			});
			// Act
			const response = await createHandler(options(f))("preview", req);
			// Assert
			expect(response.status).toBe(status);
			expect(get).not.toHaveBeenCalled();
		});
	}
	test("accepts the exact 4096-byte body and 256-character identifiers without trimming", async ({
		fixture: f,
	}) => {
		// Arrange
		f.input.groupId = "g".repeat(256);
		f.input.deviceId = "d".repeat(256);
		await enrollRevocation(f);
		const raw = JSON.stringify(body(f));
		const req = new Request("https://coordinator.example.invalid", {
			method: "POST",
			body: raw.padEnd(4096),
			headers: { "X-Codemem-Coordinator-Admin": secret },
		});
		// Act
		const response = await createHandler(options(f))("preview", req);
		// Assert
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject(body(f));
	});
}
function registerAuthentication(test: Test) {
	test("authenticates with fixed-length native MAC sign/verify rather than a secret comparison", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		const sign = vi.spyOn(crypto.subtle, "sign");
		const verify = vi.spyOn(crypto.subtle, "verify");
		try {
			// Act
			const handler = createHandler(options(f));
			const responses = [
				await handler("preview", request(body(f))),
				await handler("preview", request(body(f), "wrong")),
			];
			// Assert
			expect(responses.map((r) => r.status)).toEqual([200, 401]);
			expect(sign).toHaveBeenCalledTimes(2);
			expect(verify).toHaveBeenCalledTimes(2);
			for (const [algorithm, , signature, actual] of verify.mock.calls) {
				expect(algorithm).toBe("HMAC");
				expect(signature.byteLength).toBe(32);
				expect(actual.byteLength).toBe(32);
			}
		} finally {
			sign.mockRestore();
			verify.mockRestore();
		}
	});
}

function registerKeys(test: Test) {
	const accepted = ACCEPTED_ALIASES.slice(0, 4);
	const rejected = [
		...MALFORMED_KEYS,
		...ACCEPTED_ALIASES.slice(4),
		...NODE_ONLY_ALIASES,
		{ name: "opaque", publicKey: "pk1" },
		{ name: "private PEM", publicKey: "-----BEGIN PRIVATE KEY-----" },
		{ name: "extra base64 padding", publicKey: `${CANONICAL_PUBLIC_KEY}=` },
		{ name: "oversized comment", publicKey: `${CANONICAL_PUBLIC_KEY} ${"x".repeat(16384)}` },
	];
	for (const { name, publicKey } of [...accepted, ...rejected]) {
		test(`strict wire ${name} ${accepted.some((a) => a.name === name) ? "accepts" : "denies"}`, async ({
			fixture: f,
		}) => {
			// Arrange: SQL injects legacy metadata without trusting enrollment validation.
			await enrollRevocation(f);
			await f.exec(
				"UPDATE enrolled_devices SET public_key = ? WHERE group_id = ? AND device_id = ?",
				publicKey,
				f.input.groupId,
				f.input.deviceId,
			);
			const write = vi.spyOn(f.store, "createDeviceRevocation");
			// Act
			const response = await createHandler(options(f))("preview", request(body(f)));
			// Assert
			expect(response.status).toBe(accepted.some((a) => a.name === name) ? 200 : 409);
			if (response.status === 200)
				expect(await response.json()).toMatchObject({ key_id: EXPECTED_KEY_ID });
			else expect(await response.json()).toEqual({ error: "revocation_target_unavailable" });
			expect(write).not.toHaveBeenCalled();
			expect(await f.rows("coordinator_device_revocations")).toEqual([]);
		});
	}
}

function registerPreview(test: Test) {
	test("preview is read-only, exact-domain digest bound, and redacted", async ({ fixture: f }) => {
		// Arrange: populate human authority so unchanged comparisons are not vacuous.
		await enrollRevocation(f);
		const review = {
			...f.input,
			coordinatorId: coordinator,
			identityId: "identity",
			attestationId: "attestation",
			reviewReceiptId: "receipt",
			evidenceDigest: "b".repeat(64),
		};
		expect(await f.store.createAuthControllerAttestation(review)).toMatchObject({
			kind: "created",
		});
		expect(await f.store.issueIdentityGroupGrantFromControllerAttestation(review)).toMatchObject({
			kind: "created",
		});
		const before = await snapshot(f);
		const expected = await digest([
			"codemem-global-device-revocation",
			1,
			"revoke",
			coordinator,
			f.input.groupId,
			f.input.deviceId,
			f.input.publicKey,
			f.input.fingerprint,
			EXPECTED_KEY_ID,
		]);
		// Act
		const response = await createHandler(options(f))("preview", request(body(f)));
		const result = await response.json();
		// Assert
		expect(response.status).toBe(200);
		expect(result).toEqual({
			state: "ready",
			version: 1,
			coordinator_id: coordinator,
			...body(f),
			key_id: EXPECTED_KEY_ID,
			scope: "whole_database_device_id_any_key_and_canonical_key_any_device_all_groups",
			expected_digest: expected,
		});
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(await snapshot(f)).toEqual(before);
	});
	test("missing target neither creates subjects nor reports ready", async ({ fixture: f }) => {
		// Arrange
		const before = await snapshot(f);
		// Act
		const response = await createHandler(options(f))("preview", request(body(f)));
		// Assert
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ error: "revocation_target_unavailable" });
		expect(await snapshot(f)).toEqual(before);
	});
}
function registerDigestDrift(test: Test) {
	for (const change of ["context", "group", "device", "key", "fingerprint", "action"] as const) {
		test(`digest rejects changed ${change} evidence`, async ({ fixture: f }) => {
			// Arrange
			await enrollRevocation(f);
			const handler = createHandler(options(f));
			let { expected_digest } = await preview(f, handler);
			if (change === "action")
				expected_digest = await digest([
					"codemem-global-device-revocation",
					1,
					"preview",
					coordinator,
					f.input.groupId,
					f.input.deviceId,
					f.input.publicKey,
					f.input.fingerprint,
					EXPECTED_KEY_ID,
				]);
			await changeEvidence(f, change);
			const changed =
				change === "context"
					? createHandler({ ...options(f), trustedCoordinatorId: "other-coordinator" })
					: handler;
			const write = vi.spyOn(f.store, "createDeviceRevocation");
			// Act
			const response = await commit(f, changed, expected_digest);
			// Assert
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "revocation_preview_stale" });
			expect(write).not.toHaveBeenCalled();
			expect(await f.rows("coordinator_device_revocations")).toEqual([]);
		});
	}
}

async function changeEvidence(f: RevocationFixture, change: string) {
	if (change === "key" || change === "fingerprint") {
		const field = change === "key" ? "public_key" : "fingerprint";
		const value = change === "key" ? `${f.input.publicKey} alias` : "different-fingerprint";
		await f.exec(
			`UPDATE enrolled_devices SET ${field} = ? WHERE group_id = ? AND device_id = ?`,
			value,
			f.input.groupId,
			f.input.deviceId,
		);
	}
	if (change === "group" || change === "device") {
		f.input[change === "group" ? "groupId" : "deviceId"] += "-other";
		if (change === "group") await f.store.createGroup(f.input.groupId);
		await f.store.enrollDevice(f.input.groupId, f.input);
	}
}
function registerDisabled(test: Test) {
	test("disabled current target remains previewable and revocable", async ({ fixture: f }) => {
		// Arrange
		await enrollRevocation(f);
		await f.store.setDeviceEnabled(f.input.groupId, f.input.deviceId, false);
		const handler = createHandler(options(f));
		// Act
		const result = await preview(f, handler);
		const response = await commit(f, handler, result.expected_digest);
		// Assert
		expect(response.status).toBe(200);
		expect(await f.store.listDeviceRevocations(f.input)).toHaveLength(2);
	});
}
function registerRaces(test: Test) {
	test("factory captures secret, store and trusted context across an authentication await", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		const config = options(f);
		const handler = createHandler(config);
		const other = { getEnrollment: vi.fn(), createDeviceRevocation: vi.fn() };
		// Act: invocation yields during native authentication hashing.
		const pending = handler("preview", request(body(f)));
		config.adminSecret = "replacement";
		config.trustedCoordinatorId = "replacement-context";
		config.store = other;
		const response = await pending;
		// Assert
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ coordinator_id: coordinator });
		expect(other.getEnrollment).not.toHaveBeenCalled();
		expect((await handler("preview", request(body(f), "replacement"))).status).toBe(401);
	});
	test("copies exact enrollment evidence before canonical hashing can mutate the DTO", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		const enrollment = await f.store.getEnrollment(f.input.groupId, f.input.deviceId);
		vi.spyOn(f.store, "getEnrollment").mockImplementation(async () => {
			queueMicrotask(() =>
				queueMicrotask(() => {
					if (enrollment) enrollment.public_key = "changed-object-key";
				}),
			);
			return enrollment;
		});
		const expected = await digest([
			"codemem-global-device-revocation",
			1,
			"revoke",
			coordinator,
			f.input.groupId,
			f.input.deviceId,
			f.input.publicKey,
			f.input.fingerprint,
			EXPECTED_KEY_ID,
		]);
		// Act
		const response = await createHandler(options(f))("preview", request(body(f)));
		// Assert
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ expected_digest: expected });
		expect(enrollment?.public_key).toBe("changed-object-key");
	});
}
function registerAtomicRace(test: Test) {
	for (const mutation of ["key", "fingerprint", "remove"] as const) {
		test(`atomic primitive denies ${mutation} drift after handler reread`, async ({
			fixture: f,
		}) => {
			// Arrange: intercept the handoff but execute the real primitive against changed SQL state.
			await enrollRevocation(f);
			const handler = createHandler(options(f));
			const { expected_digest } = await preview(f, handler);
			const original = f.store.createDeviceRevocation.bind(f.store);
			const write = vi
				.spyOn(f.store, "createDeviceRevocation")
				.mockImplementation(async (tuple) => {
					if (mutation === "remove") await f.store.removeDevice(f.input.groupId, f.input.deviceId);
					else
						await f.exec(
							`UPDATE enrolled_devices SET ${mutation === "key" ? "public_key" : "fingerprint"} = ? WHERE group_id = ? AND device_id = ?`,
							mutation === "key" ? `${f.input.publicKey} rotated` : "new-fingerprint",
							f.input.groupId,
							f.input.deviceId,
						);
					return original(tuple);
				});
			// Act
			const response = await commit(f, handler, expected_digest);
			// Assert
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "revocation_preview_stale" });
			expect(write).toHaveBeenCalledExactlyOnceWith({
				groupId: f.input.groupId,
				deviceId: f.input.deviceId,
				publicKey: f.input.publicKey,
				fingerprint: f.input.fingerprint,
			});
			expect(await f.rows("coordinator_device_revocations")).toEqual([]);
		});
	}
}

function registerOutcomes(test: Test) {
	test("commit and exact retry retain two immutable subjects without changing authority", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		const handler = createHandler(options(f));
		const { expected_digest } = await preview(f, handler);
		const before = await Promise.all(revocationSideEffectTables.map(f.rows));
		// Act
		const response = await commit(f, handler, expected_digest);
		const records = await f.store.listDeviceRevocations(f.input);
		const retry = await commit(f, handler, expected_digest);
		const result = await receiptResponse(response);
		// Assert
		expect(response.status).toBe(200);
		expect(result).toEqual({
			state: "revoked",
			version: 1,
			coordinator_id: coordinator,
			...body(f),
			key_id: EXPECTED_KEY_ID,
			scope: "whole_database_device_id_any_key_and_canonical_key_any_device_all_groups",
			revocations: receiptReferences(records),
		});
		expect(result.revocations).toHaveLength(2);
		expect(retry.status).toBe(200);
		expect(await retry.json()).toEqual(result);
		expect(records).toHaveLength(2);
		expect(records.every((r) => r.actor_id === null)).toBe(true);
		expect(await f.store.listDeviceRevocations(f.input)).toEqual(records);
		expect(await Promise.all(revocationSideEffectTables.map(f.rows))).toEqual(before);
	});
}
function registerOverlap(test: Test) {
	test("overlapping historical receipts may retain distinct action IDs, evidence and times", async ({
		fixture: f,
	}) => {
		// Arrange
		await enrollRevocation(f);
		await f.store.enrollDevice(f.input.groupId, {
			...f.input,
			deviceId: `${f.input.deviceId}-prior`,
		});
		await f.store.createDeviceRevocation({ ...f.input, deviceId: `${f.input.deviceId}-prior` });
		const old = await f.store.listDeviceRevocations({ publicKey: f.input.publicKey });
		const handler = createHandler(options(f));
		const { expected_digest } = await preview(f, handler);
		// Act
		const response = await commit(f, handler, expected_digest);
		const records = await f.store.listDeviceRevocations(f.input);
		const result = await receiptResponse(response);
		const retry = await commit(f, handler, expected_digest);
		// Assert
		expect(response.status).toBe(200);
		expect(result.revocations).toEqual(receiptReferences(records));
		expect(result.revocations).toHaveLength(2);
		expect(retry.status).toBe(200);
		expect(await retry.json()).toEqual(result);
		expect(records.find((r) => r.subject_kind === "ed25519_key")).toEqual(old[0]);
		const device = records.find((r) => r.subject_kind === "device_id");
		expect(device?.revocation_id).not.toBe(old[0]?.revocation_id);
		expect(device?.created_at).not.toBe(old[0]?.created_at);
		expect(device?.evidence_device_id).not.toBe(old[0]?.evidence_device_id);
	});
}
function registerGlobalEffect(test: Test) {
	test("whole-database ID-any-key and key-any-ID denial leaves distinct B admitted", async ({
		fixture: f,
	}) => {
		// Arrange: all aliases predate revocation; B differs in both subjects.
		await enrollRevocation(f);
		const otherWire = wireBytes();
		otherWire[50] = (otherWire[50] ?? 0) ^ 1;
		const distinctKey = publicKeyFromWire(otherWire);
		const groupId = `${f.input.groupId}-other`;
		await f.store.createGroup(groupId);
		const peers = [
			{ ...f.input, groupId, publicKey: distinctKey },
			{ ...f.input, groupId, deviceId: "key-alias", publicKey: `${f.input.publicKey} alias` },
			{ ...f.input, groupId, deviceId: "distinct-B", publicKey: distinctKey },
		];
		for (const peer of peers) await f.store.enrollDevice(groupId, peer);
		const handler = createHandler(options(f));
		const { expected_digest } = await preview(f, handler);
		// Act
		const response = await commit(f, handler, expected_digest);
		const admissions = [];
		for (const peer of peers)
			admissions.push(await f.store.recordAuthorizedNonce({ ...nonceInput(f), ...peer }));
		// Assert
		expect(response.status).toBe(200);
		expect(admissions).toEqual(["device_revoked", "device_revoked", "recorded"]);
		expect(
			await f.store.listDeviceRevocations({
				deviceId: "distinct-B",
				publicKey: distinctKey,
			}),
		).toEqual([]);
		expect(await f.store.getEnrollment(groupId, "distinct-B")).toMatchObject({
			public_key: distinctKey,
			enabled: 1,
		});
	});
}
function registerIncomplete(test: Test) {
	for (const outcome of [
		"lost reply",
		"missing device",
		"missing key",
		"wrong subject",
		"unknown kind",
	] as const) {
		test(`${outcome} after real commit returns unknown outcome without compensation`, async ({
			fixture: f,
		}) => {
			// Arrange
			await enrollRevocation(f);
			const handler = createHandler(options(f));
			const { expected_digest } = await preview(f, handler);
			const original = f.store.createDeviceRevocation.bind(f.store);
			vi.spyOn(f.store, "createDeviceRevocation").mockImplementation(async (tuple) => {
				const result = await original(tuple);
				if (outcome === "lost reply") throw new Error("private backend diagnostic");
				if (result.kind !== "revoked") return result;
				if (outcome === "unknown kind") return { kind: "rejected", error: "invalid_input" };
				const records = result.records
					.filter((r) => {
						if (outcome === "missing device") return r.subject_kind !== "device_id";
						if (outcome === "missing key") return r.subject_kind !== "ed25519_key";
						return true;
					})
					.map((r) => (outcome === "wrong subject" ? { ...r, subject_value: "wrong" } : r));
				return { kind: "revoked", records };
			});
			// Act
			const response = await commit(f, handler, expected_digest);
			// Assert: real tombstones and their subsequent denial survive the bad receipt.
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: "device_revocation_incomplete" });
			expect(await f.store.listDeviceRevocations(f.input)).toHaveLength(2);
			expect(await f.store.recordAuthorizedNonce(nonceInput(f))).toBe("device_revoked");
		});
	}
	test("a throwing target backend returns no diagnostic or evidence", async ({ fixture: f }) => {
		// Arrange
		vi.spyOn(f.store, "getEnrollment").mockRejectedValue(
			new Error("private SQL and credential details"),
		);
		// Act
		const response = await createHandler(options(f))("preview", request(body(f)));
		// Assert
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "device_revocation_incomplete" });
		expect(await f.rows("coordinator_device_revocations")).toEqual([]);
	});
}

function registerReceiptReferences(test: Test) {
	test("returns only the two expected retained references without unrelated records or evidence", async ({
		fixture: f,
	}) => {
		// Arrange: a backend receipt includes another device's real retained record.
		await enrollRevocation(f);
		const prior = { ...f.input, deviceId: `${f.input.deviceId}-prior` };
		await f.store.enrollDevice(prior.groupId, prior);
		await f.store.createDeviceRevocation(prior);
		const unrelated = await f.store.listDeviceRevocations({ deviceId: prior.deviceId });
		const original = f.store.createDeviceRevocation.bind(f.store);
		vi.spyOn(f.store, "createDeviceRevocation").mockImplementation(async (tuple) => {
			const result = await original(tuple);
			if (result.kind !== "revoked") return result;
			return { ...result, records: [...result.records, ...unrelated] };
		});
		const handler = createHandler(options(f));
		const { expected_digest } = await preview(f, handler);
		// Act
		const response = await commit(f, handler, expected_digest);
		const result = await receiptResponse(response);
		const records = await f.store.listDeviceRevocations(f.input);
		// Assert: each reference contains only public subject, action ID and original time.
		expect(response.status).toBe(200);
		expect(result.revocations).toEqual(receiptReferences(records));
		expect(result.revocations).toHaveLength(2);
	});
}
function registerRetainedTime(test: Test) {
	test("preserves a valid retained noncanonical timestamp accepted by the actual primitive", async ({
		fixture: f,
	}) => {
		// Arrange: the table stores timestamp TEXT; exact retry does not normalize it.
		await enrollRevocation(f);
		await f.store.createDeviceRevocation(f.input);
		const retainedTime = "2099-12-31 23:59:59+00:00";
		await f.exec("UPDATE coordinator_device_revocations SET created_at = ?", retainedTime);
		const retained = await f.store.createDeviceRevocation(f.input);
		const handler = createHandler(options(f));
		const { expected_digest } = await preview(f, handler);
		// Act
		const response = await commit(f, handler, expected_digest);
		const result = await receiptResponse(response);
		// Assert: valid historical TEXT is neither invented nor rewritten to canonical ISO.
		expect(retained.kind).toBe("revoked");
		expect(response.status).toBe(200);
		expect(result.revocations).toEqual(
			receiptReferences(await f.store.listDeviceRevocations(f.input)),
		);
		expect(result.revocations).toHaveLength(2);
		expect(
			result.revocations.every((row: { created_at: string }) => row.created_at === retainedTime),
		).toBe(true);
	});
}
function registerMalformedReferences(test: Test) {
	for (const field of ["revocation_id", "created_at"] as const) {
		test(`missing retained ${field} cannot become an invented success receipt`, async ({
			fixture: f,
		}) => {
			// Arrange: a real write commits before the backend loses one required receipt field.
			await enrollRevocation(f);
			const original = f.store.createDeviceRevocation.bind(f.store);
			vi.spyOn(f.store, "createDeviceRevocation").mockImplementation(async (tuple) => {
				const result = await original(tuple);
				if (result.kind !== "revoked") return result;
				const records = result.records.map((row) => {
					const copy = { ...row };
					Reflect.deleteProperty(copy, field);
					return copy;
				});
				return { ...result, records };
			});
			const handler = createHandler(options(f));
			const { expected_digest } = await preview(f, handler);
			// Act
			const response = await commit(f, handler, expected_digest);
			// Assert: no rollback or replacement receipt follows this unknown outcome.
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: "device_revocation_incomplete" });
			expect(await f.store.listDeviceRevocations(f.input)).toHaveLength(2);
			expect(await f.store.recordAuthorizedNonce(nonceInput(f))).toBe("device_revoked");
		});
	}
}
