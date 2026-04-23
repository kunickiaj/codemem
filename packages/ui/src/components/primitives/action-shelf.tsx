/* ActionShelf — list / region toolbar with one primary + N secondary buttons.
 *
 * Enforces the "at most one filled-primary button per line of sight" rule
 * from docs/plans/2026-04-23-sync-tab-redesign.md (visual-hierarchy). Use
 * this anywhere a region needs a title row with trailing actions (e.g. a
 * devices list toolbar). Wraps below 900px when constrained.
 */

export interface ActionShelfAction {
	label: string;
	onClick: () => void | Promise<void>;
	disabled?: boolean;
	busy?: boolean;
	"aria-label"?: string;
}

export interface ActionShelfProps {
	primary?: ActionShelfAction;
	secondary?: ActionShelfAction[];
	align?: "start" | "end";
}

function ActionButton({ action, primary }: { action: ActionShelfAction; primary: boolean }) {
	const busy = Boolean(action.busy);
	return (
		<button
			aria-busy={busy}
			aria-label={action["aria-label"]}
			className={primary ? "settings-button sync-btn-primary" : "settings-button"}
			disabled={action.disabled || busy}
			onClick={() => {
				void action.onClick();
			}}
			type="button"
		>
			{action.label}
		</button>
	);
}

export function ActionShelf({ primary, secondary, align = "end" }: ActionShelfProps) {
	return (
		<div className={`action-shelf action-shelf-align-${align}`} role="toolbar" aria-label="Actions">
			{(secondary ?? []).map((action, index) => (
				<ActionButton action={action} key={`secondary-${index}-${action.label}`} primary={false} />
			))}
			{primary ? <ActionButton action={primary} primary /> : null}
		</div>
	);
}
