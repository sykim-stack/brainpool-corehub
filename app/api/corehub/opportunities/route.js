import { authenticateUser } from '@/lib/corehub/auth.mjs'

export const dynamic = 'force-dynamic'

const SCHEMA = 'corehub'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OUTCOMES = new Set(['shown', 'clicked', 'ignored', 'converted'])

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
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    return jsonError('method_not_allowed', traceId, 405)
  }

  try {
    const context = await getRequestContext(req, traceId)
    if (context.response) return context.response
    if (req.method === 'GET') return handleGet(req, traceId, context)
    return handlePatch(req, traceId, context)
  } catch (error) {
    console.error('[corehub/opportunities] request failed', traceId, error?.message ?? 'unknown')
    return jsonError('internal_error', traceId, 500)
  }
}

async function handleGet(req, traceId, { supabase, userId }) {
  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  if (id && !UUID_RE.test(id)) return jsonError('invalid_opportunity_id', traceId, 400)

  if (id) {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from('opportunities')
      .select('id,opportunity_type,source_meaning_id,target_owner_id,priority,action_type,payload,is_consumed,consumed_at,expires_at,created_at')
      .eq('id', id)
      .eq('target_owner_id', userId)
      .maybeSingle()
    if (error) {
      console.error('[corehub/opportunities] read failed', traceId, error.code)
      return jsonError('opportunity_read_failed', traceId, 500)
    }
    if (!data) return jsonError('opportunity_not_found', traceId, 404)
    return Response.json({ data, traceId })
  }

  const rawLimit = url.searchParams.get('limit') ?? '20'
  const limit = Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    return jsonError('invalid_limit', traceId, 400)
  }

  let query = supabase
    .schema(SCHEMA)
    .from('opportunities')
    .select('id,opportunity_type,source_meaning_id,target_owner_id,priority,action_type,payload,is_consumed,consumed_at,expires_at,created_at')
    .eq('target_owner_id', userId)
    .eq('is_consumed', false)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order('created_at', { ascending: false })
    .limit(limit)

  const { data, error } = await query
  if (error) {
    console.error('[corehub/opportunities] list failed', traceId, error.code)
    return jsonError('opportunity_read_failed', traceId, 500)
  }
  return Response.json({ data: data ?? [], traceId })
}

async function handlePatch(req, traceId, { supabase, userId }) {
  let body
  try {
    body = await req.json()
  } catch {
    return jsonError('invalid_json', traceId, 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return jsonError('invalid_request_body', traceId, 400)
  }

  const url = new URL(req.url)
  const queryId = url.searchParams.get('id')
  const bodyId = body.opportunity_id
  if (queryId && bodyId && queryId !== bodyId) {
    return jsonError('opportunity_id_mismatch', traceId, 400)
  }
  const id = bodyId || queryId
  if (typeof id !== 'string' || !UUID_RE.test(id)) {
    return jsonError('valid_opportunity_id_required', traceId, 400)
  }
  if (Object.hasOwn(body, 'owner_id') || Object.hasOwn(body, 'owner_key') || Object.hasOwn(body, 'target_owner_id')) {
    return jsonError('owner_fields_not_accepted', traceId, 400)
  }
  if (body.outcome !== undefined && !OUTCOMES.has(body.outcome)) {
    return jsonError('invalid_outcome', traceId, 400)
  }

  const now = new Date().toISOString()
  const { data: updated, error: updateError } = await supabase
    .schema(SCHEMA)
    .from('opportunities')
    .update({ is_consumed: true, consumed_at: now })
    .eq('id', id)
    .eq('target_owner_id', userId)
    .eq('is_consumed', false)
    .select('id,opportunity_type,source_meaning_id,target_owner_id,priority,action_type,payload,is_consumed,consumed_at,expires_at,created_at')
    .maybeSingle()

  if (updateError) {
    console.error('[corehub/opportunities] consume failed', traceId, updateError.code)
    return jsonError('opportunity_consume_failed', traceId, 500)
  }

  let data = updated
  if (!data) {
    // Idempotent replay: return the existing owned row without changing consumed_at.
    const { data: existing, error: readError } = await supabase
      .schema(SCHEMA)
      .from('opportunities')
      .select('id,opportunity_type,source_meaning_id,target_owner_id,priority,action_type,payload,is_consumed,consumed_at,expires_at,created_at')
      .eq('id', id)
      .eq('target_owner_id', userId)
      .maybeSingle()
    if (readError) {
      console.error('[corehub/opportunities] replay read failed', traceId, readError.code)
      return jsonError('opportunity_read_failed', traceId, 500)
    }
    if (!existing) return jsonError('opportunity_not_found', traceId, 404)
    data = existing
  }

  if (body.outcome !== undefined) {
    const { error: logError } = await supabase
      .schema(SCHEMA)
      .from('learning_logs')
      .insert({ opportunity_id: id, owner_id: userId, outcome: body.outcome })

    // A repeated identical outcome is an idempotent replay, not a new event.
    if (logError && logError.code !== '23505') {
      console.error('[corehub/opportunities] learning log failed', traceId, logError.code)
      return jsonError('learning_log_failed_retry_request', traceId, 503)
    }
  }

  return Response.json({ data, traceId })
}

export { handler as GET, handler as PATCH }
