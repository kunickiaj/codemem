import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { ed25519KeyId } from "./coordinator-ed25519-key-id.js";
import { buildFilterClausesWithContext, type OwnershipFilterContext } from "./filters.js";
import { putRecipientPolicyDenyOverlay } from "./recipient-policy-reconciliation.js";
import {
	refreshScopeMembershipCache,
	upsertCachedScopeMemberships,
} from "./scope-membership-cache.js";
import {
	cacheMember,
	cacheScope,
	cacheTime,
	cacheWireSnapshot,
} from "./scope-membership-cache-test-fixtures.js";
import type { ScopeMembershipSnapshot } from "./scope-membership-snapshot.js";
import {
	canonicalWorkspaceIdentity,
	LOCAL_DEFAULT_SCOPE_ID,
	resolveProjectScope,
	resolveVisibleScopeIds,
	type ScopeMapping,
} from "./scope-resolution.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";
import { ensureDeviceIdentity, loadPublicKey } from "./sync-identity.js";
import { initTestSchema, insertTestSession } from "./test-utils.js";

// Identity fixtures use real file keys, never an inherited host keychain setting.
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	execFileSync: vi.fn(() => {
		throw new Error("External subprocess disabled in tests");
	}),
}));

it.each(["default", "local", "manual", "invite"] as const)(
	"does not load signing keys for %s scope visibility",
	(authority) => {
		// Arrange: even an unavailable signer cannot affect ordinary local reads.
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			if (authority !== "default")
				seedManagedHistory(db, cacheScope({ authority_type: authority }));
			const loadExpectedPublicKey = vi.fn(() => {
				throw new Error("Signer unavailable");
			});
			// Act
			const visible = resolveVisibleScopeIds(db, "device-a", { loadExpectedPublicKey });
			// Assert
			expect(visible).toContain(authority === "default" ? LOCAL_DEFAULT_SCOPE_ID : "scope-a");
			expect(loadExpectedPublicKey).not.toHaveBeenCalled();
		} finally {
			db.close();
		}
	},
);

it("loads one actual key per managed visibility request and rechecks rotation", async () => {
	// Arrange: both grants come from valid V1 enrollment snapshots of a real local key.
	const keysDir = mkdtempSync(join(tmpdir(), "codemem-lazy-signer-"));
	const db = new Database(":memory:");
	try {
		initTestSchema(db);
		ensureDeviceIdentity(db, { keysDir, deviceId: "device-a" });
		const publicKey = loadPublicKey(keysDir);
		if (!publicKey) throw new Error("Missing fixture signing key");
		const snapshots = [cacheWireSnapshot(), cacheWireSnapshot(cacheScope({ scope_id: "scope-b" }))];
		for (const snapshot of snapshots) {
			const item = snapshot.items[0];
			if (!item) throw new Error("Missing fixture enrollment");
			item.enrollment.public_key = publicKey;
			item.enrollment.fingerprint = fingerprintPublicKey(publicKey);
			item.key_id = (await ed25519KeyId(publicKey)) ?? "";
		}
		expect(
			await refreshScopeMembershipCache(db, {
				coordinatorId: "server-a",
				groupIds: ["group-a"],
				now: new Date(cacheTime),
				fetchers: {
					listScopes: async () => ({ version: 1, items: snapshots.map(({ scope }) => scope) }),
					getScopeSnapshot: async (_group, scopeId) => {
						const snapshot = snapshots.find(({ scope }) => scope.scope_id === scopeId);
						if (!snapshot) throw new Error("Missing fixture snapshot");
						return snapshot;
					},
				},
			}),
		).toMatchObject({ status: "refreshed" });
		let currentKey: string | undefined = publicKey;
		const loadExpectedPublicKey = vi.fn(() => currentKey);
		const exec = vi.spyOn(db, "exec");
		const transaction = vi.spyOn(db, "transaction");
		// Act: the same callback must observe a different runtime key on the next request.
		const first = resolveVisibleScopeIds(db, "device-a", { loadExpectedPublicKey });
		expect(loadExpectedPublicKey).toHaveBeenCalledTimes(1);
		currentKey = replacementVisibilityKey(keysDir);
		const rotated = resolveVisibleScopeIds(db, "device-a", { loadExpectedPublicKey });
		expect(loadExpectedPublicKey).toHaveBeenCalledTimes(2);
		currentKey = undefined;
		const missing = resolveVisibleScopeIds(db, "device-a", { loadExpectedPublicKey });
		// Assert: no cross-request key cache and no fallback to enrollment or actor facts.
		expect(first).toEqual(expect.arrayContaining(["scope-a", "scope-b"]));
		for (const denied of [rotated, missing]) {
			expect(denied).not.toContain("scope-a");
			expect(denied).not.toContain("scope-b");
		}
		expect(loadExpectedPublicKey).toHaveBeenCalledTimes(3);
		expect(exec).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
	} finally {
		db.close();
		rmSync(keysDir, { recursive: true, force: true });
	}
});

function mapping(input: Partial<ScopeMapping> & { scope_id: string }): ScopeMapping {
	return {
		project_pattern: input.project_pattern ?? "/work/*",
		priority: input.priority ?? 0,
		scope_id: input.scope_id,
		updated_at: input.updated_at ?? "2026-04-30T00:00:00Z",
		workspace_identity: input.workspace_identity ?? null,
		id: input.id ?? null,
		source: input.source ?? "user",
	};
}

describe("canonicalWorkspaceIdentity", () => {
	it("prefers git remote over cwd and display project", () => {
		expect(
			canonicalWorkspaceIdentity({
				cwd: "/Users/adam/workspace/codemem",
				gitRemote: " https://github.com/kunickiaj/codemem.git ",
				project: "codemem",
			}),
		).toEqual({
			displayProject: "codemem",
			source: "git_remote",
			value: "https://github.com/kunickiaj/codemem.git",
		});
	});

	it("uses branch-scoped remote only when explicitly requested", () => {
		expect(
			canonicalWorkspaceIdentity({
				branchScoped: true,
				gitBranch: "feature/scope",
				gitRemote: "https://github.com/kunickiaj/codemem.git",
			}).value,
		).toBe("https://github.com/kunickiaj/codemem.git:feature/scope");
	});

	it("uses discovered repository identity before a worktree cwd", () => {
		expect(
			canonicalWorkspaceIdentity({
				cwd: "/private/tmp/worktree",
				project: "codemem",
				repositoryIdentity: "https://github.com/kunickiaj/codemem.git",
			}),
		).toEqual({
			displayProject: "codemem",
			source: "git_repository",
			value: "https://github.com/kunickiaj/codemem.git",
		});
	});

	it("falls through malformed higher-priority identity to a valid cwd", () => {
		expect(
			canonicalWorkspaceIdentity({
				cwd: "/work/acme/service",
				gitRemote: "fatal: not a git repository (or any of the parent directories): .git",
				project: "service",
			}),
		).toEqual({
			displayProject: "service",
			source: "cwd",
			value: "/work/acme/service",
		});
	});

	it("quarantines malformed legacy identity fields as unmapped", () => {
		const identity = canonicalWorkspaceIdentity({
			cwd: "Command failed: git rev-parse --show-toplevel",
			gitRemote: "fatal: not a git repository (or any of the parent directories): .git",
			project: "error: failed to discover project",
			workspaceId: "git: 'workspace-id' is not a git command",
		});

		expect(identity).toMatchObject({ displayProject: null, source: "unmapped" });
		expect(identity.value).toMatch(/^unmapped:[a-f0-9]{64}$/);
	});

	it("preserves the project-only unmapped hash", () => {
		expect(canonicalWorkspaceIdentity({ project: "codemem" }).value).toBe(
			"unmapped:34170381a2e99d876e3036c84ecdfcbbf0ef62cf9c89208236e7f8d528ed7720",
		);
	});

	it("preserves the unknown hash for an empty identity", () => {
		expect(canonicalWorkspaceIdentity({}).value).toBe(
			"unmapped:b23a6a8439c0dde5515893e7c90c1e3233b8616e634470f20dc4928bcf3609bc",
		);
	});

	it("keeps distinct malformed identity tuples in separate quarantines", () => {
		const sharedFields = {
			gitRemote: "fatal: not a git repository (or any of the parent directories): .git",
			project: "error: failed to discover project",
		};
		const first = canonicalWorkspaceIdentity({
			...sharedFields,
			cwd: "Command failed: git rev-parse --show-toplevel",
			workspaceId: "git: 'first-workspace' is not a git command",
		});
		const second = canonicalWorkspaceIdentity({
			...sharedFields,
			cwd: "Command failed: git rev-parse --show-prefix",
			workspaceId: "git: 'second-workspace' is not a git command",
		});

		expect(first).toMatchObject({ source: "unmapped" });
		expect(second).toMatchObject({ source: "unmapped" });
		expect(first.value).not.toBe(second.value);
	});
});

describe("resolveProjectScope adversarial wildcards", () => {
	it("rejects adversarial wildcard mappings without changing the selected scope", () => {
		const result = resolveProjectScope({
			cwd: `/${"a".repeat(40)}`,
			mappings: [mapping({ project_pattern: `/${"*a".repeat(10)}b`, scope_id: "nonmatch" })],
		});
		expect(result).toMatchObject({ reason: "local_default", scopeId: LOCAL_DEFAULT_SCOPE_ID });
	});
});

describe("resolveProjectScope", () => {
	it("uses an explicit runtime override before mappings", () => {
		const result = resolveProjectScope({
			explicitScopeId: "manual-scope",
			gitRemote: "https://github.com/kunickiaj/codemem.git",
			mappings: [
				mapping({
					scope_id: "repo-scope",
					workspace_identity: "https://github.com/kunickiaj/codemem.git",
				}),
			],
		});

		expect(result).toMatchObject({
			mapping: null,
			reason: "explicit_override",
			scopeId: "manual-scope",
		});
	});

	it("uses exact canonical workspace identity before pattern mappings", () => {
		const result = resolveProjectScope({
			gitRemote: "https://github.com/kunickiaj/codemem.git",
			mappings: [
				mapping({ project_pattern: "https://github.com/kunickiaj/*", scope_id: "pattern-scope" }),
				mapping({
					scope_id: "exact-scope",
					workspace_identity: "https://github.com/kunickiaj/codemem.git",
				}),
			],
		});

		expect(result).toMatchObject({
			reason: "exact_mapping",
			scopeId: "exact-scope",
			workspaceIdentity: { source: "git_remote" },
		});
	});

	it("normalizes exact workspace identity mappings", () => {
		expect(
			resolveProjectScope({
				cwd: "/work/acme/service",
				mappings: [mapping({ scope_id: "exact-cwd", workspace_identity: "/work/acme/service/" })],
			}),
		).toMatchObject({ reason: "exact_mapping", scopeId: "exact-cwd" });
	});

	it("uses highest priority deterministic pattern", () => {
		const result = resolveProjectScope({
			cwd: "/work/acme/service",
			mappings: [
				mapping({ project_pattern: "/work/acme/*", priority: 1, scope_id: "specific-low" }),
				mapping({ project_pattern: "/work/*", priority: 10, scope_id: "broad-high" }),
			],
		});

		expect(result).toMatchObject({
			matchedPattern: "/work/*",
			reason: "pattern_mapping",
			scopeId: "broad-high",
		});
	});

	it("breaks equal-priority ties by most specific pattern", () => {
		const result = resolveProjectScope({
			cwd: "/work/acme/service",
			mappings: [
				mapping({ project_pattern: "/work/*", priority: 5, scope_id: "broad" }),
				mapping({ project_pattern: "/work/acme/*", priority: 5, scope_id: "specific" }),
			],
		});

		expect(result).toMatchObject({
			matchedPattern: "/work/acme/*",
			scopeId: "specific",
		});
	});

	it("keeps basename-colliding projects separate by git remote", () => {
		const mappings = [
			mapping({
				scope_id: "work-codemem",
				workspace_identity: "https://github.com/acme/codemem.git",
			}),
			mapping({
				scope_id: "oss-codemem",
				workspace_identity: "https://github.com/kunickiaj/codemem.git",
			}),
		];

		expect(
			resolveProjectScope({
				gitRemote: "https://github.com/acme/codemem.git",
				mappings,
				project: "codemem",
			}).scopeId,
		).toBe("work-codemem");
		expect(
			resolveProjectScope({
				gitRemote: "https://github.com/kunickiaj/codemem.git",
				mappings,
				project: "codemem",
			}).scopeId,
		).toBe("oss-codemem");
	});

	it("does not authorize org scopes from basename-only project data", () => {
		const result = resolveProjectScope({
			mappings: [mapping({ project_pattern: "codemem", scope_id: "org-codemem" })],
			project: "codemem",
		});

		expect(result).toMatchObject({
			reason: "local_default",
			scopeId: LOCAL_DEFAULT_SCOPE_ID,
			workspaceIdentity: { source: "unmapped" },
		});
	});

	it("does not authorize exact unmapped-hash mappings from basename-only project data", () => {
		const unmapped = canonicalWorkspaceIdentity({ project: "codemem" });

		expect(
			resolveProjectScope({
				mappings: [mapping({ scope_id: "org-codemem", workspace_identity: unmapped.value })],
				project: "codemem",
			}),
		).toMatchObject({
			reason: "local_default",
			scopeId: LOCAL_DEFAULT_SCOPE_ID,
			workspaceIdentity: { source: "unmapped", value: unmapped.value },
		});
	});

	it("falls back to local-only when no mapping matches", () => {
		expect(
			resolveProjectScope({
				cwd: "/personal/unknown",
				localDefaultScopeId: "local-only-custom",
				mappings: [mapping({ project_pattern: "/work/*", scope_id: "work" })],
			}),
		).toMatchObject({ reason: "local_default", scopeId: "local-only-custom" });
	});
});

function repositoryIdentityCompatibilityTests(): void {
	it("uses a cwd pattern after repository identity becomes available", () => {
		expect(
			resolveProjectScope({
				cwd: "/work/acme/service",
				repositoryIdentity: "https://github.com/acme/service.git",
				mappings: [mapping({ project_pattern: "/work/acme/*", scope_id: "existing-pattern" })],
			}),
		).toMatchObject({
			reason: "pattern_mapping",
			scopeId: "existing-pattern",
			workspaceIdentity: { source: "git_repository" },
		});
	});

	it("does not use a cwd pattern when repository fallback is disabled", () => {
		expect(
			resolveProjectScope({
				allowRepositoryCwdFallback: false,
				cwd: "/work/acme/service",
				repositoryIdentity: "https://github.com/acme/service.git",
				mappings: [mapping({ project_pattern: "/work/acme/*", scope_id: "existing-pattern" })],
			}),
		).toMatchObject({ reason: "local_default", scopeId: LOCAL_DEFAULT_SCOPE_ID });
	});

	it("ranks repository and cwd pattern matches together", () => {
		expect(
			resolveProjectScope({
				cwd: "/work/acme/service",
				gitRemote: "https://github.com/acme/service.git",
				mappings: [
					mapping({
						project_pattern: "https://github.com/*",
						priority: 1,
						scope_id: "remote-pattern",
					}),
					mapping({
						project_pattern: "/work/acme/*",
						priority: 10,
						scope_id: "cwd-pattern",
					}),
				],
			}),
		).toMatchObject({ reason: "pattern_mapping", scopeId: "cwd-pattern" });
	});

	it("uses an existing cwd mapping when repository identity is newly available", () => {
		expect(
			resolveProjectScope({
				cwd: "/work/acme/service",
				gitRemote: "https://github.com/acme/service.git",
				mappings: [mapping({ scope_id: "existing-cwd", workspace_identity: "/work/acme/service" })],
			}),
		).toMatchObject({
			reason: "exact_mapping",
			scopeId: "existing-cwd",
			workspaceIdentity: {
				source: "git_remote",
				value: "https://github.com/acme/service.git",
			},
		});
	});

	it("prefers a repository mapping over its cwd compatibility mapping", () => {
		expect(
			resolveProjectScope({
				cwd: "/work/acme/service",
				gitRemote: "https://github.com/acme/service.git",
				mappings: [
					mapping({ scope_id: "existing-cwd", workspace_identity: "/work/acme/service" }),
					mapping({
						scope_id: "repository-scope",
						workspace_identity: "https://github.com/acme/service.git",
					}),
				],
			}),
		).toMatchObject({ reason: "exact_mapping", scopeId: "repository-scope" });
	});
}

describe("repository identity scope compatibility", repositoryIdentityCompatibilityTests);

function seedManagedHistory(db: Database.Database, scope = cacheScope()): void {
	db.prepare(`INSERT INTO replication_scopes
		(scope_id, label, kind, authority_type, coordinator_id, group_id,
		 membership_epoch, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
		scope.scope_id,
		scope.label,
		scope.kind,
		scope.authority_type,
		scope.coordinator_id,
		scope.group_id,
		scope.membership_epoch,
		scope.status,
		scope.created_at,
		scope.updated_at,
	);
	upsertCachedScopeMemberships(db, [cacheMember(scope)]);
}

it("excludes raw managed membership without deleting its diagnostic history", () => {
	// Arrange: a historical active row is not proof of current authorization.
	const db = new Database(":memory:");
	try {
		initTestSchema(db);
		const scope = cacheScope();
		seedManagedHistory(db, scope);
		const before = db.prepare("SELECT * FROM scope_memberships").all();
		// Act
		const visible = resolveVisibleScopeIds(db, "device-a");
		// Assert: visibility changes, not the retained raw cache.
		expect(visible).not.toContain(scope.scope_id);
		expect(db.prepare("SELECT * FROM scope_memberships").all()).toEqual(before);
	} finally {
		db.close();
	}
});

function refreshVisibilityProof(db: Database.Database, snapshot: ScopeMembershipSnapshot) {
	return refreshScopeMembershipCache(db, {
		coordinatorId: "server-a",
		groupIds: ["group-a"],
		now: new Date(cacheTime),
		fetchers: {
			listScopes: async () => ({ version: 1, items: [snapshot.scope] }),
			getScopeSnapshot: async () => snapshot,
		},
	});
}

function replacementVisibilityKey(keysDir: string): string {
	const other = new Database(":memory:");
	try {
		initTestSchema(other);
		ensureDeviceIdentity(other, { keysDir: join(keysDir, "replacement"), deviceId: "device-a" });
		const key = loadPublicKey(join(keysDir, "replacement"));
		if (!key) throw new Error("Missing replacement fixture key");
		return key;
	} finally {
		other.close();
	}
}

function seedVisibilityRows(db: Database.Database): void {
	const scopeInsert = db.prepare(`INSERT INTO replication_scopes
		(scope_id, label, kind, authority_type, membership_epoch, status, created_at, updated_at)
		VALUES (?, 'control', 'user', ?, 0, ?, ?, ?)`);
	for (const [scopeId, authority, status] of [
		["local-control", "local", "active"],
		["inactive-local", "local", "archived"],
		["manual-control", "manual", "active"],
		["revoked-manual", "manual", "active"],
	])
		scopeInsert.run(scopeId, authority, status, cacheTime, cacheTime);
	for (const scopeId of ["manual-control", "revoked-manual"]) {
		const scope = cacheScope({ scope_id: scopeId, authority_type: "manual", membership_epoch: 0 });
		const member = cacheMember(scope);
		if (scopeId === "revoked-manual") member.status = "revoked";
		upsertCachedScopeMemberships(db, [member]);
	}
	const sessionId = insertTestSession(db);
	const insert = db.prepare(`INSERT INTO memory_items
		(session_id, kind, title, body_text, confidence, tags_text, active,
		 created_at, updated_at, metadata_json, rev, visibility, scope_id, origin_device_id, import_key, actor_id)
		 VALUES (?, 'discovery', ?, 'body', 0.5, '', 1, ?, ?, '{}', 1, ?, ?, ?, ?, 'actor-a')`);
	for (const [title, scopeId, origin, importKey, visibility] of [
		["default", "local-default", "foreign", "replica-default", "shared"],
		["local control", "local-control", "foreign", "replica-local-control", "shared"],
		["inactive local control", "inactive-local", "foreign", "replica-inactive-local", "shared"],
		["manual control", "manual-control", "foreign", "replica-manual", "shared"],
		["revoked manual control", "revoked-manual", "foreign", "replica-revoked", "shared"],
		["own private history", "scope-a", "device-a", null, "private"],
		["local authored history", "scope-a", "local", null, "private"],
		["foreign replica", "scope-a", "foreign", "replica-foreign", "shared"],
		["legacy local replica", "scope-a", "local", "replica-local", "shared"],
	])
		insert.run(sessionId, title, cacheTime, cacheTime, visibility, scopeId, origin, importKey);
}

function selectVisibilityTitles(db: Database.Database, ownership: OwnershipFilterContext) {
	const filter = buildFilterClausesWithContext(null, ownership);
	return db
		.prepare(`SELECT title FROM memory_items WHERE ${filter.clauses.join(" AND ")} ORDER BY title`)
		.all(...filter.params);
}

async function applyVisibilityScenario(
	db: Database.Database,
	snapshot: ScopeMembershipSnapshot,
	options: { name: string; keysDir: string; publicKey: string },
): Promise<string | undefined> {
	const { name, keysDir, publicKey } = options;
	if (name === "missing runtime key") return undefined;
	if (name === "SSH comment alias") return ` ${publicKey}\talias\n`;
	if (name === "wrong runtime key") return replacementVisibilityKey(keysDir);
	if (name === "canonical key rotation") {
		const item = snapshot.items[0];
		if (!item) throw new Error("Missing fixture enrollment");
		item.enrollment.public_key = replacementVisibilityKey(keysDir);
		item.key_id = (await ed25519KeyId(item.enrollment.public_key)) ?? "";
		snapshot.scope.membership_epoch += 1;
		item.membership.membership_epoch += 1;
		expect(await refreshVisibilityProof(db, snapshot)).toMatchObject({ status: "refreshed" });
		const replacementContext = {
			actorId: "actor-a",
			deviceId: "device-a",
			enforceScopeVisibility: true,
			scopeVisibilityDb: db,
			expectedPublicKey: item.enrollment.public_key,
		};
		const replacementScopes = resolveVisibleScopeIds(db, "device-a", replacementContext);
		expect(replacementScopes).toContain("scope-a");
		const replacementRows = selectVisibilityTitles(db, replacementContext);
		expect(replacementRows).toContainEqual({ title: "foreign replica" });
		expect(
			selectVisibilityTitles(db, { ...replacementContext, visibleScopeIds: replacementScopes }),
		).toEqual(replacementRows);
	}
	if (name === "offline retained proof") {
		expect(
			await refreshScopeMembershipCache(db, {
				coordinatorId: "server-a",
				groupIds: ["group-a"],
				now: new Date("2026-10-08T00:00:00Z"),
				fetchers: {
					listScopes: async () => {
						throw new Error("offline");
					},
					getScopeSnapshot: async () => {
						throw new Error("unreachable");
					},
				},
			}),
		).toMatchObject({ status: "stale" });
	}
	const edits: Record<string, string> = {
		"inactive scope":
			"UPDATE replication_scopes SET status = 'archived' WHERE scope_id = 'scope-a'",
		"revoked membership":
			"UPDATE scope_memberships SET status = 'revoked' WHERE scope_id = 'scope-a'",
		"current epoch mismatch":
			"UPDATE replication_scopes SET membership_epoch = membership_epoch + 1 WHERE scope_id = 'scope-a'",
	};
	const edit = edits[name];
	if (edit) db.exec(edit);
	if (name === "team exclusion")
		putRecipientPolicyDenyOverlay(db, {
			scopeId: "scope-a",
			deviceId: "device-a",
			canonicalProjectIdentity: "project:fixture",
			generation: 1,
			reasonCode: "recipient_removed",
			now: cacheTime,
		});
	return publicKey;
}

describe("local visibility uses retained current-key proof", () => {
	it.each([
		{ name: "raw managed row", visible: false },
		{ name: "current V1 refresh", visible: true },
		{ name: "opaque legacy fingerprint", visible: true },
		{ name: "SSH comment alias", visible: true },
		{ name: "offline retained proof", visible: true },
		{ name: "wrong runtime key", visible: false },
		{ name: "missing runtime key", visible: false },
		{ name: "canonical key rotation", visible: false },
		{ name: "inactive scope", visible: false },
		{ name: "revoked membership", visible: false },
		{ name: "team exclusion", visible: false },
		{ name: "current epoch mismatch", visible: false },
	] as const)("$name selects the same rows through both SQL paths", async ({ name, visible }) => {
		// Arrange: enroll a real local signing key and promote only through the V1 refresh API.
		const keysDir = mkdtempSync(join(tmpdir(), "codemem-local-visibility-"));
		const db = new Database(":memory:");
		try {
			initTestSchema(db);
			ensureDeviceIdentity(db, { keysDir, deviceId: "device-a" });
			const publicKey = loadPublicKey(keysDir);
			if (!publicKey) throw new Error("Missing generated fixture key");
			const snapshot = cacheWireSnapshot();
			seedManagedHistory(db, snapshot.scope);
			seedVisibilityRows(db);
			const item = snapshot.items[0];
			if (!item) throw new Error("Missing fixture enrollment");
			item.enrollment.public_key = publicKey;
			item.key_id = (await ed25519KeyId(publicKey)) ?? "";
			item.enrollment.fingerprint = fingerprintPublicKey(publicKey);
			if (name === "opaque legacy fingerprint")
				item.enrollment.fingerprint = "legacy-opaque-fingerprint";
			if (name === "current V1 refresh") {
				const beforeRefresh = selectVisibilityTitles(db, {
					actorId: "actor-a",
					deviceId: "device-a",
					enforceScopeVisibility: true,
					scopeVisibilityDb: db,
					expectedPublicKey: publicKey,
				});
				expect(beforeRefresh).not.toContainEqual({ title: "foreign replica" });
			}
			if (name !== "raw managed row")
				expect(await refreshVisibilityProof(db, snapshot)).toMatchObject({ status: "refreshed" });
			const expectedPublicKey = await applyVisibilityScenario(db, snapshot, {
				name,
				keysDir,
				publicKey,
			});
			const before = db.prepare("SELECT * FROM scope_memberships").all();
			const history = db.prepare("SELECT * FROM memory_items ORDER BY id").all();
			// Act
			const resolved = resolveVisibleScopeIds(db, "device-a", { expectedPublicKey });
			const context = {
				actorId: "actor-a",
				deviceId: "device-a",
				claimedDeviceIds: ["foreign"],
				legacyActorIds: ["actor-a"],
				enforceScopeVisibility: true,
				scopeVisibilityDb: db,
				expectedPublicKey,
			};
			const fast = selectVisibilityTitles(db, { ...context, visibleScopeIds: resolved });
			const fallback = selectVisibilityTitles(db, context);
			const connectionOnly = selectVisibilityTitles(db, {
				actorId: "actor-a",
				deviceId: "device-a",
				enforceScopeVisibility: true,
				scopeVisibilityDb: db,
			});
			const dbLess = selectVisibilityTitles(db, {
				actorId: "actor-a",
				deviceId: "device-a",
				enforceScopeVisibility: true,
			});
			// Assert: denial must not erase the raw rows used for diagnostics.
			expect(resolved.includes("scope-a")).toBe(visible);
			const controls = ["default", "local control", "manual control"];
			const titles = [...controls];
			// These historical fixtures contain labels, not immutable creation evidence.
			// Current scope permission can expose them; origins cannot bypass its loss.
			if (visible)
				titles.push(
					"foreign replica",
					"legacy local replica",
					"local authored history",
					"own private history",
				);
			expect(fast).toEqual(titles.sort().map((title) => ({ title })));
			expect(fallback).toEqual(fast);
			expect(connectionOnly).toEqual(controls.map((title) => ({ title })));
			expect(dbLess).toEqual(connectionOnly);
			expect(db.prepare("SELECT * FROM scope_memberships").all()).toEqual(before);
			expect(db.prepare("SELECT * FROM memory_items ORDER BY id").all()).toEqual(history);
		} finally {
			db.close();
			rmSync(keysDir, { recursive: true, force: true });
		}
	});
});
