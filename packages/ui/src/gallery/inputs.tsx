import { useState } from "preact/hooks";
import { NativeSelect } from "../components/primitives/native-select";
import { RadixRadioGroup } from "../components/primitives/radix-radio-group";
import { RadixSelect } from "../components/primitives/radix-select";
import { RadixSwitch } from "../components/primitives/radix-switch";
import { TextArea } from "../components/primitives/text-area";
import { TextInput } from "../components/primitives/text-input";

export const LONG_LABEL =
	"A deliberately long synthetic label for checking truncation and narrow layouts";
export const SELECT_OPTIONS = [
	{ value: "alpha", label: "Alpha fixture" },
	{ value: "long", label: LONG_LABEL },
	{ value: "disabled", label: "Unavailable fixture", disabled: true },
];

export function ButtonExamples() {
	const [count, setCount] = useState(0);
	return (
		<>
			<div className="gallery-row">
				<button
					type="button"
					data-testid="gallery-button-default"
					onClick={() => setCount(count + 1)}
				>
					Native button
				</button>
				<button type="button" className="settings-button" onClick={() => setCount(count + 1)}>
					Settings button
				</button>
				<button type="button" className="settings-save" onClick={() => setCount(count + 1)}>
					Save fixture
				</button>
				<button type="button" className="sync-legacy-button" onClick={() => setCount(count + 1)}>
					Review fixture
				</button>
				<button type="button" disabled>
					Disabled
				</button>
				<button type="button" className="settings-save" disabled aria-busy="true">
					Saving…
				</button>
				<button type="button" onClick={() => setCount(count + 1)}>
					{LONG_LABEL}
				</button>
			</div>
			<output data-testid="gallery-button-result">Fixture clicks: {count}</output>
		</>
	);
}

function SelectPair({
	variant,
	initialValue,
	disabled = false,
	size = "default",
}: {
	variant: string;
	initialValue: string;
	disabled?: boolean;
	size?: "default" | "compact";
}) {
	const [radix, setRadix] = useState(initialValue);
	const [native, setNative] = useState(initialValue);
	return (
		<>
			<RadixSelect
				ariaLabel={`Radix select ${variant}`}
				id={`gallery-radix-select-${variant}`}
				value={radix}
				onValueChange={setRadix}
				options={SELECT_OPTIONS}
				disabled={disabled}
				size={size}
			/>
			<NativeSelect
				aria-label={`Native select ${variant}`}
				data-testid={`gallery-native-select-${variant}`}
				data-size={size}
				value={native}
				disabled={disabled}
				onChange={(event) => setNative(event.currentTarget.value)}
			>
				{SELECT_OPTIONS.map((option) => (
					<option key={option.value} value={option.value} disabled={option.disabled}>
						{option.label}
					</option>
				))}
			</NativeSelect>
		</>
	);
}

export function SelectExamples() {
	return (
		<>
			<SelectPair variant="default" initialValue="alpha" />
			<SelectPair variant="disabled" initialValue="alpha" disabled />
			<SelectPair variant="long" initialValue="long" />
			<SelectPair variant="compact" initialValue="alpha" size="compact" />
		</>
	);
}

export function FieldExamples() {
	const [text, setText] = useState("Synthetic text");
	const [notes, setNotes] = useState("Synthetic notes\nA second line");
	return (
		<>
			<label className="field" htmlFor="gallery-text-input">
				Text input
				<TextInput
					id="gallery-text-input"
					data-testid="gallery-text-input"
					value={text}
					onInput={(event) => setText(event.currentTarget.value)}
				/>
			</label>
			<label className="field" htmlFor="gallery-text-empty">
				Empty input
				<TextInput id="gallery-text-empty" placeholder="Type a fixture label" />
			</label>
			<label className="field" htmlFor="gallery-text-disabled">
				Disabled input
				<TextInput id="gallery-text-disabled" disabled value="Unavailable fixture" />
			</label>
			<label className="field" htmlFor="gallery-text-long">
				Long input
				<TextInput id="gallery-text-long" value={LONG_LABEL} />
			</label>
			<label className="field" htmlFor="gallery-text-area">
				Text area
				<TextArea
					id="gallery-text-area"
					data-testid="gallery-text-area"
					rows={3}
					value={notes}
					onInput={(event) => setNotes(event.currentTarget.value)}
				/>
			</label>
			<label className="field" htmlFor="gallery-area-disabled">
				Disabled text area
				<TextArea id="gallery-area-disabled" disabled value="Unavailable notes" />
			</label>
		</>
	);
}

function SwitchExamples() {
	const [enabled, setEnabled] = useState(false);
	return (
		<>
			<div className="settings-switch-row">
				<label id="gallery-switch-label" htmlFor="gallery-switch">
					Enable fixture
				</label>
				<RadixSwitch
					id="gallery-switch"
					aria-labelledby="gallery-switch-label"
					checked={enabled}
					onCheckedChange={setEnabled}
					className="settings-switch"
					thumbClassName="settings-switch-thumb"
				/>
			</div>
			<div className="settings-switch-row">
				<label id="gallery-switch-disabled-label" htmlFor="gallery-switch-disabled">
					Disabled, checked
				</label>
				<RadixSwitch
					id="gallery-switch-disabled"
					aria-labelledby="gallery-switch-disabled-label"
					checked
					disabled
					onCheckedChange={() => {}}
					className="settings-switch"
					thumbClassName="settings-switch-thumb"
				/>
			</div>
		</>
	);
}

function RadioExamples() {
	const [choice, setChoice] = useState("first");
	return (
		<RadixRadioGroup
			ariaLabel="Synthetic radio choices"
			value={choice}
			onValueChange={setChoice}
			rootClassName="sync-dialog-radio-list"
			itemClassName="sync-dialog-radio-option"
			indicatorClassName="sync-dialog-radio-indicator"
			itemLabelClassName="sync-dialog-radio-label"
			options={[
				{ value: "first", label: "First choice" },
				{ value: "second", label: LONG_LABEL },
				{ value: "disabled", label: "Unavailable choice", disabled: true },
			]}
		/>
	);
}

export function ChoiceExamples() {
	const [checked, setChecked] = useState(true);
	return (
		<>
			<SwitchExamples />
			<RadioExamples />
			<label className="sync-dialog-radio-option" htmlFor="gallery-checkbox">
				<TextInput
					id="gallery-checkbox"
					type="checkbox"
					data-testid="gallery-checkbox"
					checked={checked}
					onChange={(event) => setChecked(event.currentTarget.checked)}
				/>
				Checkbox choice
			</label>
			<label className="sync-dialog-radio-option" htmlFor="gallery-checkbox-disabled">
				<TextInput id="gallery-checkbox-disabled" type="checkbox" disabled checked />
				Disabled checkbox
			</label>
		</>
	);
}
