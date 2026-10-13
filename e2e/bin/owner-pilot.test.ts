import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "../../packages/core/src/better-sqlite-coordinator-store.js";
import { review } from "../../packages/core/src/coordinator-auth-store-test-fixtures.js";
import { oidcFixture, PROVIDER } from "../../packages/core/src/coordinator-oidc-test-fixtures.js";
import { commitPendingKey } from "../../packages/core/src/coordinator-owner-enrollment-commit-test-fixtures.js";
import {
	config,
	ORIGIN,
} from "../../packages/core/src/coordinator-owner-enrollment-start-test-fixtures.js";
import { fingerprintPublicKey } from "../../packages/core/src/sync-fingerprint.js";
import {
	createOwnerPilotHandler,
	initializeOwnerPilotState,
	ownerPilotListenPort,
	parseOwnerPilotArgs,
	readOwnerPilotState,
	runOwnerPilot,
} from "./owner-pilot.js";

let directory: string;
let stateDir: string;
const closes: (() => Promise<void>)[] = [];
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "owner-runner-test-"));
	stateDir = join(directory, "coordinator");
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("live network forbidden"));
});
afterEach(async () => {
	try {
		for (const close of closes.splice(0).reverse()) await close();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		rmSync(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
	}
});
const init = () =>
	initializeOwnerPilotState({
		stateDir,
		origin: ORIGIN,
		coordinatorId: config.coordinatorId,
		groupId: "group-a",
	});
const options = (phase: "link" | "owner") => ({
	stateDir,
	phase,
	config,
	adminSecret: "synthetic-admin-".repeat(3),
	oidcOptions: { fetch: oidcFixture({ issuer: config.issuer }).fetch },
});

it("uses explicit unprivileged listener ports including both boundaries", () => {
	for (const port of [7348, 1024, 65535]) {
		const origin = `https://pilot.example.test:${port}`;
		const actual = ownerPilotListenPort(origin);
		expect(actual).toBe(port);
	}
});

it.each([
	["https://pilot.example.test", "Use an explicit HTTPS port from 1024 to 65535"],
	["https://pilot.example.test:443", "Use an explicit HTTPS port from 1024 to 65535"],
	["https://pilot.example.test:1023", "Use an explicit HTTPS port from 1024 to 65535"],
	["http://pilot.example.test:7348", "Owner pilot unavailable"],
	["https://pilot.example.test:7348/path", "Owner pilot unavailable"],
])("refuses listener origin %s", (origin, message) => {
	const listenPort = () => ownerPilotListenPort(origin);
	expect(listenPort).toThrow(message);
});

it("refuses default-port serve before TLS reads or provider setup", async () => {
	await init();
	const argv = [
		"serve",
		"--state",
		stateDir,
		"--phase",
		"owner",
		"--cert",
		join(directory, "absent-cert.pem"),
		"--key",
		join(directory, "absent-key.pem"),
	];
	// Missing TLS files would produce ENOENT if setup ran before the port check.
	await expect(runOwnerPilot(argv)).rejects.toThrow(
		"Use an explicit HTTPS port from 1024 to 65535",
	);
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("parses explicit commands and the standalone resume flag", () => {
	// Arrange
	const argv = [
		"enroll-b",
		"--profile",
		"fresh-profile",
		"--coordinator",
		ORIGIN,
		"--group",
		"group-a",
		"--resume",
	];
	// Act
	const parsed = parseOwnerPilotArgs(argv);
	// Assert
	expect(parsed).toEqual({
		command: "enroll-b",
		flags: { profile: "fresh-profile", coordinator: ORIGIN, group: "group-a", resume: "true" },
	});
	expect(parseOwnerPilotArgs([]).command).toBe("help");
	expect(parseOwnerPilotArgs(["--", ...argv])).toEqual(parsed);
});

it.each([
	["serve", "--unknown", "x"],
	["init", "--state", "one", "--state", "two"],
	["init", "--state"],
	["reset"],
])("refuses invalid arguments %j", (...argv) => {
	// Arrange/Act
	const parse = () => parseOwnerPilotArgs(argv);
	// Assert
	expect(parse).toThrow("Owner pilot unavailable");
});

it("initializes only discovery state with private files and preserves an existing state", async () => {
	// Arrange/Act
	const state = await init();
	const marker = readFileSync(join(stateDir, "owner-pilot.json"));
	const database = readFileSync(join(stateDir, "coordinator.sqlite"));
	const revisionKey = readFileSync(join(stateDir, "revision.key"));
	await expect(init()).rejects.toThrow();
	const store = new BetterSqliteCoordinatorStore(join(stateDir, "coordinator.sqlite"));
	closes.push(() => store.close());
	// Assert: initialization grants no controller, enrollment, account link or ownership.
	expect(readOwnerPilotState(stateDir)).toEqual(state);
	expect(statSync(stateDir).mode & 0o777).toBe(0o700);
	expect(statSync(join(stateDir, "owner-pilot.json")).mode & 0o777).toBe(0o600);
	expect(statSync(join(stateDir, "revision.key")).mode & 0o777).toBe(0o600);
	expect(revisionKey).toHaveLength(32);
	expect(Object.keys(state).sort()).toEqual(["coordinatorId", "groupId", "kind", "origin"]);
	expect(JSON.stringify(state)).not.toContain(revisionKey.toString("base64"));
	expect(readFileSync(join(stateDir, "revision.key"))).toEqual(revisionKey);
	expect(readFileSync(join(stateDir, "owner-pilot.json"))).toEqual(marker);
	expect(readFileSync(join(stateDir, "coordinator.sqlite"))).toEqual(database);
	expect(store.db.prepare("SELECT group_id FROM groups").all()).toEqual([{ group_id: "group-a" }]);
	for (const table of [
		"coordinator_auth_controller_attestations",
		"enrolled_devices",
		"coordinator_auth_account_links",
		"coordinator_identity_group_grants",
		"coordinator_owner_enrollment_audit_log",
	])
		expect(store.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
});

it("refuses an unmarked ordinary database without modifying it", () => {
	// Arrange
	const path = join(directory, "coordinator.sqlite");
	writeFileSync(path, "existing ordinary database");
	// Act/Assert
	expect(() => readOwnerPilotState(directory)).toThrow();
	expect(readFileSync(path, "utf8")).toBe("existing ordinary database");
});

it.each(["marker", "database", "directory", "origin", "key-mode", "key-length"])(
	"refuses unsafe %s state",
	async (fault) => {
		// Arrange
		await init();
		let path = stateDir;
		if (fault === "key-mode") chmodSync(join(stateDir, "revision.key"), 0o644);
		else if (fault === "key-length")
			writeFileSync(join(stateDir, "revision.key"), Buffer.alloc(31));
		else if (fault === "origin")
			writeFileSync(
				join(stateDir, "owner-pilot.json"),
				JSON.stringify({
					kind: "owner-pilot-v1",
					origin: "http://example.test",
					coordinatorId: config.coordinatorId,
					groupId: "group-a",
				}),
			);
		else if (fault === "directory") {
			path = join(directory, "alias");
			symlinkSync(stateDir, path);
		} else {
			const file = join(stateDir, fault === "marker" ? "owner-pilot.json" : "coordinator.sqlite");
			renameSync(file, `${file}.saved`);
			symlinkSync(`${file}.saved`, file);
		}
		// Act/Assert
		expect(() => readOwnerPilotState(path)).toThrow();
	},
);

it.each(["namespace", "origin", "callback", "secret"])(
	"refuses mismatched handler %s",
	async (fault) => {
		// Arrange
		await init();
		const input = options("owner");
		if (fault === "namespace") input.config = { ...config, coordinatorId: "other-coordinator" };
		if (fault === "origin")
			input.config = { ...config, redirectUri: "https://other.example.test/auth/callback" };
		if (fault === "callback") input.config = { ...config, redirectUri: `${ORIGIN}/other-callback` };
		if (fault === "secret") input.adminSecret = "too-short";
		// Act/Assert
		await expect(createOwnerPilotHandler(input)).rejects.toThrow("Owner pilot unavailable");
	},
);

it("issues the reviewed device grant and refuses an unknown device without writes", async () => {
	// Arrange: existing enrolled key and explicit reviewed controller attestation, not bootstrap authority.
	await init();
	const store = new BetterSqliteCoordinatorStore(join(stateDir, "coordinator.sqlite"));
	closes.push(() => store.close());
	const key = commitPendingKey();
	const attestation = review({
		publicKey: key.publicKey,
		fingerprint: fingerprintPublicKey(key.publicKey),
	});
	await store.enrollDevice("group-a", { ...attestation, identityId: null });
	expect((await store.createAuthControllerAttestation(attestation)).kind).toBe("created");
	const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
	// Act
	await runOwnerPilot(["issue-grant", "--state", stateDir, "--device", attestation.deviceId]);
	const grants = store.db.prepare("SELECT * FROM coordinator_identity_group_grants").all();
	await expect(
		runOwnerPilot(["issue-grant", "--state", stateDir, "--device", "unknown-device"]),
	).rejects.toThrow("Owner pilot unavailable");
	// Assert
	expect(grants).toEqual([
		expect.objectContaining({
			identity_id: attestation.identityId,
			group_id: "group-a",
			status: "active",
		}),
	]);
	expect(store.db.prepare("SELECT * FROM coordinator_identity_group_grants").all()).toEqual(grants);
	expect(log).toHaveBeenCalledTimes(1);
});

it.each(["link", "owner"] as const)(
	"mounts only the %s phase through the genuine factories",
	async (phase) => {
		// Arrange
		await init();
		const provider = oidcFixture({ issuer: config.issuer });
		const handler = await createOwnerPilotHandler({
			...options(phase),
			config: { ...config, clientId: PROVIDER.clientId, clientSecret: PROVIDER.clientSecret },
			oidcOptions: { fetch: provider.fetch },
		});
		closes.push(() => handler.close());
		const discoveryRequests = provider.requests.length;
		const get = (path: string, key = "trusted-socket") =>
			handler.handle(
				new Request(`${ORIGIN}${path}`, {
					headers: { "x-forwarded-for": "spoofed", "x-client-key": "trusted-socket" },
				}),
				key,
			);
		// Act
		const signin = await get("/auth/sign-in");
		const pins = await get("/v1/auth/owner-pilot");
		const link = await get("/auth/link/start");
		const callback = await get("/auth/callback?error=access_denied");
		// Assert: shared callback belongs only to the selected purpose; probes do not exchange tokens.
		expect(signin.status).toBe(phase === "link" ? 200 : 404);
		expect(pins.status).toBe(phase === "owner" ? 200 : 404);
		if (phase === "owner") {
			const publicPins = await pins.json();
			expect(publicPins).toEqual({
				coordinatorId: config.coordinatorId,
				origin: ORIGIN,
				issuer: config.issuer,
				revision: config.revision,
			});
			expect(JSON.stringify(publicPins)).not.toContain(
				readFileSync(join(stateDir, "revision.key")).toString("base64"),
			);
			expect(link.status).toBe(404);
			expect(callback.status).toBe(400);
			expect(await callback.text()).toBe("Owner enrollment unavailable.");
			expect((await get("/v1/auth/owner-pilot", "")).status).toBe(400);
		} else expect(callback.status).not.toBe(404);
		expect(provider.requests.length).toBe(discoveryRequests);
		expect(
			provider.requests.every(({ url }) => url.endsWith("/.well-known/openid-configuration")),
		).toBe(true);
	},
);
