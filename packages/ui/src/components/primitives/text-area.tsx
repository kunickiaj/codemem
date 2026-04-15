import type { JSX } from "preact";

export type TextAreaProps = JSX.TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextArea(props: TextAreaProps) {
	return <textarea {...props} />;
}
