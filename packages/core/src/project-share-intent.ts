import { createHash } from "node:crypto";
import { normalizeIdentityDisplayName } from "./project-invite-identity.js";
import { canonicalWorkspaceIdentity } from "./scope-resolution.js";

export const SHARE_HISTORY_POLICY = "existing_and_future" as const;

export interface ShareProjectIntent {
	canonicalIdentity: string;
	displayName: string;
	identitySource: string;
	existingMemoryCount: number;
}

export interface AcceptedProjectIntent {
	canonical_identity: string;
	display_name: string;
	existing_memory_count: number;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function shareProjectSetDigest(projects: ShareProjectIntent[]): string {
	const reviewedProjects = projects
		.map((project) => ({
			canonicalIdentity: project.canonicalIdentity,
			existingMemoryCount: project.existingMemoryCount,
		}))
		.toSorted((left, right) => left.canonicalIdentity.localeCompare(right.canonicalIdentity));
	return digest({ v: 1, historyPolicy: SHARE_HISTORY_POLICY, projects: reviewedProjects });
}

export function acceptedProjectIntentDigest(projects: AcceptedProjectIntent[]): string {
	return shareProjectSetDigest(
		projects.map((project) => ({
			canonicalIdentity: project.canonical_identity,
			displayName: project.display_name,
			identitySource: "coordinator_acceptance",
			existingMemoryCount: project.existing_memory_count,
		})),
	);
}

export function parseAcceptedProjectIntent(value: unknown): AcceptedProjectIntent[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
		throw new Error("operation_intent_invalid");
	}
	const projects = value.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error("operation_intent_invalid");
		}
		const record = item as Record<string, unknown>;
		if (typeof record.canonical_identity !== "string" || typeof record.display_name !== "string") {
			throw new Error("operation_intent_invalid");
		}
		const canonicalIdentityRaw = record.canonical_identity;
		const canonicalIdentity = canonicalIdentityRaw.trim();
		const displayNameRaw = record.display_name;
		let displayName: string;
		try {
			displayName = normalizeIdentityDisplayName(displayNameRaw, "project_name");
		} catch {
			throw new Error("operation_intent_invalid");
		}
		const count = record.existing_memory_count;
		const canonicalIdentityRoundTrip = canonicalWorkspaceIdentity({
			gitRemote: canonicalIdentity,
		}).value;
		if (
			!canonicalIdentity ||
			canonicalIdentity !== canonicalIdentityRaw ||
			canonicalIdentity.length > 2048 ||
			canonicalIdentity.startsWith("unmapped:") ||
			canonicalIdentityRoundTrip !== canonicalIdentity ||
			displayName !== displayNameRaw ||
			!Number.isSafeInteger(count) ||
			Number(count) < 0 ||
			/[\p{Cc}\p{Cf}]/u.test(canonicalIdentity) ||
			/[\p{Cc}\p{Cf}]/u.test(displayName)
		) {
			throw new Error("operation_intent_invalid");
		}
		return {
			canonical_identity: canonicalIdentity,
			display_name: displayName,
			existing_memory_count: Number(count),
		};
	});
	if (new Set(projects.map((project) => project.canonical_identity)).size !== projects.length) {
		throw new Error("operation_intent_invalid");
	}
	return projects.toSorted((left, right) =>
		left.canonical_identity.localeCompare(right.canonical_identity),
	);
}
