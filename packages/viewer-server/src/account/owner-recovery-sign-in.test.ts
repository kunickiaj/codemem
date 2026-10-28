import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { signAccountLinkRequest } from "../../../core/src/coordinator-account-link-signer.js";
import {
	recoveryFixture,
	recoveryTests,
	selectionFor,
} from "../../test/owner-recovery-service-fixture.js";
import { createApp } from "../index.js";
import { createAccountLinkRegistry } from "./link-registry.js";
import { createAccountOwnerRecoveryService } from "./owner-recovery-service.js";
import { readAccountStatus } from "./status.js";

recoveryTests();

async function protectedViewer(
	f: Awaited<ReturnType<typeof recoveryFixture>>,
	registry: ReturnType<typeof createAccountLinkRegistry>,
) {
	const origin = "http://127.0.0.1:7441";
	const app = createApp({
		accountLink: {
			...f.serviceOptions,
			registry,
			getListenerAddress: () => ({ host: "127.0.0.1", port: 7441 }),
		},
	});
	const session = await app.request(`${origin}/api/account/session`, {
		headers: { Host: "127.0.0.1:7441" },
	});
	const { csrfToken } = await session.json();
	return (body: Record<string, unknown>) =>
		app.request(`${origin}/api/account/link-operations`, {
			method: "POST",
			headers: {
				Host: "127.0.0.1:7441",
				Origin: origin,
				"Content-Type": "application/json",
				"X-Codemem-Account-Csrf": csrfToken,
			},
			body: JSON.stringify(body),
		});
}

async function startSignedRebind(f: Awaited<ReturnType<typeof recoveryFixture>>, actorId: string) {
	const url = `${f.config.sync_coordinator_url}/v1/auth/rebind-attempts`;
	const body = JSON.stringify({
		group_id: "group-a",
		identity_id: actorId,
		attempt_id: "null-enrollment-rebind",
		browser_start_hash: "a".repeat(64),
		review_digest: "b".repeat(64),
		loopback_redirect: "http://127.0.0.1:4567/codemem/auth/complete",
	});
	const headers = signAccountLinkRequest({
		dbPath: f.dbPath,
		keysDir: f.keysDir,
		device: f.signer,
		method: "POST",
		url,
		bodyBytes: Buffer.from(body),
	});
	return f.transport(url, { method: "POST", headers, body });
}

it.each([false, true])(
	"offers recovered-owner sign-in without ordinary actor authority (existing receipt: %s)",
	async (fact) => {
		// Arrange: real signed status and admin review requests, with no external network.
		const f = await recoveryFixture({ fact, maintainedReview: true });
		vi.stubGlobal("fetch", f.transport);
		const service = createAccountOwnerRecoveryService(f.serviceOptions);
		f.cleanup(() => service.close());
		const rebind = vi.fn(async () => ({ kind: "failed" as const }));
		const registry = createAccountLinkRegistry({
			readContext: f.readContext,
			rebind,
			link: f.link,
		});
		f.cleanup(() => registry.close());
		const readOrdinary = () =>
			f.readRemoteStatus({
				dbPath: f.dbPath,
				keysDir: f.keysDir,
				groupId: "group-a",
				coordinatorUrl: String(f.config.sync_coordinator_url),
				identityId: "identity-b",
			});
		const before = await readOrdinary();
		const selection = await selectionFor(service);
		const preview = await service.preview({
			...selection,
			purpose: "review",
			requestId: "sign-in-regression",
		});

		// Act: recover the owner without switching the local memory actor.
		const recovered = await service.confirm({ preview, approvalDigest: preview.approvalDigest });
		const after = await readOrdinary();
		const view = await readAccountStatus(
			{ ...f.serviceOptions, registry },
			"group-a",
			new AbortController().signal,
		);

		const own = await readAccountStatus(
			{ ...f.serviceOptions, registry },
			"group-a",
			new AbortController().signal,
			{ ownIdentityOnly: true },
		);
		const current = f.readContext("group-a");
		if ("error" in current || !current.context) throw new Error("Missing current context");
		const post = await protectedViewer(f, registry);
		const request = {
			intent: "sign_in",
			groupId: "group-a",
			contextId: current.context.contextId,
			coordinatorId: "coordinator-a",
			authority: null,
		};
		const foreign = await post({ ...request, contextId: "foreign-context" });
		const display = await post({ ...request, contextId: "error" in view ? null : view.contextId });
		const started = await post(request);
		await Promise.resolve();

		// Assert: only sign-in uses the current actor context. Owner display grants no management.
		expect(recovered.groups).toMatchObject([{ groupId: "group-a", status: "confirmed" }]);
		expect(f.association()).toMatchObject({ ownerIdentityId: "identity-a", actorId: "identity-b" });
		expect(registry.supportsSignIn()).toBe(true);
		expect(view).toMatchObject({
			local: { identityId: "identity-b" },
			accountOwner: { identityId: "identity-a", memoryActorId: "identity-b" },
			canSignIn: true,
			canLink: false,
			signIn: {
				contextId: current.context.contextId,
				coordinatorId: "coordinator-a",
				authority: null,
			},
			remote: { kind: "not_checked" },
			ownerProjection: {
				status: {
					state: "owner_confirmed",
					ownerIdentity: "identity-a",
					profileState: "linked",
					profile: {},
				},
			},
		});
		expect(view).not.toHaveProperty("managementActions");
		expect(view).not.toHaveProperty("unlinkTarget");
		expect(view).toHaveProperty("ownerProjection.status.profile", {});
		expect(own).toMatchObject({
			contextId: current.context.contextId,
			canSignIn: true,
			canLink: false,
			remote: { kind: "status", state: "review_required", authority: null, account: null },
		});
		expect(own).not.toHaveProperty("ownerProjection");
		expect(own).not.toHaveProperty("accountOwner");
		expect(foreign.status).toBe(409);
		expect(display.status).toBe(409);
		expect(await foreign.json()).toEqual({ error: "account_context_changed" });
		expect(await display.json()).toEqual({ error: "account_context_changed" });
		expect(started.status).toBe(202);
		expect((await started.json()).operation).toMatchObject({
			intent: "sign_in",
			contextId: current.context.contextId,
			groupId: "group-a",
		});
		expect(rebind).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ context: current.context }),
		);
		expect(f.link).not.toHaveBeenCalled();
		if (before.kind !== "status" || after.kind !== "status" || "error" in view)
			throw new Error("Missing real coordinator or Viewer status");
		for (const read of [before, after])
			expect(read.status).toMatchObject({
				deviceId: f.deviceId,
				fingerprint: f.fingerprint,
				state: "review_required",
				authority: null,
				identityId: null,
				account: null,
			});
	},
);

it("offers recovered-owner sign-in for NULL enrollments and the default local actor across groups", async () => {
	// Arrange: current enrollments name no Identity. Retained history still names identity-b.
	const groups = ["group-a", "group-two"];
	const f = await recoveryFixture({ fact: false, maintainedReview: true, groups });
	const actorId = `local:${f.deviceId}`;
	f.profile.identityId = actorId;
	delete f.config.actor_id;
	writeFileSync(join(f.directory, "selected-config.json"), "{}");
	f.db
		.prepare(
			"UPDATE enrolled_devices SET identity_id = NULL WHERE device_id = ? AND group_id IN (?, ?)",
		)
		.run(f.deviceId, ...groups);
	vi.stubGlobal("fetch", f.transport);
	const service = createAccountOwnerRecoveryService(f.serviceOptions);
	f.cleanup(() => service.close());
	const rebind = vi.fn(async () => ({ kind: "failed" as const }));
	const registry = createAccountLinkRegistry({ readContext: f.readContext, rebind });
	f.cleanup(() => registry.close());
	const readOrdinary = (groupId: string) =>
		f.readRemoteStatus({
			dbPath: f.dbPath,
			keysDir: f.keysDir,
			groupId,
			coordinatorUrl: String(f.config.sync_coordinator_url),
			identityId: actorId,
		});
	const before = await Promise.all(groups.map(readOrdinary));
	const selection = await selectionFor(service, groups);
	const preview = await service.preview({
		...selection,
		purpose: "review",
		requestId: "null-enrollment-regression",
	});

	// Act: real admin confirmation, ordinary signed reads, and Viewer owner projection.
	const recovered = await service.confirm({ preview, approvalDigest: preview.approvalDigest });
	const after = await Promise.all(groups.map(readOrdinary));
	const views = await Promise.all(
		groups.map((groupId) =>
			readAccountStatus({ ...f.serviceOptions, registry }, groupId, new AbortController().signal),
		),
	);
	// Exercise only the signed rebind start. No loopback listener, Google request, or finalize.
	const start = await startSignedRebind(f, actorId);
	const startBody = await start.json();

	// Assert: recovery offers a separate sign-in target without changing enrollment or author.
	expect(recovered.groups).toMatchObject(
		groups.map((groupId) => ({ groupId, status: "confirmed" })),
	);
	expect(registry.supportsSignIn()).toBe(true);
	for (const [index, view] of views.entries()) {
		const current = f.readContext(groups[index]);
		if ("error" in current || !current.context) throw new Error("Missing current context");
		expect(view).toMatchObject({
			local: { identityId: actorId },
			accountOwner: { identityId: "identity-a", memoryActorId: actorId },
			canSignIn: true,
			canLink: false,
			signIn: {
				contextId: current.context.contextId,
				coordinatorId: "coordinator-a",
				authority: null,
			},
			blockedReason: "already_linked",
			ownerProjection: {
				status: {
					state: "owner_confirmed",
					ownerIdentity: "identity-a",
					profileState: "linked",
					profile: {},
				},
			},
		});
		expect(view).not.toHaveProperty("managementActions");
		expect(view).not.toHaveProperty("unlinkTarget");
		expect(view).toHaveProperty("ownerProjection.status.profile", {});
	}
	expect(
		f.db
			.prepare(
				"SELECT group_id, identity_id FROM enrolled_devices WHERE device_id = ? AND group_id IN (?, ?) ORDER BY group_id",
			)
			.all(f.deviceId, ...groups),
	).toEqual(groups.map((group_id) => ({ group_id, identity_id: null })));
	expect(rebind).not.toHaveBeenCalled();
	const expected = groups.map((groupId) => ({
		kind: "status",
		status: {
			version: 2,
			coordinatorId: "coordinator-a",
			groupId,
			deviceId: f.deviceId,
			fingerprint: f.fingerprint,
			identityId: null,
			authority: null,
			state: "review_required",
			account: null,
		},
	}));
	expect(before).toEqual(expected);
	expect(after).toEqual(expected);
	expect(start.status).toBe(200);
	expect(startBody).toEqual({
		attempt_id: "null-enrollment-rebind",
		coordinator_id: "coordinator-a",
		auth_config_revision: "a".repeat(64),
		issuer: "https://accounts.google.com",
		origin: String(f.config.sync_coordinator_url),
		expires_at_ms: f.clock.now + 600_000,
	});
});

it.each(["no-owner", "owner-unlinked"])(
	"refuses null-authority sign-in with real review status and %s",
	async (mode) => {
		// Arrange: an ordinary review-required device needs a current, linked, verified owner.
		const f = await recoveryFixture();
		if (mode === "owner-unlinked") {
			f.retain("identity-a");
			f.db
				.prepare(
					"UPDATE coordinator_auth_account_links SET revoked_at_ms=? WHERE identity_id='identity-a'",
				)
				.run(f.clock.now);
		}
		const rebind = vi.fn(async () => ({ kind: "failed" as const }));
		const registry = createAccountLinkRegistry({
			readContext: f.readContext,
			rebind,
			link: f.link,
		});
		f.cleanup(() => registry.close());
		const current = f.readContext("group-a");
		if ("error" in current || !current.context) throw new Error("Missing current context");
		const post = await protectedViewer(f, registry);

		// Act
		const view = await readAccountStatus(
			{ ...f.serviceOptions, registry },
			"group-a",
			new AbortController().signal,
		);
		const own = await readAccountStatus(
			{ ...f.serviceOptions, registry },
			"group-a",
			new AbortController().signal,
			{ ownIdentityOnly: true },
		);
		const response = await post({
			intent: "sign_in",
			groupId: "group-a",
			contextId: current.context.contextId,
			coordinatorId: "coordinator-a",
			authority: null,
		});

		// Assert: neither local enrollment nor an unlinked owner authorizes a switch.
		expect(view).toMatchObject({ canSignIn: false, canLink: false });
		expect(view).not.toHaveProperty("signIn");
		expect(own).toMatchObject({ canSignIn: false, canLink: false });
		expect(response.status).toBe(409);
		expect(rebind).not.toHaveBeenCalled();
		expect(f.link).not.toHaveBeenCalled();
	},
);
