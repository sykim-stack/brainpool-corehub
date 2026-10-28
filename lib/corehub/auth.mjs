export function getBearerToken(request) {
  const raw = request?.headers?.get?.('authorization')
  if (typeof raw !== 'string') return null
  const match = raw.match(/^Bearer\s+([^\s]+)$/i)
  return match?.[1] ?? null
}

/** Verify a Supabase access token with Auth; never trust a client-supplied UID. */
export async function authenticateUser(request, supabase) {
  const accessToken = getBearerToken(request)
  if (!accessToken) {
    return { ok: false, status: 401, error: 'authentication_required' }
  }

  try {
    const { data, error } = await supabase.auth.getUser(accessToken)
    if (error) {
      const status = Number(error.status)
      return {
        ok: false,
        status: Number.isFinite(status) && status >= 500 ? 503 : 401,
        error: Number.isFinite(status) && status >= 500
          ? 'authentication_service_unavailable'
          : 'invalid_access_token',
      }
    }
    if (!data?.user?.id) {
      return { ok: false, status: 401, error: 'invalid_access_token' }
    }
    return { ok: true, userId: data.user.id }
  } catch {
    return { ok: false, status: 503, error: 'authentication_service_unavailable' }
  }
}
