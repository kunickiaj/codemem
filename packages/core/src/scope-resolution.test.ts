import { describe, expect, it } from "vitest";
import {
	canonicalWorkspaceIdentity,
	LOCAL_DEFAULT_SCOPE_ID,
	resolveProjectScope,
	type ScopeMapping,
} from "./scope-resolution.js";

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
