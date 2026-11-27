/* Coordinator-admin devices panel — renders the enrolled devices list
 * with per-device disable-enable / remove actions. Pulls the list from
 * `state.lastCoordinatorAdminDevices`. Takes the runDevice callback as a
 * dep so the barrel can wire the factory action. Renaming a device lives
 * in Devices. */

import { h } from "preact";
import { RadixTabsContent } from "../../../components/primitives/radix-tabs";
import { state } from "../../../lib/state";
import { coordinatorAdminDeviceCardCopy, stableDeviceDisplayNames } from "../data/device-card";
import { surfaceHasSnapshot, surfaceIsNotApplicable } from "../data/recovery";
import { coordinatorAdminState } from "../data/state";
import type { CoordinatorAdminSummary } from "../data/summary";

export interface DevicesPanelDeps {
	summary: CoordinatorAdminSummary;
	fresh: boolean;
	snapshotMatchesTarget: boolean;
	runDevice: (
		deviceId: string,
		groupId: string,
		displayName: string,
		kind: "disable" | "enable" | "remove",
	) => void;
}

type DeviceItem = (typeof state.lastCoordinatorAdminDevices)[number];
type DeviceAction = "disable" | "enable" | "remove";

const ACTION_LABELS: Record<DeviceAction, { idle: string; pending: string; danger: boolean }> = {
	disable: { idle: "Disable", pending: "Disabling…", danger: true },
	enable: { idle: "Enable", pending: "Enabling…", danger: false },
	remove: { idle: "Remove", pending: "Removing…", danger: true },
};

/** Why the list cannot be shown, or null when it can. */
function listPlaceholder(options: {
	count: number;
	known: boolean;
	notApplicable: boolean;
	ready: boolean;
}): string | null {
	if (options.notApplicable) {
		return "Complete legacy coordinator setup to load enrolled devices. No device data is expected yet.";
	}
	if (!options.known) {
		return "Enrolled devices are unavailable. Retry to load current devices; no empty result is being assumed.";
	}
	if (options.count > 0) return null;
	return options.ready
		? "No enrolled devices found for the active coordinator group."
		: "Device administration will appear here once setup is complete.";
}

function renderDeviceCard(
	item: DeviceItem,
	deps: Pick<DevicesPanelDeps, "fresh" | "runDevice">,
	displayName: string | undefined,
) {
	const copy = coordinatorAdminDeviceCardCopy(
		item,
		String(state.lastCoordinatorAdminStatus?.active_group || ""),
		displayName,
	);
	const { deviceId, teamId } = copy;
	const pending = coordinatorAdminState.deviceActionPendingId === deviceId;
	const toggle: DeviceAction = item.enabled !== false && item.enabled !== 0 ? "disable" : "enable";
	const actionButton = (kind: DeviceAction) => {
		const labels = ACTION_LABELS[kind];
		const working = pending && coordinatorAdminState.deviceActionPendingKind === kind;
		return h(
			"button",
			{
				class: labels.danger ? "settings-button danger" : "settings-button",
				disabled: !deps.fresh || !deviceId || pending,
				onClick: () => deps.runDevice(deviceId, teamId, copy.displayName, kind),
				type: "button",
			},
			working ? labels.pending : labels.idle,
		);
	};
	return h(
		"div",
		{
			class: "peer-card peer-card--padded",
			key: deviceId || String(item.fingerprint || "unknown"),
		},
		h("div", { class: "peer-title" }, h("strong", null, copy.displayName)),
		h("div", { class: "peer-submeta" }, copy.statusLabel),
		h(
			"details",
			{ class: "coordinator-admin-diagnostics" },
			h("summary", null, "Diagnostics"),
			h("div", { class: "peer-meta" }, copy.advancedDetail),
		),
		h("div", { class: "peer-actions" }, actionButton(toggle), actionButton("remove")),
	);
}

export function renderDevicesPanel(deps: DevicesPanelDeps) {
	const { summary, snapshotMatchesTarget } = deps;
	const known =
		snapshotMatchesTarget && surfaceHasSnapshot(coordinatorAdminState.recovery, "devices");
	const items =
		known && Array.isArray(state.lastCoordinatorAdminDevices)
			? state.lastCoordinatorAdminDevices
			: [];
	const deviceDisplayNames = stableDeviceDisplayNames(
		items,
		coordinatorAdminState.unnamedDeviceAliases,
	);
	const placeholder = listPlaceholder({
		count: items.length,
		known,
		notApplicable: surfaceIsNotApplicable(coordinatorAdminState.recovery, "devices"),
		ready: summary.readiness === "ready",
	});
	return h(
		RadixTabsContent,
		{ className: "coordinator-admin-panel", value: "devices" },
		h("h3", null, "Enrolled devices"),
		h(
			"p",
			{ class: "peer-submeta" },
			summary.readiness === "ready"
				? "Disable, re-enable, or remove devices from the selected coordinator group. Rename a device in Devices. Space transport access is managed below; policy Team membership and Project access stay in Sharing."
				: "Finish coordinator setup first. Device administration stays disabled until legacy administration is ready.",
		),
		placeholder
			? h("div", { class: "peer-meta" }, placeholder)
			: h(
					"div",
					{ class: "peer-list" },
					items.map((item) =>
						renderDeviceCard(
							item,
							deps,
							deviceDisplayNames.get(String(item.device_id || "").trim()),
						),
					),
				),
	);
}
