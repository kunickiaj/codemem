import type { SettingsHintProps } from "../data/types";

export function SettingsHint({ children, hidden = false }: SettingsHintProps) {
	return (
		<div className="settings-note" hidden={hidden}>
			{children}
		</div>
	);
}
