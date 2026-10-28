import { deepStrictEqual } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { retainAccountOwnerAssociation } from "../../../core/src/account-owner-association.js";
import {
	recoveryAssociationFiles,
	recoveryFixture,
	recoveryTests,
} from "../../test/owner-recovery-service-fixture.js";
import { createApp } from "../index.js";
import { createAccountContextReader } from "./context.js";
import { createAccountOwnerRecoveryService } from "./owner-recovery-service.js";
import { readOwnerAssociation } from "./owner-status.js";

recoveryTests();
const LOCAL = "http://127.0.0.1:7441";
async function setup() {
	const f = await recoveryFixture();
	const result = f.readContext();
	if (!("context" in result) || !result.context)
		throw new Error("Missing genuine captured context");
	return { ...f, context: result.context };
}

it("fixture control: explicit pinned generation is readable by the existing core helper", async () => {
	// Arrange
	const f = await setup();
	const before = f.immutableSnapshot();
	// Act
	f.retain("identity-a");
	// Assert
	expect(f.association()).toMatchObject({ ownerIdentityId: "identity-a", actorId: "identity-b" });
	deepStrictEqual(f.immutableSnapshot(), before);
});

it("finds a current-context generation through a fresh Viewer owner reader without rewriting it", async () => {
	// Arrange
	const f = await setup();
	f.retain("identity-a");
	const files = recoveryAssociationFiles(f.directory);
	const before = files.map((path) => readFileSync(path));
	// Act
	const result = readOwnerAssociation(f.context, f.ownerProfile().coordinatorId);
	// Assert
	expect(files).toHaveLength(1);
	expect(result).toMatchObject({ ownerIdentityId: "identity-a", actorId: "identity-b" });
	deepStrictEqual(
		files.map((path) => readFileSync(path)),
		before,
	);
});

it("keeps legacy association fallback readable when no current generation exists", async () => {
	// Arrange
	const f = await setup();
	retainAccountOwnerAssociation(f.ownerProfile(), {
		ownerIdentityId: "identity-a",
		attestationId: f.proof.controller.attestation_id,
		reviewDigest: f.proof.controller.evidence_digest,
	});
	// Act
	const result = readOwnerAssociation(f.context, f.ownerProfile().coordinatorId);
	// Assert
	expect(result).toMatchObject({ ownerIdentityId: "identity-a", actorId: "identity-b" });
	expect(f.association()).toMatchObject({ ownerIdentityId: "identity-a" });
});

it("selects only the current actor generation while retaining the old actor's bytes", async () => {
	// Arrange
	const f = await setup();
	f.retain("identity-a");
	const oldFiles = recoveryAssociationFiles(f.directory);
	const oldBytes = oldFiles.map((path) => readFileSync(path));
	f.profile.identityId = "identity-next";
	f.config.actor_id = "identity-next";
	const current = f.readContext();
	if (!("context" in current) || !current.context) throw new Error("Missing changed actor context");
	// Act
	const absent = readOwnerAssociation(current.context, f.ownerProfile().coordinatorId);
	f.retain("identity-a");
	const result = readOwnerAssociation(current.context, f.ownerProfile().coordinatorId);
	// Assert
	expect(oldFiles).toHaveLength(1);
	expect(absent).toBeNull();
	expect(result).toMatchObject({ ownerIdentityId: "identity-a", actorId: "identity-next" });
	deepStrictEqual(
		oldFiles.map((path) => readFileSync(path)),
		oldBytes,
	);
});

it.each(["generation", "legacy"])(
	"does not expose malformed %s contents as owner metadata",
	async (mode) => {
		// Arrange
		const f = await setup();
		if (mode === "generation") f.retain("identity-a");
		else
			retainAccountOwnerAssociation(f.ownerProfile(), {
				ownerIdentityId: "identity-a",
				attestationId: f.proof.controller.attestation_id,
				reviewDigest: f.proof.controller.evidence_digest,
			});
		const path = recoveryAssociationFiles(f.directory)[0];
		if (!path) throw new Error("Missing retained association fixture");
		writeFileSync(path, '{"ownerIdentityId":"private-malformed-owner","secret":"not-public"}');
		// Act: callers may fail closed by null or the existing stable association error.
		let result: unknown;
		try {
			result = readOwnerAssociation(f.context, f.ownerProfile().coordinatorId);
		} catch (error) {
			result = error instanceof Error ? error.message : "unexpected";
		}
		// Assert
		expect([null, "account_owner_association_invalid"]).toContain(result);
		expect(JSON.stringify(result)).not.toMatch(/private-malformed-owner|not-public/);
	},
);

it("reads the current generation without deleting an older valid legacy association for another actor", async () => {
	// Arrange
	const f = await setup();
	retainAccountOwnerAssociation(f.ownerProfile(), {
		ownerIdentityId: "identity-a",
		attestationId: f.proof.controller.attestation_id,
		reviewDigest: f.proof.controller.evidence_digest,
	});
	const path = recoveryAssociationFiles(f.directory)[0];
	if (!path) throw new Error("Missing genuine legacy association");
	const original = readFileSync(path);
	f.profile.identityId = "identity-next";
	f.config.actor_id = "identity-next";
	f.retain("identity-a");
	const current = f.readContext();
	if (!("context" in current) || !current.context) throw new Error("Missing current context");
	// Act
	const result = readOwnerAssociation(current.context, f.ownerProfile().coordinatorId);
	// Assert
	expect(result).toMatchObject({ ownerIdentityId: "identity-a", actorId: "identity-next" });
	deepStrictEqual(readFileSync(path), original);
});

it("a restarted Viewer reads a proven imported generation while actor operations stay separate", async () => {
	// Arrange: publication happens through the already-tested real signed service; this isolates restart lookup.
	const f = await setup();
	f.setAdmin(null);
	const service = createAccountOwnerRecoveryService(f.serviceOptions);
	f.cleanup(() => service.close());
	const profile = (await service.getProfile()).profile;
	const imported = await service.importReply({
		selection: { profile, existingOwnerId: "identity-a", groups: ["group-a"] },
		replyText: JSON.stringify(f.reply()),
	});
	expect(imported.groups[0]?.status).toBe("confirmed");
	await service.close();
	const before = f.immutableSnapshot();
	const freshReader = createAccountContextReader({
		getProfile: () => f.profile,
		readConfig: () => f.config,
		keysDir: f.keysDir,
		configPath: f.context.configPath,
	});
	vi.stubGlobal("fetch", f.transport);
	const app = createApp({
		accountLink: {
			readContext: freshReader,
			registry: f.registry,
			getListenerAddress: () => ({ host: "127.0.0.1", port: 7441 }),
		},
	});
	const session = await app.request(`${LOCAL}/api/account/session`, {
		headers: { Host: "127.0.0.1:7441" },
	});
	const { csrfToken } = await session.json();
	// Act
	const response = await app.request(`${LOCAL}/api/account/link-status`, {
		headers: { Host: "127.0.0.1:7441", "X-Codemem-Account-Csrf": csrfToken },
	});
	const view = await response.json();
	// Assert
	expect(response.status).toBe(200);
	expect(view).toMatchObject({
		local: { identityId: "identity-b" },
		accountOwner: { identityId: "identity-a", memoryActorId: "identity-b" },
		remote: { kind: "not_checked" },
		ownerProjection: {
			status: { state: "owner_confirmed", profileState: "linked", ownerIdentity: "identity-a" },
		},
		canLink: false,
	});
	expect(view).not.toHaveProperty("managementActions");
	expect(view).not.toHaveProperty("unlinkTarget");
	expect(freshReader()).toMatchObject({ context: { identityId: "identity-b" } });
	deepStrictEqual(f.immutableSnapshot(), before);
	expect(f.link).not.toHaveBeenCalled();
});
