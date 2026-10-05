import { authenticateUser } from '@/lib/corehub/auth.mjs'

export const dynamic = 'force-dynamic'

const SCHEMA = 'corehub'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SOURCE_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const FACT_TYPE_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/
const IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{8,200}$/
const MAX_BODY_BYTES = 64 * 1024

function jsonError(error, traceId, status) {
  return Response.json({ error, traceId }, { status })
}

async function getRequestContext(req, traceId) {
  const { getSupabase } = await import('@/lib/supabase')
  const supabase = getSupabase()
  if (!supabase) return { response: jsonError('server_configuration_error', traceId, 503) }

  const auth = await authenticateUser(req, supabase)
  if (!auth.ok) return { response: jsonError(auth.error, traceId, auth.status) }
  return { supabase, userId: auth.userId }
}

async function handler(req) {
  const traceId = crypto.randomUUID()
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonError('method_not_allowed', traceId, 405)
  }

  try {
    const context = await getRequestContext(req, traceId)
    if (context.response) return context.response
    if (req.method === 'GET') return handleGet(req, traceId, context)
    return handlePost(req, traceId, context)
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

async function handlePost(req, traceId, { supabase, userId }) {
  const idempotencyKey = req.headers.get('idempotency-key')
  if (!idempotencyKey || !IDEMPOTENCY_RE.test(idempotencyKey)) {
    return jsonError('valid_idempotency_key_required', traceId, 400)
  }

  const rawBody = await req.text()
  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return jsonError('request_body_too_large', traceId, 413)
  }

  let body
  try {
    body = JSON.parse(rawBody)
  } catch {
    return jsonError('invalid_json', traceId, 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError('invalid_request_body', traceId, 400)
  }

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
    const { data: house, error: houseError } = await supabase
      .schema('corenull')
      .from('houses')
      .select('id')
      .eq('id', houseId)
      .eq('owner_id', userId)
      .maybeSingle()
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

export { handler as GET, handler as POST }
