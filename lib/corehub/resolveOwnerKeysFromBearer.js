/**
 * P4.2 — resolveOwnerKeysFromBearer
 * Spec: artifacts SPEC-P4.2 / SHARED-OWNER-001 L1
 *
 * service_role client + auth.getUser() user → owner_key[]
 */

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} adminClient
 * @param {object|null|undefined} user
 * @returns {Promise<{
 *   ok: boolean,
 *   ownerKeys: string[],
 *   owner_linked: boolean,
 *   error?: 'invalid_user' | 'principal_mapping_unavailable'
 * }>}
 */
export async function resolveOwnerKeysFromBearer(adminClient, user) {
  if (!user || typeof user !== 'object' || !user.id) {
    return {
      ok: false,
      ownerKeys: [],
      owner_linked: false,
      error: 'invalid_user',
    }
  }

  const identities = Array.isArray(user.identities) ? user.identities : []
  const pairs = []
  const seenPair = new Set()

  for (const identity of identities) {
    if (!identity || typeof identity !== 'object') continue
    const provider = normalizeProvider(identity.provider)
    if (!provider) continue

    const sub = firstNonEmpty(
      identity.identity_data && identity.identity_data.sub,
      identity.provider_id,
      identity.id,
    )
    if (!sub) continue

    const provider_sub = String(sub)
    const key = `${provider}\0${provider_sub}`
    if (seenPair.has(key)) continue
    seenPair.add(key)
    pairs.push({ provider, provider_sub })
  }

  if (pairs.length === 0) {
    return { ok: true, ownerKeys: [], owner_linked: false }
  }

  if (!adminClient || typeof adminClient.from !== 'function') {
    return {
      ok: false,
      ownerKeys: [],
      owner_linked: false,
      error: 'principal_mapping_unavailable',
    }
  }

  let rows
  try {
    rows = await fetchOwnerKeysForPairs(adminClient, pairs)
  } catch {
    return {
      ok: false,
      ownerKeys: [],
      owner_linked: false,
      error: 'principal_mapping_unavailable',
    }
  }

  if (rows === null) {
    return {
      ok: false,
      ownerKeys: [],
      owner_linked: false,
      error: 'principal_mapping_unavailable',
    }
  }

  const ownerKeys = uniqueNonEmpty(rows.map((r) => r && r.owner_key))
  return {
    ok: true,
    ownerKeys,
    owner_linked: ownerKeys.length > 0,
  }
}

function normalizeProvider(provider) {
  if (provider == null) return ''
  return String(provider).trim().toLowerCase()
}

function firstNonEmpty(...values) {
  for (const v of values) {
    if (v == null) continue
    const s = String(v).trim()
    if (s.length > 0) return s
  }
  return null
}

function uniqueNonEmpty(values) {
  const out = []
  const seen = new Set()
  for (const v of values) {
    if (v == null) continue
    const s = String(v).trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

async function fetchOwnerKeysForPairs(adminClient, pairs) {
  const providers = [...new Set(pairs.map((p) => p.provider))]
  const pairSet = new Set(pairs.map((p) => `${p.provider}\0${p.provider_sub}`))

  const { data, error } = await adminClient
    .from('corenull_owner_identities')
    .select('owner_key, provider, provider_sub')
    .in('provider', providers)

  if (error) return null

  const rows = data || []
  return rows.filter((row) => {
    if (!row) return false
    const prov = normalizeProvider(row.provider)
    const sub = row.provider_sub != null ? String(row.provider_sub) : ''
    return pairSet.has(`${prov}\0${sub}`)
  })
}
