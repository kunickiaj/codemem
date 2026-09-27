import { useEffect, useRef, useState } from "preact/hooks";
import { renameKnownDevice } from "../lib/api/sync";
import type { DeviceProjection, DevicesRendererOptions } from "./devices";

function failureMessage(error: unknown): string {
	const code = error instanceof Error ? error.message : "";
	if (code === "coordinator_device_rename_incomplete") {
		return "Some coordinator groups could not be renamed. Retry the same name after checking the coordinator.";
	}
	if (code === "coordinator_device_names_unavailable") {
		return "Coordinator device names are unavailable. Refresh Devices and retry.";
	}
	if (code === "device_enrollment_conflict") {
		return "This device has conflicting enrollment records. Review coordinator devices before renaming.";
	}
	return "Device name was not saved. Refresh Devices and retry.";
}

// The menu that opened the form is closed by now. A disabled input (while
// saving) cannot take focus, so fall back to the row's actions button.
function focusRenameTarget(input: HTMLInputElement | null, deviceId: string) {
	if (input && !input.disabled) {
		input.focus();
		return;
	}
	document.getElementById(`device-actions-${deviceId}`)?.focus();
}

function RenameForm({
	busy,
	disabled,
	inputRef,
	name,
	onCancel,
	onName,
	onSave,
}: {
	busy: boolean;
	disabled: boolean;
	inputRef: ReturnType<typeof useRef<HTMLInputElement>>;
	name: string;
	onCancel: () => void;
	onName: (value: string) => void;
	onSave: (event: Event) => void;
}) {
	return (
		<form
			className="devices-rename-form"
			onKeyDown={(event) => {
				if (event.key === "Escape" && !busy) onCancel();
			}}
			onSubmit={onSave}
		>
			<label>
				Device name
				<input
					disabled={disabled}
					maxLength={120}
					onInput={(event) => onName(event.currentTarget.value)}
					ref={inputRef}
					value={name}
				/>
			</label>
			<button className="settings-button" disabled={disabled} type="submit">
				{busy ? "Saving…" : "Save name"}
			</button>
			<button className="settings-button" disabled={busy} onClick={onCancel} type="button">
				Cancel
			</button>
		</form>
	);
}

/** Rename form opened from the device row's actions menu. */
export function RenameDevicePanel({
	device,
	focusRequest,
	onClose,
	open,
	options,
}: {
	device: DeviceProjection;
	/** Changes each time the menu asks for the form, so a repeat request refocuses it. */
	focusRequest: number;
	onClose: () => void;
	open: boolean;
	options: DevicesRendererOptions;
}) {
	const [name, setName] = useState(device.displayName);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const disabled = busy || options.inventoryUnavailable === true || options.refreshError === true;
	useEffect(() => {
		if (!open) return;
		setName(device.displayName);
		setMessage("");
	}, [open, device.displayName]);
	useEffect(() => {
		if (!open || focusRequest <= 0) return;
		queueMicrotask(() => focusRenameTarget(inputRef.current, device.deviceId));
	}, [open, focusRequest, device.deviceId]);
	const save = async (event: Event) => {
		event.preventDefault();
		if (disabled) return;
		if (!name.trim()) {
			setMessage("Enter a device name before saving.");
			inputRef.current?.focus();
			return;
		}
		setBusy(true);
		setMessage("");
		try {
			await (options.renameDevice ?? renameKnownDevice)(device.deviceId, name.trim());
			const refreshed = await options.onCommitted?.();
			onClose();
			setMessage(
				refreshed === false ? "Name saved. Refresh Devices to see it." : "Device renamed.",
			);
		} catch (error) {
			setMessage(failureMessage(error));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="devices-rename">
			{open ? (
				<RenameForm
					busy={busy}
					disabled={disabled}
					inputRef={inputRef}
					name={name}
					onCancel={() => {
						setMessage("");
						onClose();
					}}
					onName={setName}
					onSave={(event) => void save(event)}
				/>
			) : null}
			{message ? (
				<span className="small" role="status">
					{message}
				</span>
			) : null}
		</div>
	);
}
