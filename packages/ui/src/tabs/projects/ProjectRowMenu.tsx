import { ActionMenu, type MenuAction } from "../../components/primitives/action-menu";

interface ProjectRowMenuProps {
	label: string;
	canAssign: boolean;
	canChangeProject: boolean;
	canForget: boolean;
	canRemoveMapping: boolean;
	onChangeProject: () => void;
	onForget: () => void;
	onKeepLocal: () => void;
	onOpenSpaceAssignment: () => void;
	onRemoveMapping: () => void;
}

export function ProjectRowMenu(props: ProjectRowMenuProps) {
	const actions: MenuAction[] = [
		{
			disabled: !props.canAssign,
			label: "Space assignment…",
			onSelect: props.onOpenSpaceAssignment,
		},
		{
			disabled: !props.canChangeProject,
			label: "Change project…",
			onSelect: props.onChangeProject,
		},
		{ disabled: !props.canAssign, label: "Keep local-only", onSelect: props.onKeepLocal },
		...(props.canRemoveMapping
			? [{ label: "Remove mapping", onSelect: props.onRemoveMapping }]
			: []),
		{
			danger: true,
			disabled: !props.canForget,
			label: "Forget local memories…",
			onSelect: props.onForget,
		},
	];
	return (
		<div className="project-row-menu">
			<ActionMenu actions={actions} label={`More actions for ${props.label}`} />
		</div>
	);
}

export function ProjectClusterMenu({
	label,
	onOpenSpaceAssignment,
}: {
	label: string;
	onOpenSpaceAssignment: () => void;
}) {
	return (
		<div className="project-row-menu">
			<ActionMenu
				actions={[{ label: "Space assignment for all…", onSelect: onOpenSpaceAssignment }]}
				label={`More actions for ${label}`}
			/>
		</div>
	);
}
