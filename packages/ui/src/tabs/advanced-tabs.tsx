import { render } from "preact";
import { RadixTabs } from "../components/primitives/radix-tabs";

export type AdvancedTabValue = "sync" | "teams";

const ADVANCED_TABS = [
	{ id: "advancedSyncButton", label: "Sync", value: "sync" },
	{
		id: "advancedTeamsButton",
		label: "Coordinator administration",
		value: "teams",
	},
];

export function mountAdvancedTabs(
	mount: HTMLElement,
	value: AdvancedTabValue,
	onValueChange: (value: AdvancedTabValue) => void,
) {
	render(
		<RadixTabs
			ariaLabel="Advanced sections"
			listClassName="settings-tabs"
			onValueChange={(nextValue) => onValueChange(nextValue as AdvancedTabValue)}
			tabs={ADVANCED_TABS}
			triggerClassName="settings-tab"
			value={value}
		/>,
		mount,
	);
	const panelIds: Record<AdvancedTabValue, string> = {
		sync: "advancedSyncContent",
		teams: "advancedTeamsContent",
	};
	for (const tab of ADVANCED_TABS) {
		const trigger = document.getElementById(tab.id);
		trigger?.setAttribute("aria-controls", panelIds[tab.value as AdvancedTabValue]);
	}
}
