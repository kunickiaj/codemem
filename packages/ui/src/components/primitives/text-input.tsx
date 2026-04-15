import type { JSX } from "preact";

export type TextInputProps = JSX.InputHTMLAttributes<HTMLInputElement>;

export function TextInput(props: TextInputProps) {
	return <input {...props} />;
}
