// CoreHub - Opportunities API
// GET  → Opportunity 조회
// PATCH → 소비 처리

export const dynamic = 'force-dynamic'

async function handler(req) {
  const traceId = crypto.randomUUID()
  const ctx = { req, traceId, _error: null }

  const url = new URL(req.url)
  const id = url.searchParams.get('id')
  const method = req.method

  const { getSupabase } = await import('@/lib/supabase')
  const supabase = getSupabase()
  if (!supabase) return Response.json({ _error: 'supabase_init_failed', traceId }, { status: 500 })

  if (method === 'GET') {
    if (id) {
      const { data, error } = await supabase
        .schema('corehub')
        .from('opportunities')
        .select('*')
        .eq('id', id)
        .single()
      if (error || !data) return Response.json({ _error: 'opportunity_not_found', traceId }, { status: 500 })
      return Response.json({ data, traceId })
    }

    const owner_key = url.searchParams.get('owner_key')
    if (!owner_key) return Response.json({ _error: 'owner_key_required', traceId }, { status: 500 })

    const { data, error } = await supabase
      .schema('corehub')
      .from('opportunities')
      .select('*')
      .eq('target_owner_key', owner_key)
      .eq('is_consumed', false)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false })

    if (error) return Response.json({ _error: error.message, traceId }, { status: 500 })
    return Response.json({ data, traceId })
  }

  if (method === 'PATCH') {
    if (!id) return Response.json({ _error: 'id_required', traceId }, { status: 500 })

    const bodyText = await req.text()
    let body
    try { body = JSON.parse(bodyText) }
    catch { return Response.json({ _error: 'invalid_json', traceId }, { status: 500 }) }

    const { outcome, learning_log } = body

    const { data, error } = await supabase
      .schema('corehub')
      .from('opportunities')
      .update({ is_consumed: true, consumed_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single()

    if (error) return Response.json({ _error: error.message, traceId }, { status: 500 })

    if (learning_log || outcome) {
      await supabase
        .schema('corehub')
        .from('learning_logs')
        .insert({ opportunity_id: id, outcome: outcome || null })
    }

    console.log(`[corehub/opportunities] consumed id=${id} outcome=${outcome}`)
    return Response.json({ data, traceId })
  }

  return Response.json({ _error: 'method_not_allowed', traceId }, { status: 500 })
}

export { handler as GET, handler as PATCH }
