import { describe, expect, it } from 'vitest';

import {
  deriveDuplicatePeople,
  derivePeerUiStatus,
  deriveSyncViewModel,
  deviceNeedsFriendlyName,
  resolveFriendlyDeviceName,
} from './view-model';

describe('resolveFriendlyDeviceName', () => {
  it('prefers the explicit local name first', () => {
    expect(
      resolveFriendlyDeviceName({
        localName: 'Work MacBook',
        coordinatorName: 'Adam laptop',
        deviceId: '12345678-1234-1234-1234-123456789abc',
      }),
    ).toBe('Work MacBook');
  });

  it('falls back to coordinator display name before raw device ids', () => {
    expect(
      resolveFriendlyDeviceName({
        localName: '',
        coordinatorName: 'Desk Mini',
        deviceId: '12345678-1234-1234-1234-123456789abc',
      }),
    ).toBe('Desk Mini');
  });

  it('uses a short fallback when nothing friendly exists', () => {
    expect(
      resolveFriendlyDeviceName({
        deviceId: '12345678-1234-1234-1234-123456789abc',
      }),
    ).toBe('12345678');
  });
});

describe('deviceNeedsFriendlyName', () => {
  it('requires naming when no local or coordinator name exists', () => {
    expect(
      deviceNeedsFriendlyName({ deviceId: '12345678-1234-1234-1234-123456789abc' }),
    ).toBe(true);
  });

  it('does not require naming when a friendly label already exists', () => {
    expect(
      deviceNeedsFriendlyName({
        localName: 'Work MacBook',
        deviceId: '12345678-1234-1234-1234-123456789abc',
      }),
    ).toBe(false);
  });
});

describe('derivePeerUiStatus', () => {
  it('flags peers with explicit errors as needs-repair', () => {
    expect(derivePeerUiStatus({ has_error: true, status: { peer_state: 'online' } })).toBe('needs-repair');
  });

  it('maps stale peers to offline', () => {
    expect(derivePeerUiStatus({ status: { peer_state: 'stale' } })).toBe('offline');
  });
});

describe('deriveDuplicatePeople', () => {
  it('groups duplicate display names and preserves local involvement', () => {
    expect(
      deriveDuplicatePeople([
        { actor_id: 'actor-local', display_name: 'Adam', is_local: true },
        { actor_id: 'actor-remote', display_name: 'Adam', is_local: false },
        { actor_id: 'actor-other', display_name: 'Pat', is_local: false },
      ]),
    ).toEqual([
      {
        displayName: 'Adam',
        actorIds: ['actor-local', 'actor-remote'],
        includesLocal: true,
      },
    ]);
  });
});

describe('deriveSyncViewModel', () => {
  it('creates attention items for duplicates, repairs, reviewable devices, and naming gaps', () => {
    const view = deriveSyncViewModel({
      actors: [
        { actor_id: 'actor-local', display_name: 'Adam', is_local: true },
        { actor_id: 'actor-remote', display_name: 'Adam', is_local: false },
      ],
      peers: [
        {
          peer_device_id: 'peer-1',
          name: '',
          has_error: true,
          last_error: 'all addresses failed',
          status: { peer_state: 'degraded' },
          fingerprint: 'fp-old',
        },
      ],
      coordinator: {
        discovered_devices: [
          {
            device_id: 'peer-1',
            display_name: '',
            stale: false,
            fingerprint: 'fp-new',
          },
          {
            device_id: 'peer-2',
            display_name: 'Desk Mini',
            stale: false,
            fingerprint: 'fp-2',
          },
        ],
      },
    });

    expect(view.summary).toEqual({
      connectedDeviceCount: 0,
      seenOnTeamCount: 2,
      offlineTeamDeviceCount: 0,
    });
    expect(view.attentionItems.map((item) => item.kind)).toEqual([
      'possible-duplicate-person',
      'device-needs-repair',
      'review-team-device',
    ]);
  });

  it('hides duplicate-person attention when the user already marked them as different people', () => {
    const view = deriveSyncViewModel({
      actors: [
        { actor_id: 'actor-local', display_name: 'Adam', is_local: true },
        { actor_id: 'actor-remote', display_name: 'Adam', is_local: false },
      ],
      duplicatePersonDecisions: {
        'actor-local::actor-remote': 'different-people',
      },
    });

    expect(view.duplicatePeople).toEqual([]);
    expect(view.attentionItems).toEqual([]);
  });
});
