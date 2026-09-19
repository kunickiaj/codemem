import { RadixSwitch } from "../../../components/primitives/radix-switch";
import { SettingsOutcome, settingsOutcomeFor } from "./SettingsOutcome";

export type SettingsSwitchRowProps = {
	checked: boolean;
	disabled?: boolean;
	hidden?: boolean;
	id: string;
	label: string;
	onCheckedChange: (checked: boolean) => void;
	className?: string;
};

export function SettingsSwitchRow({
	checked,
	className,
	disabled = false,
	hidden = false,
	id,
	label,
	onCheckedChange,
}: SettingsSwitchRowProps) {
	const labelId = `${id}Label`;
	const outcome = settingsOutcomeFor(id);
	return (
		<div
			className={
				className
					? `field-checkbox settings-switch-row ${className}`
					: "field-checkbox settings-switch-row"
			}
			hidden={hidden}
		>
			<label className="settings-switch-copy" htmlFor={id} id={labelId}>
				{label}
			</label>
			<RadixSwitch
				aria-labelledby={labelId}
				checked={checked}
				className="settings-switch"
				disabled={disabled}
				id={id}
				onCheckedChange={onCheckedChange}
				thumbClassName="settings-switch-thumb"
			/>
			{outcome ? <SettingsOutcome {...outcome} /> : null}
		</div>
	);
}
