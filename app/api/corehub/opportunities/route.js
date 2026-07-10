// CoreHub - Opportunities API
// CoreNull이 View 생성 시 Opportunity 조회
// GET  → 미소비 Opportunity 조회
// PATCH → 소비 처리 (CoreNull이 View에 반영 후 호출)

export const dynamic = 'force-dynamic'

const handler = async (req) => {
  const traceId = crypto.randomUUID()

  if (req.method === 'GET')   return handleGet(req, traceId)
  if (req.method === 'PATCH') return handlePatch(req, traceId)

  return Response.json({ _error: 'method_not_allowed', traceId }, { status: 500 })
}

const handleGet = async (req, traceId) => {
  const { searchParams } = new URL(req.url)
  const owner_key = searchParams.get('owner_key')
  const house_id = searchParams.get('house_id')
  const consumed = searchParams.get('consumed') !== 'true'  // 기본: 미소비만

  if (!owner_key) {
    return Response.json({ _error: 'owner_key_required', traceId }, { status: 500 })
  }

  const { getSupabase } = await import('@/lib/supabase')
  const supabase = getSupabase()
  if (!supabase) return Response.json({ _error: 'supabase_init_failed', traceId }, { status: 500 })

  let query = supabase
    .from('opportunities')
    .select('*')
    .eq('target_owner_key', owner_key)
    .eq('is_consumed', false)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false })

  if (house_id) query = query.eq('house_id', house_id)

  const { data, error } = await query
  if (error) return Response.json({ _error: error.message, traceId }, { status: 500 })

  return Response.json({ data, traceId })
}

const handlePatch = async (req, traceId) => {
  const body = JSON.parse(await req.text())
  const { opportunity_id, outcome } = body

  if (!opportunity_id) {
    return Response.json({ _error: 'opportunity_id_required', traceId }, { status: 500 })
  }

  const { getSupabase } = await import('@/lib/supabase')
  const supabase = getSupabase()
  if (!supabase) return Response.json({ _error: 'supabase_init_failed', traceId }, { status: 500 })

  // 소비 처리
  const { data, error } = await supabase
    .from('opportunities')
    .update({
      is_consumed: true,
      consumed_at: new Date().toISOString(),
    })
    .eq('id', opportunity_id)
    .select()
    .single()

  if (error) return Response.json({ _error: error.message, traceId }, { status: 500 })

  // 학습 로그 기록 (outcome 있을 경우)
  if (outcome) {
    await supabase
      .from('learning_logs')
      .insert({ opportunity_id, outcome })
  }

  console.log(`[corehub/opportunities] consumed id=${opportunity_id} outcome=${outcome}`)

  return Response.json({ data, traceId })
}

export { handler as GET, handler as PATCH }