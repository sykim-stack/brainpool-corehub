// CoreHub - Facts API
// Core들이 Fact를 전달하는 수집 엔드포인트
// POST → Fact 저장 + Connection 탐지 트리거

export const dynamic = 'force-dynamic'

const handler = async (req) => {
  const traceId = crypto.randomUUID()

  if (req.method === 'POST') return handlePost(req, traceId)
  if (req.method === 'GET')  return handleGet(req, traceId)

  return Response.json({ _error: 'method_not_allowed', traceId }, { status: 500 })
}

// Fact 저장
const handlePost = async (req, traceId) => {
  const body = JSON.parse(await req.text())
  const { source, fact_type, owner_key, house_id, occurred_at, payload } = body

  if (!source || !fact_type || !owner_key) {
    return Response.json({ _error: 'source_fact_type_owner_key_required', traceId }, { status: 500 })
  }

  const { getSupabase } = await import('@/lib/supabase')
  const supabase = getSupabase()
  if (!supabase) return Response.json({ _error: 'supabase_init_failed', traceId }, { status: 500 })

  // Fact 저장
  const { data: fact, error } = await supabase
    .from('facts')
    .insert({
      source,
      fact_type,
      owner_key,
      house_id: house_id || null,
      occurred_at: occurred_at || new Date().toISOString(),
      payload: payload || {},
      processed: false,
    })
    .select()
    .single()

  if (error) return Response.json({ _error: error.message, traceId }, { status: 500 })

  console.log(`[corehub/facts] saved source=${source} type=${fact_type} owner=${owner_key}`)

  // Connection 탐지 (fire-and-forget — 실패해도 Fact 저장은 완료)
  detectConnections(supabase, fact).catch(e =>
    console.error('[corehub/facts] connection detect failed:', e)
  )

  return Response.json({ data: { fact_id: fact.id }, traceId })
}

// Fact 조회 (디버깅 / 관리용)
const handleGet = async (req, traceId) => {
  const { searchParams } = new URL(req.url)
  const owner_key = searchParams.get('owner_key')
  const source = searchParams.get('source')
  const limit = parseInt(searchParams.get('limit') || '20')

  const { getSupabase } = await import('@/lib/supabase')
  const supabase = getSupabase()
  if (!supabase) return Response.json({ _error: 'supabase_init_failed', traceId }, { status: 500 })

  let query = supabase
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

// Connection 탐지 (비동기 — Fact 저장 후 백그라운드 실행)
const detectConnections = async (supabase, newFact) => {
  // 같은 owner_key의 최근 Fact 10개 조회 (새 Fact 포함)
  const { data: recentFacts } = await supabase
    .from('facts')
    .select('*')
    .eq('owner_key', newFact.owner_key)
    .order('occurred_at', { ascending: false })
    .limit(10)

  if (!recentFacts || recentFacts.length < 2) return

  const factTypes = recentFacts.map(f => f.fact_type)

  // 패턴 매칭 — 1차 규칙 기반
  const patterns = [
    {
      // 씨앗 생성 후 방문 없음 → 포기 위험
      match: (types) =>
        types.includes('space.seed.created') &&
        !types.includes('space.room.visited'),
      connection_type: 'seed.abandonment.risk',
      strength: 0.7,
    },
    {
      // 번역 + 채팅 동시 발생 → 언어 다른 관계 형성
      match: (types) =>
        types.includes('language.translated') &&
        types.includes('relation.chat.sent'),
      connection_type: 'cross.language.relationship',
      strength: 0.8,
    },
    {
      // Fruit 생성 → 씨앗 성취
      match: (types) =>
        types.includes('space.seed.created') &&
        types.includes('space.fruit.created'),
      connection_type: 'seed.to.fruit.achieved',
      strength: 0.95,
    },
  ]

  for (const pattern of patterns) {
    if (pattern.match(factTypes)) {
      const matchedFacts = recentFacts.filter(f =>
        factTypes.includes(f.fact_type)
      )

      const { data: connection } = await supabase
        .from('connections')
        .insert({
          fact_ids: matchedFacts.map(f => f.id),
          connection_type: pattern.connection_type,
          strength: pattern.strength,
          owner_key: newFact.owner_key,
          house_id: newFact.house_id || null,
        })
        .select()
        .single()

      if (connection) {
        console.log(`[corehub/connect] detected type=${pattern.connection_type} strength=${pattern.strength}`)
        // Meaning 생성 트리거
        await generateMeaning(supabase, connection, matchedFacts)
      }
    }
  }
}

// Possible Meaning 생성
const generateMeaning = async (supabase, connection, facts) => {
  const meaningMap = {
    'seed.abandonment.risk': {
      meaning_type: 'seed.at.risk',
      confidence: 0.72,
    },
    'cross.language.relationship': {
      meaning_type: 'new.relationship.forming',
      confidence: 0.80,
    },
    'seed.to.fruit.achieved': {
      meaning_type: 'goal.achieved',
      confidence: 0.95,
    },
  }

  const meaning = meaningMap[connection.connection_type]
  if (!meaning) return

  const { data: meaningData } = await supabase
    .from('meanings')
    .insert({
      meaning_type: meaning.meaning_type,
      confidence: meaning.confidence,
      source_fact_ids: facts.map(f => f.id),
      connection_ids: [connection.id],
      owner_key: connection.owner_key,
      house_id: connection.house_id,
    })
    .select()
    .single()

  if (meaningData) {
    console.log(`[corehub/meaning] generated type=${meaning.meaning_type} confidence=${meaning.confidence}`)
    await generateOpportunity(supabase, meaningData)
  }
}

// Opportunity 생성
const generateOpportunity = async (supabase, meaning) => {
  const opportunityMap = {
    'seed.at.risk': {
      opportunity_type: 'nudge.seed.owner',
      action_type: 'trigger.hajunai.nudge',
      priority: 'high',
      payload: { message: '씨앗이 기다리고 있어요' },
    },
    'new.relationship.forming': {
      opportunity_type: 'suggest.translation.help',
      action_type: 'suggest.corering',
      priority: 'medium',
      payload: { message: '번역 도움이 필요하신가요?' },
    },
    'goal.achieved': {
      opportunity_type: 'celebrate.achievement',
      action_type: 'trigger.hajunai.celebrate',
      priority: 'high',
      payload: { message: '씨앗이 열매가 됐어요 🍎' },
    },
  }

  const opportunity = opportunityMap[meaning.meaning_type]
  if (!opportunity) return

  await supabase
    .from('opportunities')
    .insert({
      opportunity_type: opportunity.opportunity_type,
      source_meaning_id: meaning.id,
      target_owner_key: meaning.owner_key,
      priority: opportunity.priority,
      action_type: opportunity.action_type,
      payload: opportunity.payload,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    })

  console.log(`[corehub/opportunity] created type=${opportunity.opportunity_type}`)
}

export { handler as GET, handler as POST }