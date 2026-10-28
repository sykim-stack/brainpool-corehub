import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const HMAC_AUTH_SCHEME = 'CoreHub-HMAC'
export const HMAC_HEADERS = Object.freeze({
  deviceId: 'x-corehub-device-id',
  timestamp: 'x-corehub-timestamp',
  nonce: 'x-corehub-nonce',
  signature: 'authorization',
})

const DEVICE_ID_RE = /^[A-Za-z0-9._:-]{8,200}$/
const NONCE_RE = /^[A-Za-z0-9._~:-]{16,200}$/
const SIGNATURE_RE = /^[A-Za-z0-9_-]{43,128}$/

function resultError(error, status, extra = {}) {
  return { ok: false, error, status, ...extra }
}

export function sha256Hex(value) {
  return createHash('sha256').update(Buffer.from(String(value), 'utf8')).digest('hex')
}

/**
 * The signed body must be the exact raw request body, not JSON.stringify(parsedBody).
 */
export function createCanonicalRequest({ method, path, timestamp, nonce, bodySha256 }) {
  if (!method || !path || !timestamp || !nonce || !bodySha256) {
    throw new TypeError('canonical_request_fields_required')
  }
  return [method.toUpperCase(), path, String(timestamp), nonce, bodySha256].join('\n')
}

export function createHmacSignature(secret, canonicalRequest) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new TypeError('hmac_secret_required')
  }
  return createHmac('sha256', secret)
    .update(canonicalRequest, 'utf8')
    .digest('base64url')
}

function signaturesEqual(expected, supplied) {
  if (!SIGNATURE_RE.test(supplied)) return false
  const expectedBytes = Buffer.from(expected, 'utf8')
  const suppliedBytes = Buffer.from(supplied, 'utf8')
  if (expectedBytes.length !== suppliedBytes.length) return false
  return timingSafeEqual(expectedBytes, suppliedBytes)
}

function header(request, name) {
  const value = request?.headers?.get?.(name)
  return typeof value === 'string' ? value.trim() : ''
}

function parseAuthorization(value) {
  const match = value.match(/^CoreHub-HMAC\s+([^\s]+)$/i)
  return match?.[1] ?? null
}

function parseTimestamp(value) {
  if (!/^[0-9]{1,13}$/.test(value)) return null
  const timestamp = Number(value)
  return Number.isSafeInteger(timestamp) ? timestamp : null
}

/**
 * Verify one worker request after the caller has read the raw body exactly once.
 *
 * lookupDevice must return:
 *   { enabled: boolean, sourceCore: string, keyVersion: string, secret: string }
 *
 * claimNonce must atomically claim (deviceId, nonce) and return true for a new
 * nonce, false for a live replay. The verifier never stores or logs `secret`.
 */
export async function verifyHmacRequest(
  request,
  rawBody,
  { lookupDevice, claimNonce, nowMs = Date.now, maxSkewSeconds = 300 } = {},
) {
  if (typeof lookupDevice !== 'function' || typeof claimNonce !== 'function') {
    return resultError('hmac_verifier_misconfigured', 503)
  }
  if (typeof rawBody !== 'string') {
    return resultError('raw_body_required', 400)
  }

  const deviceId = header(request, HMAC_HEADERS.deviceId)
  const timestampText = header(request, HMAC_HEADERS.timestamp)
  const nonce = header(request, HMAC_HEADERS.nonce)
  const suppliedSignature = parseAuthorization(header(request, HMAC_HEADERS.signature))

  if (!deviceId || !DEVICE_ID_RE.test(deviceId) ||
      !timestampText || !nonce || !NONCE_RE.test(nonce) ||
      !suppliedSignature) {
    return resultError('invalid_hmac_headers', 401)
  }

  const timestamp = parseTimestamp(timestampText)
  if (timestamp === null) return resultError('invalid_hmac_timestamp', 401)

  const now = Number(nowMs())
  if (!Number.isFinite(now)) return resultError('hmac_verifier_clock_unavailable', 503)
  const skewMs = Math.abs(now - timestamp * 1000)
  if (skewMs > maxSkewSeconds * 1000) {
    return resultError('hmac_timestamp_out_of_window', 401)
  }

  let device
  try {
    device = await lookupDevice(deviceId)
  } catch {
    return resultError('device_registry_unavailable', 503)
  }

  if (!device?.enabled || typeof device.secret !== 'string' || device.secret.length === 0) {
    return resultError('device_not_registered_or_disabled', 403)
  }

  const bodySha256 = sha256Hex(rawBody)
  const url = new URL(request.url)
  const canonicalRequest = createCanonicalRequest({
    method: request.method,
    path: url.pathname,
    timestamp: timestampText,
    nonce,
    bodySha256,
  })
  const expectedSignature = createHmacSignature(device.secret, canonicalRequest)

  if (!signaturesEqual(expectedSignature, suppliedSignature)) {
    return resultError('invalid_hmac_signature', 401)
  }

  let claimed
  try {
    claimed = await claimNonce({
      deviceId,
      nonce,
      expiresAt: new Date(timestamp * 1000 + maxSkewSeconds * 1000).toISOString(),
    })
  } catch {
    return resultError('nonce_registry_unavailable', 503)
  }
  if (claimed !== true) return resultError('hmac_replay_detected', 401)

  return {
    ok: true,
    kind: 'worker',
    deviceId,
    sourceCore: device.sourceCore,
    keyVersion: device.keyVersion,
    timestamp,
    nonce,
    bodySha256,
  }
}

export function isHmacRequest(request) {
  return /^CoreHub-HMAC\s+[^\s]+$/i.test(header(request, HMAC_HEADERS.signature))
}
