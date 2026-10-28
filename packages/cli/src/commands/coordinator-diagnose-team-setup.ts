import * as p from "@clack/prompts";
import {
	buildBaseUrl,
	coordinatorListDevicesAction,
	coordinatorListLegacyTeamCompletionsAction,
	diagnoseLegacyTeamSetupCompletion,
	type LegacyTeamSetupCompletionDiagnosis,
	type LegacyTeamSetupDiagnosisFailure,
	legacyTeamCandidateId,
	type MemoryStore,
	readCodememConfigFile,
	readCodememConfigFileAtPath,
	readCoordinatorSyncConfig,
	resolveDbPath,
	withDiagnosticStoreSnapshot,
} from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";
import {
	addConfigOption,
	addDbOption,
	addJsonOption,
	emitJsonError,
	resolveDbOpt,
} from "../shared-options.js";

interface Options {
	config?: string;
	db?: string;
	dbPath?: string;
	json?: boolean;
}

function coordinatorTarget(options: Options) {
	const config = readCoordinatorSyncConfig(
		options.config ? readCodememConfigFileAtPath(options.config) : readCodememConfigFile(),
	);
	const coordinatorId = config.syncCoordinatorUrl ? buildBaseUrl(config.syncCoordinatorUrl) : "";
	if (!coordinatorId || !config.syncCoordinatorAdminSecret) {
		throw new Error("team_setup_diagnosis_configuration_unavailable");
	}
	return {
		coordinatorId,
		auth: {
			remoteUrl: coordinatorId,
			adminSecret: config.syncCoordinatorAdminSecret,
			timeoutS: Math.max(1, config.syncCoordinatorTimeoutS),
		},
		groups: config.syncCoordinatorGroups,
	};
}

async function diagnoseGroup(
	store: MemoryStore,
	target: ReturnType<typeof coordinatorTarget>,
	groupId: string,
): Promise<LegacyTeamSetupCompletionDiagnosis> {
	const records = await coordinatorListLegacyTeamCompletionsAction({
		groupIds: [groupId],
		...target.auth,
	});
	const devices = await coordinatorListDevicesAction({
		groupId,
		includeDisabled: true,
		...target.auth,
	});
	const candidateRef = legacyTeamCandidateId(target.coordinatorId, groupId);
	return diagnoseLegacyTeamSetupCompletion(store.db, {
		coordinatorId: target.coordinatorId,
		groupId,
		completionManifest:
			records.find(
				(record) => record.group_id === groupId && record.manifest.candidate_ref === candidateRef,
			)?.manifest ?? null,
		freshRoster: devices.map((device) => ({
			deviceId: device.device_id,
			fingerprint: device.fingerprint,
			displayName: device.display_name ?? "Device",
			enabled: device.enabled === 1,
		})),
	});
}

function describeStep(step: { ok: true } | LegacyTeamSetupDiagnosisFailure, okText: string) {
	if (step.ok) return okText;
	return step.check ? `${step.code} at ${step.check}` : step.code;
}

function printDiagnosis(diagnosis: LegacyTeamSetupCompletionDiagnosis): void {
	const lines = [
		`Candidate: ${diagnosis.candidateRef}`,
		`Coordinator completion: ${describeStep(diagnosis.manifest, `completed ${diagnosis.completedAt}`)}`,
	];
	if (diagnosis.unavailableScopeIds.length > 0) {
		lines.push(`Spaces not active here: ${diagnosis.unavailableScopeIds.join(", ")}`);
	}
	const local = diagnosis.localCompletion;
	lines.push(
		`Local completion: ${describeStep(local, local.ok ? `identical=${local.identical} additive=${local.additive}` : "")}`,
	);
	const apply = diagnosis.apply;
	if (apply) {
		const outcome = apply.ok
			? `would leave Team ${apply.teamStatus}/${apply.migrationState} with ${apply.grantedProjects} Project(s) shared`
			: "";
		lines.push(`Apply (dry run): ${describeStep(apply, outcome)}`);
	}
	const log = apply && !apply.ok ? p.log.warn : p.log.info;
	log(`${diagnosis.groupId}\n${lines.map((line) => `  ${line}`).join("\n")}`);
}

async function diagnoseTeamSetup(group: string | undefined, options: Options): Promise<void> {
	try {
		const target = coordinatorTarget(options);
		const groups = group ? [group] : target.groups;
		if (groups.length === 0) throw new Error("team_setup_diagnosis_no_groups");
		const diagnoses = await withDiagnosticStoreSnapshot(
			resolveDbPath(resolveDbOpt(options)),
			async (store) => {
				const results: LegacyTeamSetupCompletionDiagnosis[] = [];
				for (const groupId of groups) results.push(await diagnoseGroup(store, target, groupId));
				return results;
			},
		);
		if (options.json) {
			console.log(JSON.stringify({ coordinator_id: target.coordinatorId, groups: diagnoses }));
			return;
		}
		p.intro("codemem coordinator diagnose-team-setup");
		for (const diagnosis of diagnoses) printDiagnosis(diagnosis);
		p.outro("Dry run only: no changes were made.");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (options.json) {
			emitJsonError("team_setup_diagnosis_failed", message);
			return;
		}
		p.log.error(message);
		process.exitCode = 1;
	}
}

export function buildCoordinatorDiagnoseTeamSetupCommand(): Command {
	const command = new Command("diagnose-team-setup")
		.configureHelp(helpStyle)
		.description(
			"Dry-run the coordinator's legacy Team setup completion against this database and report which check fails",
		)
		.argument("[group]", "coordinator group ID (default: configured groups)");
	addDbOption(command);
	addConfigOption(command);
	addJsonOption(command);
	command.action(diagnoseTeamSetup);
	return command;
}
