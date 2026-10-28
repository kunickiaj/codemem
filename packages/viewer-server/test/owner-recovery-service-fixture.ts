import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect, ensureDeviceIdentity, loadPublicKey, MemoryStore,
	readCoordinatorAccountLinkStatus,
} from "@codemem/core";
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
	captureAccountOwnerProfilePins, readAccountOwnerAssociation, retainAccountOwnerAssociation,
} from "../../core/src/account-owner-association.js";
import { coordinatorAuthControllerReviewAction } from "../../core/src/coordinator-actions.js";
import { fixture as accountFixture, cleanupAccountChangeHttpFixtures, NOW } from "../../core/src/coordinator-account-change-http-test-fixtures.js";
import { createCoordinatorApp } from "../../core/src/coordinator-api.js";
import { captureCoordinatorBrowserAuthOptions, createCoordinatorBrowserAuth } from "../../core/src/coordinator-browser-auth-app.js";
import { importBrowserCsrfKey } from "../../core/src/coordinator-browser-csrf.js";
import { oidcFixture, PROVIDER } from "../../core/src/coordinator-oidc-test-fixtures.js";
import { OwnerResolutionReviewOperations } from "../../core/src/coordinator-owner-resolution-review.js";
import { readCoordinatorResolvedAccountOwnerStatus, readCoordinatorResolvedAccountOwnerReceiptStatus } from "../../core/src/coordinator-resolved-account-owner-status-client.js";
import { createInMemoryRequestRateLimiter } from "../../core/src/request-rate-limit.js";
import { createAccountContextReader } from "../src/account/context.js";
import { createAccountLinkRegistry } from "../src/account/link-registry.js";
import { seedResolvedOwner } from "./resolved-owner-test-fixture.js";

const cleanups: Array<() => void | Promise<void>> = [];
export function recoveryAssociationFiles(legacyDirectory?: string): string[] {
	const directories = [join(homedir(), ".codemem", "account-owner-associations")];
	if (legacyDirectory) directories.push(legacyDirectory);
	return directories.filter(existsSync)
		.flatMap((directory) => readdirSync(directory)
			.filter((name) => name.includes(".account-owner-") && name.endsWith(".json"))
			.map((name) => join(directory, name)))
		.sort();
}
export const scope = "historical_included_owner_labels_only";
export function recoveryTests() {
	// Each case builds a real signed coordinator (RSA OIDC keys, Ed25519 device key,
	// SQLite) and makes real signed requests: ~0.2s idle, but over 5s on a busy CI
	// runner. These are correctness checks, not five-second performance budgets.
	vi.setConfig({ testTimeout: 15_000 });
	beforeEach(() => {
		const home = mkdtempSync(join(tmpdir(), "recovery-service-home-"));
		vi.stubEnv("HOME", home);
		cleanups.push(() => rmSync(home, { recursive: true, force: true }));
		for (const key of ["CODEMEM_ACTOR_ID", "CODEMEM_DEVICE_ID", "CODEMEM_SYNC_COORDINATOR_URL", "CODEMEM_SYNC_COORDINATOR_GROUP", "CODEMEM_SYNC_COORDINATOR_GROUPS"]) vi.stubEnv(key, undefined);
		vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
		vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network forbidden"); }));
	});
	afterEach(async () => {
		for (const close of cleanups.splice(0).reverse()) await close();
		cleanupAccountChangeHttpFixtures();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});
}
export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
export async function recoveryFixture(options: { fact?: boolean; groups?: string[]; admin?: boolean; maintainedReview?: boolean } = {}) {
	// Disable embeddings before either database opens so bootstrap skips vector setup.
	vi.stubEnv("CODEMEM_EMBEDDING_DISABLED", "1");
	const remote = await accountFixture("device_claim", { issuer: "https://accounts.google.com" });
	const directory = mkdtempSync(join(tmpdir(), "recovery-service-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const dbPath = join(directory, "memory.sqlite"), keysDir = join(directory, "keys");
	const db = connect(dbPath);
	const [deviceId] = ensureDeviceIdentity(db, { keysDir });
	const { fingerprint } = db.prepare("SELECT fingerprint FROM sync_device").get() as { fingerprint: string };
	// Existing authored data and identity rows must survive every recovery operation byte-for-byte.
	db.exec("CREATE TABLE recovery_history(actor_id TEXT, body TEXT); INSERT INTO recovery_history VALUES ('identity-b','retain original authored history')");
	db.close();
	const configPath = join(directory, "selected-config.json");
	writeFileSync(configPath, JSON.stringify({ actor_id: "identity-b" }));
	vi.stubEnv("CODEMEM_CONFIG", configPath);
	const store = new MemoryStore(dbPath, { keysDir });
	try {
		const session = store.getOrCreateSessionForOpencodeSession({ opencodeSessionId: "recovery-capture", project: "fixture-project" });
		store.remember(session, "decision", "Retained authored memory", "Keep the original B author", 1, [], {});
		expect(store.actorId).toBe("identity-b");
	} finally { store.close(); }
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new Error("Missing generated fixture key");
	const signer = { groupId: "group-a", deviceId, publicKey, fingerprint };
	const proof = await seedResolvedOwner(remote, signer, options);
	for (const groupId of options.groups ?? []) {
		if (groupId === "group-a") continue;
		await remote.store.createGroup(groupId);
		await remote.store.enrollDevice(groupId, signer);
		remote.db.prepare("UPDATE enrolled_devices SET identity_id='identity-b' WHERE group_id=? AND device_id=?").run(groupId, deviceId);
	}
	const coordinatorUrl = new URL(remote.config.redirectUri).origin;
	const config: Record<string, unknown> = { actor_id: "identity-b", sync_coordinator_url: coordinatorUrl, sync_coordinator_groups: options.groups ?? ["group-a"] };
	const profile = { dbPath, deviceId, identityId: "identity-b", identityLabel: "Original label" };
	const readContext = createAccountContextReader({ getProfile: () => profile, readConfig: () => config, keysDir, configPath });
	const browser = await createCoordinatorBrowserAuth(captureCoordinatorBrowserAuthOptions({
		config: { ...remote.config, clientId: PROVIDER.clientId, clientSecret: PROVIDER.clientSecret },
		csrfKey: await importBrowserCsrfKey(randomBytes(32)),
		oidcOptions: { fetch: oidcFixture({ issuer: remote.config.issuer }).fetch },
	}), remote.store, createInMemoryRequestRateLimiter({ now: () => NOW }));
	if (!browser.ok) throw new Error(`Browser fixture failed: ${browser.error}`);
	const coordinator = createCoordinatorApp({ ...remote.options, runtime: { ...remote.options.runtime, adminSecret: () => options.maintainedReview ? "fixture-server-admin" : null }, browserAuth: { kind: "ready", auth: browser.auth, storeFactory: () => remote.store, clientKey: () => "fixture-client" } });
	const requests: Request[] = [];
	const transport = vi.fn<typeof fetch>(async (input, init) => {
		const request = new Request(input, init);
		if (new URL(request.url).origin !== coordinatorUrl) throw new Error("Unexpected external origin");
		requests.push(request.clone());
		return coordinator.request(request);
	});
	const backend = { ...remote.backend, async all<T>({ sql, values }: Parameters<typeof remote.backend.first>[0]): Promise<T[]> { return remote.db.prepare(sql).all(...values) as T[]; } };
	const ops = new OwnerResolutionReviewOperations(backend, () => remote.clock.now);
	const reviewOwner = vi.fn<typeof coordinatorAuthControllerReviewAction>(async (input) => {
		if (options.maintainedReview) return coordinatorAuthControllerReviewAction(input);
		const selection = { groupId: input.groupId, deviceId: input.deviceId, identityId: input.identityId, fingerprint: input.fingerprint };
		if (input.confirmOwnerResolutionDigest !== undefined) return { ...await ops.confirmOwnerResolutionReview({ ...selection, confirmOwnerResolutionDigest: input.confirmOwnerResolutionDigest }, remote.config) };
		return { ...await ops.previewOwnerResolutionReview(selection, remote.config) };
	});
	const readRemoteStatus = vi.fn<typeof readCoordinatorAccountLinkStatus>((input) => readCoordinatorAccountLinkStatus({ ...input, fetch: transport }));
	const readRemoteOwnerStatus = vi.fn<typeof readCoordinatorResolvedAccountOwnerStatus>((input) => readCoordinatorResolvedAccountOwnerStatus({ ...input, fetch: transport }));
	const readRemoteReceiptStatus = vi.fn<typeof readCoordinatorResolvedAccountOwnerReceiptStatus>((input) => readCoordinatorResolvedAccountOwnerReceiptStatus({ ...input, fetch: transport }));
	const link = vi.fn(async () => { throw new Error("Unexpected account link"); });
	const registry = createAccountLinkRegistry({ readContext, link });
	cleanups.push(() => registry.close());
	let adminSecret: string | null = options.admin === false ? null : "fixture-server-admin";
	let now = NOW;
	// Owner suggestions are optional; tests that need them replace this read-only preview.
	const previewDeviceOwner = vi.fn<typeof coordinatorAuthControllerReviewAction>(async () => ({}));
	const serviceOptions = { readContext, readAdminSecret: () => adminSecret, registry, readRemoteStatus, readRemoteOwnerStatus, readRemoteReceiptStatus, reviewOwner, previewDeviceOwner, now: () => now };
	const ownerProfile = (groupId = "group-a") => ({ dbPath: profile.dbPath, deviceId, publicKey, fingerprint, actorId: profile.identityId, coordinatorUrl: String(config.sync_coordinator_url), coordinatorId: remote.config.coordinatorId, groupId });
	const association = (groupId = "group-a") => {
		const p = ownerProfile(groupId);
		return readAccountOwnerAssociation(p, { expectedProfilePins: captureAccountOwnerProfilePins(p) });
	};
	const retain = (ownerIdentityId: string, groupId = "group-a") => {
		const p = ownerProfile(groupId);
		return retainAccountOwnerAssociation(p, { ownerIdentityId, attestationId: proof.controller.attestation_id, reviewDigest: proof.controller.evidence_digest }, { expectedProfilePins: captureAccountOwnerProfilePins(p) });
	};
	const immutableSnapshot = () => ({ db: readFileSync(dbPath), keys: readdirSync(keysDir).sort().map((name) => [name, readFileSync(join(keysDir, name))]), profile: structuredClone(profile), config: structuredClone(config), configFile: readFileSync(configPath) });
	const receipt = () => {
		const r = proof.resolution;
		if (!r) throw new Error("Fixture has no resolution receipt");
		return { attestationId: r.source_attestation_id, reviewReceiptId: r.source_review_receipt_id, reviewEvidenceDigest: r.source_evidence_digest, resolutionId: r.resolution_id, resolutionEvidenceDigest: r.resolution_evidence_digest };
	};
	const reply = (groups = ["group-a"]) => ({ version: 1, purpose: "existing_account_owner", scope, coordinatorOrigin: coordinatorUrl, coordinatorId: remote.config.coordinatorId, deviceId, fingerprint, ownerIdentityId: "identity-a", groups: groups.map((groupId) => ({ groupId, ...receipt() })) });
	return { ...remote, directory, dbPath, keysDir, publicKey, deviceId, fingerprint, signer, proof, profile, config, readContext, serviceOptions, reviewOwner, previewDeviceOwner, readRemoteStatus, readRemoteOwnerStatus, readRemoteReceiptStatus, registry, link, requests, transport, ownerProfile, association, retain, immutableSnapshot, receipt, reply,
		setAdmin: (value: string | null) => { adminSecret = value; }, advance: (ms: number) => { now += ms; },
		cleanup: (close: () => void | Promise<void>) => cleanups.push(close),
	};
}

export async function selectionFor(service: { getProfile(): Promise<{ profile: import("../../ui/src/tabs/account-owner-recovery-types.js").RecoveryProfile }> }, groups = ["group-a"]) {
	return { profile: (await service.getProfile()).profile, existingOwnerId: "identity-a", groups };
}
export function expectNoConfirmation(f: Awaited<ReturnType<typeof recoveryFixture>>) {
	expect(f.reviewOwner.mock.calls.filter(([input]) => input.confirmOwnerResolutionDigest !== undefined)).toHaveLength(0);
}
