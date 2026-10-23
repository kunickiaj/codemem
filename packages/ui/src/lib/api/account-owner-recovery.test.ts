import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	recoveryEnvelope,
	recoveryPreview,
	recoveryRequest,
} from "../../tabs/owner-recovery-test-utils";

let api: typeof import("./account");
const transport = vi.fn<typeof fetch>();
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const ROOT = "/api/account/owner-recovery";
beforeEach(async () => {
	vi.resetModules();
	api = await import("./account");
	vi.stubGlobal("fetch", transport.mockReset());
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("keeps recovery helpers dormant when the account module is imported", async () => {
	// Arrange: install the transport spy before evaluating the module again.
	vi.resetModules();
	// Act
	await import("./account");
	// Assert
	expect(transport).not.toHaveBeenCalled();
});

describe("protected owner recovery API", () => {
	it("gets a typed public profile with CSRF, same-origin transport and an abort signal", async () => {
		// Arrange
		const envelope = recoveryEnvelope(),
			controller = new AbortController();
		const storage = vi.spyOn(Storage.prototype, "setItem");
		transport
			.mockResolvedValueOnce(reply({ csrfToken: "fixture-token" }))
			.mockResolvedValueOnce(reply(envelope));
		// Act
		const result = await api.getOwnerRecoveryProfile(controller.signal);
		// Assert
		expect(result).toEqual(envelope);
		expect(transport.mock.calls.map(([url]) => url)).toEqual(["/api/account/session", ROOT]);
		for (const [, options] of transport.mock.calls)
			expect(options).toMatchObject({
				credentials: "same-origin",
				redirect: "error",
				cache: "no-store",
				signal: controller.signal,
			});
		expect(transport.mock.calls[1][1]?.headers).toEqual({
			"X-Codemem-Account-Csrf": "fixture-token",
		});
		expect(storage).not.toHaveBeenCalled();
	});
	it("serializes nested selections, preview consent and reply text without credentials or external requests", async () => {
		// Arrange
		const controller = new AbortController();
		const request = recoveryRequest(),
			preview = recoveryPreview(request);
		const confirm = { preview, approvalDigest: preview.approvalDigest };
		const selection = {
			profile: request.profile,
			existingOwnerId: request.existingOwnerId,
			groups: request.groups,
		};
		const imported = { selection, replyText: JSON.stringify({ version: 1, groups: [] }) };
		transport.mockImplementation(async (url) => {
			if (url === "/api/account/session") return reply({ csrfToken: "fixture-token" });
			return reply(
				String(url).endsWith("preview")
					? preview
					: {
							preview,
							groups: preview.groups.map((groupId) => ({
								groupId,
								status: "confirmed",
								message: "Verified.",
							})),
						},
			);
		});
		// Act
		await api.previewOwnerRecovery(request, controller.signal);
		await api.confirmOwnerRecovery(confirm, controller.signal);
		await api.importOwnerRecoveryReply(imported, controller.signal);
		// Assert
		expect(
			transport.mock.calls
				.slice(1)
				.map(([url, options]) => [url, options?.method, JSON.parse(String(options?.body))]),
		).toEqual([
			[`${ROOT}/preview`, "POST", request],
			[`${ROOT}/confirm`, "POST", confirm],
			[`${ROOT}/import`, "POST", imported],
		]);
		for (const [, options] of transport.mock.calls.slice(1))
			expect(options).toMatchObject({
				signal: controller.signal,
				redirect: "error",
				credentials: "same-origin",
				cache: "no-store",
				headers: { "X-Codemem-Account-Csrf": "fixture-token", "Content-Type": "application/json" },
			});
		expect(JSON.stringify(transport.mock.calls)).not.toMatch(
			/adminSecret|Authorization|dbPath|keysDir|privateKey/,
		);
	});
	it("renews only an explicit pre-dispatch CSRF refusal before sending the same confirmation once more", async () => {
		// Arrange
		const preview = recoveryPreview();
		transport
			.mockResolvedValueOnce(reply({ csrfToken: "old" }))
			.mockResolvedValueOnce(reply({ error: "account_csrf_invalid" }, 403))
			.mockResolvedValueOnce(reply({ csrfToken: "new" }))
			.mockResolvedValueOnce(
				reply({
					preview,
					groups: preview.groups.map((groupId) => ({
						groupId,
						status: "confirmed",
						message: "Verified.",
					})),
				}),
			);
		// Act
		await api.confirmOwnerRecovery({ preview, approvalDigest: preview.approvalDigest });
		// Assert
		expect(transport).toHaveBeenCalledTimes(4);
		expect(transport.mock.calls[3][1]?.body).toBe(transport.mock.calls[1][1]?.body);
		expect(transport.mock.calls[3][1]?.headers).toMatchObject({ "X-Codemem-Account-Csrf": "new" });
	});
	it.each(["network", "unknown denial", "transient"])(
		"never retries confirmation after %s",
		async (failure) => {
			// Arrange
			const preview = recoveryPreview();
			transport.mockResolvedValueOnce(reply({ csrfToken: "fixture" }));
			if (failure === "network") transport.mockRejectedValueOnce(new Error("Lost reply"));
			else
				transport.mockResolvedValueOnce(
					reply(
						{ error: "account_owner_recovery_unavailable" },
						failure === "transient" ? 503 : 403,
					),
				);
			// Act
			const result = api.confirmOwnerRecovery({ preview, approvalDigest: preview.approvalDigest });
			// Assert
			await expect(result).rejects.toBeInstanceOf(Error);
			expect(transport).toHaveBeenCalledTimes(2);
		},
	);
});
describe("recovery wire response validation", () => {
	it.each(["invalid", "busy", "context_changed", "unavailable"])(
		"preserves the safe recovery error code %s",
		async (suffix) => {
			// Arrange
			const code = `account_owner_recovery_${suffix}`;
			transport
				.mockResolvedValueOnce(reply({ csrfToken: "fixture" }))
				.mockResolvedValueOnce(reply({ error: code }, 409));
			// Act
			const result = api.getOwnerRecoveryProfile();
			// Assert
			await expect(result).rejects.toMatchObject({ code, message: code });
		},
	);
	it("hides arbitrary backend diagnostic text instead of displaying it as an error code", async () => {
		// Arrange
		transport
			.mockResolvedValueOnce(reply({ csrfToken: "fixture" }))
			.mockResolvedValueOnce(reply({ error: "SELECT secret FROM provider_tokens" }, 500));
		// Act
		const result = api.getOwnerRecoveryProfile();
		// Assert
		await expect(result).rejects.toMatchObject({
			code: "request_failed",
			message: "request_failed",
		});
	});
	it.each(["version", "profile", "candidate", "groups"])(
		"rejects malformed profile envelope: %s",
		async (fault) => {
			// Arrange
			const envelope = recoveryEnvelope();
			const payload: Record<string, unknown> = structuredClone(envelope);
			if (fault === "version") payload.version = 2;
			if (fault === "profile") payload.profile = null;
			if (fault === "candidate") payload.candidates = [{ id: 7 }];
			if (fault === "groups")
				payload.profile = { ...envelope.profile, configuredGroups: ["group-one", "group-one"] };
			transport
				.mockResolvedValueOnce(reply({ csrfToken: "fixture" }))
				.mockResolvedValueOnce(reply(payload));
			// Act
			const result = api.getOwnerRecoveryProfile();
			// Assert
			await expect(result).rejects.toMatchObject({ code: "invalid_response" });
		},
	);
	it("rejects malformed preview consent metadata rather than accepting an old incomplete server contract", async () => {
		// Arrange
		const { reviewedWeakLabels: _omitted, ...oldPreview } = recoveryPreview();
		transport
			.mockResolvedValueOnce(reply({ csrfToken: "fixture" }))
			.mockResolvedValueOnce(reply(oldPreview));
		// Act
		const result = api.previewOwnerRecovery(recoveryRequest());
		// Assert
		await expect(result).rejects.toMatchObject({ code: "invalid_response" });
	});
});
