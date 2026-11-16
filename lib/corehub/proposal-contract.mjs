import { createHash } from 'node:crypto'

const TYPE = {
  seed: 'space.seed.created',
  fruit: 'space.fruit.created',
  harvested: 'space.fruit.harvested',
  chat: 'relation.chat.sent',
  message: 'space.message.created',
}

function timestamp(value) {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : 0
}

function newest(facts, predicate) {
  return facts
    .filter(predicate)
    .sort((a, b) => timestamp(b.occurred_at) - timestamp(a.occurred_at))[0] || null
}

function uniqueFacts(facts) {
  const byId = new Map()
  for (const fact of facts) {
    if (fact?.id) byId.set(String(fact.id), fact)
  }
  return [...byId.values()]
}

export function selectConnectionCandidates(recentFacts) {
  const facts = uniqueFacts(Array.isArray(recentFacts) ? recentFacts : [])
  if (facts.length < 2) return []

  const candidates = []
  const seed = newest(facts, (fact) => fact.fact_type === TYPE.seed)
  const fruit = newest(facts, (fact) => fact.fact_type === TYPE.fruit)
  const chat = newest(facts, (fact) => fact.fact_type === TYPE.chat)
  const message = newest(
    facts,
    (fact) => fact.fact_type === TYPE.message || fact.fact_type === TYPE.fruit,
  )

  if (seed) {
    const hasFruitAfterSeed = facts.some(
      (fact) =>
        (fact.fact_type === TYPE.fruit || fact.fact_type === TYPE.harvested) &&
        timestamp(fact.occurred_at) >= timestamp(seed.occurred_at),
    )
    if (!hasFruitAfterSeed) {
      candidates.push({
        connection_type: 'seed.abandonment.risk',
        facts: [seed],
      })
    }
  }

  if (chat && message && chat.id !== message.id) {
    candidates.push({
      connection_type: 'cross.language.relationship',
      facts: [chat, message],
    })
  }

  if (seed && fruit && seed.id !== fruit.id) {
    candidates.push({
      connection_type: 'seed.to.fruit.achieved',
      facts: [seed, fruit],
    })
  }

  return candidates
}

export function deterministicUuid(namespace, parts) {
  const stable = [namespace, ...(parts || []).map((part) => String(part))].join(':')
  const bytes = createHash('sha256').update(stable).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x80
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

export function connectionIdentity(ownerKey, connectionType, factIds) {
  const ids = [...new Set((factIds || []).map(String))].sort()
  return deterministicUuid('brainpool.corehub.connection.v1', [
    ownerKey,
    connectionType,
    ...ids,
  ])
}

export function meaningIdentity(connectionId) {
  return deterministicUuid('brainpool.corehub.meaning.v1', [connectionId])
}

export function opportunityIdentity(kind, sourceId) {
  return deterministicUuid('brainpool.corehub.opportunity.v1', [kind, sourceId])
}

export function messageReferences(facts) {
  const refs = []
  const seen = new Set()
  for (const fact of facts || []) {
    const messageId = fact?.payload?.message_id
    const messageSource = fact?.payload?.message_source
    if (!messageId || !messageSource) continue
    const key = `${messageSource}: ${messageId}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ message_id: String(messageId), message_source: String(messageSource) })
  }
  return refs
}

export function isHajunAiSentenceFact(fact) {
  return fact?.source === 'HajunAI' && typeof fact?.payload?.sentence === 'string' &&
    fact.payload.sentence.trim().length > 0
}
