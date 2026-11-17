/* `codemem coordinator invitation create`: a Team admin creates a Team or
 * add-device invitation from their own device, after reviewing the Projects it
 * shares. It no longer creates connection-only codes. */

import * as p from "@clack/prompts";
import { MemoryStore } from "@codemem/core";
import type { RecipientInvitationOutcome } from "@codemem/server";
import { Command, Option } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addConfigOption,
	addDbOption,
	addJsonOption,
	emitJsonError,
	resolveDbOpt,
} from "../shared-options.js";

interface InvitationCreateOptions {
	team?: string;
	addDevice?: boolean;
	review?: boolean;
	reviewedOnboardingDigest?: string;
	group?: string;
	ttlHours?: string;
	db?: string;
	dbPath?: string;
	config?: string;
	json?: boolean;
}

type InvitationStep = (
	store: MemoryStore,
	body: Record<string, unknown>,
) => RecipientInvitationOutcome | Promise<RecipientInvitationOutcome>;

export interface InvitationCreateDeps {
	openStore: (dbPath: string | undefined) => MemoryStore;
	preview: InvitationStep;
	create: InvitationStep;
}

// Load the viewer server only when this command runs, like `serve` does, so
// other CLI commands don't pay for it at startup.
const defaultDeps: InvitationCreateDeps = {
	openStore: (dbPath) => new MemoryStore(dbPath),
	preview: async (store, body) =>
		(await import("@codemem/server")).previewRecipientInvitation(store, body),
	create: async (store, body) =>
		(await import("@codemem/server")).createRecipientInvitation(store, body),
};

class InvitationCreateError extends Error {
	constructor(
		readonly code: string,
		message: string,
		/** 2 for invalid flags or arguments, 1 for a failed operation (CLI conventions). */
		readonly exitCode: 1 | 2 = 1,
	) {
		super(message);
	}
}

const USAGE_ERRORS = new Set([
	"invitation_kind_required",
	"usage_error",
	"reviewed_onboarding_digest_required",
	"ttl_hours_invalid",
]);

const ERROR_MESSAGES: Record<string, string> = {
	coordinator_admin_secret_missing:
		"Team invitations need the coordinator admin secret on this device. Run this on the device that holds it.",
	coordinator_not_configured:
		"This device isn't connected to a coordinator. Set the coordinator URL and group in its config, then try again.",
	coordinator_group_missing:
		"This device has no coordinator group configured. Set one in its config, then try again.",
	reviewed_onboarding_stale:
		"The Projects this invitation shares changed after your review. Run with --review again and use the new digest.",
	reviewed_onboarding_digest_required:
		"Review the invitation first with --review, then pass --reviewed-onboarding-digest <digest>.",
	invite_identity_conflict:
		"An add-device invitation can only add a device for the person on this device.",
	ttl_hours_invalid: "--ttl-hours must be a whole number of at least 1.",
	group_id_required:
		"This device has no coordinator group configured. Pass --group <group> or set one in its config.",
};

const REMOTE_FAILURE = /^Remote coordinator request failed \((\d+)\): (.*)$/;
const TRANSPORT_FAILURE =
	/fetch failed|timeout|timed out|aborted|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i;

// Team invitations authenticate with the admin secret; add-device invitations from
// a device without it are signed by the device, so their failures need other advice.
const ADMIN_SECRET_ERRORS = new Set(["invalid_admin_secret", "missing_admin_header"]);
const DEVICE_AUTH_ERRORS = new Set([
	"unknown_device",
	"device_disabled",
	"device_revoked",
	"invalid_signature",
	"missing_headers",
	"signature_verification_error",
]);

/** Turns a raw failure from the shared invitation code into a code and next step. */
function describeFailure(raw: string): { code: string; message: string } {
	const known = ERROR_MESSAGES[raw];
	if (known) return { code: raw, message: known };
	const remote = REMOTE_FAILURE.exec(raw);
	const remoteError = remote?.[2] ?? "";
	if (ADMIN_SECRET_ERRORS.has(remoteError)) {
		return {
			code: "coordinator_admin_secret_rejected",
			message:
				"The coordinator rejected this device's admin secret, so no invitation was created. Make sure sync_coordinator_admin_secret in this device's config matches the coordinator, then try again.",
		};
	}
	if (remoteError === "admin_not_configured") {
		return {
			code: "coordinator_admin_not_configured",
			message:
				"The coordinator has no admin secret set, so it can't create Team invitations. Set CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET on the coordinator host, restart it, then try again.",
		};
	}
	if (DEVICE_AUTH_ERRORS.has(remoteError)) {
		return {
			code: "coordinator_device_rejected",
			message: `The coordinator didn't accept this device (${remoteError}), so no invitation was created. Ask a Team admin to check that this device is still active in the coordinator group, or create the invitation on a device that holds the coordinator admin secret.`,
		};
	}
	if (remote) {
		return {
			code: "coordinator_request_failed",
			message: `The coordinator refused the request (HTTP ${remote[1]}: ${remote[2]}), so no invitation was created. Check that the coordinator is running and up to date, then try again.`,
		};
	}
	if (TRANSPORT_FAILURE.test(raw)) {
		return {
			code: "coordinator_unreachable",
			message:
				"codemem couldn't reach the coordinator, so it can't confirm whether the invitation was created. Check the coordinator URL in this device's config and that the coordinator is running, then try again. An unused invitation expires on its own.",
		};
	}
	return {
		code: "invitation_create_failed",
		message: `codemem couldn't create the invitation (${raw}). Check this device's coordinator settings, then try again.`,
	};
}

function invitationFailure(raw: string): InvitationCreateError {
	const described = describeFailure(raw);
	return new InvitationCreateError(described.code, described.message);
}

function fail(code: string, message?: string): never {
	const exitCode = USAGE_ERRORS.has(code) ? 2 : 1;
	if (message) throw new InvitationCreateError(code, message, exitCode);
	const described = describeFailure(code);
	throw new InvitationCreateError(described.code, described.message, exitCode);
}

function resolveTeamId(store: MemoryStore, team: string): string {
	const rows = store.db
		.prepare("SELECT team_id, display_name FROM policy_teams WHERE status = 'active'")
		.all() as Array<{ team_id: string; display_name: string }>;
	const byId = rows.find((row) => row.team_id === team);
	if (byId) return byId.team_id;
	const key = team.normalize("NFC").toLowerCase();
	const byName = rows.filter((row) => row.display_name.normalize("NFC").toLowerCase() === key);
	if (byName.length === 1 && byName[0]) return byName[0].team_id;
	if (byName.length > 1) {
		fail("team_ambiguous", `More than one Team is named "${team}". Pass its Team ID instead.`);
	}
	return fail(
		"team_not_found",
		`No active Team named "${team}" on this device. Create it in Sharing, or run this on a device where it exists.`,
	);
}

function requestBody(
	store: MemoryStore,
	opts: InvitationCreateOptions,
	legacyArgs: string[],
): Record<string, unknown> {
	// `invitation create <group>` used to make a connection-only code; explain the
	// change instead of letting the stray argument fail as a usage error.
	if (legacyArgs.length > 0 || Boolean(opts.team) === Boolean(opts.addDevice)) {
		fail(
			"invitation_kind_required",
			"Choose --team <name> or --add-device. codemem no longer creates invitations that only connect a device. To connect a device without sharing Projects, use `codemem coordinator device enroll`.",
		);
	}
	if (opts.review && opts.reviewedOnboardingDigest !== undefined) {
		fail("usage_error", "Use --review or --reviewed-onboarding-digest, not both.");
	}
	const target = opts.team
		? { kind: "team_member", policy_team_id: resolveTeamId(store, opts.team.trim()) }
		: { kind: "add_device", target_identity_id: store.actorId };
	return {
		...target,
		...(opts.group?.trim() ? { group_id: opts.group.trim() } : {}),
		ttl_hours: opts.ttlHours ?? "24",
		...(opts.reviewedOnboardingDigest
			? { reviewed_onboarding_digest: opts.reviewedOnboardingDigest.trim() }
			: {}),
	};
}

function unwrap(outcome: RecipientInvitationOutcome): Record<string, unknown> {
	if (outcome.httpStatus === 200) return outcome.body;
	const code = String(outcome.body.error ?? "invitation_create_failed");
	return fail(code);
}

interface PreviewProject {
	displayName?: string;
	existingMemoryCount?: number;
}

function printReview(body: Record<string, unknown>, opts: InvitationCreateOptions): void {
	const preview = body.preview as {
		reviewedOnboardingDigest: string;
		team?: { displayName?: string } | null;
		projects?: PreviewProject[];
	};
	if (opts.json) {
		console.log(JSON.stringify({ kind: body.kind, preview }, null, 2));
		return;
	}
	p.intro("codemem coordinator invitation create --review");
	if (preview.team?.displayName) p.log.message(`Team: ${preview.team.displayName}`);
	const projects = preview.projects ?? [];
	p.log.message(projects.length ? "Shares these Projects:" : "Shares no Projects yet.");
	for (const project of projects) {
		p.log.message(`- ${project.displayName} (${project.existingMemoryCount ?? 0} memories)`);
	}
	p.log.message(`Create it with --reviewed-onboarding-digest ${preview.reviewedOnboardingDigest}`);
	p.outro("Review only; nothing was created");
}

function printCreated(body: Record<string, unknown>, opts: InvitationCreateOptions): void {
	if (opts.json) {
		console.log(JSON.stringify(body, null, 2));
		return;
	}
	const invite = (body.invite ?? {}) as { link?: unknown; encoded?: unknown; warnings?: unknown };
	p.intro("codemem coordinator invitation create");
	if (typeof invite.link === "string") p.log.message(`- link: ${invite.link}`);
	if (typeof invite.encoded === "string") p.log.message(`- invite: ${invite.encoded}`);
	const warnings = Array.isArray(invite.warnings) ? invite.warnings : [];
	for (const warning of warnings) {
		if (typeof warning === "string") p.log.warn(warning);
	}
	p.outro("Invitation ready. Send it to the person you are inviting.");
}

async function runInvitationCreate(
	opts: InvitationCreateOptions,
	legacyArgs: string[],
	deps: InvitationCreateDeps,
): Promise<void> {
	if (opts.config) process.env.CODEMEM_CONFIG = opts.config;
	const store = deps.openStore(resolveDbOpt(opts));
	try {
		const body = requestBody(store, opts, legacyArgs);
		if (opts.review) {
			printReview(unwrap(await deps.preview(store, body)), opts);
			return;
		}
		if (!opts.reviewedOnboardingDigest) fail("reviewed_onboarding_digest_required");
		printCreated(unwrap(await deps.create(store, body)), opts);
	} finally {
		store.close();
	}
}

export function buildCoordinatorInvitationCreateCommand(
	deps: InvitationCreateDeps = defaultDeps,
): Command {
	const cmd = new Command("create")
		.configureHelp(helpStyle)
		.description("Create a Team or add-device invitation from this device")
		.addOption(new Option("--team <team>", "Team name or ID to invite someone to"))
		.addOption(new Option("--add-device", "invite another device for the person on this device"))
		.option("--review", "show the Projects the invitation shares without creating it")
		.option("--reviewed-onboarding-digest <digest>", "create the invitation you reviewed")
		.option("--group <group>", "coordinator group (defaults to the configured group)")
		.option("--ttl-hours <hours>", "invitation lifetime in hours", "24")
		.allowExcessArguments(true);
	addDbOption(cmd);
	addConfigOption(cmd);
	addJsonOption(cmd);
	cmd.action(async (opts: InvitationCreateOptions, command: Command) => {
		try {
			await runInvitationCreate(opts, command.args, deps);
		} catch (err) {
			const failure =
				err instanceof InvitationCreateError
					? err
					: invitationFailure(err instanceof Error ? err.message : String(err));
			if (opts.json) {
				emitJsonError(failure.code, failure.message, failure.exitCode);
				return;
			}
			p.log.error(failure.message);
			process.exitCode = failure.exitCode;
		}
	});
	return cmd;
}
