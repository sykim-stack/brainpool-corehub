import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalizeJson,
  sha256Payload,
  normalizeOccurredAt,
  validateMessageEventEnvelope,
  eventIdentityKey,
  compareImmutableEvents,
  classifyEventCollision,
} from '../lib/corehub/messageEvent.mjs'

const sourceRecordId = '550e8400-e29b-41d4-a716-446655440000'
const ownerId = '123e4567-e89b-42d3-a456-426614174000'
const payload = {
  message_id: sourceRecordId,
  content: '원본 Message fixture',
  meta: {},
  relations: {},
  language: 'ko',
  translated_ko: null,
}
const event = (overrides = {}) => {
  const body = { ...payload, ...(overrides.payload ?? {}) }
  const base = {
    source: 'CoreNull',
    event_type: 'space.message.created',
    event_id: `corenull:messages:${sourceRecordId}:v1`,
    source_record_id: sourceRecordId,
    source_revision: 1,
    occurred_at: '2026-10-20T00:00:00.000Z',
    owner_id: ownerId,
    payload: body,
    payload_sha256: sha256Payload(body),
  }
  return { ...base, ...overrides, payload: overrides.payload ?? body }
}

test('canonical JSON sorts object keys recursively but preserves array order', () => {
  assert.equal(canonicalizeJson({ z: 1, a: { y: true, b: 2 }, list: [3, 2] }),
    '{"a":{"b":2,"y":true},"list":[3,2],"z":1}')
})

test('canonical JSON serializes strings, null, booleans and finite numbers', () => {
  assert.equal(canonicalizeJson({ n: null, f: false, t: true, s: 'é', x: 1.25 }),
    '{"f":false,"n":null,"s":"é","t":true,"x":1.25}')
})

test('canonical JSON rejects undefined values', () => {
  assert.throws(() => canonicalizeJson({ value: undefined }), /undefined_json_value/)
  assert.throws(() => canonicalizeJson([undefined]), /undefined_json_value/)
})

test('canonical JSON rejects non-finite numbers', () => {
  assert.throws(() => canonicalizeJson({ value: Number.NaN }), /non_finite_number/)
  assert.throws(() => canonicalizeJson({ value: Number.POSITIVE_INFINITY }), /non_finite_number/)
})

test('canonical JSON rejects unsupported JavaScript values', () => {
  assert.throws(() => canonicalizeJson(new Date()), /unsupported_json_value/)
  assert.throws(() => canonicalizeJson(1n), /unsupported_json_value/)
})

test('payload hash is stable when object key order changes', () => {
  assert.equal(sha256Payload({ a: 1, b: { c: 2, d: 3 } }),
    sha256Payload({ b: { d: 3, c: 2 }, a: 1 }))
})

test('payload hash changes when payload content changes', () => {
  assert.notEqual(sha256Payload({ content: 'original' }), sha256Payload({ content: 'edited' }))
})

test('payload hash requires a plain object', () => {
  assert.throws(() => sha256Payload(null), /payload_must_be_object/)
  assert.throws(() => sha256Payload([]), /payload_must_be_object/)
})

test('valid event envelope passes validation with recomputed hash', () => {
  assert.deepEqual(validateMessageEventEnvelope(event()), {
    ok: true,
    payloadHash: sha256Payload(payload),
  })
})

test('missing required field fails validation', () => {
  const invalid = event()
  delete invalid.owner_id
  assert.deepEqual(validateMessageEventEnvelope(invalid), { ok: false, error: 'VALIDATION_ERROR' })
})

test('non-object envelope fails validation', () => {
  assert.deepEqual(validateMessageEventEnvelope(null), { ok: false, error: 'VALIDATION_ERROR' })
  assert.deepEqual(validateMessageEventEnvelope([]), { ok: false, error: 'VALIDATION_ERROR' })
})

test('non-CoreNull source is rejected before hash/idempotency checks', () => {
  assert.deepEqual(validateMessageEventEnvelope(event({ source: 'OtherCore' })),
    { ok: false, error: 'FORBIDDEN_SOURCE' })
})

test('unsupported event type fails validation', () => {
  assert.deepEqual(validateMessageEventEnvelope(event({ event_type: 'space.message.updated' })),
    { ok: false, error: 'VALIDATION_ERROR' })
})

test('created event revision must be exactly one', () => {
  assert.deepEqual(validateMessageEventEnvelope(event({ source_revision: 2 })),
    { ok: false, error: 'REVISION_UNEXPECTED' })
  assert.deepEqual(validateMessageEventEnvelope(event({ source_revision: 0 })),
    { ok: false, error: 'REVISION_UNEXPECTED' })
})

test('event ID must be deterministic from source record ID and revision', () => {
  assert.deepEqual(validateMessageEventEnvelope(event({ event_id: 'random-event-id' })),
    { ok: false, error: 'VALIDATION_ERROR' })
})

test('invalid owner and source record UUIDs fail validation', () => {
  assert.deepEqual(validateMessageEventEnvelope(event({ owner_id: 'owner-a' })),
    { ok: false, error: 'VALIDATION_ERROR' })
  assert.deepEqual(validateMessageEventEnvelope(event({ source_record_id: 'message-a' })),
    { ok: false, error: 'VALIDATION_ERROR' })
})

test('invalid occurrence time fails validation', () => {
  assert.deepEqual(validateMessageEventEnvelope(event({ occurred_at: 'not-a-date' })),
    { ok: false, error: 'VALIDATION_ERROR' })
})

test('mismatched payload hash returns the designated 422 error', () => {
  assert.deepEqual(validateMessageEventEnvelope(event({ payload_sha256: '0'.repeat(64) })),
    { ok: false, error: 'PAYLOAD_HASH_MISMATCH' })
})

test('payload must identify the same source Message', () => {
  const body = { ...payload, message_id: 'different-message' }
  assert.deepEqual(validateMessageEventEnvelope(event({ payload: body })),
    { ok: false, error: 'VALIDATION_ERROR' })
})

test('house and room identifiers must match the envelope when both are supplied', () => {
  const houseId = '323e4567-e89b-42d3-a456-426614174000'
  const roomId = '423e4567-e89b-42d3-a456-426614174000'
  const body = { ...payload, house_id: houseId, room_id: roomId }
  const valid = event({ house_id: houseId, room_id: roomId, payload: body })
  assert.equal(validateMessageEventEnvelope(valid).ok, true)
  assert.deepEqual(validateMessageEventEnvelope(event({
    house_id: '523e4567-e89b-42d3-a456-426614174000', payload: body,
  })), { ok: false, error: 'VALIDATION_ERROR' })
})

test('occurred_at normalization makes equivalent timezone instants equal', () => {
  assert.equal(normalizeOccurredAt('2026-10-20T01:00:00+01:00'), '2026-10-20T00:00:00.000Z')
  assert.equal(normalizeOccurredAt('invalid'), null)
})

test('event identity key is stable across retries', () => {
  assert.equal(eventIdentityKey(event()), eventIdentityKey(event()))
})

test('exact duplicate compares all immutable fields and canonical payload', () => {
  const original = event()
  const reordered = event({ payload: {
    language: 'ko',
    relations: {},
    meta: {},
    translated_ko: null,
    content: '원본 Message fixture',
    message_id: sourceRecordId,
  } })
  assert.deepEqual(compareImmutableEvents(original, reordered), { same: true, error: null })
})

test('same event ID with changed owner is an idempotency conflict', () => {
  assert.deepEqual(compareImmutableEvents(event(), event({ owner_id: '223e4567-e89b-42d3-a456-426614174000' })),
    { same: false, error: 'EVENT_IDEMPOTENCY_CONFLICT' })
})

test('same event ID with changed occurred_at is an idempotency conflict', () => {
  assert.deepEqual(compareImmutableEvents(event(), event({ occurred_at: '2026-10-20T01:00:00.000Z' })),
    { same: false, error: 'EVENT_IDEMPOTENCY_CONFLICT' })
})

test('same event ID with changed source or event type is an idempotency conflict', () => {
  assert.equal(compareImmutableEvents(event(), event({ source: 'OtherCore' })).error,
    'EVENT_IDEMPOTENCY_CONFLICT')
  assert.equal(compareImmutableEvents(event(), event({ event_type: 'space.message.updated' })).error,
    'EVENT_IDEMPOTENCY_CONFLICT')
})

test('same event ID with changed payload and matching new hash is an idempotency conflict', () => {
  const body = { ...payload, content: 'edited' }
  assert.equal(compareImmutableEvents(event(), event({ payload: body })).error,
    'EVENT_IDEMPOTENCY_CONFLICT')
})

test('secondary identity collision is not treated as a duplicate', () => {
  assert.deepEqual(classifyEventCollision({
    existingByEventId: null,
    existingByIdentity: event(),
    incoming: event({ event_id: 'different-event-id' }),
  }), { same: false, error: 'EVENT_IDENTITY_CONFLICT' })
})

test('an event with no existing collision is eligible for insert', () => {
  assert.deepEqual(classifyEventCollision({
    existingByEventId: null,
    existingByIdentity: null,
    incoming: event(),
  }), { same: false, error: null })
})
