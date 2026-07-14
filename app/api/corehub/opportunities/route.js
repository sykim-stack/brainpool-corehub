// CoreHub - Opportunities API
// GET  → Opportunity 조회
// PATCH → 소비 처리

export const dynamic = 'force-dynamic'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

async function handler(req) {
  const traceId = crypto.randomUUID()

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  const owner_key = url.searchParams.get('owner_key')
  const method = req.method

  const { getSupabase } = await import('@/lib/supabase')
  const supabase = getSupabase()
  if (!supabase) return Response.json({ _error: 'supabase_init_failed', traceId }, { status: 500, headers: CORS_HEADERS })

  if (method === 'GET') {
    if (id) {
      const { data, error } = await supabase
        .schema('corehub')
        .from('opportunities')
        .select('*')
        .eq('id', id)
        .single()
      if (error || !data) return Response.json({ _error: 'opportunity_not_found', traceId }, { status: 500, headers: CORS_HEADERS })
      return Response.json({ data, traceId }, { headers: CORS_HEADERS })
    }

    if (!owner_key) return Response.json({ _error: 'owner_key_required', traceId }, { status: 500, headers: CORS_HEADERS })

    const { data, error } = await supabase
      .schema('corehub')
      .from('opportunities')
      .select('*')
      .eq('target_owner_key', owner_key)
      .eq('is_consumed', false)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })

    if (error) return Response.json({ _error: error.message, traceId }, { status: 500, headers: CORS_HEADERS })
    return Response.json({ data, traceId }, { headers: CORS_HEADERS })
  }

  if (method === 'PATCH') {
    if (!id) return Response.json({ _error: 'id_required', traceId }, { status: 500, headers: CORS_HEADERS })

    const bodyText = await req.text()
    let body
    try { body = JSON.parse(bodyText) }
    catch { return Response.json({ _error: 'invalid_json', traceId }, { status: 500, headers: CORS_HEADERS }) }

    const { outcome, opportunity_id } = body
    const targetId = opportunity_id || id

    const { data, error } = await supabase
      .schema('corehub')
      .from('opportunities')
      .update({ is_consumed: true, consumed_at: new Date().toISOString() })
      .eq('id', targetId)
      .select()
      .single()

    if (error) return Response.json({ _error: error.message, traceId }, { status: 500, headers: CORS_HEADERS })

    if (outcome) {
      await supabase
        .schema('corehub')
        .from('learning_logs')
        .insert({ opportunity_id: targetId, outcome })
    }

    console.log(`[corehub/opportunities] consumed id=${targetId} outcome=${outcome}`)
    return Response.json({ data, traceId }, { headers: CORS_HEADERS })
  }

  return Response.json({ _error: 'method_not_allowed', traceId }, { status: 500, headers: CORS_HEADERS })
}

export { handler as GET, handler as PATCH, handler as OPTIONS }
