const MEANINGS = Object.freeze({
  'seed.to.fruit.achieved': { meaning_type: 'goal.achieved', confidence: 0.95 },
  'cross.language.relationship': { meaning_type: 'new.relationship.forming', confidence: 0.8 },
  'seed.abandonment.risk': { meaning_type: 'seed.at.risk', confidence: 0.72 },
})

const OPPORTUNITIES = Object.freeze({
  'goal.achieved': {
    opportunity_type: 'celebrate.achievement',
    action_type: 'trigger.hajunai.celebrate',
    priority: 'high',
    payload: { message: '씨앗이 열매가 됐어요 🍎' },
    expires_hours: 72,
  },
  'new.relationship.forming': {
    opportunity_type: 'suggest.translation.help',
    action_type: 'suggest.corering',
    priority: 'medium',
    payload: { message: '번역 도움이 필요하신가요?' },
    expires_hours: 48,
  },
  'seed.at.risk': {
    opportunity_type: 'nudge.seed.owner',
    action_type: 'trigger.hajunai.nudge',
    priority: 'high',
    payload: { message: '씨앗이 기다리고 있어요' },
    expires_hours: 24,
  },
})

function timestamp(fact) {
  const value = Date.parse(fact?.occurred_at ?? '')
  return Number.isFinite(value) ? value : null
}

function sameScope(a, b) {
  return Boolean(
    a && b &&
    typeof a.owner_id === 'string' && a.owner_id.length > 0 &&
    a.owner_id === b.owner_id &&
    (a.house_id ?? null) === (b.house_id ?? null)
  )
}

function ref(fact, key) {
  const value = fact?.payload?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function findPair(facts, currentFact, firstType, secondType, referenceKey) {
  const first = facts.filter(fact => fact.fact_type === firstType)
  const second = facts.filter(fact => fact.fact_type === secondType)
  const candidates = []

  for (const left of first) {
    for (const right of second) {
      const leftTime = timestamp(left)
      const rightTime = timestamp(right)
      const reference = ref(left, referenceKey)
      if (!left.id || !right.id || left.id === right.id || !reference) continue
      if (ref(right, referenceKey) !== reference) continue
      if (!sameScope(left, right) || !sameScope(left, currentFact)) continue
      if (leftTime === null || rightTime === null || leftTime > rightTime) continue
      if (left.id !== currentFact.id && right.id !== currentFact.id) continue
      candidates.push({ left, right, rightTime, leftTime })
    }
  }

  candidates.sort((a, b) => b.rightTime - a.rightTime || b.leftTime - a.leftTime)
  return candidates[0] ?? null
}

/**
 * Match only explicit, causal entity pairs for the authenticated owner and house.
 * Absence of a visit/fruit is not evidence of abandonment; the source must emit
 * an explicit space.seed.abandonment_due event with the same seed_id.
 */
export function matchFactConnection(currentFact, candidateFacts) {
  if (!currentFact?.id || !currentFact.owner_id || !Array.isArray(candidateFacts)) return null

  const factsById = new Map()
  for (const fact of candidateFacts) {
    if (fact?.id && sameScope(fact, currentFact)) factsById.set(fact.id, fact)
  }
  if (!factsById.has(currentFact.id)) factsById.set(currentFact.id, currentFact)
  const facts = [...factsById.values()]

  // Positive completion evidence wins over any risk signal.
  const achieved = findPair(
    facts, currentFact,
    'space.seed.created', 'space.fruit.created', 'seed_id'
  )
  if (achieved) {
    return {
      connection_type: 'seed.to.fruit.achieved',
      strength: 0.95,
      fact_ids: [achieved.left.id, achieved.right.id],
    }
  }

  const relationship = findPair(
    facts, currentFact,
    'language.translated', 'relation.chat.sent', 'conversation_id'
  )
  if (relationship) {
    return {
      connection_type: 'cross.language.relationship',
      strength: 0.8,
      fact_ids: [relationship.left.id, relationship.right.id],
    }
  }

  const abandonment = findPair(
    facts, currentFact,
    'space.seed.created', 'space.seed.abandonment_due', 'seed_id'
  )
  if (abandonment) {
    return {
      connection_type: 'seed.abandonment.risk',
      strength: 0.7,
      fact_ids: [abandonment.left.id, abandonment.right.id],
    }
  }

  return null
}

export function meaningForConnection(connectionType) {
  return MEANINGS[connectionType] ?? null
}

export function opportunityForMeaning(meaningType) {
  const value = OPPORTUNITIES[meaningType]
  return value ? structuredClone(value) : null
}
