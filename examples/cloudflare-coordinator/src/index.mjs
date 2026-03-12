const SSHSIG_MAGIC = new TextEncoder().encode("SSHSIG")
const NAMESPACE = "codemem-sync"
const TIME_WINDOW_S = 300

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

function readUint32(view, offset) {
  return view.getUint32(offset, false)
}

function readSshString(bytes, offset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const length = readUint32(view, offset)
  const start = offset + 4
  const end = start + length
  if (end > bytes.length) throw new Error("invalid_ssh_string")
  return { value: bytes.slice(start, end), nextOffset: end }
}

function writeUint32(value) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, false)
  return bytes
}

function writeSshString(bytes) {
  return concatBytes(writeUint32(bytes.length), bytes)
}

function concatBytes(...parts) {
  const length = parts.reduce((total, part) => total + part.length, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false
  }
  return true
}

function decodeBase64(value) {
  const raw = atob(value)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function encodeUtf8(value) {
  return new TextEncoder().encode(value)
}

function decodeUtf8(bytes) {
  return new TextDecoder().decode(bytes)
}

function normalizeAddress(value) {
  const raw = String(value || "").trim()
  if (!raw) return ""
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`)
    url.hash = ""
    return url.toString().replace(/\/$/, "")
  } catch {
    return raw.replace(/\/$/, "")
  }
}

function normalizeAddresses(values) {
  const seen = new Set()
  const output = []
  for (const value of values || []) {
    if (typeof value !== "string") continue
    const normalized = normalizeAddress(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    output.push(normalized)
  }
  return output
}

function parseOpenSshPublicKey(publicKey) {
  const parts = String(publicKey || "").trim().split(/\s+/)
  if (parts.length < 2 || parts[0] !== "ssh-ed25519") {
    throw new Error("unsupported_public_key")
  }
  const blob = decodeBase64(parts[1])
  let offset = 0
  const alg = readSshString(blob, offset)
  offset = alg.nextOffset
  const keyBytes = readSshString(blob, offset)
  if (decodeUtf8(alg.value) !== "ssh-ed25519") {
    throw new Error("unsupported_public_key")
  }
  return keyBytes.value
}

function unwrapSshSignatureArmor(bytes) {
  if (bytesEqual(bytes.slice(0, SSHSIG_MAGIC.length), SSHSIG_MAGIC)) {
    return bytes
  }
  const text = decodeUtf8(bytes)
  const header = "-----BEGIN SSH SIGNATURE-----"
  const footer = "-----END SSH SIGNATURE-----"
  if (!text.includes(header) || !text.includes(footer)) {
    throw new Error("invalid_signature_magic")
  }
  const body = text
    .replace(header, "")
    .replace(footer, "")
    .split(/\s+/)
    .filter(Boolean)
    .join("")
  return decodeBase64(body)
}

function parseSshSignature(signatureValue) {
  const prefix = "v1:"
  if (!String(signatureValue || "").startsWith(prefix)) {
    throw new Error("unsupported_signature_version")
  }
  const blob = unwrapSshSignatureArmor(decodeBase64(String(signatureValue).slice(prefix.length)))
  if (!bytesEqual(blob.slice(0, SSHSIG_MAGIC.length), SSHSIG_MAGIC)) {
    throw new Error("invalid_signature_magic")
  }
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength)
  const version = readUint32(view, SSHSIG_MAGIC.length)
  if (version !== 1) throw new Error("unsupported_signature_version")
  let offset = SSHSIG_MAGIC.length + 4
  const publicKey = readSshString(blob, offset)
  offset = publicKey.nextOffset
  const namespace = readSshString(blob, offset)
  offset = namespace.nextOffset
  const reserved = readSshString(blob, offset)
  offset = reserved.nextOffset
  const hashAlgorithm = readSshString(blob, offset)
  offset = hashAlgorithm.nextOffset
  const signature = readSshString(blob, offset)
  let sigOffset = 0
  const sigAlg = readSshString(signature.value, sigOffset)
  sigOffset = sigAlg.nextOffset
  const sigBytes = readSshString(signature.value, sigOffset)
  return {
    publicKeyBlob: publicKey.value,
    namespace: decodeUtf8(namespace.value),
    reserved: reserved.value,
    hashAlgorithm: decodeUtf8(hashAlgorithm.value),
    signatureAlgorithm: decodeUtf8(sigAlg.value),
    signatureBytes: sigBytes.value,
  }
}

async function shaBytes(name, bytes) {
  const digest = await crypto.subtle.digest(name, bytes)
  return new Uint8Array(digest)
}

async function canonicalRequest(request, bodyBytes, timestamp, nonce) {
  const url = new URL(request.url)
  const pathWithQuery = `${url.pathname}${url.search}`
  const bodyHash = await shaBytes("SHA-256", bodyBytes)
  const bodyHashHex = Array.from(bodyHash, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return encodeUtf8([
    request.method.toUpperCase(),
    pathWithQuery,
    timestamp,
    nonce,
    bodyHashHex,
  ].join("\n"))
}

async function verifyDeviceRequest(request, bodyBytes, enrolledPublicKey, expectedDeviceId) {
  const deviceId = request.headers.get("X-Opencode-Device") || ""
  const timestamp = request.headers.get("X-Opencode-Timestamp") || ""
  const nonce = request.headers.get("X-Opencode-Nonce") || ""
  const signatureValue = request.headers.get("X-Opencode-Signature") || ""
  if (!deviceId || !timestamp || !nonce || !signatureValue) {
    throw new Error("missing_headers")
  }
  if (deviceId !== expectedDeviceId) {
    throw new Error("device_mismatch")
  }
  const ts = Number(timestamp)
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TIME_WINDOW_S) {
    throw new Error("timestamp_out_of_window")
  }
  const parsed = parseSshSignature(signatureValue)
  if (parsed.namespace !== NAMESPACE) throw new Error("invalid_namespace")
  if (parsed.signatureAlgorithm !== "ssh-ed25519") throw new Error("unsupported_signature_algorithm")
  if (!["sha256", "sha512"].includes(parsed.hashAlgorithm)) throw new Error("unsupported_hash_algorithm")

  const enrolledRaw = parseOpenSshPublicKey(enrolledPublicKey)
  const parsedPublicKey = readSshString(parsed.publicKeyBlob, 0)
  if (decodeUtf8(parsedPublicKey.value) !== "ssh-ed25519") throw new Error("unsupported_public_key")
  const parsedRaw = readSshString(parsed.publicKeyBlob, parsedPublicKey.nextOffset)
  if (!bytesEqual(enrolledRaw, parsedRaw.value)) throw new Error("public_key_mismatch")

  const canonical = await canonicalRequest(request, bodyBytes, timestamp, nonce)
  const hashName = parsed.hashAlgorithm === "sha512" ? "SHA-512" : "SHA-256"
  const hashedMessage = await shaBytes(hashName, canonical)
  const signedData = concatBytes(
    SSHSIG_MAGIC,
    writeSshString(encodeUtf8(parsed.namespace)),
    writeSshString(parsed.reserved),
    writeSshString(encodeUtf8(parsed.hashAlgorithm)),
    writeSshString(hashedMessage),
  )

  const key = await crypto.subtle.importKey("raw", enrolledRaw, { name: "Ed25519" }, false, ["verify"])
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, parsed.signatureBytes, signedData)
  if (!ok) throw new Error("invalid_signature")
  return { deviceId, nonce }
}

async function recordNonce(env, deviceId, nonce) {
  const now = new Date().toISOString()
  const cutoff = new Date(Date.now() - TIME_WINDOW_S * 2000).toISOString()
  await env.COORDINATOR_DB.prepare("DELETE FROM request_nonces WHERE created_at < ?").bind(cutoff).run()
  const result = await env.COORDINATOR_DB.prepare(
    "INSERT OR IGNORE INTO request_nonces(device_id, nonce, created_at) VALUES (?, ?, ?)",
  ).bind(deviceId, nonce, now).run()
  if (result.meta.changes === 0) throw new Error("nonce_replay")
}

async function loadEnrollment(env, groupId, deviceId) {
  const row = await env.COORDINATOR_DB.prepare(
    "SELECT device_id, public_key, fingerprint, display_name FROM enrolled_devices WHERE group_id = ? AND device_id = ? AND enabled = 1",
  ).bind(groupId, deviceId).first()
  return row || null
}

async function handlePresence(request, env) {
  const bodyText = await request.text()
  let body
  try {
    body = JSON.parse(bodyText || "{}")
  } catch {
    return jsonResponse({ error: "invalid_json" }, 400)
  }
  const groupId = String(body.group_id || "").trim()
  if (!groupId) return jsonResponse({ error: "group_id_required" }, 400)
  const deviceId = request.headers.get("X-Opencode-Device") || ""
  const enrollment = await loadEnrollment(env, groupId, deviceId)
  if (!enrollment) return jsonResponse({ error: "unknown_device" }, 401)
  try {
    const auth = await verifyDeviceRequest(request, encodeUtf8(bodyText), enrollment.public_key, deviceId)
    await recordNonce(env, auth.deviceId, auth.nonce)
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "unauthorized" }, 401)
  }
  if (body.fingerprint && String(body.fingerprint) !== String(enrollment.fingerprint)) {
    return jsonResponse({ error: "fingerprint_mismatch" }, 401)
  }
  const addresses = normalizeAddresses(body.addresses)
  const ttlS = Math.max(1, Number(body.ttl_s || 180))
  const now = new Date()
  const expiresAt = new Date(now.getTime() + ttlS * 1000).toISOString()
  await env.COORDINATOR_DB.prepare(
    `INSERT INTO presence_records(group_id, device_id, addresses_json, last_seen_at, expires_at, capabilities_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(group_id, device_id) DO UPDATE SET
       addresses_json = excluded.addresses_json,
       last_seen_at = excluded.last_seen_at,
       expires_at = excluded.expires_at,
       capabilities_json = excluded.capabilities_json`,
  ).bind(
    groupId,
    deviceId,
    JSON.stringify(addresses),
    now.toISOString(),
    expiresAt,
    JSON.stringify(body.capabilities || {}),
  ).run()
  return jsonResponse({ ok: true, group_id: groupId, device_id: deviceId, addresses, expires_at: expiresAt })
}

async function handlePeers(request, env) {
  const url = new URL(request.url)
  const groupId = String(url.searchParams.get("group_id") || "").trim()
  if (!groupId) return jsonResponse({ error: "group_id_required" }, 400)
  const deviceId = request.headers.get("X-Opencode-Device") || ""
  const enrollment = await loadEnrollment(env, groupId, deviceId)
  if (!enrollment) return jsonResponse({ error: "unknown_device" }, 401)
  try {
    const auth = await verifyDeviceRequest(request, new Uint8Array(), enrollment.public_key, deviceId)
    await recordNonce(env, auth.deviceId, auth.nonce)
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "unauthorized" }, 401)
  }
  const now = new Date().toISOString()
  const rows = await env.COORDINATOR_DB.prepare(
    `SELECT enrolled_devices.device_id, enrolled_devices.fingerprint, enrolled_devices.display_name,
            presence_records.addresses_json, presence_records.last_seen_at, presence_records.expires_at,
            presence_records.capabilities_json
     FROM enrolled_devices
     LEFT JOIN presence_records
       ON presence_records.group_id = enrolled_devices.group_id
      AND presence_records.device_id = enrolled_devices.device_id
     WHERE enrolled_devices.group_id = ?
       AND enrolled_devices.enabled = 1
       AND enrolled_devices.device_id != ?
     ORDER BY enrolled_devices.device_id ASC`,
  ).bind(groupId, deviceId).all()
  const items = (rows.results || []).map((row) => {
    const stale = !row.expires_at || String(row.expires_at) <= now
    const addresses = stale ? [] : JSON.parse(row.addresses_json || "[]")
    return {
      device_id: row.device_id,
      fingerprint: row.fingerprint,
      display_name: row.display_name,
      addresses,
      last_seen_at: row.last_seen_at,
      expires_at: row.expires_at,
      stale,
      capabilities: JSON.parse(row.capabilities_json || "{}"),
    }
  })
  return jsonResponse({ items })
}

export default {
  async fetch(request, env) {
    if (!env.COORDINATOR_DB) {
      return jsonResponse({ error: "missing_d1_binding" }, 500)
    }
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/v1/presence") {
      return handlePresence(request, env)
    }
    if (request.method === "GET" && url.pathname === "/v1/peers") {
      return handlePeers(request, env)
    }
    return jsonResponse({ error: "not_found" }, 404)
  },
}
