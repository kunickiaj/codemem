import {
	closeSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import { oidcFixture, PROVIDER } from "./coordinator-oidc-test-fixtures.js";
import { runOwnerEnrollment } from "./coordinator-owner-enrollment-client.js";
import { createCoordinatorOwnerEnrollmentHttp } from "./coordinator-owner-enrollment-http.js";
import {
	config,
	ORIGIN,
	ownerStartFixture,
	seedOwnerCallbackAuthority,
} from "./coordinator-owner-enrollment-start-test-fixtures.js";
import { connect } from "./db.js";
import * as observerConfig from "./observer-config.js";
import { MemoryStore } from "./store.js";

// Keep real filesystem publication except at the selected crash boundary.
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return { ...fs, linkSync: vi.fn(fs.linkSync), unlinkSync: vi.fn(fs.unlinkSync) };
});
const realLink = (await vi.importActual<typeof import("node:fs")>("node:fs")).linkSync;
const realUnlink = (await vi.importActual<typeof import("node:fs")>("node:fs")).unlinkSync;
const deadPid = 2147483647;
const tempName = (name: string, pid = deadPid) =>
	`${name}.tmp-${pid}-00000000-0000-4000-8000-000000000000`;
function assertDeadPid() {
	expect(() => process.kill(deadPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

let directory: string;
let profileDir: string;
let f: ReturnType<typeof ownerStartFixture>;
beforeEach(() => {
	vi.mocked(linkSync).mockImplementation(realLink);
	vi.mocked(unlinkSync).mockImplementation(realUnlink);
	directory = mkdtempSync(join(tmpdir(), "owner-client-test-"));
	profileDir = join(directory, "profile");
	f = ownerStartFixture();
	seedOwnerCallbackAuthority(f);
	vi.stubEnv("CODEMEM_CONFIG", join(profileDir, "config.json"));
	vi.stubEnv("CODEMEM_ACTOR_ID", undefined);
	vi.stubEnv("CODEMEM_DEVICE_ID", undefined);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live network forbidden"));
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		f.close();
		rmSync(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	}
});
const read = (name: string) => readFileSync(join(profileDir, name), "utf8");
const fields = (html: string) =>
	Object.fromEntries(
		[...html.matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]),
	);

function interruptPublication(name: string, publish?: () => void) {
	vi.mocked(linkSync).mockImplementation((temp, canonical) => {
		if (canonical === join(profileDir, name)) {
			publish?.();
			if (!publish) throw new Error("interrupted publication");
		}
		return realLink(temp, canonical);
	});
}

function interruptOwnedConfigRelease(finals: readonly string[]) {
	const control = { initializerReleased: false, interruptedPilot: false };
	vi.mocked(unlinkSync).mockImplementation((path) => {
		if (
			!String(path).endsWith("/config.json.lock") ||
			!existsSync(path) ||
			realpathSync(path) !== realpathSync(join(profileDir, "config.json.lock"))
		)
			return realUnlink(path);
		const text = readFileSync(path, "utf8");
		if (text === "") {
			realUnlink(path);
			control.initializerReleased = true;
			return;
		}
		const record = JSON.parse(text);
		if (record.purpose !== "owner-pilot-config-v1") return realUnlink(path);
		const receipt = JSON.parse(read("owner-receipt.json"));
		expect(record.bindingId).toBe(receipt.bindingId);
		expect(finals).toHaveLength(1);
		const db = connect(join(profileDir, "mem.sqlite"));
		try {
			expect(
				db
					.prepare("SELECT identity_id FROM identity_devices WHERE device_id=?")
					.get(record.deviceId),
			).toEqual({ identity_id: receipt.identityId });
		} finally {
			db.close();
		}
		control.interruptedPilot = true;
		throw new Error("interrupted owned lock release");
	});
	return control;
}

// Only the client-owned loopback socket is real. Coordinator/provider use injected fakes.
function deliver(url: string): Promise<number | undefined> {
	const target = new URL(url);
	expect(target.hostname).toBe("127.0.0.1");
	expect(target.protocol).toBe("http:");
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			target,
			{ headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } },
			(response) => {
				response.resume();
				response.on("end", () => resolve(response.statusCode));
			},
		);
		request.on("error", reject);
		request.end();
	});
}
async function corruptReceipt(result: Response, fault: string) {
	const value = await result.json();
	if (fault === "identity") delete value.identityId;
	if (fault === "group") value.groups = ["other-group"];
	if (fault === "duplicate") value.groups.push(value.groups[0]);
	return Response.json(value);
}
async function fixture() {
	const provider = oidcFixture({ issuer: config.issuer });
	const compose = (revision = config.revision) =>
		createCoordinatorOwnerEnrollmentHttp({
			config: {
				...config,
				revision,
				clientId: PROVIDER.clientId,
				clientSecret: PROVIDER.clientSecret,
			},
			backend: f.backend,
			oidcOptions: { fetch: provider.fetch },
			clock: () => NOW,
		});
	let http = await compose();
	const finals: string[] = [];
	let loseReply = false;
	let receiptFault = "";
	const fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
		const request = new Request(input, init);
		expect(new URL(request.url).origin).toBe(ORIGIN);
		expect(init?.redirect).toBe("error");
		const final = new URL(request.url).pathname.endsWith("/finalize");
		if (final) {
			const body = await request.clone().text();
			finals.push(body);
			expect(JSON.parse(read("owner-finalize.json")).body).toBe(body);
			expect(statSync(join(profileDir, "owner-finalize.json")).mode & 0o777).toBe(0o600);
		}
		const result = await http.handle(request, "client-socket");
		if (final && loseReply) {
			loseReply = false;
			throw new Error("lost final reply");
		}
		if (final && receiptFault) {
			return corruptReceipt(result, receiptFault);
		}
		return result;
	});
	const openBrowser = vi.fn(async (url: string) => {
		const page = await http.handle(new Request(url), "browser-socket");
		const cookie = page.headers.getSetCookie()[0]?.split(";")[0] ?? "";
		const claimed = await http.handle(
			new Request(`${ORIGIN}/auth/owner/start`, {
				method: "POST",
				headers: { origin: ORIGIN, cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(fields(await page.text())),
			}),
			"browser-socket",
		);
		expect(claimed.status).toBe(303);
		const transaction = claimed.headers.getSetCookie()[0]?.split(";")[0] ?? "";
		const callback = await http.handle(
			new Request(provider.authorize(claimed.headers.get("location") ?? ""), {
				headers: { cookie: transaction },
			}),
			"browser-socket",
		);
		expect(callback.status).toBe(200);
		const confirmed = await http.handle(
			new Request(`${ORIGIN}/auth/owner/confirm`, {
				method: "POST",
				headers: {
					origin: ORIGIN,
					cookie: transaction,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams(fields(await callback.text())),
			}),
			"browser-socket",
		);
		expect(confirmed.status).toBe(303);
		expect(await deliver(confirmed.headers.get("location") ?? "")).toBe(200);
	});
	return {
		options: { profileDir, coordinatorUrl: ORIGIN, groupId: "group-a", fetch, openBrowser },
		finals,
		rotateRevision: async (revision: string) => {
			http = await compose(revision);
		},
		setReceiptFault: (fault: string) => {
			receiptFault = fault;
		},
		loseReply: () => {
			loseReply = true;
		},
	};
}

it.each(["success", "lost-final", "config-write", "config-write-rotated"])(
	"adopts receipt identity and preserves key through reopen and %s retry",
	async (mode) => {
		// Arrange: no A link result or coordinator row supplies the adoption identity.
		const c = await fixture();
		const configFailure = mode.startsWith("config-write");
		if (mode === "lost-final") c.loseReply();
		if (configFailure) {
			const replaceConfig = observerConfig.atomicReplaceConfigFile;
			let failed = false;
			vi.spyOn(observerConfig, "atomicReplaceConfigFile").mockImplementation(
				(path, text, ...options) => {
					if (
						!failed &&
						existsSync(join(profileDir, "owner-receipt.json")) &&
						JSON.parse(text).actor_id === JSON.parse(read("owner-receipt.json")).identityId
					) {
						failed = true;
						throw new Error("post-receipt config write failed");
					}
					return replaceConfig(path, text, ...options);
				},
			);
		}
		// Act
		if (mode === "success") await runOwnerEnrollment(c.options);
		else await expect(runOwnerEnrollment(c.options)).rejects.toThrow("Owner pilot incomplete");
		const key = read("keys/device.key");
		const retained = read("owner-finalize.json");
		let binding: unknown;
		const originalReceipt = configFailure ? read("owner-receipt.json") : "";
		const authority = f.snapshot();
		if (configFailure) {
			assertDeadPid();
			writeFileSync(join(profileDir, tempName("config.json")), "partial config", { mode: 0o600 });
			const store = new MemoryStore(join(profileDir, "mem.sqlite"), {
				keysDir: join(profileDir, "keys"),
			});
			try {
				const receipt = JSON.parse(read("owner-receipt.json"));
				binding = store.db.prepare("SELECT * FROM identity_devices").all();
				expect(binding).toEqual([
					expect.objectContaining({
						identity_id: receipt.identityId,
						source_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
					}),
				]);
				expect(
					store.db
						.prepare("SELECT actor_id, display_name, is_local, status FROM actors WHERE actor_id=?")
						.get(receipt.identityId),
				).toEqual({
					actor_id: receipt.identityId,
					display_name: "Owner pilot device",
					is_local: 1,
					status: "active",
				});
				expect(JSON.parse(read("config.json")).actor_id).not.toBe(receipt.identityId);
				expect(f.rows("coordinator_device_ownership_bindings")).toHaveLength(1);
				expect(JSON.parse(retained).body).toBe(c.finals[0]);
			} finally {
				store.close();
			}
		}
		if (mode === "config-write-rotated") {
			// Recreate the actual HTTP factory; only public revision changes, not retained proof pins.
			const saved = JSON.parse(retained);
			const revision = "c".repeat(64);
			await c.rotateRevision(revision);
			const published = await (
				await c.options.fetch(`${ORIGIN}/v1/auth/owner-pilot`, { redirect: "error" })
			).json();
			expect(published).toEqual({ ...saved.pins, revision });
			expect(saved.pins.revision).toBe(config.revision);
			expect(published.revision).not.toBe(saved.pins.revision);
		}
		const openBrowser = vi.fn(() => {
			throw new Error("Resume must not open a replacement ceremony");
		});
		const receipt = await runOwnerEnrollment({ ...c.options, openBrowser, resume: true });
		const store = new MemoryStore(join(profileDir, "mem.sqlite"), {
			keysDir: join(profileDir, "keys"),
		});
		// Assert: DB/config use only receipt identity, retained wire body and key remain byte-identical.
		try {
			expect(store.actorId).toBe(receipt.identityId);
			expect(
				store.db
					.prepare("SELECT identity_id FROM identity_devices WHERE device_id=?")
					.get(store.deviceId),
			).toEqual({ identity_id: receipt.identityId });
			expect(JSON.parse(read("config.json"))).toMatchObject({
				actor_id: receipt.identityId,
				actor_display_name: "Owner pilot device",
				sync_device_name: "Owner pilot device",
				sync_coordinator_group: "group-a",
				sync_coordinator_url: ORIGIN,
			});
			expect(store.actorDisplayName).toBe("Owner pilot device");
			expect(receipt).toMatchObject({
				kind: "prior_commit",
				identityId: "identity-a",
				groups: ["group-a", "group-b"],
			});
			expect(read("keys/device.key")).toBe(key);
			expect(read("owner-finalize.json")).toBe(retained);
			if (configFailure) {
				expect(store.db.prepare("SELECT * FROM identity_devices").all()).toEqual(binding);
				expect(read("owner-receipt.json")).toBe(originalReceipt);
				expect(receipt).toEqual({ ...JSON.parse(originalReceipt), kind: "prior_commit" });
				expect(existsSync(join(profileDir, tempName("config.json")))).toBe(false);
			}
			expect(f.snapshot()).toEqual(authority);
			expect(c.finals).toEqual([c.finals[0], c.finals[0]]);
			expect(openBrowser).not.toHaveBeenCalled();
			expect(f.rows("coordinator_owner_enrollment_audit_log")).toHaveLength(1);
		} finally {
			store.close();
		}
	},
);

it.each(["populated", "config", "group", "permissions"])(
	"rejects %s profile conflict before resume network and preserves state",
	async (fault) => {
		// Arrange: ambiguous first finalize supplies a genuine retained proof, not invented fixture state.
		const c = await fixture();
		c.loseReply();
		await expect(runOwnerEnrollment(c.options)).rejects.toThrow("Owner pilot incomplete");
		if (fault === "populated") {
			const store = new MemoryStore(join(profileDir, "mem.sqlite"), {
				keysDir: join(profileDir, "keys"),
			});
			try {
				store.startSession({ cwd: "/synthetic/populated" });
			} finally {
				store.close();
			}
		}
		if (fault === "config")
			writeFileSync(
				join(profileDir, "config.json"),
				JSON.stringify({ actor_id: "conflicting-identity" }),
			);
		if (fault === "permissions") {
			const { chmodSync } = await import("node:fs");
			chmodSync(join(profileDir, "owner-finalize.json"), 0o644);
		}
		const key = read("keys/device.key");
		const retained = read("owner-finalize.json");
		const fetch = vi
			.fn<typeof globalThis.fetch>()
			.mockRejectedValue(new Error("preflight must precede network"));
		// Act
		await expect(
			runOwnerEnrollment({
				...c.options,
				resume: true,
				groupId: fault === "group" ? "other-group" : "group-a",
				fetch,
			}),
		).rejects.toThrow("Owner pilot incomplete");
		// Assert
		expect(fetch).not.toHaveBeenCalled();
		expect(read("keys/device.key")).toBe(key);
		expect(read("owner-finalize.json")).toBe(retained);
		if (fault === "config")
			expect(JSON.parse(read("config.json"))).toEqual({ actor_id: "conflicting-identity" });
	},
);

it("refuses an existing ordinary directory without network or overwriting config/key", async () => {
	// Arrange
	writeFileSync(join(directory, "config.json"), '{"actor_id":"existing"}');
	writeFileSync(join(directory, "device.key"), "existing-key");
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	const fetch = vi.fn<typeof globalThis.fetch>();
	// Act
	await expect(
		runOwnerEnrollment({
			profileDir: directory,
			coordinatorUrl: ORIGIN,
			groupId: "group-a",
			openBrowser: vi.fn(),
			fetch,
		}),
	).rejects.toThrow("Owner pilot incomplete");
	// Assert
	expect(fetch).not.toHaveBeenCalled();
	expect(readFileSync(join(directory, "config.json"), "utf8")).toBe('{"actor_id":"existing"}');
	expect(readFileSync(join(directory, "device.key"), "utf8")).toBe("existing-key");
});

it.each(["identity", "group", "duplicate"])(
	"does not adopt an invalid %s receipt",
	async (fault) => {
		// Arrange
		const c = await fixture();
		c.setReceiptFault(fault);
		// Act
		await expect(runOwnerEnrollment(c.options)).rejects.toThrow("Owner pilot incomplete");
		const store = new MemoryStore(join(profileDir, "mem.sqlite"), {
			keysDir: join(profileDir, "keys"),
		});
		// Assert: coordinator commit is not local identity authority without a valid receipt.
		try {
			expect(store.db.prepare("SELECT * FROM identity_devices").all()).toEqual([]);
			expect(store.actorId).not.toBe("identity-a");
			expect(c.finals).toHaveLength(1);
		} finally {
			store.close();
		}
	},
);

it.each(["browser", "committed"])(
	"refuses real key drift at %s without adopting or rewriting config",
	async (stage) => {
		// Arrange: replace the actual public-key file with another genuine synthetic device key.
		const c = await fixture();
		let initialConfig = "";
		const changeKey = () => writeFileSync(join(profileDir, "keys/device.key.pub"), f.key.publicKey);
		const openBrowser = async (
			url: string,
			metadata: { deviceId: string; fingerprint: string },
		) => {
			initialConfig = read("config.json");
			expect(metadata.deviceId).toBe(JSON.parse(initialConfig).actor_id.replace(/^local:/, ""));
			expect(metadata.fingerprint).toMatch(/^[a-f0-9]{64}$/);
			await c.options.openBrowser(url);
			if (stage === "browser") changeKey();
		};
		const fetch: typeof globalThis.fetch = async (input, init) => {
			const response = await c.options.fetch(input, init);
			if (stage === "committed" && new URL(String(input)).pathname.endsWith("/finalize"))
				changeKey();
			return response;
		};
		// Act
		await expect(runOwnerEnrollment({ ...c.options, openBrowser, fetch })).rejects.toThrow(
			"Owner pilot incomplete",
		);
		const db = connect(join(profileDir, "mem.sqlite"));
		// Assert: a remote commit is retained truthfully, but changed local key context authorizes no adoption.
		try {
			expect(db.prepare("SELECT * FROM identity_devices").all()).toEqual([]);
			expect(read("config.json")).toBe(initialConfig);
			expect(read("keys/device.key.pub")).toBe(f.key.publicKey);
			expect(c.finals).toHaveLength(stage === "browser" ? 0 : 1);
			expect(f.rows("coordinator_device_ownership_bindings")).toHaveLength(
				stage === "browser" ? 0 : 1,
			);
			if (stage === "committed") {
				expect(JSON.parse(read("owner-receipt.json"))).toMatchObject({
					kind: "finalized",
					identityId: "identity-a",
					groups: ["group-a", "group-b"],
				});
				expect(JSON.parse(read("owner-finalize.json")).body).toBe(c.finals[0]);
			} else expect(existsSync(join(profileDir, "owner-finalize.json"))).toBe(false);
		} finally {
			db.close();
		}
	},
);

it("retries exact proof after interrupted post-commit receipt publication", async () => {
	// Arrange
	const c = await fixture();
	interruptPublication("owner-receipt.json");
	// Act: server commits, but canonical receipt publication fails.
	await expect(runOwnerEnrollment(c.options)).rejects.toThrow("Owner pilot incomplete");
	const proof = read("owner-finalize.json");
	const key = read("keys/device.key");
	const temp = readdirSync(profileDir).find((name) => name.startsWith("owner-receipt.json.tmp-"));
	expect(temp).toBeDefined();
	expect(existsSync(join(profileDir, "owner-receipt.json"))).toBe(false);
	expect(f.rows("coordinator_device_ownership_bindings")).toHaveLength(1);
	assertDeadPid();
	renameSync(join(profileDir, temp as string), join(profileDir, tempName("owner-receipt.json")));
	vi.mocked(linkSync).mockImplementation(realLink);
	const receipt = await runOwnerEnrollment({
		...c.options,
		resume: true,
		openBrowser: () => {
			throw new Error("no replacement browser");
		},
	});
	// Assert: simulate a new process cleaning only its dead predecessor's complete temp.
	expect(receipt.kind).toBe("prior_commit");
	expect(JSON.parse(read("config.json")).actor_id).toBe(receipt.identityId);
	expect(read("owner-finalize.json")).toBe(proof);
	expect(read("keys/device.key")).toBe(key);
	expect(c.finals).toEqual([c.finals[0], c.finals[0]]);
	expect(existsSync(join(profileDir, tempName("owner-receipt.json")))).toBe(false);
	const db = connect(join(profileDir, "mem.sqlite"));
	try {
		expect(db.prepare("SELECT identity_id FROM identity_devices").get()).toEqual({
			identity_id: receipt.identityId,
		});
	} finally {
		db.close();
	}
});

it("refuses to remove a legacy empty writer lock with no verifiable owner", async () => {
	// Arrange: the generic writer can still leave a real empty lock, but its PID is unknowable.
	const c = await fixture();
	const receipt = await runOwnerEnrollment(c.options);
	observerConfig.mutateCodememConfigFile((data) => data, join(profileDir, "config.json"), {
		lockCleanupOperations: {
			close: closeSync,
			unlink: (lock) => {
				if (lock === join(realpathSync(profileDir), "config.json.lock"))
					throw new Error("interrupted generic lock release");
				realUnlink(lock);
			},
		},
	});
	expect(existsSync(join(profileDir, "config.json.lock"))).toBe(true);
	const proof = read("owner-finalize.json");
	const key = read("keys/device.key");
	const authority = f.snapshot();
	const fetch = vi.fn<typeof globalThis.fetch>();
	// Act
	await expect(runOwnerEnrollment({ ...c.options, resume: true, fetch })).rejects.toThrow(
		"unknown or unverifiable",
	);
	// Assert: refusal preserves authority and every recovery artifact, rather than guessing staleness.
	expect(read("owner-receipt.json")).toBe(JSON.stringify(receipt));
	expect(read("owner-finalize.json")).toBe(proof);
	expect(read("keys/device.key")).toBe(key);
	expect(f.snapshot()).toEqual(authority);
	const db = connect(join(profileDir, "mem.sqlite"));
	try {
		expect(db.prepare("SELECT identity_id FROM identity_devices").get()).toEqual({
			identity_id: receipt.identityId,
		});
	} finally {
		db.close();
	}
	expect(read("config.json.lock")).toBe("");
	expect(statSync(join(profileDir, "config.json.lock")).mode & 0o777).toBe(0o600);
	expect(fetch).not.toHaveBeenCalled();
	expect(c.finals).toHaveLength(1);
});

it("reclaims only a dead owned config lock after verifying its retained proof and receipt", async () => {
	// Arrange: crash the actual pilot writer at release, after the config replacement and DB commit.
	const c = await fixture();
	const control = interruptOwnedConfigRelease(c.finals);
	await expect(runOwnerEnrollment(c.options)).rejects.toThrow("Owner pilot incomplete");
	expect(control).toEqual({ initializerReleased: true, interruptedPilot: true });
	const record = JSON.parse(read("config.json.lock"));
	expect(record).toMatchObject({
		purpose: "owner-pilot-config-v1",
		pid: process.pid,
		bindingId: JSON.parse(read("owner-receipt.json")).bindingId,
	});
	const key = read("keys/device.key");
	const proof = read("owner-finalize.json");
	const receiptBytes = read("owner-receipt.json");
	expect(record).toMatchObject({
		deviceId: JSON.parse(proof).deviceId,
		keyId: JSON.parse(proof).keyId,
	});
	const authority = f.snapshot();
	assertDeadPid();
	writeFileSync(join(profileDir, "config.json.lock"), JSON.stringify({ ...record, pid: deadPid }));
	writeFileSync(join(profileDir, tempName("config.json.lock")), '{"partial":', { mode: 0o600 });
	vi.mocked(unlinkSync).mockImplementation(realUnlink);
	// Act: simulate the recorded process having exited, without changing its binding/key/token.
	const receipt = await runOwnerEnrollment({
		...c.options,
		resume: true,
		openBrowser: () => {
			throw new Error("no replacement ceremony");
		},
	});
	// Assert: exact retry reconciles history and performs only local config recovery.
	expect(receipt.kind).toBe("prior_commit");
	expect(f.snapshot()).toEqual(authority);
	expect(read("owner-receipt.json")).toBe(receiptBytes);
	expect(read("owner-finalize.json")).toBe(proof);
	expect(read("keys/device.key")).toBe(key);
	expect(JSON.parse(read("config.json")).actor_id).toBe(receipt.identityId);
	expect(c.finals).toEqual([c.finals[0], c.finals[0]]);
	expect(existsSync(join(profileDir, "config.json.lock"))).toBe(false);
	expect(existsSync(join(profileDir, tempName("config.json.lock")))).toBe(false);
});

it.each(["live", "malformed", "foreign", "symlink", "unknown", "proof"])(
	"refuses %s canonical config lock without changing recovery state",
	async (fault) => {
		// Arrange: start with the actual writer's typed lock, not invented ownership authority.
		const c = await fixture();
		const control = interruptOwnedConfigRelease(c.finals);
		await expect(runOwnerEnrollment(c.options)).rejects.toThrow("Owner pilot incomplete");
		expect(control).toEqual({ initializerReleased: true, interruptedPilot: true });
		vi.mocked(unlinkSync).mockImplementation(realUnlink);
		const path = join(profileDir, "config.json.lock");
		const record = JSON.parse(read("config.json.lock"));
		assertDeadPid();
		if (fault === "malformed") delete record.keyId;
		if (fault === "foreign") {
			record.pid = deadPid;
			record.bindingId = "foreign-binding";
		}
		if (fault === "unknown") record.pid = Number.MAX_SAFE_INTEGER;
		if (fault === "proof") {
			record.pid = deadPid;
			const saved = JSON.parse(read("owner-finalize.json"));
			saved.body = JSON.stringify({ ...JSON.parse(saved.body), signature: "A".repeat(86) });
			writeFileSync(join(profileDir, "owner-finalize.json"), JSON.stringify(saved));
		}
		if (fault === "symlink") {
			realUnlink(path);
			symlinkSync(join(profileDir, "owner-receipt.json"), path);
		} else writeFileSync(path, JSON.stringify(record));
		const lock = readFileSync(path, "utf8");
		const proof = read("owner-finalize.json");
		const receipt = read("owner-receipt.json");
		const configBytes = read("config.json");
		const key = read("keys/device.key");
		const fetch = vi.fn<typeof globalThis.fetch>();
		// Act
		await expect(runOwnerEnrollment({ ...c.options, resume: true, fetch })).rejects.toThrow();
		// Assert: no final POST, lock cleanup, config rewrite or loss of the verified receipt.
		expect(fetch).not.toHaveBeenCalled();
		expect(c.finals).toHaveLength(1);
		expect(readFileSync(path, "utf8")).toBe(lock);
		expect(lstatSync(path).isSymbolicLink()).toBe(fault === "symlink");
		expect(read("owner-finalize.json")).toBe(proof);
		expect(read("owner-receipt.json")).toBe(receipt);
		expect(read("config.json")).toBe(configBytes);
		expect(read("keys/device.key")).toBe(key);
	},
);

it("rejects a config actor changed at atomic rename without overwriting the foreign value", async () => {
	// Arrange: mutate the real file immediately before the actual writer's compare-and-replace check.
	const c = await fixture();
	const replace = observerConfig.atomicReplaceConfigFile;
	vi.spyOn(observerConfig, "atomicReplaceConfigFile").mockImplementation(
		(path, text, mode, operations, verify, options) =>
			replace(
				path,
				text,
				mode,
				operations,
				() => {
					writeFileSync(path, JSON.stringify({ actor_id: "foreign-identity" }));
					verify?.();
				},
				options,
			),
	);
	// Act
	await expect(runOwnerEnrollment(c.options)).rejects.toThrow("Owner pilot incomplete");
	// Assert: coordinator history remains recorded, but foreign config is not replaced.
	expect(JSON.parse(read("config.json"))).toEqual({ actor_id: "foreign-identity" });
	expect(JSON.parse(read("owner-receipt.json"))).toMatchObject({ identityId: "identity-a" });
	expect(JSON.parse(read("owner-finalize.json")).body).toBe(c.finals[0]);
	expect(f.rows("coordinator_device_ownership_bindings")).toHaveLength(1);
	expect(existsSync(join(profileDir, "config.json.lock"))).toBe(false);
});

it("never sends or replaces a final request when only an interrupted final temp exists", async () => {
	// Arrange
	const c = await fixture();
	interruptPublication("owner-finalize.json");
	// Act
	await expect(runOwnerEnrollment(c.options)).rejects.toThrow("Owner pilot incomplete");
	const temp = readdirSync(profileDir).find((name) => name.startsWith("owner-finalize.json.tmp-"));
	expect(temp).toBeDefined();
	const stale = join(profileDir, tempName("owner-finalize.json"));
	const key = read("keys/device.key");
	assertDeadPid();
	renameSync(join(profileDir, temp as string), stale);
	writeFileSync(stale, '{"partial":', { mode: 0o600 });
	const fetch = vi.fn<typeof globalThis.fetch>();
	await expect(runOwnerEnrollment({ ...c.options, resume: true, fetch })).rejects.toThrow(
		"Before a final request exists, abandon only this disposable profile.",
	);
	// Assert: dead partial bytes are not signed, sent, or promoted to canonical proof.
	expect(fetch).not.toHaveBeenCalled();
	expect(c.finals).toEqual([]);
	expect(existsSync(join(profileDir, "owner-finalize.json"))).toBe(false);
	expect(f.rows("coordinator_device_ownership_bindings")).toEqual([]);
	expect(read("keys/device.key")).toBe(key);
});

it("cannot overwrite a canonical proof published concurrently", async () => {
	// Arrange: real hard-link EEXIST, not a mocked success result.
	const c = await fixture();
	interruptPublication("owner-finalize.json", () =>
		writeFileSync(join(profileDir, "owner-finalize.json"), "existing proof bytes", {
			flag: "wx",
			mode: 0o600,
		}),
	);
	// Act
	await expect(runOwnerEnrollment(c.options)).rejects.toThrow("Owner pilot incomplete");
	// Assert
	expect(read("owner-finalize.json")).toBe("existing proof bytes");
	expect(c.finals).toEqual([]);
	expect(f.rows("coordinator_device_ownership_bindings")).toEqual([]);
});

it.each(["symlink", "unsafe", "live", "unknown"])(
	"refuses %s temp without deleting proof or keys",
	async (fault) => {
		// Arrange: genuine retained request after an ambiguous commit.
		const c = await fixture();
		c.loseReply();
		await expect(runOwnerEnrollment(c.options)).rejects.toThrow("Owner pilot incomplete");
		assertDeadPid();
		let pid = deadPid;
		if (fault === "live") pid = process.pid;
		if (fault === "unknown") pid = Number.MAX_SAFE_INTEGER;
		const temp = join(profileDir, tempName("config.json", pid));
		if (fault === "symlink") symlinkSync(join(profileDir, "owner-finalize.json"), temp);
		else writeFileSync(temp, "unfinished config", { mode: fault === "unsafe" ? 0o644 : 0o600 });
		const proof = read("owner-finalize.json");
		const key = read("keys/device.key");
		const fetch = vi.fn<typeof globalThis.fetch>();
		// Act
		await expect(runOwnerEnrollment({ ...c.options, resume: true, fetch })).rejects.toThrow(
			"Owner pilot incomplete",
		);
		// Assert: neither unsafe cleanup nor a replacement ceremony is permitted.
		expect(fetch).not.toHaveBeenCalled();
		expect(lstatSync(temp).isSymbolicLink()).toBe(fault === "symlink");
		if (fault !== "symlink") expect(readFileSync(temp, "utf8")).toBe("unfinished config");
		expect(read("owner-finalize.json")).toBe(proof);
		expect(read("keys/device.key")).toBe(key);
	},
);
