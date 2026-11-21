import { getSupabase } from '@/lib/supabase'
import { redeemHandoff, HANDOFF_AUDIENCES } from '@/lib/corehub/authHandoff.mjs'

export const dynamic = 'force-dynamic'

export async function POST(request) {
  const traceId = crypto.randomUUID()

  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ _error: 'invalid_json', traceId }, { status: 400 })
  }

  const ticket = typeof body?.ticket === 'string' ? body.ticket : ''
  const audience = body?.audience

  if (!ticket) {
    return Response.json({ _error: 'ticket_required', traceId }, { status: 400 })
  }
  if (!HANDOFF_AUDIENCES.has(audience)) {
    return Response.json({ _error: 'invalid_audience', traceId }, { status: 400 })
  }

  const supabase = getSupabase()
  if (!supabase) {
    return Response.json({ _error: 'supabase_init_failed', traceId }, { status: 503 })
  }

  const result = await redeemHandoff(supabase, { ticket, audience })
  if (!result.ok) {
    const status =
      result.error === 'invalid_or_expired_ticket' || result.error === 'ticket_required'
        ? 401
        : result.error === 'invalid_audience'
          ? 400
          : 503
    return Response.json({ _error: result.error, traceId }, { status })
  }

  return Response.json({
    data: {
      auth_user_id: result.authUserId,
      audience,
      session_token: result.sessionToken,
      expires_at: result.sessionExpiresAt,
    },
    traceId,
  }, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  })
}
