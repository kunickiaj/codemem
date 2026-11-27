import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDeviceIdentity, MemoryStore } from "@codemem/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecipientInvitation, previewRecipientInvitation } from "./sync.js";

const NOW = "2026-07-21T12:00:00.000Z";
const COORDINATOR = "https://coord.example.test";
let dir: string;
let store: MemoryStore;
let coordinatorCalls: ReturnType<typeof vi.fn>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "codemem-team-invite-group-"));
	vi.stubEnv("CODEMEM_CONFIG", join(dir, "config.json"));
	vi.stubEnv("CODEMEM_KEYS_DIR", join(dir, "keys"));
	vi.stubEnv("CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET", undefined);
	coordinatorCalls = vi.fn(async () => new Response("{}", { status: 500 }));
	vi.stubGlobal("fetch", coordinatorCalls);
	store = new MemoryStore(join(dir, "mem.sqlite"));
	const [deviceId] = ensureDeviceIdentity(store.db, { keysDir: join(dir, "keys") });
	store.adoptEnsuredDeviceIdentity(deviceId);
	store.db
		.prepare(`INSERT INTO policy_teams(team_id, display_name, status, provenance, revision,
		 migration_state, source_fingerprint, idempotency_key, created_at, updated_at)
		 VALUES ('team-a', 'Team A', 'active', 'user', 'r1', 'user_managed', NULL, 'team-a', ?, ?)`)
		.run(NOW, NOW);
});

afterEach(() => {
	store.close();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});

function configure(groupId: string) {
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({
			sync_coordinator_url: COORDINATOR,
			sync_coordinator_group: groupId,
			sync_coordinator_admin_secret: "synthetic-admin",
		}),
	);
}

async function invite() {
	const body = { kind: "team_member", policy_team_id: "team-a" };
	const preview = previewRecipientInvitation(store, body);
	const digest = (preview.body.preview as { reviewedOnboardingDigest: string })
		.reviewedOnboardingDigest;
	return createRecipientInvitation(store, { ...body, reviewed_onboarding_digest: digest });
}

describe("a Team invitation", () => {
	it("is refused through another group than the one the Team was created for, and sends nothing", async () => {
		// Created while this device used group A; it is configured for group B now.
		store.db
			.prepare(`INSERT INTO policy_team_coordinator_links(team_id, coordinator_id, group_id, source, recorded_at)
			 VALUES ('team-a', ?, 'group-a', 'team_create', ?)`)
			.run(COORDINATOR, NOW);
		configure("group-b");

		const outcome = await invite();

		expect(outcome).toEqual({ httpStatus: 409, body: { error: "team_group_mismatch" } });
		expect(coordinatorCalls).not.toHaveBeenCalled();
	});

	it("is refused while the Team's group is a conflict", async () => {
		store.db
			.prepare(`INSERT INTO policy_team_coordinator_links(team_id, coordinator_id, group_id, source, recorded_at)
			 VALUES ('team-a', ?, '', 'coordinator_conflict', ?)`)
			.run(COORDINATOR, NOW);
		configure("group-a");

		const outcome = await invite();

		expect(outcome).toEqual({ httpStatus: 409, body: { error: "team_link_conflict" } });
		expect(coordinatorCalls).not.toHaveBeenCalled();
	});
});
