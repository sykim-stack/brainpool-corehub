// CoreHub - Opportunities API (P4.3 Bearer scope)
// GET  → Opportunity 조회 (ownerKeys 스코프)
// PATCH → 소비 처리 (동일 스코프)
// SPEC: P4.3 Accepted 2026-11-03 · SHARED-OWNER-001

export const dynamic = 'force-dynamic'

import { resolveOwnerKeysFromBearer } from '@/lib/corehub/resolveOwnerKeysFromBearer'

const SCHEMA = 'corehub'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

const OWNER_FIELD_KEYS = [
  'owner_key',
  'owner_id',
  'target_owner_key',
  'target_owner_id',
  'device_id',
]

function json(body, status, traceId) {
  return Response.json(
    { ...body, traceId },
    { status, headers: CORS_HEADERS },
  )
}

function hasOwnerFieldClaims(url, body) {
  for (const k of OWNER_FIELD_KEYS) {
    if (url.searchParams.has(k)) return true
    if (body && Object.prototype.hasOwnProperty.call(body, k)) return true
  }
  return false
}

function isHmacRequest(req) {
  const auth = req.headers.get('authorization') || ''
  if (/^CoreHub-HMAC\s+/i.test(auth)) return true
  if (req.headers.get('x-corehub-device-id')) return true
  if (req.headers.get('x-corehub-timestamp')) return true
  return false
}

async function getUserFromRequest(req, supabase) {
  const header = req.headers.get('authorization') || ''
  const m = header.match(/^Bearer\s+(.+)$/i)
  if (!m) return { user: null, error: 'auth_required' }
  const token = m[1].trim()
  if (!token) return { user: null, error: 'auth_required' }

  const { data, error } = await supabase.auth.getUser(token)
  if (error || !data?.user) {
    return { user: null, error: 'invalid_token' }
  }
  return { user: data.user, error: null }
}

async function handler(req) {
  const traceId = crypto.randomUUID()

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method !== 'GET' && req.method !== 'PATCH') {
    return json({ error: 'method_not_allowed' }, 405, traceId)
  }

  const url = new URL(req.url)

  let body = null
  if (req.method === 'PATCH') {
    try {
      const text = await req.text()
      body = text ? JSON.parse(text) : {}
    } catch {
      return json({ error: 'invalid_json' }, 400, traceId)
    }
  }

  if (hasOwnerFieldClaims(url, body)) {
    return json({ error: 'owner_fields_not_accepted' }, 400, traceId)
  }

  // L3: HMAC present → do not fall through to Bearer
  if (isHmacRequest(req)) {
    return json({ error: 'hmac_not_implemented' }, 501, traceId)
  }

  const { getSupabase } = await import('@/lib/supabase')
  const supabase = getSupabase()
  if (!supabase) {
    return json({ error: 'supabase_init_failed' }, 500, traceId)
  }

  const userResult = await getUserFromRequest(req, supabase)
  if (!userResult.user) {
    return json({ error: userResult.error || 'auth_required' }, 401, traceId)
  }

  const resolved = await resolveOwnerKeysFromBearer(supabase, userResult.user)
  if (!resolved.ok) {
    if (resolved.error === 'invalid_user') {
      return json({ error: 'auth_required' }, 401, traceId)
    }
    return json({ error: 'principal_mapping_unavailable' }, 503, traceId)
  }

  const { ownerKeys, owner_linked } = resolved
  const meta = { owner_linked, auth: 'bearer' }

  if (req.method === 'GET') {
    return handleGet(supabase, url, ownerKeys, meta, traceId)
  }
  return handlePatch(supabase, url, body || {}, ownerKeys, meta, traceId)
}

async function handleGet(supabase, url, ownerKeys, meta, traceId) {
  const id = url.searchParams.get('id')

  if (!ownerKeys.length) {
    if (id) return json({ error: 'opportunity_not_found' }, 404, traceId)
    return json({ data: [], meta }, 200, traceId)
  }

  if (id) {
    const { data, error } = await supabase
      .schema(SCHEMA)
      .from('opportunities')
      .select('*')
      .eq('id', id)
      .in('target_owner_key', ownerKeys)
      .maybeSingle()

    if (error) return json({ error: error.message || 'query_failed' }, 500, traceId)
    if (!data) return json({ error: 'opportunity_not_found' }, 404, traceId)
    return json({ data, meta }, 200, traceId)
  }

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('opportunities')
    .select('*')
    .in('target_owner_key', ownerKeys)
    .eq('is_consumed', false)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false })

  if (error) return json({ error: error.message || 'query_failed' }, 500, traceId)
  return json({ data: data || [], meta }, 200, traceId)
}

async function handlePatch(supabase, url, body, ownerKeys, meta, traceId) {
  const targetId = body.opportunity_id || url.searchParams.get('id')
  if (!targetId) {
    return json({ error: 'id_required' }, 400, traceId)
  }

  if (!ownerKeys.length) {
    return json({ error: 'opportunity_not_found' }, 404, traceId)
  }

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .schema(SCHEMA)
    .from('opportunities')
    .update({ is_consumed: true, consumed_at: now })
    .eq('id', targetId)
    .in('target_owner_key', ownerKeys)
    .eq('is_consumed', false)
    .select()
    .maybeSingle()

  if (error) return json({ error: error.message || 'query_failed' }, 500, traceId)
  if (!data) return json({ error: 'opportunity_not_found' }, 404, traceId)

  if (body.outcome != null && body.outcome !== '') {
    await supabase.schema(SCHEMA).from('learning_logs').insert({
      opportunity_id: targetId,
      outcome: body.outcome,
    })
  }

  console.log(`[corehub/opportunities] consumed id=${targetId} outcome=${body.outcome || ''}`)
  return json({ data, meta }, 200, traceId)
}

export { handler as GET, handler as PATCH, handler as OPTIONS }
