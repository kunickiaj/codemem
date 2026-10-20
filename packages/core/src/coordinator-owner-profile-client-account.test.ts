import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, get } from "node:http";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import { expect, it, vi } from "vitest";
import * as receiver from "./coordinator-account-link-receiver.js";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import {
	ownerEnrollmentFinalMessage,
	verifyOwnerEnrollmentSignature,
} from "./coordinator-owner-enrollment-proof.js";
import {
	enrollOwnerProfile,
	type OwnerProfileClientOptions,
} from "./coordinator-owner-profile-client.js";
import {
	facts,
	fixture,
	pin,
	prepared,
	read,
	registerOwnerProfileClientMockState,
} from "./coordinator-owner-profile-client-test-harness.js";
import * as configWriter from "./observer-config.js";
import { ownerEnrollmentHash } from "./owner-enrollment-start.js";

registerOwnerProfileClientMockState({ signing: { corrupt: false }, databaseOpens: [] });
const completionSecret = Buffer.alloc(32, 4).toString("base64url");
const confirmationHash = "a".repeat(64);
const stateBytes = (name: string) => readFileSync(join(fixture.options.stateDir, name));

async function accountPrepared(): Promise<void> {
	await prepared();
	fixture.options.admissionMode = "account";
	fixture.options.capability = undefined;
	fixture.calls = [];
}

function deliver(start: {
	loopbackRedirect: string;
	attemptId: string;
}): Promise<number | undefined> {
	const url = new URL(start.loopbackRedirect);
	url.search = new URLSearchParams({
		attempt_id: start.attemptId,
		completion: completionSecret,
		confirmation: confirmationHash,
	}).toString();
	return new Promise((resolve, reject) => {
		const request = get(url, (response) => {
			response.resume();
			response.once("end", () => resolve(response.statusCode));
		});
		request.once("error", reject);
	});
}

function accountBrowser() {
	return vi.fn(
		async (
			url: string,
			metadata?: { requestFile: string; deviceId: string; fingerprint: string },
		) => {
			const start = read("prepared.json").start;
			expect(url).toBe(`${pin.origin}/auth/owner/admit`);
			expect(new URL(url).search).toBe("");
			expect(new URL(url).hash).toBe("");
			expect(metadata).toEqual({
				requestFile: join(fixture.options.stateDir, "capability-request.json"),
				deviceId: start.deviceId,
				fingerprint: await ownerEnrollmentHash(start.publicKey),
			});
			expect(JSON.stringify(metadata)).not.toContain(start.browserStartCode);
			expect(read("capability-request.json")).toEqual({ start });
			expect(read("start-attempted.json")).toEqual({ attemptId: start.attemptId });
			// A real callback succeeds inside the hook only if the reviewed port is already bound.
			expect(await deliver(start)).toBe(200);
		},
	);
}

it("binds the reviewed receiver and persists the marker before fixed account handoff, then signs the exact final", async () => {
	// Arrange: the account browser replaces the operator-only fixture browser.
	await accountPrepared();
	const before = facts();
	const key = readFileSync(join(fixture.options.keysDir, "device.key"));
	const start = read("prepared.json").start;
	const browser = accountBrowser();
	fixture.options.onBrowserStart = browser;
	// Act: complete through real loopback delivery, with all coordinator transport mocked.
	const result = await enrollOwnerProfile(fixture.options);
	// Assert: neither operator admission nor bearer credentials participate.
	expect(result).toEqual({
		kind: "adopted",
		identityId: "identity",
		bindingId: "binding",
		groups: ["group"],
	});
	expect(browser).toHaveBeenCalledOnce();
	expect(fixture.calls).toEqual([
		{ path: "/v1/auth/owner-config", authorization: null },
		{ path: "/v1/auth/owner-attempts/finalize", authorization: null },
	]);
	const final = read("final.json");
	const body = JSON.parse(final.body);
	expect(body).toEqual({
		attemptId: start.attemptId,
		completionSecret,
		signature: expect.any(String),
	});
	expect(final.confirmationHash).toBe(confirmationHash);
	const message = ownerEnrollmentFinalMessage(
		{
			coordinator_id: pin.coordinatorId,
			origin: pin.origin,
			auth_config_revision: pin.revision,
			issuer: pin.issuer,
			attempt_id: start.attemptId,
			device_id: start.deviceId,
			public_key: start.publicKey,
			key_id: await ed25519KeyId(start.publicKey),
			fingerprint: await ownerEnrollmentHash(start.publicKey),
			confirmation_hash: confirmationHash,
		},
		completionSecret,
	);
	expect(await verifyOwnerEnrollmentSignature(start.publicKey, message, body.signature)).toBe(true);
	expect(
		await verifyOwnerEnrollmentSignature(start.publicKey, `${message}changed`, body.signature),
	).toBe(false);
	expect(fixture.finalBodies).toEqual([final.body]);
	expect(facts()).toEqual(before);
	expect(readFileSync(join(fixture.options.keysDir, "device.key"))).toEqual(key);
	const reopened = new Sqlite(fixture.options.dbPath, { readonly: true });
	try {
		expect(reopened.prepare("SELECT identity_id FROM identity_devices").pluck().get()).toBe(
			"identity",
		);
		expect(reopened.prepare("SELECT * FROM memory_items").all()).toEqual(before.memories);
	} finally {
		reopened.close();
	}
});

it.each([null, "", "ACCOUNT", "unknown", false, 1])(
	"rejects unknown admission selector %j before discovery or browser delivery",
	async (mode) => {
		// Arrange: even untyped API callers cannot select an implicit alternate path.
		const browser = vi.fn();
		const before = facts();
		// Act: pass an invalid runtime selector without weakening the public option type.
		await expect(
			enrollOwnerProfile({
				...fixture.options,
				admissionMode: mode as OwnerProfileClientOptions["admissionMode"],
				onBrowserStart: browser,
			}),
		).rejects.toMatchObject({ code: "review_required" });
		// Assert: refusal creates no request and changes no profile state.
		expect(fixture.calls).toEqual([]);
		expect(browser).not.toHaveBeenCalled();
		expect(existsSync(fixture.options.stateDir)).toBe(false);
		expect(facts()).toEqual(before);
	},
);

it.each(["", "explicit-admin-capability"])(
	"rejects mixed account/capability admission, including empty capability (%j)",
	async (capability) => {
		// Arrange: retain an otherwise valid, reusable review.
		await accountPrepared();
		const saved = stateBytes("prepared.json");
		const browser = vi.fn();
		// Act: combining admission modes must fail before refreshing coordinator pins.
		await expect(
			enrollOwnerProfile({ ...fixture.options, capability, onBrowserStart: browser }),
		).rejects.toMatchObject({ code: "review_required" });
		// Assert: no consumed-start marker or external action occurs.
		expect(fixture.calls).toEqual([]);
		expect(browser).not.toHaveBeenCalled();
		expect(stateBytes("prepared.json")).toEqual(saved);
		expect(existsSync(join(fixture.options.stateDir, "start-attempted.json"))).toBe(false);
	},
);

it("opens nothing when the reviewed loopback port cannot bind, and permits corrected resume", async () => {
	// Arrange: occupy the exact reviewed port after prepare released it.
	await accountPrepared();
	const blocker = createServer();
	const port = Number(new URL(read("prepared.json").start.loopbackRedirect).port);
	await new Promise<void>((resolve, reject) => {
		blocker.once("error", reject);
		blocker.listen(port, "127.0.0.1", resolve);
	});
	const browser = accountBrowser();
	fixture.options.onBrowserStart = browser;
	// Act: binding failure must precede browser opening and start consumption.
	try {
		await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
			code: "review_required",
		});
		// Assert: no marker, final or browser notification exists.
		expect(browser).not.toHaveBeenCalled();
		expect(existsSync(join(fixture.options.stateDir, "start-attempted.json"))).toBe(false);
		expect(fixture.finalBodies).toEqual([]);
	} finally {
		await new Promise<void>((resolve, reject) =>
			blocker.close((error) => (error ? reject(error) : resolve())),
		);
	}
	// Act: releasing the port makes the same reviewed request usable.
	const result = await enrollOwnerProfile(fixture.options);
	// Assert: successful handoff still happens only once.
	expect(result.kind).toBe("adopted");
	expect(browser).toHaveBeenCalledOnce();
});

it.each(["cancel", "timeout", "browser failure"])(
	"never finalizes or reports success after account %s",
	async (failure) => {
		// Arrange: trigger cancellation/deadline deterministically without elapsed-time waits.
		await accountPrepared();
		const before = facts();
		const config = readFileSync(fixture.options.configPath);
		const controller = new AbortController();
		const deadline = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
		fixture.options.signal = controller.signal;
		fixture.options.onBrowserStart = vi.fn(() => {
			if (failure === "browser failure") throw new Error("private-browser-code");
			if (failure === "timeout") deadline.abort();
			else controller.abort();
		});
		// Act: no loopback confirmation can complete this account ceremony.
		await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
			code: "fresh_prepare_required",
		});
		// Assert: a caller signal cannot remove the ten-minute deadline or produce a final.
		expect(timeout).toHaveBeenCalledWith(600000);
		expect(fixture.options.onBrowserStart).toHaveBeenCalledOnce();
		expect(fixture.finalBodies).toEqual([]);
		expect(existsSync(join(fixture.options.stateDir, "final.json"))).toBe(false);
		expect(facts()).toEqual(before);
		expect(readFileSync(fixture.options.configPath)).toEqual(config);
		expect(fixture.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
		fixture.calls = [];
		// Act: a consumed-start marker requires a fresh review, not silent browser replay.
		await expect(
			enrollOwnerProfile({ ...fixture.options, signal: undefined }),
		).rejects.toMatchObject({ code: "fresh_prepare_required" });
		// Assert: retries stop before transport or reopening the browser.
		expect(fixture.calls).toEqual([]);
		expect(fixture.options.onBrowserStart).toHaveBeenCalledOnce();
	},
);

it("retains the account final byte-for-byte across transport failure and retries without browser or operator start", async () => {
	// Arrange: the coordinator may have committed, but the final response is lost.
	await accountPrepared();
	fixture.options.onBrowserStart = accountBrowser();
	fixture.failFinal = true;
	const before = facts();
	const request = stateBytes("capability-request.json");
	// Act: complete the callback but fail final transport.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
		code: "retained_request_incomplete",
	});
	// Assert: a signed final survives without local adoption.
	const final = stateBytes("final.json");
	expect(fixture.finalBodies).toHaveLength(1);
	expect(fixture.db.prepare("SELECT COUNT(*) FROM identity_devices").pluck().get()).toBe(0);
	fixture.failFinal = false;
	fixture.calls = [];
	fixture.options.onBrowserStart = undefined;
	const bind = vi.spyOn(receiver, "createCoordinatorOwnerEnrollmentReceiver");
	// Act: a new client invocation retries only the retained final.
	const result = await enrollOwnerProfile(fixture.options);
	// Assert: final bytes, signature, request and profile content stay unchanged.
	expect(result.kind).toBe("adopted");
	expect(bind).not.toHaveBeenCalled();
	expect(fixture.finalBodies).toEqual([read("final.json").body, read("final.json").body]);
	expect(fixture.calls.map((call) => call.path)).toEqual([
		"/v1/auth/owner-config",
		"/v1/auth/owner-attempts/finalize",
	]);
	expect(stateBytes("final.json")).toEqual(final);
	expect(stateBytes("capability-request.json")).toEqual(request);
	expect(facts()).toEqual(before);
});

it("uses a retained account receipt offline after config failure, then reopens without rewriting history", async () => {
	// Arrange: metadata commits but the config writer fails after the receipt is retained.
	await accountPrepared();
	fixture.options.onBrowserStart = accountBrowser();
	const before = facts();
	const writer = vi.spyOn(configWriter, "atomicReplaceConfigFile").mockImplementationOnce(() => {
		throw new Error("config unavailable");
	});
	// Act: preserve truthful partial completion rather than pretending config succeeded.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
		code: "retained_request_incomplete",
	});
	// Assert: the receipt and assignment exist even though config is still local.
	expect(JSON.parse(readFileSync(fixture.options.configPath, "utf8")).actor_id).toBe("local:local");
	const receipt = stateBytes("receipt.json");
	const final = stateBytes("final.json");
	const assignment = fixture.db.prepare("SELECT * FROM identity_devices").all();
	expect(assignment).toHaveLength(1);
	writer.mockRestore();
	const offline = vi.fn().mockRejectedValue(new Error("network forbidden"));
	fixture.options.fetch = offline;
	fixture.options.onBrowserStart = vi.fn();
	// Act: resume config-only adoption, then repeat from the already adopted profile.
	expect((await enrollOwnerProfile(fixture.options)).kind).toBe("adopted");
	expect((await enrollOwnerProfile(fixture.options)).kind).toBe("adopted");
	// Assert: no discovery, browser, new final or duplicate assignment is needed.
	expect(offline).not.toHaveBeenCalled();
	expect(fixture.options.onBrowserStart).not.toHaveBeenCalled();
	expect(stateBytes("receipt.json")).toEqual(receipt);
	expect(stateBytes("final.json")).toEqual(final);
	expect(facts()).toEqual(before);
	const reopened = new Sqlite(fixture.options.dbPath, { readonly: true });
	try {
		expect(reopened.prepare("SELECT * FROM identity_devices").all()).toEqual(assignment);
		expect(reopened.prepare("SELECT * FROM replication_ops").all()).toEqual(before.history);
	} finally {
		reopened.close();
	}
});

it("rejects a changed private upload before opening account admission", async () => {
	// Arrange: the reviewed request file no longer contains the exact signed start.
	await accountPrepared();
	const browser = accountBrowser();
	fixture.options.onBrowserStart = browser;
	writeFileSync(
		join(fixture.options.stateDir, "capability-request.json"),
		JSON.stringify({ start: { ...read("prepared.json").start, deviceId: "other-device" } }),
	);
	// Act: refuse to direct the user to upload an unreviewed request.
	await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
		code: "fresh_prepare_required",
	});
	// Assert: no browser handoff, operator start or final escapes.
	expect(browser).not.toHaveBeenCalled();
	expect(fixture.calls.map((call) => call.path)).toEqual(["/v1/auth/owner-config"]);
	expect(fixture.finalBodies).toEqual([]);
});

it.each(["final", "receipt"])(
	"refuses tampered retained account %s without replaying browser admission",
	async (artifact) => {
		// Arrange: retain a valid signed final and receipt, but interrupt config publication.
		await accountPrepared();
		fixture.options.onBrowserStart = accountBrowser();
		const writer = vi.spyOn(configWriter, "atomicReplaceConfigFile").mockImplementationOnce(() => {
			throw new Error("config unavailable");
		});
		await expect(enrollOwnerProfile(fixture.options)).rejects.toMatchObject({
			code: "retained_request_incomplete",
		});
		writer.mockRestore();
		const before = facts();
		const config = readFileSync(fixture.options.configPath);
		const saved = read(`${artifact}.json`);
		if (artifact === "final") {
			saved.body = JSON.stringify({
				...JSON.parse(saved.body),
				completionSecret: Buffer.alloc(32, 9).toString("base64url"),
			});
		} else saved.keyId = "different-key";
		writeFileSync(join(fixture.options.stateDir, `${artifact}.json`), JSON.stringify(saved));
		const offline = vi.fn().mockRejectedValue(new Error("network forbidden"));
		const browser = vi.fn();
		// Act: offline config adoption still authenticates the retained artifacts.
		await expect(
			enrollOwnerProfile({ ...fixture.options, fetch: offline, onBrowserStart: browser }),
		).rejects.toMatchObject({ code: "retained_request_incomplete" });
		// Assert: do not overwrite config or try to replace an already consumed ceremony.
		expect(offline).not.toHaveBeenCalled();
		expect(browser).not.toHaveBeenCalled();
		expect(readFileSync(fixture.options.configPath)).toEqual(config);
		expect(facts()).toEqual(before);
	},
);

it("refuses an already cancelled account resume before opening the browser or consuming the start", async () => {
	// Arrange: cancellation precedes the resume invocation, rather than browser confirmation.
	await accountPrepared();
	const controller = new AbortController();
	controller.abort();
	const browser = accountBrowser();
	// Act: cancellation cannot produce a false success or consume a reusable review.
	await expect(
		enrollOwnerProfile({ ...fixture.options, signal: controller.signal, onBrowserStart: browser }),
	).rejects.toMatchObject({ code: "review_required" });
	// Assert: no coordinator request, browser or start marker exists.
	expect(fixture.calls).toEqual([]);
	expect(browser).not.toHaveBeenCalled();
	expect(existsSync(join(fixture.options.stateDir, "start-attempted.json"))).toBe(false);
	expect(fixture.finalBodies).toEqual([]);
});
