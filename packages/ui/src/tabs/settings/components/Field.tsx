import { type ComponentChildren, toChildArray } from "preact";
import { SettingsOutcome, settingsOutcomeFor } from "./SettingsOutcome";

function findEditableControlId(children: ComponentChildren): string | undefined {
	for (const child of toChildArray(children)) {
		if (!child || typeof child !== "object" || !("props" in child)) continue;
		const props = child.props as { children?: ComponentChildren; id?: unknown };
		if (typeof props.id === "string" && settingsOutcomeFor(props.id)) return props.id;
		const nestedId = findEditableControlId(props.children);
		if (nestedId) return nestedId;
	}
	return undefined;
}

export function Field({
	children,
	className = "field",
	hidden = false,
	id,
}: {
	children: ComponentChildren;
	className?: string;
	hidden?: boolean;
	id?: string;
}) {
	const controlId = findEditableControlId(children);
	const outcome = controlId ? settingsOutcomeFor(controlId) : undefined;
	return (
		<div className={className} hidden={hidden} id={id}>
			{children}
			{outcome ? <SettingsOutcome {...outcome} /> : null}
		</div>
	);
}
