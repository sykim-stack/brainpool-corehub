import { createHash } from 'node:crypto'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_RE = /^[0-9a-f]{64}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T/

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function hasValidUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

/**
 * Canonical JSON serialization for JSON-compatible values using ECMAScript
 * number/string serialization and UTF-16 property-name ordering (JCS rules).
 * Input must originate from parsed JSON; unsupported JS values are rejected.
 */
export function canonicalizeJson(value) {
  if (typeof value === 'string' && !hasValidUnicode(value)) throw new TypeError('invalid_unicode_string')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non_finite_number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => {
      if (item === undefined) throw new TypeError('undefined_json_value')
      return canonicalizeJson(item)
    }).join(',') + ']'
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort()
    return '{' + keys.map((key) => {
      if (!hasValidUnicode(key)) throw new TypeError('invalid_unicode_key')
      const item = value[key]
      if (item === undefined) throw new TypeError('undefined_json_value')
      return JSON.stringify(key) + ':' + canonicalizeJson(item)
    }).join(',') + '}'
  }
  throw new TypeError('unsupported_json_value')
}

export function sha256Payload(payload) {
  if (!isPlainObject(payload)) throw new TypeError('payload_must_be_object')
  return createHash('sha256').update(canonicalizeJson(payload), 'utf8').digest('hex')
}

export function normalizeOccurredAt(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value) || !/(?:Z|[+-]\\d{2}:\\d{2})$/i.test(value)) return null
  const parts = /^(\d{4})-(\d{2})-(\d{2})T/.exec(value)
  if (!parts) return null
  const [, year, month, day] = parts.map(Number)
  const calendarDate = new Date(Date.UTC(year, month - 1, day))
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return date.toISOString()
}

/**
 * Validate the transport envelope before idempotency lookup.
 * This is shape/integrity validation only; it does not authenticate the sender
 * or prove that owner_id is a real Auth UID.
 */
export function validateMessageEventEnvelope(event) {
  if (!isPlainObject(event)) return { ok: false, error: 'VALIDATION_ERROR' }
  const required = [
    'source', 'event_type', 'event_id', 'source_record_id',
    'source_revision', 'occurred_at', 'owner_id', 'payload', 'payload_sha256',
  ]
  if (required.some((key) => !Object.hasOwn(event, key))) {
    return { ok: false, error: 'VALIDATION_ERROR' }
  }
  if (event.source !== 'CoreNull') return { ok: false, error: 'FORBIDDEN_SOURCE' }
  if (event.event_type !== 'space.message.created') {
    return { ok: false, error: 'VALIDATION_ERROR' }
  }
  if (!Number.isSafeInteger(event.source_revision) || event.source_revision !== 1) {
    return { ok: false, error: 'REVISION_UNEXPECTED' }
  }
  if (!UUID_RE.test(event.source_record_id) || !UUID_RE.test(event.owner_id)) {
    return { ok: false, error: 'VALIDATION_ERROR' }
  }
  const expectedEventId = `corenull:messages:${event.source_record_id}:v${event.source_revision}`
  if (event.event_id !== expectedEventId) return { ok: false, error: 'VALIDATION_ERROR' }
  if (!normalizeOccurredAt(event.occurred_at)) return { ok: false, error: 'VALIDATION_ERROR' }
  if (!isPlainObject(event.payload)) return { ok: false, error: 'VALIDATION_ERROR' }
  if (event.house_id != null && !UUID_RE.test(event.house_id)) {
    return { ok: false, error: 'VALIDATION_ERROR' }
  }
  if (event.room_id != null && !UUID_RE.test(event.room_id)) {
    return { ok: false, error: 'VALIDATION_ERROR' }
  }
  if (event.payload.house_id != null && event.house_id != null && event.payload.house_id !== event.house_id) {
    return { ok: false, error: 'VALIDATION_ERROR' }
  }
  if (event.payload.room_id != null && event.room_id != null && event.payload.room_id !== event.room_id) {
    return { ok: false, error: 'VALIDATION_ERROR' }
  }
  if (!SHA256_RE.test(event.payload_sha256)) return { ok: false, error: 'VALIDATION_ERROR' }
  let computedHash
  try {
    computedHash = sha256Payload(event.payload)
  } catch {
    return { ok: false, error: 'VALIDATION_ERROR' }
  }
  if (computedHash !== event.payload_sha256) {
    return { ok: false, error: 'PAYLOAD_HASH_MISMATCH' }
  }
  if (event.payload.message_id !== event.source_record_id) {
    return { ok: false, error: 'VALIDATION_ERROR' }
  }
  return { ok: true, payloadHash: computedHash }
}

export function eventIdentityKey(event) {
  return [event.source, event.source_record_id, event.source_revision, event.event_type].join(':')
}

export function compareImmutableEvents(existing, incoming) {
  const existingTime = normalizeOccurredAt(existing?.occurred_at)
  const incomingTime = normalizeOccurredAt(incoming?.occurred_at)
  const same = existing?.source === incoming?.source
    && existing?.event_type === incoming?.event_type
    && existing?.event_id === incoming?.event_id
    && existing?.source_record_id === incoming?.source_record_id
    && existing?.source_revision === incoming?.source_revision
    && existingTime !== null
    && existingTime === incomingTime
    && existing?.owner_id === incoming?.owner_id
    && (existing?.house_id ?? null) === (incoming?.house_id ?? null)
    && (existing?.room_id ?? null) === (incoming?.room_id ?? null)
    && existing?.payload_sha256 === incoming?.payload_sha256
    && isPlainObject(existing?.payload)
    && isPlainObject(incoming?.payload)
    && canonicalizeJson(existing.payload) === canonicalizeJson(incoming.payload)
  return same ? { same: true, error: null } : { same: false, error: 'EVENT_IDEMPOTENCY_CONFLICT' }
}

export function classifyEventCollision({ existingByEventId, existingByIdentity, incoming }) {
  if (existingByEventId && existingByIdentity
    && existingByEventId.event_id !== existingByIdentity.event_id) {
    return { same: false, error: 'EVENT_IDENTITY_CONFLICT' }
  }
  if (existingByEventId) return compareImmutableEvents(existingByEventId, incoming)
  if (existingByIdentity) {
    return { same: false, error: 'EVENT_IDENTITY_CONFLICT' }
  }
  return { same: false, error: null }
}
