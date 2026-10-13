import * as fs from "node:fs";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import * as enrollmentReceiver from "./coordinator-account-link-receiver.js";
import { enrollOwnerProfile } from "./coordinator-owner-profile-client.js";
import {
	browser,
	facts,
	fakeFetch,
	fixture,
	insertMemory,
	pin,
	prepared,
	read,
	registerOwnerProfileClientMockState,
	rotateKey,
} from "./coordinator-owner-profile-client-test-harness.js";
import { ownerFileSnapshot } from "./coordinator-owner-profile-files.js";
import {
	importOwnerEnrollmentAdmissionKey,
	issueOwnerEnrollmentAdmission,
	verifyOwnerEnrollmentAdmission,
} from "./owner-enrollment-admission.js";
import { fingerprintPublicKey } from "./sync-identity.js";

const signing = vi.hoisted(() => ({ corrupt: false }));
const databaseOpens = vi.hoisted(() => [] as Array<{ readonly?: boolean }>);
const platformAccess = vi.hoisted(() => ({ tracking: false, files: [] as string[], databases: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const tracked = Object.fromEntries(
		[
			"existsSync",
			"lstatSync",
			"statSync",
			"readFileSync",
			"writeFileSync",
			"mkdirSync",
			"openSync",
			"closeSync",
			"fsyncSync",
			"linkSync",
			"unlinkSync",
			"renameSync",
			"chmodSync",
			"copyFileSync",
			"rmSync",
			"readdirSync",
			"realpathSync",
		].map((name) => [
			name,
			(...args: unknown[]) => {
				if (platformAccess.tracking) platformAccess.files.push(name);
				return Reflect.apply(
					actual[name as keyof typeof actual] as (...args: unknown[]) => unknown,
					actual,
					args,
				);
			},
		]),
	);
	return { ...actual, ...tracked };
});
vi.mock("better-sqlite3", async (importOriginal) => {
	const actual = await importOriginal<{ default: typeof import("better-sqlite3") }>();
	return {
		...actual,
		default: new Proxy(actual.default, {
			construct(target, args, newTarget) {
				databaseOpens.push((args[1] as { readonly?: boolean } | undefined) ?? {});
				if (platformAccess.tracking) platformAccess.databases += 1;
				return Reflect.construct(target, args, newTarget);
			},
		}),
	};
});
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		sign: (...args: unknown[]) =>
			signing.corrupt ? Buffer.alloc(64) : Reflect.apply(actual.sign, undefined, args),
	};
});
registerOwnerProfileClientMockState({ signing, databaseOpens });

it.each(["", " \t ", "private/capability", " private-capability ", "x".repeat(513)])(
	"keeps a prepared attempt reusable after malformed capability (case %#)",
	async (capability) => {
		// Arrange: mock loopback delivery so refusal and corrected retry stay offline.
		const receiver = vi
			.spyOn(enrollmentReceiver, "createCoordinatorOwnerEnrollmentReceiver")
			.mockResolvedValue({
				destination: "http://127.0.0.1:43127/owner/callback",
				close: vi.fn().mockResolvedValue(undefined),
				completion: Promise.resolve({
					completionSecret: Buffer.alloc(32, 4).toString("base64url"),
					confirmationHash: "a".repeat(64),
				}),
			});
		fixture.options.onBrowserStart = vi.fn().mockResolvedValue(undefined);
		const digest = await prepared();
		const saved = ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"));
		const request = ownerFileSnapshot(join(fixture.options.stateDir, "capability-request.json"));
		const before = facts();
		const config = ownerFileSnapshot(fixture.options.configPath);
		const key = ownerFileSnapshot(join(fixture.options.keysDir, "device.key"));
		receiver.mockClear();
		fixture.calls = [];
		fixture.options.capability = capability;
		// Act: direct core callers must not burn a reviewed attempt on malformed admission text.
		await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
			code: "review_required",
		});
		// Assert: GET pin refresh may occur, but no start marker, receiver or POST can occur.
		expect(fixture.calls.map((call) => call.path)).toEqual(["/v1/auth/owner-config"]);
		expect(receiver).not.toHaveBeenCalled();
		expect(fixture.options.onBrowserStart).not.toHaveBeenCalled();
		expect(fs.readdirSync(fixture.options.stateDir).sort()).toEqual([
			"capability-request.json",
			"prepared.json",
		]);
		expect(ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"))).toEqual(saved);
		expect(ownerFileSnapshot(join(fixture.options.stateDir, "capability-request.json"))).toEqual(
			request,
		);
		expect(facts()).toEqual(before);
		expect(ownerFileSnapshot(fixture.options.configPath)).toEqual(config);
		expect(ownerFileSnapshot(join(fixture.options.keysDir, "device.key"))).toEqual(key);
		// Act: a corrected format, including the 512-character edge, resumes the same attempt.
		fixture.options.capability = "x".repeat(512);
		const result = await enrollOwnerProfile(fixture.options);
		// Assert: semantic capability verification remains the mocked server's responsibility.
		expect(result.kind).toBe("adopted");
		expect(receiver).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ attemptId: read("prepared.json").start.attemptId }),
		);
		expect(read("prepared.json").reviewDigest).toBe(digest);
		expect(ownerFileSnapshot(join(fixture.options.stateDir, "prepared.json"))).toEqual(saved);
		expect(ownerFileSnapshot(join(fixture.options.stateDir, "capability-request.json"))).toEqual(
			request,
		);
		expect(facts()).toEqual(before);
	},
);

it("uses an admin-issued capability bound to the exact saved signed start", async () => {
	// Arrange: admit the exact saved signed start.
	await prepared();
	const key = await importOwnerEnrollmentAdmissionKey(new Uint8Array(32).fill(7));
	const start = read("capability-request.json").start;
	fixture.options.capability = await issueOwnerEnrollmentAdmission(key, pin, start, {
		nowMs: Date.now(),
		ttlMs: 60000,
	});
	fixture.options.fetch = async (input, init) => {
		if (new URL(String(input)).pathname === "/v1/auth/owner-attempts") {
			const body = JSON.parse(String(init?.body));
			const token = new Headers(init?.headers).get("Authorization")?.slice("Bearer ".length);
			// Assert: the server accepts only the exact admitted device tuple.
			expect(await verifyOwnerEnrollmentAdmission(key, token, pin, body, Date.now())).toBe(true);
			expect(
				await verifyOwnerEnrollmentAdmission(
					key,
					token,
					pin,
					{ ...body, deviceId: "another-device" },
					Date.now(),
				),
			).toBe(false);
		}
		return fakeFetch(input, init);
	};
	// Act: send the admitted ceremony through the validating mock server.
	await enrollOwnerProfile(fixture.options);
});
it("canonicalizes only the signed wire key and preserves differing public-key comments", async () => {
	// Arrange: stored and file public-key comments intentionally differ.
	const stored = `${fixture.publicKey} stored-device-comment`;
	const file = `${fixture.publicKey} existing-file-comment\n`;
	fixture.db
		.prepare("UPDATE sync_device SET public_key = ?, fingerprint = ?")
		.run(stored, fingerprintPublicKey(stored));
	writeFileSync(join(fixture.options.keysDir, "device.key.pub"), file);
	const privateKey = readFileSync(join(fixture.options.keysDir, "device.key"));
	// Act: prepare the canonical wire key and adopt with its admission.
	await prepared();
	const start = read("capability-request.json").start;
	expect(start.publicKey).toBe(fixture.publicKey);
	const key = await importOwnerEnrollmentAdmissionKey(new Uint8Array(32).fill(8));
	fixture.options.capability = await issueOwnerEnrollmentAdmission(key, pin, start, {
		nowMs: Date.now(),
		ttlMs: 60000,
	});
	await enrollOwnerProfile(fixture.options);
	// Assert: local key files and the stored public key retain their original representations.
	expect(readFileSync(join(fixture.options.keysDir, "device.key"))).toEqual(privateKey);
	expect(readFileSync(join(fixture.options.keysDir, "device.key.pub"), "utf8")).toBe(file);
	expect(fixture.db.prepare("SELECT public_key FROM sync_device").pluck().get()).toBe(stored);
	expect(
		fixture.db.prepare("SELECT public_key FROM memory_local_capture_adoption").pluck().get(),
	).toBe(stored);
});
it.each(["key", "actor", "device"])(
	"rechecks the %s after browser delivery before retaining/sending a final",
	async (conflict) => {
		// Arrange: the browser callback changes one reviewed profile fact.
		await prepared();
		fixture.options.onBrowserStart = async () => {
			await browser();
			if (conflict === "key") rotateKey();
			if (conflict === "actor") vi.stubEnv("CODEMEM_ACTOR_ID", "runtime-actor");
			if (conflict === "device")
				fixture.db.prepare("UPDATE sync_device SET device_id = 'another-device'").run();
		};
		// Act: refuse finalization after delivery reveals drift.
		await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
		// Assert: no signed final or identity assignment survives.
		expect(fixture.finalBodies).toEqual([]);
		expect(existsSync(join(fixture.options.stateDir, "final.json"))).toBe(false);
		expect(fixture.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
	},
);

it("refuses to materialize an existing remote Identity or ambiguous target authorship", async () => {
	// Arrange: target authorship appears between finalization and local adoption.
	await prepared();
	fixture.options.fetch = async (input, init) => {
		const response = await fakeFetch(input, init);
		if (new URL(String(input)).pathname.endsWith("/finalize"))
			insertMemory({ actorId: "identity", entityId: "imported-target" });
		return response;
	};
	// Act: refuse the ambiguous target identity.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	// Assert: neither assignment nor local actor authority changes.
	expect(fixture.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
	expect(
		fixture.db.prepare("SELECT is_local FROM actors WHERE actor_id = 'local:local'").pluck().get(),
	).toBe(1);
});

it("prepares read-only, then keeps key/device/authorship/history and unrelated config unchanged", async () => {
	// Arrange: only the imported row has a recorded foreign revision.
	const before = facts();
	const key = readFileSync(join(fixture.options.keysDir, "device.key"));
	expect(before.foreignRevisions).toHaveLength(1);
	const imported = fixture.db
		.prepare("SELECT * FROM memory_items WHERE actor_id = 'foreign'")
		.all();
	// Act: adopt the clean locally authored capture, not the imported row.
	await prepared();
	expect(facts()).toEqual(before);
	// Assert: imported rows remain physically unchanged and receive no identity assignment.
	expect(fixture.db.prepare("SELECT * FROM memory_items WHERE actor_id = 'foreign'").all()).toEqual(
		imported,
	);
	expect(
		fixture.db.prepare("SELECT * FROM identity_devices WHERE identity_id = 'foreign'").all(),
	).toEqual([]);
	expect(fixture.db.prepare("SELECT * FROM actors WHERE actor_id = 'foreign'").all()).toEqual([]);
	expect(fixture.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
	expect(await enrollOwnerProfile(fixture.options)).toEqual({
		kind: "adopted",
		identityId: "identity",
		bindingId: "binding",
		groups: ["group"],
	});
	expect(facts()).toEqual(before);
	expect(readFileSync(join(fixture.options.keysDir, "device.key"))).toEqual(key);
	expect(fixture.db.prepare("SELECT device_id FROM sync_device").pluck().get()).toBe("device");
	expect(
		fixture.db
			.prepare("SELECT merged_into_actor_id FROM actors WHERE actor_id = 'local:local'")
			.pluck()
			.get(),
	).toBeNull();
	expect(JSON.parse(readFileSync(fixture.options.configPath, "utf8"))).toMatchObject({
		actor_id: "identity",
		unrelated: { nested: [1, { keep: true }] },
	});
	expect(fixture.calls.filter((c) => c.authorization !== null)).toEqual([
		{ path: "/v1/auth/owner-attempts", authorization: "Bearer explicit-admin-capability" },
	]);
});

it("stops when the key or reviewed database changes before resume", async () => {
	// Arrange: change the reviewed local capture after preparation.
	await prepared();
	fixture.calls = [];
	fixture.db
		.prepare(
			"UPDATE memory_items SET body_text = 'competing writer' WHERE actor_id = 'local:local'",
		)
		.run();
	// Act: refuse review drift and then additional key drift.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	expect(fixture.calls).toEqual([]);
	rotateKey();
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	// Assert: neither refusal contacts the coordinator.
	expect(fixture.calls).toEqual([]);
});
it("requires exact reviewed digest and never sends an unadmitted start", async () => {
	// Arrange: first corrupt the reviewed digest, then omit admission.
	await prepared();
	fixture.calls = [];
	fixture.options.reviewedDigest = "wrong";
	// Act: both resume variants must refuse.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	expect(fixture.calls).toEqual([]);
	fixture.options.reviewedDigest = read("prepared.json").reviewDigest;
	fixture.options.capability = undefined;
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();
	// Assert: admission refusal can refresh the pin but never sends a start.
	expect(fixture.calls.map((c) => c.path)).toEqual(["/v1/auth/owner-config"]);
});

it("verifies a newly signed start before publishing admission files", async () => {
	// Arrange: simulate a signer returning bytes that do not match the wire public key.
	signing.corrupt = true;
	const before = facts();

	// Act: prepare must verify its own signature before handing a request to an operator.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toThrow();

	// Assert: neither saved review nor admission request advertises an invalid signature.
	expect(existsSync(join(fixture.options.stateDir, "prepared.json"))).toBe(false);
	expect(existsSync(join(fixture.options.stateDir, "capability-request.json"))).toBe(false);
	expect(facts()).toEqual(before);
	expect(fixture.calls.map((call) => call.path)).toEqual(["/v1/auth/owner-config"]);
});
