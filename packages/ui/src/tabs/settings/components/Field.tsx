import type { ComponentChildren } from "preact";

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
	return (
		<div className={className} hidden={hidden} id={id}>
			{children}
		</div>
	);
}
