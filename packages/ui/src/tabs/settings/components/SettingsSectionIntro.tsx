import type { SettingsSectionIntroProps } from "../data/types";

export function SettingsSectionIntro({ detail, title }: SettingsSectionIntroProps) {
	return (
		<div className="settings-section-intro">
			<div className="settings-section-intro-title">{title}</div>
			<div className="small settings-section-intro-detail">{detail}</div>
		</div>
	);
}
