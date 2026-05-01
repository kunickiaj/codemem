/**
 * Coordinator CLI commands — manage coordinator invites, join requests, and relay server.
 *
 * Extracted from sync.ts to give coordinator admin its own top-level group
 * per cli-design-conventions.md (operator/admin surfaces belong in their own group).
 *
 * buildCoordinatorCommand() is a factory that creates a fresh command tree.
 * This allows both the canonical top-level `coordinator` and the deprecated
 * `sync coordinator` alias to have independent Commander instances (Commander
 * re-parents commands on addCommand, so sharing instances between two parents
 * is not possible).
 */

import { readFileSync } from "node:fs";

import * as p from "@clack/prompts";
import {
	coordinatorCreateGroupAction,
	coordinatorCreateInviteAction,
	coordinatorCreateScopeAction,
	coordinatorDisableDeviceAction,
	coordinatorEnrollDeviceAction,
	coordinatorGrantScopeMembershipAction,
	coordinatorImportInviteAction,
	coordinatorListBootstrapGrantsAction,
	coordinatorListDevicesAction,
	coordinatorListGroupsAction,
	coordinatorListJoinRequestsAction,
	coordinatorListScopeMembershipsAction,
	coordinatorListScopesAction,
	coordinatorRemoveDeviceAction,
	coordinatorRenameDeviceAction,
	coordinatorReviewJoinRequestAction,
	coordinatorRevokeBootstrapGrantAction,
	coordinatorRevokeScopeMembershipAction,
	coordinatorUpdateScopeAction,
	createBetterSqliteCoordinatorApp,
	DEFAULT_COORDINATOR_DB_PATH,
	fingerprintPublicKey,
} from "@codemem/core";
import { serve as honoServe } from "@hono/node-server";
import { Command, Option } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addConfigOption,
	addDbOption,
	addJsonOption,
	emitJsonError,
	resolveDbOpt,
} from "../shared-options.js";

function readCoordinatorPublicKey(opts: { publicKey?: string; publicKeyFile?: string }): string {
	const inline = String(opts.publicKey ?? "").trim();
	const filePath = String(opts.publicKeyFile ?? "").trim();
	if (inline && filePath) throw new Error("Use only one of --public-key or --public-key-file");
	if (filePath) {
		const text = readFileSync(filePath, "utf8").trim();
		if (!text) throw new Error(`Public key file is empty: ${filePath}`);
		return text;
	}
	if (!inline) throw new Error("Public key required via --public-key or --public-key-file");
	return inline;
}

function parseOptionalInteger(value: string | undefined, name: string): number | null {
	if (value == null || !String(value).trim()) return null;
	const parsed = Number.parseInt(String(value), 10);
	if (!Number.isFinite(parsed)) throw new Error(`${name} must be an integer`);
	return parsed;
}

/**
 * Build a fresh coordinator command tree. Each call returns independent
 * Commander instances so the tree can be mounted under multiple parents.
 */
export function buildCoordinatorCommand(): Command {
	const cmd = new Command("coordinator")
		.configureHelp(helpStyle)
		.description("Manage coordinator invites, join requests, and relay server");

	// ---- group-create ----

	const groupCreateCmd = new Command("group-create")
		.configureHelp(helpStyle)
		.description("Create a coordinator group in the local store")
		.argument("<group>", "group id")
		.option("--name <name>", "display name override");
	addDbOption(groupCreateCmd);
	addJsonOption(groupCreateCmd);
	groupCreateCmd.action(
		async (
			groupId: string,
			opts: { name?: string; db?: string; dbPath?: string; json?: boolean },
		) => {
			try {
				const group = await coordinatorCreateGroupAction({
					groupId,
					displayName: opts.name?.trim() || null,
					dbPath: resolveDbOpt(opts) ?? null,
				});
				if (opts.json) {
					console.log(JSON.stringify(group, null, 2));
					return;
				}
				p.intro("codemem coordinator group-create");
				p.log.success(`Group ready: ${groupId.trim()}`);
				p.outro(String(group.display_name ?? group.group_id ?? groupId.trim()));
			} catch (err) {
				if (opts.json) {
					emitJsonError("group_create_failed", err instanceof Error ? err.message : String(err));
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(groupCreateCmd);

	// ---- list-groups ----

	const listGroupsCmd = new Command("list-groups")
		.configureHelp(helpStyle)
		.description("List coordinator groups from the local store");
	addDbOption(listGroupsCmd);
	addJsonOption(listGroupsCmd);
	listGroupsCmd.action(async (opts: { db?: string; dbPath?: string; json?: boolean }) => {
		try {
			const groups = await coordinatorListGroupsAction({ dbPath: resolveDbOpt(opts) ?? null });
			if (opts.json) {
				console.log(JSON.stringify(groups, null, 2));
				return;
			}
			p.intro("codemem coordinator list-groups");
			if (groups.length === 0) {
				p.outro("No coordinator groups found");
				return;
			}
			for (const group of groups) {
				p.log.message(
					`- ${String(group.group_id ?? "")}${group.display_name ? ` (${String(group.display_name)})` : ""}`,
				);
			}
			p.outro(`${groups.length} group(s)`);
		} catch (err) {
			if (opts.json) {
				emitJsonError("list_groups_failed", err instanceof Error ? err.message : String(err));
				return;
			}
			p.log.error(err instanceof Error ? err.message : String(err));
			process.exitCode = 1;
		}
	});
	cmd.addCommand(listGroupsCmd);

	// ---- enroll-device ----

	const enrollDeviceCmd = new Command("enroll-device")
		.configureHelp(helpStyle)
		.description("Enroll a device in a local coordinator group")
		.argument("<group>", "group id")
		.argument("<device-id>", "device id")
		.option("--fingerprint <fingerprint>", "device fingerprint")
		.option("--public-key <key>", "device public key")
		.option("--public-key-file <path>", "path to device public key")
		.option("--name <name>", "display name");
	addDbOption(enrollDeviceCmd);
	addJsonOption(enrollDeviceCmd);
	enrollDeviceCmd.action(
		async (
			groupId: string,
			deviceId: string,
			opts: {
				fingerprint?: string;
				publicKey?: string;
				publicKeyFile?: string;
				name?: string;
				db?: string;
				dbPath?: string;
				json?: boolean;
			},
		) => {
			try {
				const publicKey = readCoordinatorPublicKey(opts);
				const fingerprint = String(opts.fingerprint ?? "").trim();
				if (!fingerprint) {
					if (opts.json) {
						emitJsonError("usage_error", "Fingerprint required via --fingerprint", 2);
						return;
					}
					p.log.error("Fingerprint required via --fingerprint");
					process.exitCode = 1;
					return;
				}
				const actualFingerprint = fingerprintPublicKey(publicKey);
				if (actualFingerprint !== fingerprint) {
					if (opts.json) {
						emitJsonError(
							"fingerprint_mismatch",
							"Fingerprint does not match the provided public key",
						);
						return;
					}
					p.log.error("Fingerprint does not match the provided public key");
					process.exitCode = 1;
					return;
				}
				const enrollment = await coordinatorEnrollDeviceAction({
					groupId,
					deviceId,
					fingerprint,
					publicKey,
					displayName: opts.name?.trim() || null,
					dbPath: resolveDbOpt(opts) ?? null,
				});
				if (opts.json) {
					console.log(JSON.stringify(enrollment, null, 2));
					return;
				}
				p.intro("codemem coordinator enroll-device");
				p.log.success(`Enrolled ${deviceId.trim()} in ${groupId.trim()}`);
				p.outro(String(enrollment.display_name ?? enrollment.device_id ?? deviceId.trim()));
			} catch (err) {
				if (opts.json) {
					emitJsonError("enroll_failed", err instanceof Error ? err.message : String(err));
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(enrollDeviceCmd);

	// ---- list-devices ----

	const listDevicesCmd = new Command("list-devices")
		.configureHelp(helpStyle)
		.description("List enrolled devices in a local coordinator group")
		.argument("<group>", "group id")
		.option("--include-disabled", "include disabled devices");
	addDbOption(listDevicesCmd);
	addJsonOption(listDevicesCmd);
	listDevicesCmd.action(
		async (
			groupId: string,
			opts: { includeDisabled?: boolean; db?: string; dbPath?: string; json?: boolean },
		) => {
			try {
				const rows = await coordinatorListDevicesAction({
					groupId,
					includeDisabled: opts.includeDisabled === true,
					dbPath: resolveDbOpt(opts) ?? null,
				});
				if (opts.json) {
					console.log(JSON.stringify(rows, null, 2));
					return;
				}
				p.intro("codemem coordinator list-devices");
				if (rows.length === 0) {
					p.outro(`No enrolled devices for ${groupId.trim()}`);
					return;
				}
				for (const row of rows) {
					const label =
						String(row.display_name ?? row.device_id ?? "").trim() || String(row.device_id ?? "");
					const enabled = Number(row.enabled ?? 1) === 1 ? "enabled" : "disabled";
					p.log.message(`- ${label} (${String(row.device_id ?? "")}) ${enabled}`);
				}
				p.outro(`${rows.length} device(s)`);
			} catch (err) {
				if (opts.json) {
					emitJsonError("list_devices_failed", err instanceof Error ? err.message : String(err));
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(listDevicesCmd);

	// ---- list-scopes ----

	const listScopesCmd = new Command("list-scopes")
		.configureHelp(helpStyle)
		.description("List coordinator Sharing domains for a group")
		.argument("<group>", "group id")
		.option("--include-inactive", "include inactive Sharing domains")
		.option("--remote-url <url>", "remote coordinator URL override")
		.option("--admin-secret <secret>", "remote coordinator admin secret override");
	addDbOption(listScopesCmd);
	addJsonOption(listScopesCmd);
	listScopesCmd.action(
		async (
			groupId: string,
			opts: {
				includeInactive?: boolean;
				remoteUrl?: string;
				adminSecret?: string;
				db?: string;
				dbPath?: string;
				json?: boolean;
			},
		) => {
			try {
				const rows = await coordinatorListScopesAction({
					groupId,
					includeInactive: opts.includeInactive === true,
					dbPath: resolveDbOpt(opts) ?? null,
					remoteUrl: opts.remoteUrl?.trim() || null,
					adminSecret: opts.adminSecret?.trim() || null,
				});
				if (opts.json) {
					console.log(JSON.stringify(rows, null, 2));
					return;
				}
				p.intro("codemem coordinator list-scopes");
				if (rows.length === 0) {
					p.outro(`No Sharing domains for ${groupId.trim()}`);
					return;
				}
				for (const row of rows) {
					p.log.message(
						`- ${row.label} (${row.scope_id}) status=${row.status} epoch=${row.membership_epoch}`,
					);
				}
				p.outro(`${rows.length} Sharing domain(s)`);
			} catch (err) {
				if (opts.json) {
					emitJsonError("list_scopes_failed", err instanceof Error ? err.message : String(err));
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(listScopesCmd);

	// ---- create-scope ----

	const createScopeCmd = new Command("create-scope")
		.configureHelp(helpStyle)
		.description("Create a coordinator Sharing domain")
		.argument("<group>", "group id")
		.argument("<scope-id>", "Sharing domain scope_id")
		.requiredOption("--label <label>", "Sharing domain label")
		.option("--kind <kind>", "Sharing domain kind")
		.option("--authority-type <type>", "authority type")
		.option("--coordinator-id <id>", "coordinator id assertion")
		.option("--membership-epoch <epoch>", "membership epoch")
		.option("--manifest-hash <hash>", "membership manifest hash")
		.option("--status <status>", "Sharing domain status")
		.option("--remote-url <url>", "remote coordinator URL override")
		.option("--admin-secret <secret>", "remote coordinator admin secret override");
	addDbOption(createScopeCmd);
	addJsonOption(createScopeCmd);
	createScopeCmd.action(
		async (
			groupId: string,
			scopeId: string,
			opts: {
				label: string;
				kind?: string;
				authorityType?: string;
				coordinatorId?: string;
				membershipEpoch?: string;
				manifestHash?: string;
				status?: string;
				remoteUrl?: string;
				adminSecret?: string;
				db?: string;
				dbPath?: string;
				json?: boolean;
			},
		) => {
			try {
				const scope = await coordinatorCreateScopeAction({
					groupId,
					scopeId,
					label: opts.label.trim(),
					kind: opts.kind?.trim() || null,
					authorityType: opts.authorityType?.trim() || null,
					coordinatorId: opts.coordinatorId?.trim() || null,
					membershipEpoch: parseOptionalInteger(opts.membershipEpoch, "membership epoch"),
					manifestHash: opts.manifestHash?.trim() || null,
					status: opts.status?.trim() || null,
					dbPath: resolveDbOpt(opts) ?? null,
					remoteUrl: opts.remoteUrl?.trim() || null,
					adminSecret: opts.adminSecret?.trim() || null,
				});
				if (opts.json) {
					console.log(JSON.stringify(scope, null, 2));
					return;
				}
				p.intro("codemem coordinator create-scope");
				p.log.success(`Sharing domain ready: ${scope.scope_id}`);
				p.outro(scope.label);
			} catch (err) {
				if (opts.json) {
					emitJsonError("create_scope_failed", err instanceof Error ? err.message : String(err));
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(createScopeCmd);

	// ---- update-scope ----

	const updateScopeCmd = new Command("update-scope")
		.configureHelp(helpStyle)
		.description("Update coordinator Sharing domain metadata")
		.argument("<group>", "group id")
		.argument("<scope-id>", "Sharing domain scope_id")
		.option("--label <label>", "Sharing domain label")
		.option("--kind <kind>", "Sharing domain kind")
		.option("--authority-type <type>", "authority type")
		.option("--coordinator-id <id>", "coordinator id assertion")
		.option("--membership-epoch <epoch>", "membership epoch")
		.option("--manifest-hash <hash>", "membership manifest hash")
		.option("--status <status>", "Sharing domain status")
		.option("--remote-url <url>", "remote coordinator URL override")
		.option("--admin-secret <secret>", "remote coordinator admin secret override");
	addDbOption(updateScopeCmd);
	addJsonOption(updateScopeCmd);
	updateScopeCmd.action(
		async (
			groupId: string,
			scopeId: string,
			opts: {
				label?: string;
				kind?: string;
				authorityType?: string;
				coordinatorId?: string;
				membershipEpoch?: string;
				manifestHash?: string;
				status?: string;
				remoteUrl?: string;
				adminSecret?: string;
				db?: string;
				dbPath?: string;
				json?: boolean;
			},
		) => {
			try {
				const scope = await coordinatorUpdateScopeAction({
					groupId,
					scopeId,
					label: opts.label?.trim(),
					kind: opts.kind?.trim(),
					authorityType: opts.authorityType?.trim(),
					coordinatorId: opts.coordinatorId?.trim(),
					membershipEpoch: parseOptionalInteger(opts.membershipEpoch, "membership epoch"),
					manifestHash: opts.manifestHash?.trim(),
					status: opts.status?.trim(),
					dbPath: resolveDbOpt(opts) ?? null,
					remoteUrl: opts.remoteUrl?.trim() || null,
					adminSecret: opts.adminSecret?.trim() || null,
				});
				if (!scope) {
					if (opts.json) {
						emitJsonError("scope_not_found", `Sharing domain not found: ${scopeId.trim()}`);
						return;
					}
					p.log.error(`Sharing domain not found: ${scopeId.trim()}`);
					process.exitCode = 1;
					return;
				}
				if (opts.json) {
					console.log(JSON.stringify(scope, null, 2));
					return;
				}
				p.intro("codemem coordinator update-scope");
				p.log.success(`Updated Sharing domain: ${scope.scope_id}`);
				p.outro(scope.label);
			} catch (err) {
				if (opts.json) {
					emitJsonError("update_scope_failed", err instanceof Error ? err.message : String(err));
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(updateScopeCmd);

	// ---- list-scope-members ----

	const listScopeMembersCmd = new Command("list-scope-members")
		.configureHelp(helpStyle)
		.description("List explicit members of a Sharing domain")
		.argument("<group>", "group id")
		.argument("<scope-id>", "Sharing domain scope_id")
		.option("--include-revoked", "include revoked memberships")
		.option("--remote-url <url>", "remote coordinator URL override")
		.option("--admin-secret <secret>", "remote coordinator admin secret override");
	addDbOption(listScopeMembersCmd);
	addJsonOption(listScopeMembersCmd);
	listScopeMembersCmd.action(
		async (
			groupId: string,
			scopeId: string,
			opts: {
				includeRevoked?: boolean;
				remoteUrl?: string;
				adminSecret?: string;
				db?: string;
				dbPath?: string;
				json?: boolean;
			},
		) => {
			try {
				const rows = await coordinatorListScopeMembershipsAction({
					groupId,
					scopeId,
					includeRevoked: opts.includeRevoked === true,
					dbPath: resolveDbOpt(opts) ?? null,
					remoteUrl: opts.remoteUrl?.trim() || null,
					adminSecret: opts.adminSecret?.trim() || null,
				});
				if (opts.json) {
					console.log(JSON.stringify(rows, null, 2));
					return;
				}
				p.intro("codemem coordinator list-scope-members");
				if (rows.length === 0) {
					p.outro(`No members for Sharing domain ${scopeId.trim()}`);
					return;
				}
				for (const row of rows) {
					p.log.message(
						`- ${row.device_id} role=${row.role} status=${row.status} epoch=${row.membership_epoch}`,
					);
				}
				p.outro(`${rows.length} member(s)`);
			} catch (err) {
				if (opts.json) {
					emitJsonError(
						"list_scope_members_failed",
						err instanceof Error ? err.message : String(err),
					);
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(listScopeMembersCmd);

	// ---- grant-scope-member ----

	const grantScopeMemberCmd = new Command("grant-scope-member")
		.configureHelp(helpStyle)
		.description("Grant a device explicit access to a Sharing domain")
		.argument("<group>", "group id")
		.argument("<scope-id>", "Sharing domain scope_id")
		.argument("<device-id>", "device id")
		.option("--role <role>", "membership role")
		.option("--membership-epoch <epoch>", "membership epoch")
		.option("--manifest-hash <hash>", "membership manifest hash")
		.option("--remote-url <url>", "remote coordinator URL override")
		.option("--admin-secret <secret>", "remote coordinator admin secret override");
	addDbOption(grantScopeMemberCmd);
	addJsonOption(grantScopeMemberCmd);
	grantScopeMemberCmd.action(
		async (
			groupId: string,
			scopeId: string,
			deviceId: string,
			opts: {
				role?: string;
				membershipEpoch?: string;
				manifestHash?: string;
				remoteUrl?: string;
				adminSecret?: string;
				db?: string;
				dbPath?: string;
				json?: boolean;
			},
		) => {
			try {
				const membership = await coordinatorGrantScopeMembershipAction({
					groupId,
					scopeId,
					deviceId,
					role: opts.role?.trim() || null,
					membershipEpoch: parseOptionalInteger(opts.membershipEpoch, "membership epoch"),
					manifestHash: opts.manifestHash?.trim() || null,
					dbPath: resolveDbOpt(opts) ?? null,
					remoteUrl: opts.remoteUrl?.trim() || null,
					adminSecret: opts.adminSecret?.trim() || null,
				});
				if (opts.json) {
					console.log(JSON.stringify(membership, null, 2));
					return;
				}
				p.intro("codemem coordinator grant-scope-member");
				p.log.success(`Granted ${deviceId.trim()} to Sharing domain ${scopeId.trim()}`);
				p.outro(membership.role);
			} catch (err) {
				if (opts.json) {
					emitJsonError(
						"grant_scope_member_failed",
						err instanceof Error ? err.message : String(err),
					);
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(grantScopeMemberCmd);

	// ---- revoke-scope-member ----

	const revokeScopeMemberCmd = new Command("revoke-scope-member")
		.configureHelp(helpStyle)
		.description("Revoke a device from a Sharing domain")
		.argument("<group>", "group id")
		.argument("<scope-id>", "Sharing domain scope_id")
		.argument("<device-id>", "device id")
		.option("--membership-epoch <epoch>", "membership epoch")
		.option("--manifest-hash <hash>", "membership manifest hash")
		.option("--remote-url <url>", "remote coordinator URL override")
		.option("--admin-secret <secret>", "remote coordinator admin secret override");
	addDbOption(revokeScopeMemberCmd);
	addJsonOption(revokeScopeMemberCmd);
	revokeScopeMemberCmd.action(
		async (
			groupId: string,
			scopeId: string,
			deviceId: string,
			opts: {
				membershipEpoch?: string;
				manifestHash?: string;
				remoteUrl?: string;
				adminSecret?: string;
				db?: string;
				dbPath?: string;
				json?: boolean;
			},
		) => {
			try {
				const ok = await coordinatorRevokeScopeMembershipAction({
					groupId,
					scopeId,
					deviceId,
					membershipEpoch: parseOptionalInteger(opts.membershipEpoch, "membership epoch"),
					manifestHash: opts.manifestHash?.trim() || null,
					dbPath: resolveDbOpt(opts) ?? null,
					remoteUrl: opts.remoteUrl?.trim() || null,
					adminSecret: opts.adminSecret?.trim() || null,
				});
				if (!ok) {
					if (opts.json) {
						emitJsonError("scope_membership_not_found", "Sharing domain membership not found");
						return;
					}
					p.log.error("Sharing domain membership not found");
					process.exitCode = 1;
					return;
				}
				if (opts.json) {
					console.log(
						JSON.stringify(
							{ ok: true, scope_id: scopeId.trim(), device_id: deviceId.trim() },
							null,
							2,
						),
					);
					return;
				}
				p.intro("codemem coordinator revoke-scope-member");
				p.log.success(`Revoked ${deviceId.trim()} from Sharing domain ${scopeId.trim()}`);
				p.outro("revoked");
			} catch (err) {
				if (opts.json) {
					emitJsonError(
						"revoke_scope_member_failed",
						err instanceof Error ? err.message : String(err),
					);
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(revokeScopeMemberCmd);

	// ---- rename-device ----

	const renameDeviceCmd = new Command("rename-device")
		.configureHelp(helpStyle)
		.description("Rename an enrolled device in the local coordinator store")
		.argument("<group>", "group id")
		.argument("<device-id>", "device id")
		.requiredOption("--name <name>", "display name");
	addDbOption(renameDeviceCmd);
	addJsonOption(renameDeviceCmd);
	renameDeviceCmd.action(
		async (
			groupId: string,
			deviceId: string,
			opts: { name: string; db?: string; dbPath?: string; json?: boolean },
		) => {
			try {
				const result = await coordinatorRenameDeviceAction({
					groupId,
					deviceId,
					displayName: opts.name.trim(),
					dbPath: resolveDbOpt(opts) ?? null,
				});
				if (!result) {
					if (opts.json) {
						emitJsonError("device_not_found", `Device not found: ${deviceId.trim()}`);
						return;
					}
					p.log.error(`Device not found: ${deviceId.trim()}`);
					process.exitCode = 1;
					return;
				}
				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}
				p.intro("codemem coordinator rename-device");
				p.log.success(`Renamed ${deviceId.trim()} in ${groupId.trim()}`);
				p.outro(String(result.display_name ?? result.device_id ?? deviceId.trim()));
			} catch (err) {
				if (opts.json) {
					emitJsonError("rename_failed", err instanceof Error ? err.message : String(err));
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(renameDeviceCmd);

	// ---- disable-device ----

	const disableDeviceCmd = new Command("disable-device")
		.configureHelp(helpStyle)
		.description("Disable an enrolled device in the local coordinator store")
		.argument("<group>", "group id")
		.argument("<device-id>", "device id");
	addDbOption(disableDeviceCmd);
	addJsonOption(disableDeviceCmd);
	disableDeviceCmd.action(
		async (
			groupId: string,
			deviceId: string,
			opts: { db?: string; dbPath?: string; json?: boolean },
		) => {
			try {
				const ok = await coordinatorDisableDeviceAction({
					groupId,
					deviceId,
					dbPath: resolveDbOpt(opts) ?? null,
				});
				if (!ok) {
					if (opts.json) {
						emitJsonError("device_not_found", `Device not found: ${deviceId.trim()}`);
						return;
					}
					p.log.error(`Device not found: ${deviceId.trim()}`);
					process.exitCode = 1;
					return;
				}
				if (opts.json) {
					console.log(
						JSON.stringify(
							{ ok: true, group_id: groupId.trim(), device_id: deviceId.trim() },
							null,
							2,
						),
					);
					return;
				}
				p.intro("codemem coordinator disable-device");
				p.log.success(`Disabled ${deviceId.trim()} in ${groupId.trim()}`);
				p.outro("disabled");
			} catch (err) {
				if (opts.json) {
					emitJsonError("disable_failed", err instanceof Error ? err.message : String(err));
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(disableDeviceCmd);

	// ---- remove-device ----

	const removeDeviceCmd = new Command("remove-device")
		.configureHelp(helpStyle)
		.description("Remove an enrolled device from the local coordinator store")
		.argument("<group>", "group id")
		.argument("<device-id>", "device id");
	addDbOption(removeDeviceCmd);
	addJsonOption(removeDeviceCmd);
	removeDeviceCmd.action(
		async (
			groupId: string,
			deviceId: string,
			opts: { db?: string; dbPath?: string; json?: boolean },
		) => {
			try {
				const ok = await coordinatorRemoveDeviceAction({
					groupId,
					deviceId,
					dbPath: resolveDbOpt(opts) ?? null,
				});
				if (!ok) {
					if (opts.json) {
						emitJsonError("device_not_found", `Device not found: ${deviceId.trim()}`);
						return;
					}
					p.log.error(`Device not found: ${deviceId.trim()}`);
					process.exitCode = 1;
					return;
				}
				if (opts.json) {
					console.log(
						JSON.stringify(
							{ ok: true, group_id: groupId.trim(), device_id: deviceId.trim() },
							null,
							2,
						),
					);
					return;
				}
				p.intro("codemem coordinator remove-device");
				p.log.success(`Removed ${deviceId.trim()} from ${groupId.trim()}`);
				p.outro("removed");
			} catch (err) {
				if (opts.json) {
					emitJsonError("remove_failed", err instanceof Error ? err.message : String(err));
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(removeDeviceCmd);

	// ---- serve (coordinator relay) ----

	const coordServeCmd = new Command("serve")
		.configureHelp(helpStyle)
		.description("Run the coordinator relay HTTP server")
		.option("--coordinator-host <host>", "bind host")
		.option("--coordinator-port <port>", "bind port");
	// Coordinator serve uses its own DB, not the main codemem DB
	coordServeCmd.addOption(new Option("-d, --db-path <path>", "coordinator database path"));
	coordServeCmd.addOption(new Option("--db <path>", "coordinator database path").hideHelp());
	// Hidden host/port aliases for backwards compat
	coordServeCmd.addOption(new Option("--host <host>", "bind host").hideHelp());
	coordServeCmd.addOption(new Option("--port <port>", "bind port").hideHelp());
	coordServeCmd.action(
		async (opts: {
			db?: string;
			dbPath?: string;
			coordinatorHost?: string;
			coordinatorPort?: string;
			host?: string;
			port?: string;
		}) => {
			// Prefer canonical flags; fall back to hidden aliases; then defaults.
			// Defaults must NOT be set on the Option definitions, otherwise Commander
			// populates them and ?? cannot distinguish "explicitly passed" from "default".
			const host = String(opts.coordinatorHost ?? opts.host ?? "127.0.0.1").trim() || "127.0.0.1";
			const port = Number.parseInt(String(opts.coordinatorPort ?? opts.port ?? "7347"), 10);
			const dbPath = resolveDbOpt(opts) ?? DEFAULT_COORDINATOR_DB_PATH;
			const app = createBetterSqliteCoordinatorApp({ dbPath });
			p.intro("codemem coordinator serve");
			p.log.success(`Coordinator listening at http://${host}:${port}`);
			p.log.info(`DB: ${dbPath}`);
			honoServe({ fetch: app.fetch, hostname: host, port });
		},
	);
	cmd.addCommand(coordServeCmd);

	// ---- list-bootstrap-grants ----

	const listBootstrapGrantsCmd = new Command("list-bootstrap-grants")
		.configureHelp(helpStyle)
		.description("List bootstrap grants for a coordinator group")
		.argument("<group>", "group id")
		.option("--remote-url <url>", "remote coordinator URL override")
		.option("--admin-secret <secret>", "remote coordinator admin secret override");
	addDbOption(listBootstrapGrantsCmd);
	addJsonOption(listBootstrapGrantsCmd);
	listBootstrapGrantsCmd.action(
		async (
			groupId: string,
			opts: {
				db?: string;
				dbPath?: string;
				remoteUrl?: string;
				adminSecret?: string;
				json?: boolean;
			},
		) => {
			try {
				const rows = await coordinatorListBootstrapGrantsAction({
					groupId,
					dbPath: resolveDbOpt(opts) ?? null,
					remoteUrl: opts.remoteUrl?.trim() || null,
					adminSecret: opts.adminSecret?.trim() || null,
				});
				if (opts.json) {
					console.log(JSON.stringify(rows, null, 2));
					return;
				}
				p.intro("codemem coordinator list-bootstrap-grants");
				if (rows.length === 0) {
					p.outro(`No bootstrap grants for ${groupId.trim()}`);
					return;
				}
				for (const row of rows) {
					p.log.message(
						`- ${row.grant_id} seed=${row.seed_device_id} worker=${row.worker_device_id} expires=${row.expires_at} revoked=${row.revoked_at ?? "no"}`,
					);
				}
				p.outro(`${rows.length} bootstrap grant(s)`);
			} catch (err) {
				if (opts.json) {
					emitJsonError(
						"list_bootstrap_grants_failed",
						err instanceof Error ? err.message : String(err),
					);
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(listBootstrapGrantsCmd);

	// ---- revoke-bootstrap-grant ----

	const revokeBootstrapGrantCmd = new Command("revoke-bootstrap-grant")
		.configureHelp(helpStyle)
		.description("Revoke a bootstrap grant")
		.argument("<grant-id>", "bootstrap grant id")
		.option("--remote-url <url>", "remote coordinator URL override")
		.option("--admin-secret <secret>", "remote coordinator admin secret override");
	addDbOption(revokeBootstrapGrantCmd);
	addJsonOption(revokeBootstrapGrantCmd);
	revokeBootstrapGrantCmd.action(
		async (
			grantId: string,
			opts: {
				db?: string;
				dbPath?: string;
				remoteUrl?: string;
				adminSecret?: string;
				json?: boolean;
			},
		) => {
			try {
				const ok = await coordinatorRevokeBootstrapGrantAction({
					grantId,
					dbPath: resolveDbOpt(opts) ?? null,
					remoteUrl: opts.remoteUrl?.trim() || null,
					adminSecret: opts.adminSecret?.trim() || null,
				});
				if (!ok) {
					if (opts.json) {
						emitJsonError("grant_not_found", `Bootstrap grant not found: ${grantId.trim()}`);
						return;
					}
					p.log.error(`Bootstrap grant not found: ${grantId.trim()}`);
					process.exitCode = 1;
					return;
				}
				if (opts.json) {
					console.log(JSON.stringify({ ok: true, grant_id: grantId.trim() }, null, 2));
					return;
				}
				p.intro("codemem coordinator revoke-bootstrap-grant");
				p.log.success(`Revoked ${grantId.trim()}`);
				p.outro("revoked");
			} catch (err) {
				if (opts.json) {
					emitJsonError("revoke_failed", err instanceof Error ? err.message : String(err));
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(revokeBootstrapGrantCmd);

	// ---- create-invite ----

	const createInviteCmd = new Command("create-invite")
		.configureHelp(helpStyle)
		.description("Create a coordinator team invite")
		.argument("[group]", "group id")
		.option("--group <group>", "group id")
		.option("--coordinator-url <url>", "coordinator URL override")
		.option("--policy <policy>", "invite policy", "auto_admit")
		.option("--ttl-hours <hours>", "invite TTL hours", "24")
		.option("--remote-url <url>", "remote coordinator URL override")
		.option("--admin-secret <secret>", "remote coordinator admin secret override");
	addDbOption(createInviteCmd);
	addJsonOption(createInviteCmd);
	createInviteCmd.action(
		async (
			groupArg: string | undefined,
			opts: {
				group?: string;
				coordinatorUrl?: string;
				policy?: string;
				ttlHours?: string;
				db?: string;
				dbPath?: string;
				remoteUrl?: string;
				adminSecret?: string;
				json?: boolean;
			},
		) => {
			try {
				const ttlHours = Number.parseInt(String(opts.ttlHours ?? "24"), 10);
				const groupId = String(opts.group ?? "").trim() || String(groupArg ?? "").trim();
				const result = await coordinatorCreateInviteAction({
					groupId,
					coordinatorUrl: opts.coordinatorUrl?.trim() || null,
					policy: String(opts.policy ?? "auto_admit").trim(),
					ttlHours,
					createdBy: null,
					dbPath: resolveDbOpt(opts) ?? null,
					remoteUrl: opts.remoteUrl?.trim() || null,
					adminSecret: opts.adminSecret?.trim() || null,
				});
				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}
				p.intro("codemem coordinator create-invite");
				p.log.success(`Invite created for ${groupId}`);
				if (typeof result.link === "string") p.log.message(`- link: ${result.link}`);
				if (typeof result.encoded === "string") p.log.message(`- invite: ${result.encoded}`);
				for (const warning of Array.isArray(result.warnings) ? result.warnings : []) {
					p.log.warn(String(warning));
				}
				p.outro("Invite ready");
			} catch (err) {
				if (opts.json) {
					emitJsonError("create_invite_failed", err instanceof Error ? err.message : String(err));
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(createInviteCmd);

	// ---- import-invite ----

	const importInviteCmd = new Command("import-invite")
		.configureHelp(helpStyle)
		.description("Import a coordinator invite")
		.argument("<invite>", "invite value or link")
		.option("--keys-dir <path>", "keys directory");
	addDbOption(importInviteCmd);
	addConfigOption(importInviteCmd);
	addJsonOption(importInviteCmd);
	importInviteCmd.action(
		async (
			invite: string,
			opts: {
				db?: string;
				dbPath?: string;
				keysDir?: string;
				config?: string;
				json?: boolean;
			},
		) => {
			try {
				const result = await coordinatorImportInviteAction({
					inviteValue: invite,
					dbPath: resolveDbOpt(opts) ?? null,
					keysDir: opts.keysDir ?? null,
					configPath: opts.config ?? null,
				});
				if (opts.json) {
					console.log(JSON.stringify(result, null, 2));
					return;
				}
				p.intro("codemem coordinator import-invite");
				p.log.success(`Invite imported for ${result.group_id}`);
				p.log.message(`- coordinator: ${result.coordinator_url}`);
				p.log.message(`- status: ${result.status}`);
				p.outro("Coordinator config updated");
			} catch (err) {
				if (opts.json) {
					emitJsonError("import_invite_failed", err instanceof Error ? err.message : String(err));
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(importInviteCmd);

	// ---- list-join-requests ----

	const listJoinRequestsCmd = new Command("list-join-requests")
		.configureHelp(helpStyle)
		.description("List pending coordinator join requests")
		.argument("[group]", "group id")
		.option("--group <group>", "group id")
		.option("--remote-url <url>", "remote coordinator URL override")
		.option("--admin-secret <secret>", "remote coordinator admin secret override");
	addDbOption(listJoinRequestsCmd);
	addJsonOption(listJoinRequestsCmd);
	listJoinRequestsCmd.action(
		async (
			groupArg: string | undefined,
			opts: {
				group?: string;
				db?: string;
				dbPath?: string;
				remoteUrl?: string;
				adminSecret?: string;
				json?: boolean;
			},
		) => {
			try {
				const groupId = String(opts.group ?? "").trim() || String(groupArg ?? "").trim();
				const rows = await coordinatorListJoinRequestsAction({
					groupId,
					dbPath: resolveDbOpt(opts) ?? null,
					remoteUrl: opts.remoteUrl?.trim() || null,
					adminSecret: opts.adminSecret?.trim() || null,
				});
				if (opts.json) {
					console.log(JSON.stringify(rows, null, 2));
					return;
				}
				p.intro("codemem coordinator list-join-requests");
				if (rows.length === 0) {
					p.outro(`No pending join requests for ${groupId}`);
					return;
				}
				for (const row of rows) {
					const displayName = row.display_name || row.device_id;
					p.log.message(`- ${displayName} (${row.device_id}) request_id=${row.request_id}`);
				}
				p.outro(`${rows.length} pending join request(s)`);
			} catch (err) {
				if (opts.json) {
					emitJsonError(
						"list_join_requests_failed",
						err instanceof Error ? err.message : String(err),
					);
					return;
				}
				p.log.error(err instanceof Error ? err.message : String(err));
				process.exitCode = 1;
			}
		},
	);
	cmd.addCommand(listJoinRequestsCmd);

	// ---- approve-join-request / deny-join-request ----

	function addReviewJoinRequestCommand(
		name: "approve-join-request" | "deny-join-request",
		approve: boolean,
	) {
		const reviewCmd = new Command(name)
			.configureHelp(helpStyle)
			.description(`${approve ? "Approve" : "Deny"} a coordinator join request`)
			.argument("<request-id>", "join request id")
			.option("--remote-url <url>", "remote coordinator URL override")
			.option("--admin-secret <secret>", "remote coordinator admin secret override");
		addDbOption(reviewCmd);
		addJsonOption(reviewCmd);
		reviewCmd.action(
			async (
				requestId: string,
				opts: {
					db?: string;
					dbPath?: string;
					remoteUrl?: string;
					adminSecret?: string;
					json?: boolean;
				},
			) => {
				try {
					const request = await coordinatorReviewJoinRequestAction({
						requestId: requestId.trim(),
						approve,
						reviewedBy: null,
						dbPath: resolveDbOpt(opts) ?? null,
						remoteUrl: opts.remoteUrl?.trim() || null,
						adminSecret: opts.adminSecret?.trim() || null,
					});
					if (!request) {
						if (opts.json) {
							emitJsonError(
								"join_request_not_found",
								`Join request not found: ${requestId.trim()}`,
							);
							return;
						}
						p.log.error(`Join request not found: ${requestId.trim()}`);
						process.exitCode = 1;
						return;
					}
					if (opts.json) {
						console.log(JSON.stringify(request, null, 2));
						return;
					}
					p.intro(`codemem coordinator ${name}`);
					p.log.success(`${approve ? "Approved" : "Denied"} join request ${requestId.trim()}`);
					p.outro(String(request.status ?? "updated"));
				} catch (err) {
					if (opts.json) {
						emitJsonError("review_failed", err instanceof Error ? err.message : String(err));
						return;
					}
					p.log.error(err instanceof Error ? err.message : String(err));
					process.exitCode = 1;
				}
			},
		);
		cmd.addCommand(reviewCmd);
	}

	addReviewJoinRequestCommand("approve-join-request", true);
	addReviewJoinRequestCommand("deny-join-request", false);

	return cmd;
}

/** Canonical top-level coordinator command for registration in index.ts. */
export const coordinatorCommand = buildCoordinatorCommand();
