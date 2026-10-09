import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { cleanProjectIdentity, isMalformedProjectIdentity } from "./project-identity.js";

export type WorkspaceIdentitySource =
	| "git_remote"
	| "git_remote_branch"
	| "git_repository"
	| "cwd"
	| "workspace_id"
	| "unmapped";

export interface WorkspaceIdentityInput {
	gitRemote?: string | null;
	gitBranch?: string | null;
	repositoryIdentity?: string | null;
	cwd?: string | null;
	workspaceId?: string | null;
	project?: string | null;
	branchScoped?: boolean;
	allowRepositoryCwdFallback?: boolean;
}

export interface CanonicalWorkspaceIdentity {
	value: string;
	source: WorkspaceIdentitySource;
	displayProject: string | null;
}

function normalizeSlash(value: string): string {
	const normalized = value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
	return normalized || value.trim();
}

function normalizeCwd(cwd: string): string {
	// Callers should pass an already-realpathed session cwd when symlink
	// resolution matters; this pure helper only normalizes path syntax.
	return normalizeSlash(resolve(cwd));
}

function unmappedIdentity(input: WorkspaceIdentityInput): string {
	const validSeed = [input.cwd, input.project, input.workspaceId]
		.map((value) => cleanProjectIdentity(value))
		.find((value) => value !== null);
	const identityTuple = [
		input.gitRemote,
		input.gitBranch,
		input.cwd,
		input.project,
		input.workspaceId,
	].map((value) => (typeof value === "string" ? value.trim() : null));
	let seed = validSeed ?? "unknown";
	if (!validSeed && identityTuple.some(isMalformedProjectIdentity)) {
		seed = JSON.stringify(identityTuple);
	}
	const digest = createHash("sha256").update(seed, "utf8").digest("hex");
	return `unmapped:${digest}`;
}

export function canonicalWorkspaceIdentity(
	input: WorkspaceIdentityInput,
): CanonicalWorkspaceIdentity {
	const gitRemote = cleanProjectIdentity(input.gitRemote);
	const gitBranch = cleanProjectIdentity(input.gitBranch);
	const repositoryIdentity = cleanProjectIdentity(input.repositoryIdentity);
	const cwd = cleanProjectIdentity(input.cwd);
	const workspaceId = cleanProjectIdentity(input.workspaceId);
	const project = cleanProjectIdentity(input.project);

	if (repositoryIdentity && !input.branchScoped) {
		return {
			value: normalizeSlash(repositoryIdentity),
			source: "git_repository",
			displayProject: project,
		};
	}

	if (gitRemote) {
		const normalizedRemote = normalizeSlash(gitRemote);
		if (input.branchScoped && gitBranch) {
			return {
				value: `${normalizedRemote}:${gitBranch}`,
				source: "git_remote_branch",
				displayProject: project,
			};
		}
		return { value: normalizedRemote, source: "git_remote", displayProject: project };
	}

	if (repositoryIdentity) {
		return {
			value: normalizeSlash(repositoryIdentity),
			source: "git_repository",
			displayProject: project,
		};
	}

	if (cwd) {
		return { value: normalizeCwd(cwd), source: "cwd", displayProject: project };
	}

	if (workspaceId) {
		return { value: normalizeSlash(workspaceId), source: "workspace_id", displayProject: project };
	}

	return { value: unmappedIdentity(input), source: "unmapped", displayProject: project };
}
