import { ActionMenu } from "../../../components/primitives/action-menu";

export function FeedItemMenu({
	assignProjectDisabled,
	disabled,
	onAssignProject,
	onForget,
	title,
}: {
	assignProjectDisabled: boolean;
	disabled: boolean;
	onAssignProject: () => void;
	onForget: () => void;
	title: string;
}) {
	return (
		<ActionMenu
			label={`Actions for ${title}`}
			actions={[
				{
					disabled: assignProjectDisabled,
					label: assignProjectDisabled ? "Moving…" : "Assign to project…",
					onSelect: onAssignProject,
				},
				{
					danger: true,
					disabled,
					label: disabled ? "Forgetting…" : "Forget memory",
					onSelect: onForget,
				},
			]}
		/>
	);
}
