import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { reassignProjectScopeInventoryProject } from "./project-scope-settings.js";
import { initTestSchema } from "./test-utils.js";

const CWD = "/workspace/acme/service";
const REPOSITORY_A = "https://git.example.invalid/acme/old.git";
const REPOSITORY_B = "https://git.example.invalid/acme/service.git";
const NOW = "2026-09-23T00:00:00.000Z";

function insertSession(
	db: InstanceType<typeof Database>,
	input: { gitRemote?: string; repositoryIdentity?: string; project: string },
): number {
	return Number(
		db
			.prepare(
				`INSERT INTO sessions(started_at, cwd, project, git_remote, metadata_json)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(
				NOW,
				CWD,
				input.project,
				input.gitRemote ?? null,
				input.repositoryIdentity
					? JSON.stringify({ codemem_repository_identity: input.repositoryIdentity })
					: null,
			).lastInsertRowid,
	);
}

function insertMemory(db: InstanceType<typeof Database>, sessionId: number, project: string): void {
	db.prepare(`INSERT INTO memory_items(
		session_id, kind, title, body_text, created_at, updated_at, visibility,
		origin_device_id, active, metadata_json, project
	 ) VALUES (?, 'discovery', 'Title', 'Body', ?, ?, 'shared', 'source-device', 1, '{}', ?)`).run(
		sessionId,
		NOW,
		NOW,
		project,
	);
}

it("reassigns a pre-upgrade cwd session inferred from repository evidence", () => {
	const db = new Database(":memory:");
	initTestSchema(db);
	try {
		const legacySession = insertSession(db, { project: "legacy-service" });
		insertMemory(db, legacySession, "legacy-service");
		const identifiedSession = insertSession(db, {
			gitRemote: REPOSITORY_B,
			project: "service",
			repositoryIdentity: REPOSITORY_B,
		});

		const result = reassignProjectScopeInventoryProject(db, {
			deviceId: "source-device",
			project: "service-renamed",
			workspaceIdentity: REPOSITORY_B,
		});

		expect(result).toMatchObject({ moved_memory_count: 1, moved_session_count: 2 });
		expect(
			db
				.prepare("SELECT project FROM sessions WHERE id IN (?, ?) ORDER BY id")
				.all(legacySession, identifiedSession),
		).toEqual([{ project: "service-renamed" }, { project: "service-renamed" }]);
	} finally {
		db.close();
	}
});

it("does not override an explicit historical remote with cwd inference", () => {
	const db = new Database(":memory:");
	initTestSchema(db);
	try {
		const oldSession = insertSession(db, { gitRemote: REPOSITORY_A, project: "old" });
		insertMemory(db, oldSession, "old");
		const currentSession = insertSession(db, {
			gitRemote: REPOSITORY_B,
			project: "current",
			repositoryIdentity: REPOSITORY_B,
		});

		const result = reassignProjectScopeInventoryProject(db, {
			deviceId: "source-device",
			project: "current-renamed",
			workspaceIdentity: REPOSITORY_B,
		});

		expect(result).toMatchObject({ moved_memory_count: 0, moved_session_count: 1 });
		expect(db.prepare("SELECT project FROM sessions WHERE id = ?").pluck().get(oldSession)).toBe(
			"old",
		);
		expect(
			db.prepare("SELECT project FROM sessions WHERE id = ?").pluck().get(currentSession),
		).toBe("current-renamed");
	} finally {
		db.close();
	}
});
