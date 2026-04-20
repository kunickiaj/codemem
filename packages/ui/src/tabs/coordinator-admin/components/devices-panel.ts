/* Coordinator-admin devices panel — renders the enrolled devices list
 * with per-device rename / disable-enable / remove actions. Pulls the
 * list from `state.lastCoordinatorAdminDevices` and rename drafts from
 * coordinatorAdminState. Takes the runDevice callback as a dep so the
 * barrel can wire the factory action. */

import { h } from "preact";
import { RadixTabsContent } from "../../../components/primitives/radix-tabs";
import { TextInput } from "../../../components/primitives/text-input";
import { state } from "../../../lib/state";
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
				? "Rename, disable, re-enable, or remove enrolled devices from the operator surface without confusing this with direct sync state."
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
					{ class: "coordinator-admin-request-list" },
					items.map((item) => {
						const deviceId = String(item.device_id || "").trim();
						const groupId = String(
							item.group_id || state.lastCoordinatorAdminStatus?.active_group || "",
						).trim();
						const displayName = String(item.display_name || deviceId || "Unnamed device");
						const pending = coordinatorAdminState.deviceActionPendingId === deviceId;
						const draft =
							coordinatorAdminState.deviceRenameDrafts.get(deviceId) ??
							String(item.display_name || "");
						const enabled = item.enabled !== false && item.enabled !== 0;
						return h(
							"div",
							{ class: "peer-card", key: deviceId || String(item.fingerprint || "unknown") },
							h("div", { class: "peer-title" }, h("strong", null, draft || displayName)),
							h("div", { class: "peer-meta" }, `Device: ${deviceId || "unknown"}`),
							groupId ? h("div", { class: "peer-submeta" }, `Group: ${groupId}`) : null,
							h("div", { class: "peer-submeta" }, enabled ? "Enabled" : "Disabled"),
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
										onClick: () => runDevice(deviceId, groupId, displayName, "rename"),
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
												onClick: () => runDevice(deviceId, groupId, displayName, "disable"),
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
												onClick: () => runDevice(deviceId, groupId, displayName, "enable"),
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
										onClick: () => runDevice(deviceId, groupId, displayName, "remove"),
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
