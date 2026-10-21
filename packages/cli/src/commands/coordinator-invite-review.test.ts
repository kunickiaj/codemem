import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connect,
	connectReadOnly,
	coordinatorImportInviteAction,
	coordinatorReviewInviteAction,
	encodeInvitePayload,
	ensureDeviceIdentity,
	initDatabase,
	readCodememConfigFileAtPath,
	recipientReviewedIntentDigest,
	writeCodememConfigFile,
} from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildCoordinatorCommand } from "./coordinator.js";

const output = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("@clack/prompts", () => ({
	intro: output.write,
	outro: output.write,
	note: output.write,
	log: {
		info: output.write,
		message: output.write,
		success: output.write,
		error: output.write,
		warn: output.write,
	},
}));

const token = "disposable-invite-bearer";
const arbitrarySecret = "disposable-inspection-secret";
const intent = {
	version: 1 as const,
	journey: "add_device" as const,
	targetIdentity: { identityId: "identity-existing", displayName: "Existing Person" },
	projects: [],
	excludedProjects: [],
};

function snapshot(directory: string): Record<string, string> {
	if (!existsSync(directory)) return {};
	const files: Record<string, string> = {};
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		// WAL/SHM are transient; serialize SQLite itself to include committed WAL data.
		if (entry.name.endsWith("-wal") || entry.name.endsWith("-shm")) continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			for (const [name, contents] of Object.entries(snapshot(path)))
				files[`${entry.name}/${name}`] = contents;
		} else {
			let contents: Buffer<ArrayBufferLike> = readFileSync(path);
			if (entry.name.endsWith(".sqlite")) {
				const db = connectReadOnly(path);
				try {
					contents = db.serialize();
				} finally {
					db.close();
				}
			}
			files[entry.name] = createHash("sha256").update(contents).digest("hex");
		}
	}
	return files;
}

let directory: string;
let dbPath: string;
let keysDir: string;
let configPath: string;
let invite: string;
let inspection: Record<string, unknown>;
let requests: string[];
let bodies: Record<string, unknown>[];
const previousExitCode = process.exitCode;

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "codemem-invite-review-"));
	dbPath = join(directory, "profile.sqlite");
	keysDir = join(directory, "keys");
	configPath = join(directory, "config.json");
	for (const [name, value] of Object.entries({
		HOME: directory,
		XDG_CONFIG_HOME: directory,
		CODEMEM_DB: dbPath,
		CODEMEM_CONFIG: configPath,
		CODEMEM_KEYS_DIR: keysDir,
	}))
		vi.stubEnv(name, value);
	process.exitCode = undefined;
	output.write.mockReset();
	vi.spyOn(console, "log").mockImplementation(output.write);
	const digest = await recipientReviewedIntentDigest(intent);
	inspection = {
		kind: "add_device",
		group_id: "group-a",
		target_identity_id: "identity-existing",
		identity_id: "identity-existing",
		reviewed_preview_digest: digest,
		reviewed_intent: intent,
		token,
		private_detail: arbitrarySecret,
	};
	invite = encodeInvitePayload({
		v: 1,
		kind: "add_device",
		coordinator_url: "https://coordinator.example.test",
		group_id: "group-a",
		policy: "auto_admit",
		token,
		expires_at: "2099-01-01T00:00:00Z",
		team_name: null,
		target_identity_id: "identity-existing",
		reviewed_preview_digest: digest,
	});
	requests = [];
	bodies = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			requests.push(String(url));
			bodies.push(JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8")));
			return Response.json({ ...inspection, status: "accepted", ok: true });
		}),
	);
});
afterEach(() => {
	process.exitCode = previousExitCode;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	rmSync(directory, { recursive: true, force: true });
});

function initialize() {
	initDatabase(dbPath);
	const db = connect(dbPath);
	try {
		ensureDeviceIdentity(db, { keysDir });
	} finally {
		db.close();
	}
}
function options() {
	return {
		inviteValue: invite,
		dbPath,
		keysDir,
		configPath,
		deviceDisplayName: "Recipient laptop",
	};
}
function commandArgs(extra: string[]) {
	return [
		"import-invite",
		invite,
		"--db-path",
		dbPath,
		"--keys-dir",
		keysDir,
		"--config",
		configPath,
		"--device-name",
		"  Recipient laptop  ",
		...extra,
	];
}
function text() {
	return output.write.mock.calls.flat().map(String).join("\n");
}
function assertSafe() {
	expect(text()).not.toContain(token);
	expect(text()).not.toContain(invite);
	expect(text()).not.toContain(arbitrarySecret);
}

it("preserves an explicit recipient name as the legacy join display name", async () => {
	// Arrange: the explicit name must win over the configured actor name.
	writeCodememConfigFile({ actor_display_name: "Configured Person" }, configPath);
	const fetchMock = vi.fn(async () => Response.json({ ok: true, status: "enrolled" }));
	vi.stubGlobal("fetch", fetchMock);
	const legacyInvite = encodeInvitePayload({
		v: 1,
		kind: "coordinator_team_invite",
		coordinator_url: "https://coordinator.example.test",
		group_id: "legacy-group",
		policy: "auto_admit",
		token: "synthetic-legacy-name-token",
		expires_at: "2099-01-01T00:00:00Z",
		team_name: "Legacy Team",
	});
	// Act: legacy invitations still need no reviewed digest.
	const result = await coordinatorImportInviteAction({
		...options(),
		inviteValue: legacyInvite,
		recipientDisplayName: "  Explicit Person  ",
	});
	// Assert: do not replace the legacy recipient name with config or device defaults.
	expect(result).toMatchObject({ status: "enrolled", group_id: "legacy-group" });
	expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
		"https://coordinator.example.test/v1/join",
		expect.objectContaining({ body: expect.any(Uint8Array) }),
	);
	const init = vi.mocked(fetch).mock.calls[0]?.[1];
	expect(JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8"))).toMatchObject({
		display_name: "Explicit Person",
	});
});

async function useTeamInvite() {
	const reviewedIntent = {
		version: 1 as const,
		journey: "team" as const,
		team: { teamId: "policy-team-a", displayName: "Team A", futureProjectsInherit: true as const },
		projects: [],
		excludedProjects: [],
	};
	const digest = await recipientReviewedIntentDigest(reviewedIntent);
	inspection = {
		kind: "team_member",
		group_id: "group-a",
		policy_team_id: "policy-team-a",
		assigned_identity_id: "identity-assigned",
		identity_id: "identity-assigned",
		reviewed_preview_digest: digest,
		reviewed_intent: reviewedIntent,
		token,
		private_detail: arbitrarySecret,
	};
	invite = encodeInvitePayload({
		v: 1,
		kind: "team_member",
		coordinator_url: "https://coordinator.example.test",
		group_id: "group-a",
		policy: "auto_admit",
		token,
		expires_at: "2099-01-01T00:00:00Z",
		team_name: "Team A",
		policy_team_id: "policy-team-a",
		assigned_identity_id: "identity-assigned",
		reviewed_preview_digest: digest,
	});
}

it("reviews and accepts Team access using the assigned Identity and matching normalized names", async () => {
	// Arrange
	initialize();
	await useTeamInvite();
	const before = snapshot(directory);
	const names = ["--recipient-name", "  Team Person  "];
	// Act: obtain the handoff from Commander, then confirm it through the same command.
	await buildCoordinatorCommand().parseAsync(commandArgs(["--review", ...names, "--json"]), {
		from: "user",
	});
	const review = JSON.parse(String(output.write.mock.calls[0]?.[0]));
	const afterReview = snapshot(directory);
	const coreReview = await coordinatorReviewInviteAction({
		...options(),
		recipientDisplayName: "Team Person",
	});
	await buildCoordinatorCommand().parseAsync(
		commandArgs([
			"--reviewed-onboarding-digest",
			review.reviewed_onboarding_digest,
			...names,
			"--json",
		]),
		{ from: "user" },
	);
	// Assert
	expect(afterReview).toEqual(before);
	expect(review).toEqual(coreReview);
	expect(review).toMatchObject({
		journey: "team",
		target_identity_id: "identity-assigned",
		recipient_display_name: "Team Person",
		team: { teamId: "policy-team-a" },
	});
	expect(process.exitCode).toBeUndefined();
	expect(requests.filter((url) => url.endsWith("/v1/join"))).toHaveLength(1);
	expect(bodies.at(-1)).toMatchObject({
		invite_kind: "team_member",
		identity_id: "identity-assigned",
		recipient_display_name: "Team Person",
		device_display_name: "Recipient laptop",
	});
	expect(readCodememConfigFileAtPath(configPath)).toMatchObject({
		actor_id: "identity-assigned",
		actor_display_name: "Team Person",
	});
	assertSafe();
});

it.each(["caller Identity", "inspected Team"])(
	"rejects Team review with a different %s without accepting or changing the profile",
	async (mismatch) => {
		// Arrange
		initialize();
		await useTeamInvite();
		if (mismatch === "inspected Team") inspection.policy_team_id = "policy-team-other";
		const before = snapshot(directory);
		// Act
		const failure = await coordinatorReviewInviteAction({
			...options(),
			recipientDisplayName: "Team Person",
			...(mismatch === "caller Identity" ? { recipientActorId: "identity-self-nominated" } : {}),
		}).catch((error: unknown) => error);
		// Assert
		expect(String(failure)).toContain(
			mismatch === "caller Identity"
				? "invite_identity_conflict"
				: "recipient_invite_intent_mismatch",
		);
		expect(snapshot(directory)).toEqual(before);
		expect(requests.some((url) => url.endsWith("/v1/join"))).toBe(false);
		expect(requests).toHaveLength(mismatch === "caller Identity" ? 0 : 1);
		expect(String(failure)).not.toContain(token);
		expect(String(failure)).not.toContain(arbitrarySecret);
	},
);

it.each([true, false])("prints a safe read-only handoff (JSON=%s)", async (json) => {
	// Arrange: keys already exist; review may not initialize or adopt anything.
	initialize();
	const before = snapshot(directory);
	// Act: exercise Commander and the real Core digest computation.
	await buildCoordinatorCommand().parseAsync(
		commandArgs(["--review", ...(json ? ["--json"] : [])]),
		{ from: "user" },
	);
	// Assert
	expect(process.exitCode).toBeUndefined();
	expect(requests).toEqual(["https://coordinator.example.test/v1/invites/inspect"]);
	expect(snapshot(directory)).toEqual(before);
	const review = await coordinatorReviewInviteAction(options());
	expect(review).toMatchObject({
		status: "review",
		kind: "add_device",
		target_identity_id: "identity-existing",
		device_display_name: "Recipient laptop",
		journey: "add_device",
		reviewed_onboarding_digest: expect.any(String),
	});
	expect(review).not.toHaveProperty("binding");
	expect(JSON.stringify(review)).not.toContain(token);
	expect(JSON.stringify(review)).not.toContain(arbitrarySecret);
	expect(text()).toContain(review.reviewed_onboarding_digest);
	if (json) expect(JSON.parse(String(output.write.mock.calls[0]?.[0]))).toEqual(review);
	assertSafe();
});

it("accepts the explicit digest through Commander and adopts the reviewed Identity", async () => {
	// Arrange
	initialize();
	const review = await coordinatorReviewInviteAction(options());
	// Act
	await buildCoordinatorCommand().parseAsync(
		commandArgs(["--reviewed-onboarding-digest", review.reviewed_onboarding_digest, "--json"]),
		{ from: "user" },
	);
	// Assert
	expect(process.exitCode).toBeUndefined();
	expect(requests.filter((url) => url.endsWith("/v1/join"))).toHaveLength(1);
	expect(bodies.at(-1)).toMatchObject({
		identity_id: "identity-existing",
		device_display_name: "Recipient laptop",
	});
	expect(readCodememConfigFileAtPath(configPath)).toMatchObject({
		actor_id: "identity-existing",
		sync_device_name: "Recipient laptop",
	});
	const db = connect(dbPath);
	try {
		expect(db.prepare("SELECT identity_id FROM identity_devices").get()).toEqual({
			identity_id: "identity-existing",
		});
	} finally {
		db.close();
	}
	assertSafe();
});

it.each(["wrong", "changed device name"])(
	"rejects a %s digest before join or local mutation",
	async (kind) => {
		// Arrange
		initialize();
		const review = await coordinatorReviewInviteAction(options());
		const before = snapshot(directory);
		// Act
		const failure = await coordinatorImportInviteAction({
			...options(),
			deviceDisplayName: kind === "wrong" ? "Recipient laptop" : "Another laptop",
			reviewedOnboardingDigest:
				kind === "wrong" ? "0".repeat(64) : review.reviewed_onboarding_digest,
		}).catch((error: unknown) => error);
		// Assert
		expect(failure).toBeInstanceOf(Error);
		expect(String(failure)).toContain("reviewed_onboarding_stale");
		expect(requests.some((url) => url.endsWith("/v1/join"))).toBe(false);
		expect(snapshot(directory)).toEqual(before);
	},
);

it("rejects missing confirmation without creating a profile or sending a token", async () => {
	// Arrange
	const before = snapshot(directory);
	// Act
	const failure = await coordinatorImportInviteAction(options()).catch((error: unknown) => error);
	// Assert
	expect(String(failure)).toContain("reviewed_onboarding_digest_required");
	expect(snapshot(directory)).toEqual(before);
	expect(requests).toEqual([]);
});

it("cannot create a missing profile during review", async () => {
	// Arrange
	const before = snapshot(directory);
	// Act
	const failure = await coordinatorReviewInviteAction(options()).catch((error: unknown) => error);
	// Assert
	expect(failure).toBeInstanceOf(Error);
	expect(snapshot(directory)).toEqual(before);
	expect(requests).toEqual([]);
});

it("rejects encoded intent that differs from the inspected authority", async () => {
	// Arrange
	initialize();
	inspection.target_identity_id = "identity-other";
	const before = snapshot(directory);
	// Act
	const failure = await coordinatorReviewInviteAction(options()).catch((error: unknown) => error);
	// Assert
	expect(String(failure)).toContain("recipient_invite_intent_mismatch");
	expect(snapshot(directory)).toEqual(before);
	expect(requests.some((url) => url.endsWith("/v1/join"))).toBe(false);
});

it.each([true, false])("does not echo arbitrary inspection errors (JSON=%s)", async (json) => {
	// Arrange
	initialize();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ error: `${token} ${arbitrarySecret}` }, { status: 500 })),
	);
	// Act
	await buildCoordinatorCommand().parseAsync(
		commandArgs(["--review", ...(json ? ["--json"] : [])]),
		{ from: "user" },
	);
	// Assert
	expect(process.exitCode).toBe(1);
	expect(text().length).toBeGreaterThan(0);
	assertSafe();
});

it("rejects review plus confirmation before inspecting or changing the profile", async () => {
	// Arrange
	initialize();
	const before = snapshot(directory);
	// Act
	await buildCoordinatorCommand().parseAsync(
		commandArgs(["--review", "--reviewed-onboarding-digest", "0".repeat(64), "--json"]),
		{ from: "user" },
	);
	// Assert
	expect(process.exitCode).toBeGreaterThan(0);
	expect(requests).toEqual([]);
	expect(snapshot(directory)).toEqual(before);
	assertSafe();
});
