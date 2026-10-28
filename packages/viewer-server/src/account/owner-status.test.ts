import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CoordinatorAccountLinkError,
	type CoordinatorAccountLinkStatusRead,
	type CoordinatorResolvedAccountOwnerStatusRead,
	connect,
	ensureDeviceIdentity,
	initTestSchema,
	loadPublicKey,
} from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	captureAccountOwnerProfilePins,
	retainAccountOwnerAssociation,
} from "../../../core/src/account-owner-association.js";
import { createApp } from "../index.js";
import { type AccountContext, createAccountContextReader } from "./context.js";
import { createAccountLinkRegistry } from "./link-registry.js";
import { associatedOwnerView, readOwnerAssociation } from "./owner-status.js";
import { type AccountLinkViewV1, accountLocalView, readAccountStatus } from "./status.js";

const cleanups: Array<() => void | Promise<void>> = [];
const ORIGIN = "http://127.0.0.1:7441";
beforeEach(() => {
	for (const name of [
		"CODEMEM_ACTOR_ID",
		"CODEMEM_DEVICE_ID",
		"CODEMEM_SYNC_COORDINATOR_URL",
		"CODEMEM_SYNC_COORDINATOR_GROUP",
		"CODEMEM_SYNC_COORDINATOR_GROUPS",
	])
		vi.stubEnv(name, undefined);
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", "file");
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Network forbidden");
		}),
	);
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

function ordinaryStatus(
	context: AccountContext,
	coordinatorId: string,
	identityId: string,
): CoordinatorAccountLinkStatusRead {
	return {
		kind: "status",
		status: {
			version: 2,
			coordinatorId,
			groupId: context.groupId,
			deviceId: context.deviceId,
			fingerprint: context.fingerprint,
			identityId,
			authority: "device_claim",
			state: "unlinked",
			account: null,
		},
	};
}

function fixture(options: { associate?: boolean } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "viewer-owner-status-"));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const dbPath = join(directory, "memory.sqlite");
	const keysDir = join(directory, "keys");
	const db = connect(dbPath);
	initTestSchema(db);
	const [deviceId] = ensureDeviceIdentity(db, { keysDir });
	const { fingerprint } = db.prepare("SELECT fingerprint FROM sync_device").get() as {
		fingerprint: string;
	};
	db.exec(
		"CREATE TABLE owner_test_history(actor_id TEXT, body TEXT); INSERT INTO owner_test_history VALUES ('actor-c', 'unchanged capture')",
	);
	db.close();
	const publicKey = loadPublicKey(keysDir);
	if (!publicKey) throw new Error("Missing fixture public key");
	const profile = { dbPath, deviceId, identityId: "actor-c" };
	const config = {
		actor_id: "actor-c",
		sync_coordinator_url: "https://coordinator.example.test",
		sync_coordinator_groups: ["group-a"],
	};
	const readContext = createAccountContextReader({
		getProfile: () => profile,
		readConfig: () => config,
		keysDir,
	});
	const ready = readContext();
	if (!("context" in ready) || !ready.context) throw new Error("Missing fixture context");
	const context = ready.context;
	const ownerProfile = {
		dbPath,
		deviceId,
		publicKey,
		fingerprint,
		actorId: "actor-c",
		coordinatorUrl: config.sync_coordinator_url,
		coordinatorId: "actual-coordinator-id",
		groupId: "group-a",
	};
	const associate = () =>
		retainAccountOwnerAssociation(ownerProfile, {
			ownerIdentityId: "identity-a",
			attestationId: `controller-v1:${"a".repeat(64)}`,
			reviewDigest: "b".repeat(64),
		});
	if (options.associate !== false) associate();
	const associationPath = () =>
		join(
			directory,
			readdirSync(directory).find((name) => name.includes(".account-owner-")) ?? "absent",
		);
	const editAssociation = (patch: Record<string, unknown>) => {
		const path = associationPath();
		writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), ...patch }));
	};
	const status = (identityId: string) =>
		ordinaryStatus(context, ownerProfile.coordinatorId, identityId);
	const ownerStatus = (): CoordinatorResolvedAccountOwnerStatusRead => ({
		kind: "owner_status",
		status: {
			version: 1,
			coordinatorId: ownerProfile.coordinatorId,
			groupId: context.groupId,
			deviceId,
			fingerprint,
			state: "owner_confirmed",
			ownerIdentity: "identity-a",
			profileState: "linked",
			profile: { displayName: "Verified owner", email: "owner@example.test" },
		},
	});
	const readRemoteStatus = vi.fn(async (input: { identityId: string }) => status(input.identityId));
	const readRemoteOwnerStatus = vi.fn(async () => ownerStatus());
	const readRemoteCapabilities = vi.fn(async () => ({ kind: "unsupported" as const }));
	const read = () =>
		readAccountStatus(
			{ readContext, readRemoteStatus, readRemoteOwnerStatus, readRemoteCapabilities },
			undefined,
			new AbortController().signal,
		);
	return {
		directory,
		dbPath,
		keysDir,
		publicKey,
		context,
		config,
		profile,
		ownerProfile,
		readContext,
		associate,
		associationPath,
		editAssociation,
		readRemoteStatus,
		readRemoteOwnerStatus,
		ownerStatus,
		readRemoteCapabilities,
		status,
		read,
	};
}

function expectPrivateFailure(
	view: Awaited<ReturnType<typeof readAccountStatus>>,
	code = "account_owner_association_invalid",
) {
	expect(view).toMatchObject({
		local: { identityId: "actor-c" },
		canLink: false,
		remote: { kind: "unavailable", code },
	});
	expect(view).not.toHaveProperty("accountOwner");
	expect(view).not.toHaveProperty("ownerProjection");
	expect(view).not.toHaveProperty("managementActions");
	expect(view).not.toHaveProperty("unlinkTarget");
	expect(JSON.stringify(view)).not.toContain("owner@example.test");
	expect(JSON.stringify(view)).not.toContain("Verified owner");
}

describe("real-profile owner display context", () => {
	it.each(["conflict", "review_required"] as const)(
		"uses the signed coordinator ID from actor %s with no identity or authority",
		async (state) => {
			// Arrange: ordinary status is not ownership evidence, only a coordinator selector.
			const f = fixture();
			f.readRemoteStatus.mockImplementation(async () => {
				const result = f.status("actor-c");
				if (result.kind === "status")
					Object.assign(result.status, { state, identityId: null, authority: null });
				return result;
			});
			// Act
			const view = await f.read();
			// Assert
			expect(view).toMatchObject({
				remote: { kind: "not_checked" },
				ownerProjection: { status: { ownerIdentity: "identity-a" } },
				canLink: false,
			});
			expect(f.readRemoteOwnerStatus).toHaveBeenCalledOnce();
			expect(f.readRemoteStatus).toHaveBeenCalledOnce();
		},
	);
	it.each(["unsupported", "unavailable"] as const)(
		"does not discover an association from URL or proposal after ordinary %s",
		async (kind) => {
			// Arrange: a local proposal and matching URL are not signed coordinator identity.
			const f = fixture();
			f.readRemoteStatus.mockResolvedValue(
				kind === "unsupported" ? { kind } : { kind, code: "coordinator_unreachable" },
			);
			// Act
			const view = await f.read();
			// Assert
			expect(view).toMatchObject({ remote: { kind }, canLink: false });
			expect(view).not.toHaveProperty("accountOwner");
			expect(view).not.toHaveProperty("ownerProjection");
			expect(f.readRemoteOwnerStatus).not.toHaveBeenCalled();
		},
	);
	it.each(["unsupported", "unavailable", "throws", "unconfirmed"] as const)(
		"hides the proposed owner and all profile data after owner %s",
		async (mode) => {
			// Arrange
			const f = fixture();
			f.readRemoteOwnerStatus.mockImplementation(async () => {
				if (mode === "throws") throw new Error("owner@example.test private failure");
				if (mode === "unsupported") return { kind: "unsupported" };
				if (mode === "unavailable") return { kind: "unavailable", code: "coordinator_unreachable" };
				const result = f.ownerStatus();
				if (result.kind !== "owner_status") throw new Error("Invalid fixture");
				return {
					kind: "owner_status",
					status: {
						...result.status,
						state: "owner_unconfirmed",
						ownerIdentity: null,
						profileState: "unavailable",
						profile: null,
					},
				};
			});
			// Act
			const view = await f.read();
			// Assert
			expectPrivateFailure(view);
			expect(f.readRemoteOwnerStatus).toHaveBeenCalledOnce();
			expect(f.readRemoteStatus).toHaveBeenCalledOnce();
		},
	);
	it.each(["account_unlinked", "unavailable"] as const)(
		"retains confirmed owner identity but no profile or actions when profile is %s",
		async (profileState) => {
			// Arrange
			const f = fixture();
			const result = f.ownerStatus();
			if (result.kind !== "owner_status") throw new Error("Invalid fixture");
			f.readRemoteOwnerStatus.mockResolvedValue({
				kind: "owner_status",
				status: {
					...result.status,
					state: "owner_confirmed",
					ownerIdentity: "identity-a",
					profileState,
					profile: null,
				},
			});
			// Act
			const view = await f.read();
			// Assert
			expect(view).toMatchObject({
				accountOwner: { identityId: "identity-a", memoryActorId: "actor-c" },
				ownerProjection: { status: { profileState, profile: null } },
				remote: { kind: "not_checked" },
				canLink: false,
				blockedReason: "status_unavailable",
			});
			expect(view).not.toHaveProperty("managementActions");
			expect(view).not.toHaveProperty("unlinkTarget");
			expect(JSON.stringify(view)).not.toContain("owner@example.test");
			expect(f.readRemoteCapabilities).not.toHaveBeenCalled();
		},
	);
});

describe("direct owner projection capability isolation", () => {
	it.each(["confirmed", "unconfirmed"] as const)(
		"strips inherited management, unlink and ordinary profile fields in direct %s projection",
		(mode) => {
			// Arrange: the exported projector must be safe even without its normal caller's clean base.
			const f = fixture();
			const ready = f.readContext();
			if ("error" in ready) throw new Error("Invalid context");
			const association = readOwnerAssociation(f.context, f.ownerProfile.coordinatorId);
			if (!association) throw new Error("Missing association");
			const previous = f.ownerStatus();
			if (previous.kind !== "owner_status" || previous.status.state !== "owner_confirmed")
				throw new Error("Invalid fixture");
			const previousProjection: NonNullable<AccountLinkViewV1["ownerProjection"]> = {
				kind: "resolved_account_owner",
				status: previous.status,
			};
			const base = {
				...accountLocalView(ready),
				canLink: true,
				managementActions: { refresh: true, disconnect: true },
				unlinkTarget: "old-link",
				accountOwner: { identityId: "old-owner", memoryActorId: "actor-c" },
				ownerProjection: previousProjection,
				remote: {
					kind: "status" as const,
					coordinatorId: f.ownerProfile.coordinatorId,
					authority: "device_claim" as const,
					identityId: "actor-c",
					identityMatches: true,
					state: "linked" as const,
					account: { email: "old-profile@example.test" },
				},
			};
			const remote = f.ownerStatus();
			if (mode === "unconfirmed" && remote.kind === "owner_status")
				Object.assign(remote.status, {
					state: "owner_unconfirmed",
					ownerIdentity: null,
					profileState: "unavailable",
					profile: null,
				});
			// Act
			const view = associatedOwnerView(base, f.context, association, remote);
			// Assert
			expect(view.canLink).toBe(false);
			expect(view).not.toHaveProperty("managementActions");
			expect(view).not.toHaveProperty("unlinkTarget");
			expect(JSON.stringify(view)).not.toContain("old-profile@example.test");
			expect(JSON.stringify(view)).not.toContain("old-owner");
			if (mode === "unconfirmed") expectPrivateFailure(view);
			else expect(view.remote).toEqual({ kind: "not_checked" });
		},
	);
});

describe("resolved owner profile pins", () => {
	it("pins the public key and uses the signed coordinator ID rather than its URL", async () => {
		// Arrange: real nonempty profile, keys and private association; actor C is not owner A.
		const f = fixture();
		// Compare a digest: deep-equality on the whole SQLite file took ~1s per call.
		const dbDigest = () => createHash("sha256").update(readFileSync(f.dbPath)).digest("hex");
		const before = dbDigest();
		// Act
		const view = await f.read();
		// Assert: display ownership never changes the memory actor or mutation authority.
		expect(f.context.publicKeyHash).toBe(createHash("sha256").update(f.publicKey).digest("hex"));
		expect(view).toMatchObject({
			accountOwner: { identityId: "identity-a", memoryActorId: "actor-c" },
			local: { identityId: "actor-c" },
			remote: { kind: "not_checked" },
			ownerProjection: {
				kind: "resolved_account_owner",
				status: {
					version: 1,
					ownerIdentity: "identity-a",
					state: "owner_confirmed",
					profile: { email: "owner@example.test" },
				},
			},
			canLink: false,
			blockedReason: "already_linked",
		});
		expect("contextId" in view && view.contextId).not.toBe(f.context.contextId);
		expect(f.readContext()).toMatchObject({ context: f.context });
		expect(f.readRemoteStatus.mock.calls.map(([input]) => input.identityId)).toEqual(["actor-c"]);
		expect(f.readRemoteOwnerStatus).toHaveBeenCalledExactlyOnceWith({
			dbPath: f.dbPath,
			keysDir: f.keysDir,
			groupId: "group-a",
			coordinatorUrl: f.config.sync_coordinator_url,
			ownerIdentityId: "identity-a",
			signal: expect.any(AbortSignal),
		});
		expect(view).not.toHaveProperty("remote.authority");
		expect(view).not.toHaveProperty("ownerProjection.status.authority");
		expect(f.readRemoteCapabilities).not.toHaveBeenCalled();
		expect(view).not.toHaveProperty("managementActions");
		expect(dbDigest()).toBe(before);
	});
	it.each([
		"ownerIdentity",
		"version",
		"state",
		"deviceId",
		"groupId",
		"fingerprint",
		"coordinatorId",
	])("does not disclose owner data when remote %s mismatches", async (field) => {
		// Arrange
		const f = fixture();
		f.readRemoteOwnerStatus.mockImplementation(async () => {
			const result = f.ownerStatus();
			if (result.kind === "owner_status")
				Object.assign(result.status, { [field]: field === "version" ? 2 : "wrong" });
			return result;
		});
		// Act
		const view = await f.read();
		// Assert
		expectPrivateFailure(view);
		expect(f.readRemoteOwnerStatus).toHaveBeenCalledOnce();
		expect(f.readRemoteStatus).toHaveBeenCalledOnce();
		expect(f.readRemoteCapabilities).not.toHaveBeenCalled();
	});
	it("treats an editable wrong-owner proposal as a proposal, not authorization", async () => {
		// Arrange: local JSON proposes B but the real transport response still describes A.
		const f = fixture();
		f.editAssociation({ ownerIdentityId: "identity-b" });
		// Act
		const view = await f.read();
		// Assert
		expectPrivateFailure(view);
		expect(f.readRemoteStatus.mock.calls.map(([input]) => input.identityId)).toEqual(["actor-c"]);
		expect(f.readRemoteOwnerStatus).toHaveBeenCalledWith(
			expect.objectContaining({ ownerIdentityId: "identity-b" }),
		);
	});
});

describe("private owner association freshness", () => {
	it("rechecks the original context before sending the owner request", async () => {
		// Arrange: change the actor only after the ordinary request's context check.
		const f = fixture();
		let reads = 0;
		const readContext = vi.fn((groupId?: string) => {
			if (++reads === 3) f.profile.identityId = "actor-other";
			return f.readContext(groupId);
		});
		// Act
		const view = await readAccountStatus(
			{
				readContext,
				readRemoteStatus: f.readRemoteStatus,
				readRemoteOwnerStatus: f.readRemoteOwnerStatus,
			},
			undefined,
			new AbortController().signal,
		);
		// Assert
		expectPrivateFailure(view, "context_changed");
		expect(f.readRemoteOwnerStatus).not.toHaveBeenCalled();
	});
	it.each([
		"actorId",
		"deviceId",
		"fingerprint",
		"keyId",
		"coordinatorId",
		"groupId",
		"databaseFile",
		"coordinatorUrl",
	])("rejects locally edited %s before requesting owner data", async (field) => {
		// Arrange
		const f = fixture();
		f.editAssociation({ [field]: "wrong" });
		// Act
		const view = await f.read();
		// Assert
		expectPrivateFailure(view);
		expect(f.readRemoteStatus).toHaveBeenCalledOnce();
		expect(f.readRemoteOwnerStatus).not.toHaveBeenCalled();
	});
	it("rejects a nonprivate association file", async () => {
		// Arrange
		const f = fixture();
		chmodSync(f.associationPath(), 0o644);
		// Act
		const view = await f.read();
		// Assert
		expectPrivateFailure(view);
		expect(f.readRemoteStatus).toHaveBeenCalledOnce();
		expect(f.readRemoteOwnerStatus).not.toHaveBeenCalled();
	});
	it.each(["association", "key", "actor", "coordinator", "database", "group", "abort"] as const)(
		"drops account data when %s changes during the owner read",
		async (change) => {
			// Arrange
			const f = fixture();
			const controller = new AbortController();
			const changes = {
				association: () => f.editAssociation({ reviewDigest: "c".repeat(64) }),
				key: () => {
					const db = connect(f.dbPath);
					db.prepare("UPDATE sync_device SET public_key=?").run(`${f.publicKey} changed`);
					db.close();
				},
				actor: () => {
					f.profile.identityId = "actor-other";
				},
				coordinator: () => {
					f.config.sync_coordinator_url = "https://changed.example.test";
				},
				database: () => {
					copyFileSync(f.dbPath, `${f.dbPath}.replacement`);
					renameSync(`${f.dbPath}.replacement`, f.dbPath);
				},
				group: () => {
					f.config.sync_coordinator_groups = ["group-other"];
				},
				abort: () => controller.abort(),
			};
			f.readRemoteOwnerStatus.mockImplementation(async () => {
				changes[change]();
				return f.ownerStatus();
			});
			// Act
			const view = await readAccountStatus(
				{
					readContext: f.readContext,
					readRemoteStatus: f.readRemoteStatus,
					readRemoteOwnerStatus: f.readRemoteOwnerStatus,
				},
				undefined,
				controller.signal,
			);
			// Assert
			expectPrivateFailure(view, "context_changed");
		},
	);
});

describe("ordinary actor and operation context compatibility", () => {
	it.each(["awaiting_browser", "succeeded", "failed"] as const)(
		"retains the original actor's %s operation without closing or cancelling it",
		async (state) => {
			// Arrange: a retained result belongs to C's original context, not A or the display hash.
			const f = fixture();
			const registry = createAccountLinkRegistry({ readContext: f.readContext });
			cleanups.push(() => registry.close());
			const operation = {
				operationId: "original-c-operation",
				contextId: f.context.contextId,
				groupId: "group-a",
				state,
				failure: null,
				browserUrlAvailable: state === "awaiting_browser",
				startedAt: "2026-10-02T12:00:00.000Z",
				deadlineAt: "2026-10-02T12:10:00.000Z",
				finishedAt: state === "awaiting_browser" ? null : "2026-10-02T12:01:00.000Z",
			};
			const forContext = vi
				.spyOn(registry, "forContext")
				.mockImplementation((contextId) => (contextId === f.context.contextId ? operation : null));
			vi.spyOn(registry, "hasActive").mockReturnValue(state === "awaiting_browser");
			const close = vi.spyOn(registry, "close");
			const cancel = vi.spyOn(registry, "cancel");
			const browserUrl = vi.spyOn(registry, "browserUrl");
			// Act
			const view = await readAccountStatus(
				{
					readContext: f.readContext,
					readRemoteStatus: f.readRemoteStatus,
					readRemoteOwnerStatus: f.readRemoteOwnerStatus,
					registry,
				},
				undefined,
				new AbortController().signal,
			);
			// Assert: reading the display is not an operation or browser-window lifecycle event.
			expect(view).toMatchObject({
				accountOwner: { identityId: "identity-a", memoryActorId: "actor-c" },
				operation,
				operationContextId: f.context.contextId,
				canLink: false,
			});
			expect("contextId" in view && view.contextId).not.toBe(f.context.contextId);
			expect(forContext).toHaveBeenCalledExactlyOnceWith(f.context.contextId);
			expect(close).not.toHaveBeenCalled();
			expect(cancel).not.toHaveBeenCalled();
			expect(browserUrl).not.toHaveBeenCalled();
		},
	);
	it("keeps unknown-outcome operations attached to actor C despite a separate display context", async () => {
		// Arrange: an existing operation belongs to C, never the owner display hash.
		const f = fixture();
		const link = vi.fn(async () => {
			throw new CoordinatorAccountLinkError("cancellation_unconfirmed");
		});
		const registry = createAccountLinkRegistry({ readContext: f.readContext, link });
		cleanups.push(() => registry.close());
		const started = registry.start({
			context: f.context,
			expectedCoordinatorId: f.ownerProfile.coordinatorId,
			expectedAuthority: "controller_attestation",
		});
		if (!("operation" in started)) throw new Error("Fixture operation did not start");
		await vi.waitFor(() =>
			expect(registry.get(started.operation.operationId)?.state).toBe("outcome_unknown"),
		);
		// Act
		const view = await readAccountStatus(
			{
				readContext: f.readContext,
				readRemoteStatus: f.readRemoteStatus,
				readRemoteOwnerStatus: f.readRemoteOwnerStatus,
				registry,
			},
			undefined,
			new AbortController().signal,
		);
		// Assert: global busy state and the actual actor's result remain visible.
		expect(view).toMatchObject({
			accountOwner: { identityId: "identity-a", memoryActorId: "actor-c" },
			canLink: false,
			blockedReason: "operation_active",
			operationContextId: f.context.contextId,
			operation: {
				operationId: started.operation.operationId,
				contextId: f.context.contextId,
				state: "outcome_unknown",
			},
		});
		expect(registry.hasActive()).toBe(true);
		expect(link).toHaveBeenCalledWith(expect.objectContaining({ expectedIdentityId: "actor-c" }));
	});
});

describe("ordinary actor compatibility", () => {
	it.each(["absent", "legacy"])(
		"preserves ordinary flow with %s association evidence",
		async (mode) => {
			// Arrange: legacy injected readers cannot exercise the production association path.
			const f = fixture({ associate: mode === "legacy" });
			const readContext =
				mode === "legacy"
					? () => {
							const result = f.readContext();
							if ("context" in result && result.context) delete result.context.publicKeyHash;
							return result;
						}
					: f.readContext;
			f.readRemoteStatus.mockImplementation(async () => ({
				kind: "status",
				status: {
					version: 2,
					coordinatorId: f.ownerProfile.coordinatorId,
					groupId: f.context.groupId,
					deviceId: f.context.deviceId,
					fingerprint: f.context.fingerprint,
					identityId: "actor-c",
					authority: "device_claim",
					state: "unlinked",
					account: null,
				},
			}));
			// Act
			const view = await readAccountStatus(
				{
					readContext,
					readRemoteStatus: f.readRemoteStatus,
					readRemoteOwnerStatus: f.readRemoteOwnerStatus,
				},
				undefined,
				new AbortController().signal,
			);
			// Assert
			expect(view).toMatchObject({
				contextId: f.context.contextId,
				canLink: true,
				remote: { kind: "status", identityId: "actor-c", state: "unlinked" },
			});
			expect(view).not.toHaveProperty("accountOwner");
			expect(f.readRemoteStatus).toHaveBeenCalledOnce();
			expect(f.readRemoteOwnerStatus).not.toHaveBeenCalled();
		},
	);
});

describe("associated owner HTTP mutation isolation", () => {
	it.each(["connect", "refresh", "disconnect"])(
		"rejects raw %s POSTs using either display or actor context",
		async (intent) => {
			// Arrange: actual app, actual context and association; only coordinator transport is mocked.
			const f = fixture();
			const link = vi.fn(async () => {
				throw new Error("Must not link owner");
			});
			const change = vi.fn(async () => {
				throw new Error("Must not mutate owner");
			});
			const registry = createAccountLinkRegistry({ readContext: f.readContext, link, change });
			cleanups.push(() => registry.close());
			const app = createApp({
				accountLink: {
					getListenerAddress: () => ({ host: "127.0.0.1", port: 7441 }),
					readContext: f.readContext,
					readRemoteStatus: f.readRemoteStatus,
					readRemoteOwnerStatus: f.readRemoteOwnerStatus,
					readRemoteCapabilities: f.readRemoteCapabilities,
					registry,
				},
			});
			const session = await app.request(`${ORIGIN}/api/account/session`, {
				headers: { Host: "127.0.0.1:7441" },
			});
			const { csrfToken } = await session.json();
			const headers = {
				Host: "127.0.0.1:7441",
				Origin: ORIGIN,
				"X-Codemem-Account-Csrf": csrfToken,
				"Content-Type": "application/json",
			};
			const status = await app.request(`${ORIGIN}/api/account/link-status`, { headers });
			const view = await status.json();
			// Act
			const responses = [];
			for (const contextId of [view.contextId, f.context.contextId])
				responses.push(
					await app.request(`${ORIGIN}/api/account/link-operations`, {
						method: "POST",
						headers,
						body: JSON.stringify({
							intent,
							groupId: "group-a",
							contextId,
							coordinatorId: f.ownerProfile.coordinatorId,
							authority: "controller_attestation",
							...(intent === "disconnect" ? { expectedLinkId: "link-a" } : {}),
						}),
					}),
				);
			// Assert: valid loopback/CSRF requests still cannot promote a display context to authority.
			expect(status.status).toBe(200);
			expect(view.accountOwner).toEqual({ identityId: "identity-a", memoryActorId: "actor-c" });
			for (const response of responses) {
				expect(response.status).toBe(409);
				expect(await response.json()).toEqual({ error: "account_context_changed" });
			}
			expect(link).not.toHaveBeenCalled();
			expect(change).not.toHaveBeenCalled();
			expect(f.readRemoteCapabilities).not.toHaveBeenCalled();
			expect(f.readContext()).toMatchObject({ context: f.context });
		},
	);
});

/** A switch completion time after the fixture's association file was published. */
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

describe("owner association after this device switched to its owner", () => {
	function switchTo(
		f: ReturnType<typeof fixture>,
		options: { recorded: boolean; target?: string },
	) {
		const target = options.target ?? "identity-a";
		if (options.recorded) {
			const db = connect(f.dbPath);
			db.exec(`CREATE TABLE IF NOT EXISTS local_identity_switches (attempt_id TEXT PRIMARY KEY,
				previous_identity_id TEXT, target_identity_id TEXT, state TEXT, updated_at TEXT)`);
			db.prepare(
				"INSERT INTO local_identity_switches VALUES ('rebind-a', 'actor-c', ?, 'completed', ?)",
			).run(target, later(1));
			db.close();
		}
		f.profile.identityId = target;
		f.config.actor_id = target;
	}

	it("stops showing an association the switch fulfilled", async () => {
		// Arrange
		const f = fixture();
		switchTo(f, { recorded: true });
		// Act
		const view = await f.read();
		// Assert
		expect(view).not.toHaveProperty("ownerProjection");
		expect(view).toMatchObject({ remote: { kind: "status", identityId: "identity-a" } });
	});

	it("stops showing the association after a switch to another account's Identity", async () => {
		// Arrange: the person signed in with a different linked account than the owner's.
		const f = fixture();
		switchTo(f, { recorded: true, target: "identity-c" });
		// Act
		const view = await f.read();
		// Assert
		expect(view).not.toHaveProperty("ownerProjection");
		expect(view).toMatchObject({ remote: { kind: "status", identityId: "identity-c" } });
	});

	it("stops showing the association after successive switches", async () => {
		// Arrange: B -> A, then A -> C; the association still pins B.
		const f = fixture();
		switchTo(f, { recorded: true, target: "identity-a" });
		const db = connect(f.dbPath);
		db.prepare(
			"INSERT INTO local_identity_switches VALUES ('rebind-b', 'identity-a', 'identity-c', 'completed', ?)",
		).run(later(2));
		db.close();
		f.profile.identityId = "identity-c";
		f.config.actor_id = "identity-c";
		// Act
		const view = await f.read();
		// Assert
		expect(view).not.toHaveProperty("ownerProjection");
		expect(view).toMatchObject({ remote: { kind: "status", identityId: "identity-c" } });
	});

	it("doesn't revive the association when the device returns to the pinned Identity", async () => {
		// Arrange: actor-c -> identity-a, then identity-a -> actor-c again.
		const f = fixture();
		switchTo(f, { recorded: true, target: "identity-a" });
		const db = connect(f.dbPath);
		db.prepare(
			"INSERT INTO local_identity_switches VALUES ('rebind-b', 'identity-a', 'actor-c', 'completed', ?)",
		).run(later(2));
		db.close();
		f.profile.identityId = "actor-c";
		f.config.actor_id = "actor-c";
		// Act
		const view = await f.read();
		// Assert
		expect(view).not.toHaveProperty("ownerProjection");
		expect(view).toMatchObject({ remote: { kind: "status", identityId: "actor-c" } });
	});

	it("keeps an association published after the device's earlier switches", async () => {
		// Arrange: actor-c switched away and back long ago; owner recovery published this one since.
		const f = fixture();
		const db = connect(f.dbPath);
		db.exec(`CREATE TABLE IF NOT EXISTS local_identity_switches (attempt_id TEXT PRIMARY KEY,
			previous_identity_id TEXT, target_identity_id TEXT, state TEXT, updated_at TEXT)`);
		db.prepare(
			"INSERT INTO local_identity_switches VALUES ('old', 'actor-c', 'identity-z', 'completed', '2000-01-01T00:00:00Z')",
		).run();
		db.close();
		// Act
		const view = await f.read();
		// Assert
		expect(view).toMatchObject({ ownerProjection: { kind: "resolved_account_owner" } });
	});

	it("still reports corrupt evidence for the current Identity next to a superseded one", async () => {
		// Arrange: B's legacy association was superseded by B -> C; C then got its own, now corrupt.
		const home = mkdtempSync(join(tmpdir(), "viewer-owner-home-"));
		cleanups.push(() => rmSync(home, { recursive: true, force: true }));
		vi.stubEnv("HOME", home);
		const f = fixture();
		switchTo(f, { recorded: true, target: "identity-c" });
		const current = { ...f.ownerProfile, actorId: "identity-c" };
		retainAccountOwnerAssociation(
			current,
			{
				ownerIdentityId: "identity-a",
				attestationId: `controller-v1:${"c".repeat(64)}`,
				reviewDigest: "d".repeat(64),
			},
			{ expectedProfilePins: captureAccountOwnerProfilePins(current) },
		);
		const directory = join(home, ".codemem", "account-owner-associations");
		const file = readdirSync(directory).find((name) => name.startsWith(".account-owner-"));
		if (!file) throw new Error("Missing current association fixture");
		chmodSync(join(directory, file), 0o600);
		writeFileSync(join(directory, file), "not json");
		// Act
		const view = await f.read();
		// Assert
		expect(view).toMatchObject({ remote: { kind: "unavailable" } });
	});

	it("still flags an association whose Identity changed without a recorded switch", async () => {
		// Arrange
		const f = fixture();
		switchTo(f, { recorded: false });
		// Act
		const view = await f.read();
		// Assert
		expect(view).toMatchObject({ remote: { kind: "unavailable" } });
	});
});

describe("sign-in from the owner-only state", () => {
	function readWith(f: ReturnType<typeof fixture>, options: { ownIdentityOnly?: boolean } = {}) {
		const registry = createAccountLinkRegistry({
			readContext: f.readContext,
			rebind: async () => ({ kind: "failed" }),
		});
		cleanups.push(() => registry.close());
		return readAccountStatus(
			{
				readContext: f.readContext,
				readRemoteStatus: f.readRemoteStatus,
				readRemoteOwnerStatus: f.readRemoteOwnerStatus,
				registry,
			},
			undefined,
			new AbortController().signal,
			options,
		);
	}

	it("offers sign-in that starts from this device's own Identity", async () => {
		// Arrange
		const f = fixture();
		// Act
		const view = await readWith(f);
		// Assert
		expect(view).toMatchObject({
			ownerProjection: { kind: "resolved_account_owner" },
			canSignIn: true,
			signIn: {
				contextId: f.context.contextId,
				coordinatorId: "actual-coordinator-id",
				authority: "device_claim",
			},
		});
	});

	it.each(["review_required", "conflict"] as const)(
		"checks recovered-owner sign-in against ordinary %s status",
		async (state) => {
			// Arrange: the same verified owner must not override an ordinary conflict.
			const f = fixture();
			f.readRemoteStatus.mockImplementation(async () => {
				const read = f.status("actor-c");
				if (read.kind !== "status") throw new Error("Expected status");
				return {
					...read,
					status: { ...read.status, state, identityId: null, authority: null, account: null },
				};
			});
			// Act
			const view = await readWith(f);
			const own = await readWith(f, { ownIdentityOnly: true });
			// Assert
			expect(view).toMatchObject({ canLink: false, canSignIn: state === "review_required" });
			if (state === "review_required") {
				expect(view).toHaveProperty("signIn", {
					contextId: f.context.contextId,
					coordinatorId: "actual-coordinator-id",
					authority: null,
				});
				expect(own).toMatchObject({
					contextId: f.context.contextId,
					canSignIn: true,
					canLink: false,
					remote: { kind: "status", state, authority: null },
				});
			} else {
				expect(view).not.toHaveProperty("signIn");
				expect(own).toMatchObject({ canSignIn: false });
				expect(own).not.toHaveProperty("contextId", f.context.contextId);
			}
			expect(view).not.toHaveProperty("managementActions");
			expect(view).not.toHaveProperty("unlinkTarget");
		},
	);

	it("does not offer switching to the owner when this device's own Identity is linked", async () => {
		// Arrange: this device's Identity is linked on another device, so a switch would be refused.
		const f = fixture();
		f.readRemoteStatus.mockImplementation(async (input: { identityId: string }) => {
			const read = f.status(input.identityId);
			if (read.kind !== "status") throw new Error("expected status");
			return { ...read, status: { ...read.status, state: "linked", account: null } };
		});
		// Act
		const view = await readWith(f);
		// Assert
		expect(view).not.toHaveProperty("signIn");
		expect((view as AccountLinkViewV1).canSignIn).not.toBe(true);
	});

	it("does not offer sign-in when the owner has no linked account", async () => {
		// Arrange
		const f = fixture();
		f.readRemoteOwnerStatus.mockResolvedValue({
			kind: "owner_status",
			status: { ...f.ownerStatus().status, profileState: "account_unlinked", profile: null },
		} as CoordinatorResolvedAccountOwnerStatusRead);
		// Act
		const view = await readWith(f);
		// Assert
		expect(view).not.toHaveProperty("signIn");
		expect((view as AccountLinkViewV1).canSignIn).not.toBe(true);
	});

	it("keeps the owner view for a sign-in start the owner view doesn't offer", async () => {
		// Arrange: the owner has no linked Google account, so sign-in is not offered.
		const f = fixture();
		f.readRemoteOwnerStatus.mockResolvedValue({
			kind: "owner_status",
			status: { ...f.ownerStatus().status, profileState: "account_unlinked", profile: null },
		} as CoordinatorResolvedAccountOwnerStatusRead);
		// Act
		const view = await readWith(f, { ownIdentityOnly: true });
		// Assert: the start route rejects any view other than this device's own.
		expect((view as AccountLinkViewV1).contextId).not.toBe(f.context.contextId);
	});

	it("fails closed for a sign-in start when the association is invalid", async () => {
		// Arrange
		const f = fixture();
		f.editAssociation({ ownerIdentityId: "not valid!" });
		// Act
		const view = await readWith(f, { ownIdentityOnly: true });
		// Assert
		expect(view).toMatchObject({ remote: { kind: "unavailable" } });
	});

	it("checks sign-in against this device's own Identity when starting", async () => {
		// Arrange
		const f = fixture();
		// Act
		const view = await readWith(f, { ownIdentityOnly: true });
		// Assert
		expect(view).not.toHaveProperty("ownerProjection");
		expect(view).toMatchObject({ contextId: f.context.contextId, canSignIn: true });
	});
});

describe("sign-in for a linked Identity", () => {
	it.each([
		["without its own proof", null, true],
		["with its own proof", { email: "owner@example.test" }, false],
	] as const)("offers sign-in to a device %s: %s", async (_label, account, canSignIn) => {
		// Arrange: this device's own Identity is linked.
		const f = fixture({ associate: false });
		f.readRemoteStatus.mockImplementation(async (input: { identityId: string }) => {
			const read = f.status(input.identityId);
			if (read.kind !== "status") throw new Error("expected status");
			return { ...read, status: { ...read.status, state: "linked", account } };
		});
		const registry = createAccountLinkRegistry({
			readContext: f.readContext,
			rebind: async () => ({ kind: "failed" }),
		});
		cleanups.push(() => registry.close());
		// Act
		const view = await readAccountStatus(
			{ readContext: f.readContext, readRemoteStatus: f.readRemoteStatus, registry },
			undefined,
			new AbortController().signal,
		);
		// Assert
		expect(view).toMatchObject({ remote: { state: "linked" }, canSignIn });
	});
});
