import { useRef, useState } from "preact/hooks";
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

function RenameForm({
	busy,
	disabled,
	inputRef,
	name,
	onName,
	onSave,
}: {
	busy: boolean;
	disabled: boolean;
	inputRef: ReturnType<typeof useRef<HTMLInputElement>>;
	name: string;
	onName: (value: string) => void;
	onSave: (event: Event) => void;
}) {
	return (
		<form className="devices-rename-form" onSubmit={onSave}>
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
		</form>
	);
}

export function RenameDeviceAction({
	device,
	options,
}: {
	device: DeviceProjection;
	options: DevicesRendererOptions;
}) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState(device.displayName);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const disabled = busy || options.inventoryUnavailable === true || options.refreshError === true;
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
			setOpen(false);
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
			<button
				aria-expanded={open}
				className="sync-subview-link"
				onClick={() => {
					setOpen((current) => !current);
					setName(device.displayName);
					setMessage("");
					queueMicrotask(() => inputRef.current?.focus());
				}}
				type="button"
			>
				Rename device…
			</button>
			{open ? (
				<RenameForm
					busy={busy}
					disabled={disabled}
					inputRef={inputRef}
					name={name}
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
