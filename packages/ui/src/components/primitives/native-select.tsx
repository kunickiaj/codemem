import type { JSX } from "preact";
import { forwardRef } from "preact/compat";

export type NativeSelectProps = JSX.SelectHTMLAttributes<HTMLSelectElement>;

/** Styled native picker; attributes, events and refs still target the select. */
export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(function NativeSelect(
	{ className, class: htmlClass, ...props },
	ref,
) {
	return (
		<select
			{...props}
			className={["native-select", htmlClass, className].filter(Boolean).join(" ")}
			ref={ref}
		/>
	);
});
