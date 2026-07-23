import { normalizeIdentityDisplayName } from "./project-invite-identity.js";

export const RECIPIENT_REVIEWED_INTENT_VERSION = 1 as const;

export type RecipientReviewedIntentProjectSourceV1 =
	| { kind: "direct" }
	| { kind: "team"; teamId: string; displayName: string };

export interface RecipientReviewedIntentProjectV1 {
	canonicalProjectIdentity: string;
	displayName: string;
	existingMemoryCount: number;
	futureMemoriesShared: true;
	sources: RecipientReviewedIntentProjectSourceV1[];
}

export interface RecipientReviewedIntentExcludedProjectV1 {
	canonicalProjectIdentity: string;
	displayName: string;
	existingMemoryCount: number;
}

interface RecipientReviewedIntentBaseV1 {
	version: 1;
	projects: RecipientReviewedIntentProjectV1[];
	excludedProjects: RecipientReviewedIntentExcludedProjectV1[];
}

export type RecipientReviewedIntentV1 =
	| (RecipientReviewedIntentBaseV1 & {
			journey: "team";
			team: { teamId: string; displayName: string; futureProjectsInherit: true };
	  })
	| (RecipientReviewedIntentBaseV1 & {
			journey: "add_device";
			targetIdentity: { identityId: string; displayName: string };
	  });

export type RecipientReviewedIntentTargetV1 =
	| { kind: "team_member"; policyTeamId: string }
	| { kind: "add_device"; targetIdentityId: string };

export class RecipientReviewedIntentError extends Error {
	readonly code: "recipient_reviewed_intent_invalid" | "recipient_invite_intent_mismatch";

	constructor(code: RecipientReviewedIntentError["code"]) {
		super(code);
		this.name = "RecipientReviewedIntentError";
		this.code = code;
	}
}

const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}]/u;
const MAX_PROJECTS = 100;
const MAX_CANONICAL_BYTES = 64 * 1024;

function invalid(): never {
	throw new RecipientReviewedIntentError("recipient_reviewed_intent_invalid");
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
	return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(value).some((key) => !keys.includes(key))) invalid();
}

function strictText(value: unknown, maxLength: number): string {
	if (
		typeof value !== "string" ||
		!value ||
		value !== value.trim() ||
		value.length > maxLength ||
		CONTROL_CHARACTER.test(value)
	) {
		invalid();
	}
	return value;
}

function displayName(value: unknown): string {
	if (typeof value !== "string" || CONTROL_CHARACTER.test(value)) invalid();
	const normalized = value.trim().replace(/\s+/gu, " ");
	if (!normalized || normalized.length > 256) invalid();
	return normalized;
}

function identityDisplayName(value: unknown): string {
	if (typeof value !== "string") invalid();
	try {
		return normalizeIdentityDisplayName(value, "identity_display_name");
	} catch {
		return invalid();
	}
}

function memoryCount(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
	return value;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sourceKey(source: RecipientReviewedIntentProjectSourceV1): string {
	return source.kind === "direct" ? "direct" : `team\u0000${source.teamId}`;
}

function normalizeSource(value: unknown): RecipientReviewedIntentProjectSourceV1 {
	const input = record(value);
	if (input.kind === "direct") {
		assertKeys(input, ["kind"]);
		return { kind: "direct" };
	}
	if (input.kind !== "team") invalid();
	assertKeys(input, ["kind", "teamId", "displayName"]);
	return {
		kind: "team",
		teamId: strictText(input.teamId, 256),
		displayName: displayName(input.displayName),
	};
}

function normalizeProject(value: unknown): RecipientReviewedIntentProjectV1 {
	const input = record(value);
	assertKeys(input, [
		"canonicalProjectIdentity",
		"displayName",
		"existingMemoryCount",
		"futureMemoriesShared",
		"sources",
	]);
	if (
		input.futureMemoriesShared !== true ||
		!Array.isArray(input.sources) ||
		!input.sources.length
	) {
		invalid();
	}
	const sources = input.sources
		.map(normalizeSource)
		.toSorted((left, right) => compareText(sourceKey(left), sourceKey(right)));
	if (new Set(sources.map(sourceKey)).size !== sources.length) invalid();
	return {
		canonicalProjectIdentity: strictText(input.canonicalProjectIdentity, 512),
		displayName: displayName(input.displayName),
		existingMemoryCount: memoryCount(input.existingMemoryCount),
		futureMemoriesShared: true,
		sources,
	};
}

function normalizeExcludedProject(value: unknown): RecipientReviewedIntentExcludedProjectV1 {
	const input = record(value);
	assertKeys(input, ["canonicalProjectIdentity", "displayName", "existingMemoryCount"]);
	return {
		canonicalProjectIdentity: strictText(input.canonicalProjectIdentity, 512),
		displayName: displayName(input.displayName),
		existingMemoryCount: memoryCount(input.existingMemoryCount),
	};
}

function normalizeProjectLists(
	input: Record<string, unknown>,
): Pick<RecipientReviewedIntentBaseV1, "projects" | "excludedProjects"> {
	if (
		!Array.isArray(input.projects) ||
		!Array.isArray(input.excludedProjects) ||
		input.projects.length > MAX_PROJECTS
	) {
		invalid();
	}
	const projects = input.projects
		.map(normalizeProject)
		.toSorted((left, right) =>
			compareText(left.canonicalProjectIdentity, right.canonicalProjectIdentity),
		);
	const excludedProjects = input.excludedProjects
		.map(normalizeExcludedProject)
		.toSorted((left, right) =>
			compareText(left.canonicalProjectIdentity, right.canonicalProjectIdentity),
		);
	const includedIds = projects.map((project) => project.canonicalProjectIdentity);
	const excludedIds = excludedProjects.map((project) => project.canonicalProjectIdentity);
	if (
		new Set(includedIds).size !== includedIds.length ||
		new Set(excludedIds).size !== excludedIds.length ||
		excludedIds.some((projectId) => includedIds.includes(projectId))
	) {
		invalid();
	}
	return { projects, excludedProjects };
}

function assertTarget(
	intent: RecipientReviewedIntentV1,
	target: RecipientReviewedIntentTargetV1,
): void {
	const matches =
		(intent.journey === "team" &&
			target.kind === "team_member" &&
			intent.team.teamId === target.policyTeamId) ||
		(intent.journey === "add_device" &&
			target.kind === "add_device" &&
			intent.targetIdentity.identityId === target.targetIdentityId);
	if (!matches) throw new RecipientReviewedIntentError("recipient_invite_intent_mismatch");
}

export function normalizeRecipientReviewedIntent(
	value: unknown,
	target?: RecipientReviewedIntentTargetV1,
): RecipientReviewedIntentV1 {
	const input = record(value);
	if (input.version !== RECIPIENT_REVIEWED_INTENT_VERSION) invalid();
	const projectLists = normalizeProjectLists(input);
	let intent: RecipientReviewedIntentV1;
	if (input.journey === "team") {
		assertKeys(input, ["version", "journey", "team", "projects", "excludedProjects"]);
		const team = record(input.team);
		assertKeys(team, ["teamId", "displayName", "futureProjectsInherit"]);
		if (team.futureProjectsInherit !== true) invalid();
		intent = {
			version: 1,
			journey: "team",
			team: {
				teamId: strictText(team.teamId, 256),
				displayName: displayName(team.displayName),
				futureProjectsInherit: true,
			},
			...projectLists,
		};
	} else if (input.journey === "add_device") {
		assertKeys(input, ["version", "journey", "targetIdentity", "projects", "excludedProjects"]);
		const identity = record(input.targetIdentity);
		assertKeys(identity, ["identityId", "displayName"]);
		intent = {
			version: 1,
			journey: "add_device",
			targetIdentity: {
				identityId: strictText(identity.identityId, 256),
				displayName: identityDisplayName(identity.displayName),
			},
			...projectLists,
		};
	} else {
		invalid();
	}
	if (target) assertTarget(intent, target);
	if (new TextEncoder().encode(canonicalJson(intent)).byteLength > MAX_CANONICAL_BYTES) invalid();
	return intent;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.toSorted(([left], [right]) => compareText(left, right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export function canonicalRecipientReviewedIntentJson(
	value: unknown,
	target?: RecipientReviewedIntentTargetV1,
): string {
	return canonicalJson(normalizeRecipientReviewedIntent(value, target));
}

export async function recipientReviewedIntentDigest(
	value: unknown,
	target?: RecipientReviewedIntentTargetV1,
): Promise<string> {
	const canonical = canonicalRecipientReviewedIntentJson(value, target);
	const bytes = new TextEncoder().encode(`recipient-reviewed-intent-v1\n${canonical}`);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyRecipientReviewedIntent(
	value: unknown,
	options: { target: RecipientReviewedIntentTargetV1; digest: string },
): Promise<RecipientReviewedIntentV1> {
	const normalized = normalizeRecipientReviewedIntent(value, options.target);
	if ((await recipientReviewedIntentDigest(normalized)) !== options.digest) {
		throw new RecipientReviewedIntentError("recipient_invite_intent_mismatch");
	}
	return normalized;
}

export async function parseStoredRecipientReviewedIntent(
	json: string | null | undefined,
	options: { target: RecipientReviewedIntentTargetV1; digest: string },
): Promise<RecipientReviewedIntentV1> {
	if (!json) throw new Error("recipient_invite_review_unavailable");
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		throw new Error("recipient_invite_review_unavailable");
	}
	try {
		const normalized = normalizeRecipientReviewedIntent(parsed, options.target);
		if (canonicalJson(normalized) !== json) {
			throw new Error("recipient_invite_review_unavailable");
		}
		return await verifyRecipientReviewedIntent(normalized, options);
	} catch (error) {
		if (
			error instanceof RecipientReviewedIntentError &&
			error.code === "recipient_invite_intent_mismatch"
		) {
			throw error;
		}
		if (error instanceof Error && error.message === "recipient_invite_review_unavailable") {
			throw error;
		}
		throw new Error("recipient_invite_review_unavailable");
	}
}
