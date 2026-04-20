/* Factory for the settings form's input event handlers. Takes a deps
 * object so the handlers don't need direct module-state access —
 * settings.tsx passes in the touched-keys accessor, current-values getter,
 * and dispatch callbacks and gets back the bound handlers. */

import type { JSX } from "preact";
import { INPUT_TO_CONFIG_KEY } from "./constants";
import type { SettingsFormState } from "./types";

export interface EventHandlerDeps {
	// Accessor rather than a direct Set reference: settings.tsx
	// reassigns `settingsTouchedKeys` in renderConfigModal/closeSettings,
	// so a captured reference would go stale after the first reset.
	getTouchedKeys: () => Set<string>;
	getValues: () => SettingsFormState;
	updateFormState: (patch: Partial<SettingsFormState>) => void;
	setDirty: (dirty: boolean) => void;
}

export interface SettingsEventHandlers {
	markFieldTouched: (inputId: keyof SettingsFormState) => void;
	updateField: <K extends keyof SettingsFormState>(field: K, value: SettingsFormState[K]) => void;
	onTextInput: <K extends keyof SettingsFormState>(
		field: K,
	) => (event: JSX.TargetedEvent<HTMLInputElement | HTMLTextAreaElement, Event>) => void;
	onSelectValueChange: <K extends keyof SettingsFormState>(field: K) => (value: string) => void;
	onSwitchInput: <K extends keyof SettingsFormState>(field: K) => (checked: boolean) => void;
}

export function createSettingsEventHandlers(deps: EventHandlerDeps): SettingsEventHandlers {
	const markFieldTouched = (inputId: keyof SettingsFormState) => {
		const key = INPUT_TO_CONFIG_KEY[inputId];
		if (!key) return;
		deps.getTouchedKeys().add(key);
	};

	const updateField = <K extends keyof SettingsFormState>(
		field: K,
		value: SettingsFormState[K],
	) => {
		markFieldTouched(field);
		deps.updateFormState({ [field]: value } as Partial<SettingsFormState>);
		deps.setDirty(true);
	};

	const onTextInput =
		<K extends keyof SettingsFormState>(field: K) =>
		(event: JSX.TargetedEvent<HTMLInputElement | HTMLTextAreaElement, Event>) => {
			updateField(field, event.currentTarget.value as SettingsFormState[K]);
		};

	const onSelectValueChange =
		<K extends keyof SettingsFormState>(field: K) =>
		(value: string) => {
			updateField(field, value as SettingsFormState[K]);
		};

	const onSwitchInput =
		<K extends keyof SettingsFormState>(field: K) =>
		(checked: boolean) => {
			updateField(field, checked as SettingsFormState[K]);
		};

	return {
		markFieldTouched,
		updateField,
		onTextInput,
		onSelectValueChange,
		onSwitchInput,
	};
}
