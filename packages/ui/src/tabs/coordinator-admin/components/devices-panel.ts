/* Coordinator-admin devices panel — renders the enrolled devices list
 * with per-device rename / disable-enable / remove actions. Pulls the
 * list from `state.lastCoordinatorAdminDevices` and rename drafts from
 * coordinatorAdminState. Takes the runDevice callback as a dep so the
 * barrel can wire the factory action. */

import { h } from "preact";
import { RadixTabsContent } from "../../../components/primitives/radix-tabs";
import { TextInput } from "../../../components/primitives/text-input";
import { state } from "../../../lib/state";
import { coordinatorAdminDeviceCardCopy } from "../data/device-card";
import { coordinatorAdminState } from "../data/state";
import type { CoordinatorAdminSummary } from "../data/summary";

export interface DevicesPanelDeps {
	summary: CoordinatorAdminSummary;
	runDevice: (
		deviceId: string,
		groupId: string,
		displayName: string,
		kind: "rename" | "disable" | "enable" | "remove",
	) => void;
}

export function renderDevicesPanel(deps: DevicesPanelDeps) {
	const { summary, runDevice } = deps;
	const items = Array.isArray(state.lastCoordinatorAdminDevices)
		? state.lastCoordinatorAdminDevices
		: [];
	return h(
		RadixTabsContent,
		{ className: "coordinator-admin-panel", value: "devices" },
		h("h3", null, "Enrolled devices"),
		h(
			"p",
			{ class: "peer-submeta" },
			summary.readiness === "ready"
				? "Rename, disable, re-enable, or remove Team devices here. Space access is granted from Spaces below; Team membership alone does not share memories."
				: "Finish setup first. Device administration stays disabled until coordinator admin is ready.",
		),
		!items.length
			? h(
					"div",
					{ class: "peer-meta" },
					summary.readiness === "ready"
						? "No enrolled devices found for the active coordinator group."
						: "Device administration will appear here once setup is complete.",
				)
			: h(
					"div",
					{ class: "peer-list" },
					items.map((item) => {
						const copy = coordinatorAdminDeviceCardCopy(
							item,
							String(state.lastCoordinatorAdminStatus?.active_group || ""),
						);
						const { deviceId, displayName, teamId } = copy;
						const pending = coordinatorAdminState.deviceActionPendingId === deviceId;
						const draft =
							coordinatorAdminState.deviceRenameDrafts.get(deviceId) ??
							String(item.display_name || "");
						const enabled = item.enabled !== false && item.enabled !== 0;
						return h(
							"div",
							{
								class: "peer-card peer-card--padded",
								key: deviceId || String(item.fingerprint || "unknown"),
							},
							h("div", { class: "peer-title" }, h("strong", null, draft || displayName)),
							h("div", { class: "peer-submeta" }, copy.statusLabel),
							h("div", { class: "peer-meta" }, copy.advancedDetail),
							h(
								"div",
								{ class: "coordinator-admin-form-grid" },
								h(
									"label",
									{ class: "coordinator-admin-field" },
									h("span", null, "Display name"),
									h(TextInput, {
										class: "peer-scope-input",
										disabled: summary.readiness !== "ready" || pending,
										onInput: (event) => {
											coordinatorAdminState.deviceRenameDrafts.set(
												deviceId,
												String((event.currentTarget as HTMLInputElement).value || ""),
											);
										},
										type: "text",
										value: draft,
									}),
								),
							),
							h(
								"div",
								{ class: "peer-actions" },
								h(
									"button",
									{
										class: "settings-button",
										disabled: !deviceId || pending || summary.readiness !== "ready",
										onClick: () => runDevice(deviceId, teamId, displayName, "rename"),
										type: "button",
									},
									pending && coordinatorAdminState.deviceActionPendingKind === "rename"
										? "Renaming…"
										: "Rename",
								),
								enabled
									? h(
											"button",
											{
												class: "settings-button danger",
												disabled: !deviceId || pending || summary.readiness !== "ready",
												onClick: () => runDevice(deviceId, teamId, displayName, "disable"),
												type: "button",
											},
											pending && coordinatorAdminState.deviceActionPendingKind === "disable"
												? "Disabling…"
												: "Disable",
										)
									: h(
											"button",
											{
												class: "settings-button",
												disabled: !deviceId || pending || summary.readiness !== "ready",
												onClick: () => runDevice(deviceId, teamId, displayName, "enable"),
												type: "button",
											},
											pending && coordinatorAdminState.deviceActionPendingKind === "enable"
												? "Enabling…"
												: "Enable",
										),
								h(
									"button",
									{
										class: "settings-button danger",
										disabled: !deviceId || pending || summary.readiness !== "ready",
										onClick: () => runDevice(deviceId, teamId, displayName, "remove"),
										type: "button",
									},
									pending && coordinatorAdminState.deviceActionPendingKind === "remove"
										? "Removing…"
										: "Remove",
								),
							),
						);
					}),
				),
	);
}
