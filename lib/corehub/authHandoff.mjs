import { createHash, randomBytes } from 'node:crypto'

export const HANDOFF_AUDIENCES = new Set(['corenull', 'corering'])
export const HANDOFF_TTL_MS = 60 * 1000
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function hashOpaqueToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

export async function resolveAuthSubjectFromBearer(supabase, token, now = new Date()) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'auth_required' }

  try {
    const { data, error } = await supabase.auth.getUser(token)
    const authUserId = data?.user?.id
    if (!error && typeof authUserId === 'string' && authUserId.trim()) {
      return { ok: true, authUserId }
    }
  } catch {
    // A CoreHub session token is checked below if the Supabase Auth lookup fails.
  }

  try {
    const { data, error } = await supabase
      .schema('corehub')
      .from('auth_sessions')
      .select('auth_user_id')
      .eq('token_hash', hashOpaqueToken(token))
      .is('revoked_at', null)
      .gt('expires_at', now.toISOString())
      .maybeSingle()

    if (error) return { ok: false, error: 'session_store_unavailable' }
    const authUserId = data?.auth_user_id
    if (typeof authUserId !== 'string' || !authUserId.trim()) {
      return { ok: false, error: 'invalid_bearer' }
    }
    return { ok: true, authUserId }
  } catch {
    return { ok: false, error: 'session_store_unavailable' }
  }
}

export async function createHandoff(supabase, { authUserId, audience, now = new Date(), ttlMs = HANDOFF_TTL_MS }) {
  if (!HANDOFF_AUDIENCES.has(audience)) return { ok: false, error: 'invalid_audience' }
  if (typeof authUserId !== 'string' || !authUserId.trim()) return { ok: false, error: 'invalid_subject' }

  const ticket = randomBytes(32).toString('base64url')
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
  try {
    const { error } = await supabase.schema('corehub').from('auth_handoffs').insert({
      ticket_hash: hashOpaqueToken(ticket),
      auth_user_id: authUserId,
      audience,
      expires_at: expiresAt,
    })
    if (error) return { ok: false, error: 'handoff_store_unavailable' }
    return { ok: true, ticket, audience, expiresAt }
  } catch {
    return { ok: false, error: 'handoff_store_unavailable' }
  }
}

export async function redeemHandoff(supabase, { ticket, audience, now = new Date(), sessionTtlMs = SESSION_TTL_MS }) {
  if (!ticket || typeof ticket !== 'string') return { ok: false, error: 'ticket_required' }
  if (!HANDOFF_AUDIENCES.has(audience)) return { ok: false, error: 'invalid_audience' }

  const redeemedAt = now.toISOString()
  let claim
  try {
    claim = await supabase
      .schema('corehub')
      .from('auth_handoffs')
      .update({ used_at: redeemedAt })
      .eq('ticket_hash', hashOpaqueToken(ticket))
      .eq('audience', audience)
      .is('used_at', null)
      .gt('expires_at', redeemedAt)
      .select('auth_user_id')
      .maybeSingle()
  } catch {
    return { ok: false, error: 'handoff_store_unavailable' }
  }

  if (claim?.error) return { ok: false, error: 'handoff_store_unavailable' }
  const authUserId = claim?.data?.auth_user_id
  if (typeof authUserId !== 'string' || !authUserId.trim()) {
    return { ok: false, error: 'invalid_or_expired_ticket' }
  }

  const sessionToken = randomBytes(32).toString('base64url')
  const sessionExpiresAt = new Date(now.getTime() + sessionTtlMs).toISOString()
  try {
    const { error } = await supabase.schema('corehub').from('auth_sessions').insert({
      token_hash: hashOpaqueToken(sessionToken),
      auth_user_id: authUserId,
      expires_at: sessionExpiresAt,
    })
    if (error) return { ok: false, error: 'session_store_unavailable' }
  } catch {
    return { ok: false, error: 'session_store_unavailable' }
  }

  return { ok: true, authUserId, sessionToken, sessionExpiresAt }
}
