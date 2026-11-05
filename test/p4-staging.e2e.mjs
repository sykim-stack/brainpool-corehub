const baseUrl = process.env.COREHUB_STAGING_URL
const token = process.env.COREHUB_STAGING_BEARER
const ownedOpportunityId = process.env.COREHUB_STAGING_OWNED_OPPORTUNITY_ID
const otherOpportunityId = process.env.COREHUB_STAGING_OTHER_OPPORTUNITY_ID

if (!baseUrl || !token) {
  console.log('SKIP: COREHUB_STAGING_URL and COREHUB_STAGING_BEARER are required for Staging E2E.')
  process.exit(0)
}

const endpoint = new URL('/api/corehub/opportunities', baseUrl)

async function request(path = '', options = {}) {
  const response = await fetch(new URL(path, endpoint), {
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  })
  const body = await response.json().catch(() => null)
  return { response, body }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const unauth = await request()
assert(unauth.response.status === 401, `unauthenticated GET expected 401, got ${unauth.response.status}`)
assert(unauth.body?.error === 'auth_required' && unauth.body?._error === 'auth_required', 'error compatibility missing')
console.log('PASS unauthenticated request')

const invalid = await request('', { headers: { Authorization: 'Bearer invalid-staging-token' } })
assert(invalid.response.status === 401, `invalid Bearer expected 401, got ${invalid.response.status}`)
console.log('PASS invalid Bearer')

const listed = await request('', { headers: { Authorization: `Bearer ${token}` } })
assert(listed.response.status === 200, `mapped user GET expected 200, got ${listed.response.status}`)
assert(Array.isArray(listed.body?.data), 'mapped user response data must be an array')
assert(typeof listed.body?.meta?.owner_linked === 'boolean', 'owner_linked metadata missing')
console.log(`PASS authenticated mapping path owner_linked=${listed.body.meta.owner_linked}`)

if (listed.body?.meta?.owner_linked === false) {
  assert(listed.body.data.length === 0, 'unmapped user must receive empty data')
  console.log('PASS unmapped user empty result')
}

if (ownedOpportunityId) {
  const patch = await request(`?id=${encodeURIComponent(ownedOpportunityId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ opportunity_id: ownedOpportunityId, outcome: 'shown' }),
  })
  assert([200, 404].includes(patch.response.status), `owned PATCH unexpected ${patch.response.status}`)
  console.log(`CHECK owned PATCH status=${patch.response.status}`)
} else {
  console.log('SKIP owned PATCH: COREHUB_STAGING_OWNED_OPPORTUNITY_ID not set')
}

if (otherOpportunityId) {
  const other = await request(`?id=${encodeURIComponent(otherOpportunityId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  assert(other.response.status === 404, `other-owner GET expected 404, got ${other.response.status}`)
  console.log('PASS other-owner GET blocked')

  const raceA = request(`?id=${encodeURIComponent(otherOpportunityId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ opportunity_id: otherOpportunityId, outcome: 'shown' }),
  })
  const raceB = request(`?id=${encodeURIComponent(otherOpportunityId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ opportunity_id: otherOpportunityId, outcome: 'shown' }),
  })
  const [a, b] = await Promise.all([raceA, raceB])
  assert(a.response.status === 404 && b.response.status === 404, 'other-owner concurrent PATCH must be blocked')
  console.log('PASS other-owner concurrent PATCH blocked')
} else {
  console.log('SKIP other-owner GET/PATCH: COREHUB_STAGING_OTHER_OPPORTUNITY_ID not set')
}

console.log('Staging E2E completed for the scenarios with supplied fixtures.')
