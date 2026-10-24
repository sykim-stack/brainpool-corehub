import { authenticateUser } from '@/lib/corehub/auth.mjs'
import { isHmacRequest, verifyHmacRequest } from '@/lib/corehub/hmac.mjs'
import { ownedHouseQuery } from '@/lib/corehub/houseOwnership.mjs'

export const dynamic = 'force-dynamic'

const SCHEMA = 'corehub'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SOURCE_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const FACT_TYPE_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{8,200}$/
const HASH_RE = /^[A-Fa-f0-9]{64}$/
const MAX_BODY_BYTES = 64 * 1024
const WORKER_IDENTITY_FIELDS = ['owner_id', 'owner_key', 'auth_user_id', 'device_id']
const HMAC_SECRET_ENV_BY_KEY_VERSION = Object.freeze({
  'corehub-r5-staging-v1': 'COREHUB_HMAC_SECRET_COREHUB_R5_STAGING_V1',
})

function jsonError(error, traceId, status) {
  return Response.json({ error, traceId }, { status })
}

function hasWorkerIdentityFields(body) {
  return WORKER_IDENTITY_FIELDS.some((field) => Object.hasOwn(body, field))
}

function resolveHmacSecret(keyVersion) {
  const envName = HMAC_SECRET_ENV_BY_KEY_VERSION[keyVersion]
  return envName ? process.env[envName] ?? null : null
}

async function lookupHmacDevice(supabase, deviceId) {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('device_registry')
    .select('device_id,source_core,key_version,enabled')
    .eq('device_id', deviceId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null
  return { ...data, secret: resolveHmacSecret(data.key_version) }
}

async function claimHmacNonce(supabase, claim) {
  const { data, error } = await supabase
    .schema(SCHEMA)
    .rpc('claim_device_nonce', {
      p_device_id: claim.deviceId,
      p_nonce: claim.nonce,
      p_expires_at: claim.expiresAt,
    })

  if (error) throw error
  return data === true
}

async function getSupabase(traceId) {
  const { getSupabase: createSupabase } = await import('@/lib/supabase')
  const supabase = createSupabase()
  return supabase ?? { response: jsonError('server_configuration_error', traceId, 503) }
}

async function getUserContext(req, traceId, supabase) {
  const auth = await authenticateUser(req, supabase)
  if (!auth.ok) return { response: jsonError(auth.error, traceId, auth.status) }
  return { supabase, subjectType: 'user', userId: auth.userId }
}

async function getPostContext(req, traceId, supabase, rawBody) {
  if (!isHmacRequest(req)) return getUserContext(req, traceId, supabase)

  const auth = await verifyHmacRequest(req, rawBody, {
    lookupDevice: (deviceId) => lookupHmacDevice(supabase, deviceId),
    claimNonce: (claim) => claimHmacNonce(supabase, claim),
  })
  if (!auth.ok) return { response: jsonError(auth.error, traceId, auth.status) }

  return {
    supabase,
    subjectType: 'device',
    deviceId: auth.deviceId,
    sourceCore: auth.sourceCore,
  }
}

async function handler(req) {
  const traceId = crypto.randomUUID()
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonError('method_not_allowed', traceId, 405)
  }

  try {
    const supabase = await getSupabase(traceId)
    if (supabase.response) return supabase.response

    if (req.method === 'GET') {
      const context = await getUserContext(req, traceId, supabase)
      if (context.response) return context.response
      return handleGet(req, traceId, context)
    }

    const rawBody = await req.text()
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return jsonError('request_body_too_large', traceId, 413)
    }

    const context = await getPostContext(req, traceId, supabase, rawBody)
    if (context.response) return context.response
    return handlePost(req, traceId, context, rawBody)
  } catch (error) {
    console.error('[corehub/facts] request failed', traceId, error?.message ?? 'unknown')
    return jsonError('internal_error', traceId, 500)
  }
}

async function handleGet(req, traceId, { supabase, userId }) {
  const url = new URL(req.url)
  const rawLimit = url.searchParams.get('limit') ?? '20'
  const limit = Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return jsonError('invalid_limit', traceId, 400)
  }

  const source = url.searchParams.get('source')
  if (source && !SOURCE_RE.test(source)) return jsonError('invalid_source', traceId, 400)

  const houseId = url.searchParams.get('house_id')
  if (houseId && !UUID_RE.test(houseId)) return jsonError('invalid_house_id', traceId, 400)

  let query = supabase
    .schema(SCHEMA)
    .from('facts')
    .select('id,source,fact_type,owner_id,house_id,occurred_at,payload,processed')
    .eq('owner_id', userId)
    .order('occurred_at', { ascending: false })
    .limit(limit)

  if (source) query = query.eq('source', source)
  if (houseId) query = query.eq('house_id', houseId)

  const { data, error } = await query
  if (error) {
    console.error('[corehub/facts] read failed', traceId, error.code)
    return jsonError('fact_read_failed', traceId, 500)
  }
  return Response.json({ data: data ?? [], traceId })
}

function parseJsonObject(rawBody, traceId) {
  let body
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { response: jsonError('invalid_json', traceId, 400) }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { response: jsonError('invalid_request_body', traceId, 400) }
  }
  return { body }
}

async function handlePost(req, traceId, context, rawBody) {
  const idempotencyKey = req.headers.get('idempotency-key')
  if (!idempotencyKey || !IDEMPOTENCY_RE.test(idempotencyKey)) {
    return jsonError('valid_idempotency_key_required', traceId, 400)
  }

  const parsed = parseJsonObject(rawBody, traceId)
  if (parsed.response) return parsed.response
  const { body } = parsed

  if (context.subjectType === 'device') {
    return handleWorkerPost(req, traceId, context, body, idempotencyKey)
  }
  return handleUserPost(traceId, context, body, idempotencyKey)
}

async function handleUserPost(traceId, { supabase, userId }, body, idempotencyKey) {
  // Ownership is derived only from the verified Supabase access token.
  if (Object.hasOwn(body, 'owner_id') || Object.hasOwn(body, 'owner_key')) {
    return jsonError('owner_fields_not_accepted', traceId, 400)
  }

  const source = typeof body.source === 'string' ? body.source.trim() : ''
  const factType = typeof body.fact_type === 'string' ? body.fact_type.trim() : ''
  const houseId = body.house_id ?? null
  const occurredAt = typeof body.occurred_at === 'string' ? new Date(body.occurred_at) : null
  const payload = body.payload ?? {}

  if (!SOURCE_RE.test(source) || !FACT_TYPE_RE.test(factType)) {
    return jsonError('source_and_fact_type_required', traceId, 400)
  }
  if (!occurredAt || !Number.isFinite(occurredAt.getTime())) {
    return jsonError('valid_occurred_at_required', traceId, 400)
  }
  if (houseId !== null && (typeof houseId !== 'string' || !UUID_RE.test(houseId))) {
    return jsonError('invalid_house_id', traceId, 400)
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonError('payload_must_be_an_object', traceId, 400)
  }

  if (houseId) {
    const { data: house, error: houseError } = await ownedHouseQuery(supabase, houseId, userId)
    if (houseError) {
      console.error('[corehub/facts] house ownership check failed', traceId, houseError.code)
      return jsonError('ownership_check_failed', traceId, 500)
    }
    if (!house) return jsonError('house_not_owned_by_user', traceId, 403)
  }

  const { data, error } = await supabase
    .schema(SCHEMA)
    .rpc('process_fact_event', {
      p_owner_id: userId,
      p_source: source,
      p_fact_type: factType,
      p_idempotency_key: idempotencyKey,
      p_house_id: houseId,
      p_occurred_at: occurredAt.toISOString(),
      p_payload: payload,
    })

  if (error) {
    if (error.code === '22023' && error.message?.includes('idempotency_key_reused')) {
      return jsonError('idempotency_key_reused_with_different_event', traceId, 409)
    }
    console.error('[corehub/facts] atomic processing failed', traceId, error.code)
    return jsonError('fact_processing_failed_retry_with_same_key', traceId, 503)
  }

  return Response.json({ data, traceId }, { status: data?.duplicate ? 200 : 201 })
}

async function handleWorkerPost(req, traceId, { supabase, deviceId, sourceCore }, body, idempotencyKey) {
  if (hasWorkerIdentityFields(body)) {
    return jsonError('worker_identity_fields_not_accepted', traceId, 400)
  }
  if (Object.hasOwn(body, 'house_id')) {
    return jsonError('worker_house_id_not_accepted', traceId, 400)
  }

  const source = typeof body.source === 'string' ? body.source.trim() : ''
  const eventType = typeof body.event_type === 'string' ? body.event_type.trim() : ''
  const eventId = typeof body.event_id === 'string' ? body.event_id.trim() : ''
  const sourceRecordId = typeof body.source_record_id === 'string'
    ? body.source_record_id.trim()
    : ''
  const sourceRevision = body.source_revision
  const occurredAt = typeof body.occurred_at === 'string' ? new Date(body.occurred_at) : null
  const payload = body.payload
  const payloadSha256 = typeof body.payload_sha256 === 'string'
    ? body.payload_sha256.trim()
    : ''

  if (source !== sourceCore || !SOURCE_RE.test(source)) {
    return jsonError('worker_source_not_allowed', traceId, 403)
  }
  if (!FACT_TYPE_RE.test(eventType) || !eventId || eventId !== idempotencyKey) {
    return jsonError('valid_event_id_and_idempotency_key_required', traceId, 400)
  }
  if (!sourceRecordId || sourceRecordId.length > 200) {
    return jsonError('valid_source_record_id_required', traceId, 400)
  }
  if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1) {
    return jsonError('valid_source_revision_required', traceId, 400)
  }
  if (!occurredAt || !Number.isFinite(occurredAt.getTime())) {
    return jsonError('valid_occurred_at_required', traceId, 400)
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonError('payload_must_be_an_object', traceId, 400)
  }
  if (!HASH_RE.test(payloadSha256)) {
    return jsonError('valid_payload_sha256_required', traceId, 400)
  }

  const { data, error } = await supabase
    .schema(SCHEMA)
    .rpc('process_device_fact_event', {
      p_device_id: deviceId,
      p_source: source,
      p_event_type: eventType,
      p_event_id: eventId,
      p_source_record_id: sourceRecordId,
      p_source_revision: sourceRevision,
      p_occurred_at: occurredAt.toISOString(),
      p_payload: payload,
      p_payload_sha256: payloadSha256,
    })

  if (error) {
    if (error.code === '42501') return jsonError('worker_device_scope_denied', traceId, 403)
    if (error.code === '22023' && /reused|conflict/i.test(error.message ?? '')) {
      return jsonError('worker_event_conflict', traceId, 409)
    }
    if (error.code === '40001') {
      return jsonError('worker_event_processing_retry', traceId, 503)
    }
    console.error('[corehub/facts] device event processing failed', traceId, error.code)
    return jsonError('worker_event_processing_failed_retry', traceId, 503)
  }

  return Response.json({ data, traceId }, { status: data?.duplicate ? 200 : 201 })
}

export { handler as GET, handler as POST }
