/* API fetch wrappers — thin layer over the viewer HTTP endpoints. */

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

export async function loadStats(): Promise<any> {
  return fetchJson('/api/stats');
}

export async function loadUsage(project: string): Promise<any> {
  return fetchJson(`/api/usage?project=${encodeURIComponent(project)}`);
}

export async function loadSession(project: string): Promise<any> {
  return fetchJson(`/api/session?project=${encodeURIComponent(project)}`);
}

export async function loadRawEvents(project: string): Promise<any> {
  return fetchJson(`/api/raw-events?project=${encodeURIComponent(project)}`);
}

export async function loadMemories(project: string): Promise<any> {
  return loadMemoriesPage(project);
}

function buildProjectParams(
  project: string,
  limit?: number,
  offset?: number,
  scope?: string,
): string {
  const params = new URLSearchParams();
  params.set('project', project || '');
  if (typeof limit === 'number') params.set('limit', String(limit));
  if (typeof offset === 'number') params.set('offset', String(offset));
  if (scope) params.set('scope', scope);
  return params.toString();
}

export async function loadMemoriesPage(
  project: string,
  options?: { limit?: number; offset?: number; scope?: string },
): Promise<any> {
  const query = buildProjectParams(project, options?.limit, options?.offset, options?.scope);
  return fetchJson(`/api/observations?${query}`);
}

export async function updateMemoryVisibility(memoryId: number, visibility: 'private' | 'shared'): Promise<any> {
  const resp = await fetch('/api/memories/visibility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ memory_id: memoryId, visibility }),
  });
  const text = await resp.text();
  const payload = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(payload?.error || text || 'request failed');
  return payload;
}

export async function loadSummaries(project: string): Promise<any> {
  return loadSummariesPage(project);
}

export async function loadSummariesPage(
  project: string,
  options?: { limit?: number; offset?: number; scope?: string },
): Promise<any> {
  const query = buildProjectParams(project, options?.limit, options?.offset, options?.scope);
  return fetchJson(`/api/summaries?${query}`);
}

export async function loadObserverStatus(): Promise<any> {
  return fetchJson('/api/observer-status');
}

export async function loadConfig(): Promise<any> {
  return fetchJson('/api/config');
}

export async function saveConfig(payload: any): Promise<void> {
  const resp = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let parsed: any = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {}
  }
  if (!resp.ok) {
    const message = parsed && typeof parsed.error === 'string' ? parsed.error : text || 'request failed';
    throw new Error(message);
  }
  return parsed;
}

export async function loadSyncStatus(
  includeDiagnostics: boolean,
  project = '',
  options?: { includeJoinRequests?: boolean },
): Promise<any> {
  const params = new URLSearchParams();
  if (includeDiagnostics) params.set('includeDiagnostics', '1');
  if (project) params.set('project', project);
  if (options?.includeJoinRequests) params.set('includeJoinRequests', '1');
  const suffix = params.size ? `?${params.toString()}` : '';
  return fetchJson(`/api/sync/status${suffix}`);
}

export async function createCoordinatorInvite(payload: {
  group_id: string;
  coordinator_url?: string;
  policy: 'auto_admit' | 'approval_required';
  ttl_hours: number;
}): Promise<any> {
  const resp = await fetch('/api/sync/invites/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  const data = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(data?.error || text || 'request failed');
  return data;
}

export async function importCoordinatorInvite(invite: string): Promise<any> {
  const resp = await fetch('/api/sync/invites/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite }),
  });
  const text = await resp.text();
  const data = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(data?.error || text || 'request failed');
  return data;
}

export async function reviewJoinRequest(requestId: string, action: 'approve' | 'deny'): Promise<any> {
  const resp = await fetch('/api/sync/join-requests/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_id: requestId, action }),
  });
  const text = await resp.text();
  const data = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(data?.error || text || 'request failed');
  return data;
}

export async function loadSyncActors(): Promise<any> {
  return fetchJson('/api/sync/actors');
}

export async function loadPairing(): Promise<any> {
  return fetchJson('/api/sync/pairing?includeDiagnostics=1');
}

export async function updatePeerScope(
  peerDeviceId: string,
  include: string[] | null,
  exclude: string[] | null,
  inheritGlobal = false,
): Promise<any> {
  const resp = await fetch('/api/sync/peers/scope', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      peer_device_id: peerDeviceId,
      include,
      exclude,
      inherit_global: inheritGlobal,
    }),
  });
  const text = await resp.text();
  const payload = text ? JSON.parse(text) : {};
  if (!resp.ok) {
    throw new Error(payload?.error || text || 'request failed');
  }
  return payload;
}

export async function updatePeerIdentity(peerDeviceId: string, claimedLocalActor: boolean): Promise<any> {
  const resp = await fetch('/api/sync/peers/identity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      peer_device_id: peerDeviceId,
      claimed_local_actor: claimedLocalActor,
    }),
  });
  const text = await resp.text();
  const payload = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(payload?.error || text || 'request failed');
  return payload;
}

export async function assignPeerActor(peerDeviceId: string, actorId: string | null): Promise<any> {
  const resp = await fetch('/api/sync/peers/identity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      peer_device_id: peerDeviceId,
      actor_id: actorId,
    }),
  });
  const text = await resp.text();
  const payload = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(payload?.error || text || 'request failed');
  return payload;
}

export async function deletePeer(peerDeviceId: string): Promise<any> {
  const resp = await fetch(`/api/sync/peers/${encodeURIComponent(peerDeviceId)}`, {
    method: 'DELETE',
  });
  const text = await resp.text();
  const payload = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(payload?.error || text || 'request failed');
  return payload;
}

export async function acceptDiscoveredPeer(peerDeviceId: string, fingerprint: string): Promise<any> {
  const resp = await fetch('/api/sync/peers/accept-discovered', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      peer_device_id: peerDeviceId,
      fingerprint,
    }),
  });
  const text = await resp.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!resp.ok) throw new Error(payload?.detail || payload?.error || text || 'request failed');
  return payload;
}

export async function createActor(displayName: string): Promise<any> {
  const resp = await fetch('/api/sync/actors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ display_name: displayName }),
  });
  const text = await resp.text();
  const payload = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(payload?.error || text || 'request failed');
  return payload;
}

export async function renameActor(actorId: string, displayName: string): Promise<any> {
  const resp = await fetch('/api/sync/actors/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor_id: actorId, display_name: displayName }),
  });
  const text = await resp.text();
  const payload = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(payload?.error || text || 'request failed');
  return payload;
}

export async function mergeActor(primaryActorId: string, secondaryActorId: string): Promise<any> {
  const resp = await fetch('/api/sync/actors/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      primary_actor_id: primaryActorId,
      secondary_actor_id: secondaryActorId,
    }),
  });
  const text = await resp.text();
  const payload = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(payload?.error || text || 'request failed');
  return payload;
}

export async function claimLegacyDeviceIdentity(originDeviceId: string): Promise<any> {
  const resp = await fetch('/api/sync/legacy-devices/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ origin_device_id: originDeviceId }),
  });
  const text = await resp.text();
  const payload = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(payload?.error || text || 'request failed');
  return payload;
}

export async function loadProjects(): Promise<string[]> {
  const payload = await fetchJson('/api/projects');
  return payload.projects || [];
}

export async function triggerSync(address?: string): Promise<void> {
  const payload = address ? { address } : {};
  const resp = await fetch('/api/sync/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let body: any = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!resp.ok) throw new Error(body?.error || text || 'request failed');
}
