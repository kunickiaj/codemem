import { describe, expect, it } from 'vitest';

import {
  deriveDuplicatePeople,
  derivePeerTrustSummary,
  derivePeerUiStatus,
  deriveSyncViewModel,
  deriveVisiblePeopleActors,
  deviceNeedsFriendlyName,
  resolveFriendlyDeviceName,
  summarizeSyncRunResult,
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

describe('derivePeerTrustSummary', () => {
  it('prioritizes current offline state over stale unauthorized history', () => {
    expect(
      derivePeerTrustSummary({
        last_error: 'peer status failed (401: unauthorized)',
        status: { peer_state: 'offline' },
        has_error: false,
      }).state,
    ).toBe('offline');
  });

  it('surfaces one-way trust when the remote device rejects us with unauthorized', () => {
    expect(
      derivePeerTrustSummary({
        last_error: 'peer status failed (401: unauthorized)',
        status: { peer_state: 'degraded' },
        has_error: true,
      }),
    ).toEqual({
      state: 'trusted-by-you',
      badgeLabel: 'Waiting for other device',
      description:
        'You accepted this device, but the other device still needs to trust this one before sync can work.',
      isWarning: true,
    });
  });

  it('surfaces two-way trust once sync or ping succeeds', () => {
    expect(derivePeerTrustSummary({ status: { sync_status: 'ok', peer_state: 'online' } }).state).toBe(
      'mutual-trust',
    );
  });
});

describe('summarizeSyncRunResult', () => {
  it('summarizes mixed failures without pretending they are all one-way trust', () => {
    expect(
      summarizeSyncRunResult({
        items: [
          { peer_device_id: 'a', ok: false, error: 'peer status failed (401: unauthorized)', opsIn: 0, opsOut: 0, addressErrors: [] },
          { peer_device_id: 'b', ok: false, error: 'connection refused', opsIn: 0, opsOut: 0, addressErrors: [] },
          { peer_device_id: 'c', ok: true, opsIn: 2, opsOut: 1, addressErrors: [] },
        ],
      }),
    ).toEqual({
      ok: false,
      message: '2 of 3 device sync attempts failed. Review device details for the specific errors.',
      warning: true,
    });
  });

  it('turns unauthorized sync failures into a directional trust message', () => {
    expect(
      summarizeSyncRunResult({
        items: [{ peer_device_id: 'peer-a', ok: false, error: 'all addresses failed | http://x: peer status failed (401: unauthorized)', opsIn: 0, opsOut: 0, addressErrors: [] }],
      }),
    ).toEqual({
      ok: false,
      message:
        'This device trusts the peer, but the other device still needs to trust this one before sync can work.',
      warning: true,
    });
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

describe('deriveVisiblePeopleActors', () => {
  it('hides unresolved zero-device duplicates of the local person from the people list', () => {
    expect(
      deriveVisiblePeopleActors({
        actors: [
          { actor_id: 'actor-local', display_name: 'Adam', is_local: true },
          { actor_id: 'actor-shadow', display_name: 'Adam', is_local: false },
          { actor_id: 'actor-other', display_name: 'Pat', is_local: false },
        ],
        peers: [],
        duplicatePeople: [
          {
            displayName: 'Adam',
            actorIds: ['actor-local', 'actor-shadow'],
            includesLocal: true,
          },
        ],
      }),
    ).toEqual({
      visibleActors: [
        { actor_id: 'actor-local', display_name: 'Adam', is_local: true },
        { actor_id: 'actor-other', display_name: 'Pat', is_local: false },
      ],
      hiddenLocalDuplicateCount: 1,
    });
  });

  it('keeps duplicate rows visible when the non-local duplicate already owns devices', () => {
    expect(
      deriveVisiblePeopleActors({
        actors: [
          { actor_id: 'actor-local', display_name: 'Adam', is_local: true },
          { actor_id: 'actor-remote', display_name: 'Adam', is_local: false },
        ],
        peers: [{ actor_id: 'actor-remote' }],
        duplicatePeople: [
          {
            displayName: 'Adam',
            actorIds: ['actor-local', 'actor-remote'],
            includesLocal: true,
          },
        ],
      }),
    ).toEqual({
      visibleActors: [
        { actor_id: 'actor-local', display_name: 'Adam', is_local: true },
        { actor_id: 'actor-remote', display_name: 'Adam', is_local: false },
      ],
      hiddenLocalDuplicateCount: 0,
    });
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
