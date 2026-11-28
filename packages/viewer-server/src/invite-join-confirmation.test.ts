import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeInvitePayload, ensureDeviceIdentity, MemoryStore } from "@codemem/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "./index.js";
import { inviteImportFailureResponse } from "./routes/sync.js";

let directory: string;
let store: MemoryStore;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "codemem-viewer-join-confirmation-"));
	writeFileSync(join(directory, "config.json"), "{}");
	vi.stubEnv("CODEMEM_CONFIG", join(directory, "config.json"));
	vi.stubEnv("CODEMEM_KEYS_DIR", join(directory, "keys"));
	store = new MemoryStore(join(directory, "mem.sqlite"));
});

afterEach(() => {
	if (existsSync(join(directory, "keys"))) chmodSync(join(directory, "keys"), 0o700);
	store.close();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(directory, { recursive: true, force: true });
});

function importInvite(body: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
	const invite = encodeInvitePayload({
		v: 1,
		kind: "coordinator_team_invite",
		coordinator_url: "https://coord.example.test",
		group_id: "team-a",
		policy: "auto_admit",
		token: "join-token",
		expires_at: "2099-01-01T00:00:00.000Z",
		team_name: "Team A",
		...extra,
	});
	return createApp({ storeFactory: () => store }).request("/api/sync/invites/import", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ invite, ...body }),
	});
}

it("asks for confirmation before a join, without contacting the coordinator, then joins", async () => {
	const fetchMock = vi.fn(async () => Response.json({ ok: true, status: "enrolled" }));
	vi.stubGlobal("fetch", fetchMock);

	const refused = await importInvite();

	expect(refused.status).toBe(409);
	expect(await refused.json()).toEqual({
		error: "coordinator_join_confirmation_required",
		detail:
			"Joining a coordinator permanently turns off syncing without a coordinator for this device's key, including other codemem profiles that use the same key.",
	});
	expect(fetchMock).not.toHaveBeenCalled();

	const confirmed = await importInvite({ confirm_coordinator_join: true });

	expect(confirmed.status).toBe(200);
	expect(fetchMock).toHaveBeenCalledOnce();
});

const RECORD_UNAVAILABLE = {
	error: "coordinator_free_witness_unavailable",
	detail:
		"codemem couldn't save this device's coordinator record. Unlock or repair the keychain, or make the codemem keys folder writable, then try again.",
};

it("says to unlock or repair the keychain when a Project join can't be recorded", async () => {
	const fetchMock = vi.fn(async () => Response.json({ ok: true, status: "accepted" }));
	vi.stubGlobal("fetch", fetchMock);
	ensureDeviceIdentity(store.db, { keysDir: join(directory, "keys") });
	chmodSync(join(directory, "keys"), 0o500);

	const response = await importInvite(
		{ confirm_coordinator_join: true },
		{ operation_id: `share_${"a".repeat(40)}` },
	);

	expect(response.status).toBe(503);
	expect(await response.json()).toEqual(RECORD_UNAVAILABLE);
	expect(fetchMock).not.toHaveBeenCalled();
});

it("answers a recipient or Project invitation whose join can't be recorded the same way", () => {
	const error = new Error("coordinator_free_witness_unavailable");

	for (const invite of [
		{ projectInvite: false, recipientInvite: true },
		{ projectInvite: true, recipientInvite: false },
	]) {
		expect(inviteImportFailureResponse(error, invite)).toEqual({
			status: 503,
			body: RECORD_UNAVAILABLE,
		});
	}
});
