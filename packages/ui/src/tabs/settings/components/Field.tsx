import { type ComponentChildren, toChildArray } from "preact";
import { settingsView } from "../data/state";
import {
	SettingsOutcome,
	type SettingsOutcomeContext,
	settingsOutcomeFor,
} from "./SettingsOutcome";

function findEditableControlId(
	children: ComponentChildren,
	context: SettingsOutcomeContext,
): string | undefined {
	for (const child of toChildArray(children)) {
		if (!child || typeof child !== "object" || !("props" in child)) continue;
		const props = child.props as { children?: ComponentChildren; id?: unknown };
		if (typeof props.id === "string" && settingsOutcomeFor(props.id, context)) return props.id;
		const nestedId = findEditableControlId(props.children, context);
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
	const context = { observerRuntime: settingsView.value.renderState.values.observerRuntime };
	const controlId = findEditableControlId(children, context);
	const outcome = controlId ? settingsOutcomeFor(controlId, context) : undefined;
	return (
		<div className={className} hidden={hidden} id={id}>
			{children}
			{outcome ? <SettingsOutcome {...outcome} /> : null}
		</div>
	);
}
