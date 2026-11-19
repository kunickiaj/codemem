import { MemoryStore } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCoordinatorInvitationCreateCommand,
	type InvitationCreateDeps,
} from "./coordinator-invitation-create.js";

const NOW = "2026-11-17T12:00:00.000Z";
const PREVIEW = {
	reviewedOnboardingDigest: "digest-1",
	team: { displayName: "Platform" },
	projects: [{ displayName: "codemem", existingMemoryCount: 12 }],
};

function seededStore(): MemoryStore {
	const store = new MemoryStore(":memory:");
	store.db
		.prepare(
			`INSERT INTO policy_teams(
			 team_id, display_name, status, provenance, revision, migration_state,
			 idempotency_key, created_at, updated_at
			 ) VALUES ('team-platform', 'Platform', 'active', 'test', 'r1', 'user_managed', 'k1', ?, ?)`,
		)
		.run(NOW, NOW);
	return store;
}

let logSpy: ReturnType<typeof vi.spyOn>;
let deps: InvitationCreateDeps & {
	preview: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
};
let actorId = "";
const previousExitCode = process.exitCode;

beforeEach(() => {
	logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	process.exitCode = undefined;
	deps = {
		openStore: () => {
			const store = seededStore();
			actorId = store.actorId;
			return store;
		},
		preview: vi.fn(() => ({
			httpStatus: 200 as const,
			body: { kind: "team_member", preview: PREVIEW },
		})),
		create: vi.fn(async () => ({
			httpStatus: 200 as const,
			body: { ok: true, kind: "team_member", preview: PREVIEW, invite: { encoded: "code" } },
		})),
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = previousExitCode;
});

async function run(args: string[]): Promise<Record<string, unknown>> {
	await buildCoordinatorInvitationCreateCommand(deps).parseAsync([...args, "--json"], {
		from: "user",
	});
	return JSON.parse(String(logSpy.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
}

describe("codemem coordinator invitation create", () => {
	it("refuses to create a connection-only invitation", async () => {
		const output = await run([]);

		expect(output).toMatchObject({ error: "invitation_kind_required" });
		expect(String(output.message)).toContain("Choose --team <name> or --add-device");
		expect(deps.preview).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(2);
	});

	it("explains the old group form instead of rejecting its argument", async () => {
		const output = await run(["my-team"]);

		expect(output).toMatchObject({ error: "invitation_kind_required" });
		expect(String(output.message)).toContain("no longer creates invitations that only connect");
		expect(String(output.message)).toContain("codemem coordinator device enroll");
		expect(deps.preview).not.toHaveBeenCalled();
	});

	it("reviews a Team invitation by Team name without creating it", async () => {
		const output = await run(["--team", "platform", "--review"]);

		expect(output).toMatchObject({ kind: "team_member", preview: PREVIEW });
		expect(deps.preview).toHaveBeenCalledWith(
			expect.any(MemoryStore),
			expect.objectContaining({ kind: "team_member", policy_team_id: "team-platform" }),
		);
		expect(deps.create).not.toHaveBeenCalled();
	});

	it("creates the reviewed invitation when given its digest", async () => {
		const output = await run([
			"--team",
			"team-platform",
			"--reviewed-onboarding-digest",
			"digest-1",
		]);

		expect(output).toMatchObject({ ok: true, invite: { encoded: "code" } });
		expect(deps.create).toHaveBeenCalledWith(
			expect.any(MemoryStore),
			expect.objectContaining({
				kind: "team_member",
				policy_team_id: "team-platform",
				reviewed_onboarding_digest: "digest-1",
				ttl_hours: "24",
			}),
		);
	});

	it("targets the person on this device for an add-device invitation", async () => {
		await run(["--add-device", "--review"]);

		expect(deps.preview).toHaveBeenCalledWith(
			expect.any(MemoryStore),
			expect.objectContaining({ kind: "add_device", target_identity_id: actorId }),
		);
	});

	it.each([
		[["--team", "platform"], "reviewed_onboarding_digest_required", "Review the invitation first"],
		[["--team", "missing", "--review"], "team_not_found", 'No active Team named "missing"'],
		[["--team", "platform", "--add-device"], "invitation_kind_required", "Choose --team"],
	])("explains %j", async (args, code, message) => {
		const output = await run(args);

		expect(output).toMatchObject({ error: code });
		expect(String(output.message)).toContain(message);
		expect(deps.create).not.toHaveBeenCalled();
	});

	it("explains a review that went stale before creation", async () => {
		deps.create.mockResolvedValue({
			httpStatus: 409,
			body: { error: "reviewed_onboarding_stale", preview: PREVIEW },
		});

		const output = await run(["--team", "platform", "--reviewed-onboarding-digest", "old"]);

		expect(output).toMatchObject({ error: "reviewed_onboarding_stale" });
		expect(String(output.message)).toContain("Run with --review again");
	});
});

describe("invitation create exit codes", () => {
	it.each([
		[["--add-device", "--review", "--reviewed-onboarding-digest", "d"], "usage_error"],
		[["--team", "platform"], "reviewed_onboarding_digest_required"],
		[["my-team"], "invitation_kind_required"],
	])("exits 2 for invalid flags %j", async (args, code) => {
		const output = await run(args);

		expect(output).toMatchObject({ error: code });
		expect(process.exitCode).toBe(2);
	});

	it("exits 1 when the Team doesn't exist", async () => {
		await run(["--team", "missing", "--review"]);

		expect(process.exitCode).toBe(1);
	});
});

describe("invitation create coordinator failures", () => {
	it.each([
		[
			"Remote coordinator request failed (401): invalid_admin_secret",
			"coordinator_admin_secret_rejected",
			"The coordinator rejected this device's admin secret",
		],
		["fetch failed", "coordinator_unreachable", "couldn't reach the coordinator"],
		[
			"The operation was aborted due to timeout",
			"coordinator_unreachable",
			"An unused invitation expires on its own",
		],
		[
			"Remote coordinator request failed (500): internal_error",
			"coordinator_request_failed",
			"The coordinator refused the request (HTTP 500: internal_error)",
		],
		["something_unexpected", "invitation_create_failed", "(something_unexpected)"],
	])("explains %s", async (raw, code, message) => {
		deps.create.mockResolvedValue({ httpStatus: 400, body: { error: raw } });

		const output = await run(["--team", "platform", "--reviewed-onboarding-digest", "digest-1"]);

		expect(output).toMatchObject({ error: code });
		expect(String(output.message)).toContain(message);
		expect(output.message).not.toBe(raw);
		expect(process.exitCode).toBe(1);
	});
});

describe("invitation create human output", () => {
	it("shows coordinator reachability warnings with the invitation", async () => {
		const written: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			written.push(String(chunk));
			return true;
		});
		deps.create.mockResolvedValue({
			httpStatus: 200,
			body: {
				ok: true,
				invite: { encoded: "code", warnings: ["Coordinator URL looks LAN-only."] },
			},
		});

		await buildCoordinatorInvitationCreateCommand(deps).parseAsync(
			["--team", "platform", "--reviewed-onboarding-digest", "digest-1"],
			{ from: "user" },
		);

		expect(written.join("")).toContain("Coordinator URL looks LAN-only.");
	});
});

describe("invitation create authentication failures", () => {
	it.each([
		[["--team", "platform"], "401: invalid_admin_secret", "coordinator_admin_secret_rejected"],
		[["--team", "platform"], "401: missing_admin_header", "coordinator_admin_secret_rejected"],
		[["--team", "platform"], "403: admin_not_configured", "coordinator_admin_not_configured"],
		[["--add-device"], "403: device_disabled", "coordinator_device_rejected"],
		[["--add-device"], "401: invalid_signature", "coordinator_device_rejected"],
		[["--add-device"], "401: unknown_device", "coordinator_device_rejected"],
	])("%j with %s is explained as %s", async (args, failure, code) => {
		deps.create.mockResolvedValue({
			httpStatus: 400,
			body: { error: `Remote coordinator request failed (${failure.replace(": ", "): ")}` },
		});

		const output = await run([...args, "--reviewed-onboarding-digest", "digest-1"]);

		expect(output).toMatchObject({ error: code });
		if (code === "coordinator_device_rejected") {
			expect(String(output.message)).not.toContain("admin secret in");
			expect(String(output.message)).toContain(failure.split(": ")[1]);
		}
	});
});
