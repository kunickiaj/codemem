import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isScopeDeviceAdmissionRefused } from "./scope-device-admission.js";
import {
	GROUP_ID,
	insertScope,
	NOW,
	PROJECT,
	quarantinedTeam,
} from "./team-recovery-test-fixtures.js";

let db: InstanceType<typeof Database>;

beforeEach(async () => {
	db = new Database(":memory:");
	await quarantinedTeam(db);
	insertScope(db, "scope-former", GROUP_ID);
});

afterEach(() => db.close());

const run = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...values);

const refused = (deviceId: string) =>
	isScopeDeviceAdmissionRefused(db, { scopeId: "scope-former", deviceId });

/**
 * A memory in a scope that no mapping points the Project to and no setup put
 * it in. Its session ran somewhere else and recorded no remote, so only what
 * is given here says which Project the memory belongs to.
 */
function storeMemory(evidence: { memoryProject?: string; recordedRepository?: string }) {
	const metadata = evidence.recordedRepository
		? JSON.stringify({ codemem_repository_identity: evidence.recordedRepository })
		: null;
	const session = run(
		`INSERT INTO sessions(started_at, cwd, project, tool_version, metadata_json)
		 VALUES (?, '/work/elsewhere', 'elsewhere', 'test', ?)`,
		NOW,
		metadata,
	);
	run(
		`INSERT INTO memory_items(session_id, kind, title, body_text, active, created_at, updated_at,
		 scope_id, project) VALUES (?, 'discovery', 'Stored', 'Stored', 1, ?, ?, 'scope-former', ?)`,
		session.lastInsertRowid,
		NOW,
		NOW,
		evidence.memoryProject ?? null,
	);
}

const STORED_BY = [
	["the memory's own Project", { memoryProject: PROJECT }],
	["the repository its session recorded", { recordedRepository: PROJECT }],
] as const;

describe("Team setup scope admission for a scope that only stores a Team Project's memories", () => {
	it.each(STORED_BY)(
		"refuses a device of a disabled Team when %s names the Project",
		(_case, evidence) => {
			// A memory of another Project does not make the scope the Team's.
			storeMemory({ memoryProject: "https://git.example.invalid/acme/other.git" });
			expect(refused("device-b")).toBe(false);

			storeMemory(evidence);

			expect(refused("device-b")).toBe(true);
		},
	);

	it.each(STORED_BY)(
		"refuses an eligible device a Project the Team no longer shares when %s names it",
		(_case, evidence) => {
			// Arrange: the Team is active again, but its recipient for the Project stays revoked.
			run("UPDATE policy_teams SET status = 'active', migration_state = 'completed'");
			storeMemory(evidence);

			expect(refused("device-b")).toBe(true);

			// Once the Team shares the Project again, the scope is served.
			run("UPDATE project_recipients SET status = 'active', migration_state = 'completed'");
			expect(refused("device-b")).toBe(false);
		},
	);
});
