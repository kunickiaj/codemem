import { Fragment } from 'preact';
import { clearSyncMount, renderIntoSyncMount } from './render-root';
import { formatTimestamp } from '../../../lib/format';
import { RadixSelect, type RadixSelectOption } from '../../../components/primitives/radix-select';

type LegacyDeviceClaim = {
  origin_device_id?: string;
  memory_count?: number;
  last_seen_at?: string;
};

function validDevices(devices: LegacyDeviceClaim[]): LegacyDeviceClaim[] {
  return devices.filter((device) => String(device.origin_device_id || '').trim());
}

function metaText(devices: LegacyDeviceClaim[]): string {
  const withLastSeen = devices.find((device) => String(device.last_seen_at || '').trim());
  if (withLastSeen?.last_seen_at) {
    return `Detected from older synced memories. Latest memory: ${formatTimestamp(String(withLastSeen.last_seen_at).trim())}`;
  }
  return 'Detected from older synced memories not yet attached to a current device.';
}

function LegacyClaimMeta({ devices }: { devices: LegacyDeviceClaim[] }) {
  return <Fragment>{metaText(devices)}</Fragment>;
}

function option(device: LegacyDeviceClaim): RadixSelectOption {
  const deviceId = String(device.origin_device_id || '').trim();
  const count = Number(device.memory_count || 0);
  return {
    label: count > 0 ? `${deviceId} (${count} memories)` : deviceId,
    value: deviceId,
  };
}

export function renderLegacyClaimsSlice(input: {
  panel: HTMLElement;
  mount: HTMLElement;
  meta: HTMLElement;
  devices: LegacyDeviceClaim[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  const devices = validDevices(input.devices);
  if (!devices.length) {
    input.panel.hidden = true;
    input.onValueChange('');
    clearSyncMount(input.mount);
    clearSyncMount(input.meta);
    return;
  }

  const options = devices.map(option);
  const nextValue = options.some((item) => item.value === input.value)
    ? input.value
    : options[0]?.value || '';

  if (nextValue !== input.value) input.onValueChange(nextValue);

  input.panel.hidden = false;
  renderIntoSyncMount(
    input.mount,
    <RadixSelect
      ariaLabel="Legacy device"
      contentClassName="sync-radix-select-content sync-legacy-select-content"
      id="syncLegacyDeviceSelect"
      itemClassName="sync-radix-select-item"
      name="syncLegacyDeviceSelect"
      onValueChange={input.onValueChange}
      options={options}
      triggerClassName="sync-radix-select-trigger sync-legacy-select"
      value={nextValue}
      viewportClassName="sync-radix-select-viewport"
    />,
  );
  renderIntoSyncMount(input.meta, <LegacyClaimMeta devices={devices} />);
}
