// CoreHub - Facts API
// Core들이 Fact를 전달하는 수집 엔드포인트
// POST → Fact 저장 + Connection 탐지 트리거
// GET  → Fact 조회

export const dynamic = 'force-dynamic'

const SCHEMA = 'corehub'

const handler = async (req) => {
  const traceId = crypto.randomUUID()
  if (req.method === 'POST') return handlePost(req, traceId)
  if (req.method === 'GET') return handleGet(req, traceId)
  return Response.json({ _error: 'method_not_allowed', traceId }, { status: 500 })
}

const resolveIdempotencyKey = (req, body) => {
  const header = (req.headers.get('idempotency-key') || '').trim()
  if (header) return header
  if (body.idempotency_key) return String(body.idempotency_key)
  const p = body.payload || {}
  if (p.idempotency_key) return String(p.idempotency_key)
  if (p.message_id) return `corenull:messages:${p.message_id}:v1`
  return null
}

const handlePost = async (req, traceId) => {
  const body = JSON.parse(await req.text())
  const { source, fact_type, owner_key, house_id, occurred_at, payload } = body

  if (!source || !fact_type || !owner_key) {
    return Response.json({ _error: 'source_fact_type_owner_key_required', traceId }, { status: 500 })
  }

  const { getSupabase } = await import('@/lib/supabase')
  const supabase = getSupabase()
  if (!supabase) return Response.json({ _error: 'supabase_init_failed', traceId }, { status: 500 })

  const idempotencyKey = resolveIdempotencyKey(req, body)
  const nextPayload = {
    ...(payload || {}),
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  }

  // 동일 키로 이미 저장된 Fact면 insert 생략 (재전송/이중 flush 대비)
  if (idempotencyKey) {
    const { data: existing, error: lookupError } = await supabase
      .schema(SCHEMA)
      .from('facts')
      .select('id')
      .eq('source', source)
      .eq('fact_type', fact_type)
      .eq('owner_key', owner_key)
      .contains('payload', { idempotency_key: idempotencyKey })
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!lookupError && existing?.id) {
      console.log(
        `[corehub/facts] idempotent hit source=${source} type=${fact_type} fact=${existing.id}`
      )
      return Response.json({
        data: { fact_id: existing.id, idempotent: true },
        traceId,
      })
    }
  }

  const { data: fact, error } = await supabase
    .schema(SCHEMA)
    .from('facts')
    .insert({
      source,
      fact_type,
      owner_key,
      house_id: house_id || null,
      occurred_at: occurred_at || new Date().toISOString(),
      payload: nextPayload,
      processed: false,
    })
    .select()
    .single()

  if (error) return Response.json({ _error: error.message, traceId }, { status: 500 })

  console.log(`[corehub/facts] saved source=${source} type=${fact_type} owner=${owner_key}`)

  detectConnections(supabase, fact).catch((e) =>
    console.error('[corehub/facts] connection detect failed:', e)
  )

  return Response.json({ data: { fact_id: fact.id, idempotent: false }, traceId })
}

const handleGet = async (req, traceId) => {
  const { searchParams } = new URL(req.url)
  const owner_key = searchParams.get('owner_key')
  const source = searchParams.get('source')
  const limit = parseInt(searchParams.get('limit') || '20')

  const { getSupabase } = await import('@/lib/supabase')
  const supabase = getSupabase()
  if (!supabase) return Response.json({ _error: 'supabase_init_failed', traceId }, { status: 500 })

  let query = supabase
    .schema(SCHEMA)
    .from('facts')
    .select('*')
    .order('occurred_at', { ascending: false })
    .limit(limit)

  if (owner_key) query = query.eq('owner_key', owner_key)
  if (source) query = query.eq('source', source)

  const { data, error } = await query
  if (error) return Response.json({ _error: error.message, traceId }, { status: 500 })

  return Response.json({ data, traceId })
}

const detectConnections = async (supabase, newFact) => {
  const { data: recentFacts } = await supabase
    .schema(SCHEMA)
    .from('facts')
    .select('*')
    .eq('owner_key', newFact.owner_key)
    .order('occurred_at', { ascending: false })
    .limit(20)

  if (!recentFacts || recentFacts.length < 2) return

  const factTypes = recentFacts.map((f) => f.fact_type)

  const rules = [
    {
      connection_type: 'seed.abandonment.risk',
      match: () =>
        factTypes.includes('space.seed.created') &&
        !factTypes.includes('space.fruit.created') &&
        !factTypes.includes('space.fruit.harvested'),
    },
    {
      connection_type: 'cross.language.relationship',
      match: () =>
        factTypes.includes('relation.chat.sent') &&
        (factTypes.includes('space.message.created') || factTypes.includes('space.fruit.created')),
    },
    {
      connection_type: 'seed.to.fruit.achieved',
      match: () =>
        factTypes.includes('space.seed.created') && factTypes.includes('space.fruit.created'),
    },
  ]

  for (const rule of rules) {
    if (!rule.match()) continue

    const related = recentFacts.filter(
      (f) =>
        f.fact_type.includes('seed') ||
        f.fact_type.includes('fruit') ||
        f.fact_type.includes('chat') ||
        f.fact_type.includes('message') ||
        factTypes.includes(f.fact_type)
    )

    const { data: connection } = await supabase
      .schema(SCHEMA)
      .from('connections')
      .insert({
        connection_type: rule.connection_type,
        fact_ids: related.slice(0, 5).map((f) => f.id),
        owner_key: newFact.owner_key,
        house_id: newFact.house_id || null,
      })
      .select()
      .single()

    if (connection) {
      console.log(`[corehub/connection] type=${rule.connection_type}`)
      await generateMeaning(supabase, connection, related.slice(0, 5))
    }
  }
}

const generateMeaning = async (supabase, connection, facts) => {
  const meaningMap = {
    'seed.abandonment.risk': { meaning_type: 'seed.at.risk', confidence: 0.72 },
    'cross.language.relationship': { meaning_type: 'new.relationship.forming', confidence: 0.80 },
    'seed.to.fruit.achieved': { meaning_type: 'goal.achieved', confidence: 0.95 },
  }

  const meaning = meaningMap[connection.connection_type]
  if (!meaning) return

  const { data: meaningData } = await supabase
    .schema(SCHEMA)
    .from('meanings')
    .insert({
      meaning_type: meaning.meaning_type,
      confidence: meaning.confidence,
      source_fact_ids: facts.map((f) => f.id),
      connection_ids: [connection.id],
      owner_key: connection.owner_key,
      house_id: connection.house_id,
    })
    .select()
    .single()

  if (meaningData) {
    console.log(
      `[corehub/meaning] generated type=${meaning.meaning_type} confidence=${meaning.confidence}`
    )
    await generateOpportunity(supabase, meaningData)
  }
}

const generateOpportunity = async (supabase, meaning) => {
  const opportunityMap = {
    'seed.at.risk': {
      opportunity_type: 'nudge.seed.owner',
      action_type: 'trigger.hajunai.nudge',
      priority: 'high',
      payload: { message: '씨앗이 기다리고 있어요' },
      expires_hours: 24,
    },
    'new.relationship.forming': {
      opportunity_type: 'suggest.translation.help',
      action_type: 'suggest.corering',
      priority: 'medium',
      payload: { message: '번역 도움이 필요하신가요?' },
      expires_hours: 48,
    },
    'goal.achieved': {
      opportunity_type: 'celebrate.achievement',
      action_type: 'trigger.hajunai.celebrate',
      priority: 'high',
      payload: { message: '씨앗이 열매가 됐어요 🍎' },
      expires_hours: 72,
    },
  }

  const opportunity = opportunityMap[meaning.meaning_type]
  if (!opportunity) return

  await supabase
    .schema(SCHEMA)
    .from('opportunities')
    .insert({
      opportunity_type: opportunity.opportunity_type,
      source_meaning_id: meaning.id,
      target_owner_key: meaning.owner_key,
      priority: opportunity.priority,
      action_type: opportunity.action_type,
      payload: opportunity.payload,
      expires_at: new Date(
        Date.now() + opportunity.expires_hours * 60 * 60 * 1000
      ).toISOString(),
    })

  console.log(
    `[corehub/opportunity] created type=${opportunity.opportunity_type} expires_hours=${opportunity.expires_hours}`
  )
}

export { handler as GET, handler as POST }
