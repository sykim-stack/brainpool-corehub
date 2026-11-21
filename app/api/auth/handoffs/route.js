import { getSupabase } from '@/lib/supabase'
import {
  createHandoff,
  HANDOFF_AUDIENCES,
  resolveAuthSubjectFromBearer,
} from '@/lib/corehub/authHandoff.mjs'

export const dynamic = 'force-dynamic'

function tokenFromRequest(request) {
  const authorization = request.headers.get('authorization') || ''
  const match = authorization.match(/^Bearer\s+(\S+)$/i)
  if (match) return match[1]

  const cookie = (request.headers.get('cookie') || '').split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('corehub_session='))
  if (!cookie) return ''
  try {
    return decodeURIComponent(cookie.slice('corehub_session='.length))
  } catch {
    return ''
  }
}

export async function POST(request) {
  const traceId = crypto.randomUUID()
  const token = tokenFromRequest(request)
  if (!token) return Response.json({ _error: 'auth_required', traceId }, { status: 401 })

  let body
  try {
    body = await request.json()
  } catch {
    return Response.json({ _error: 'invalid_json', traceId }, { status: 400 })
  }

  const audience = body?.audience
  if (!HANDOFF_AUDIENCES.has(audience)) {
    return Response.json({ _error: 'invalid_audience', traceId }, { status: 400 })
  }

  const supabase = getSupabase()
  if (!supabase) return Response.json({ _error: 'supabase_init_failed', traceId }, { status: 503 })

  const principal = await resolveAuthSubjectFromBearer(supabase, token)
  if (!principal.ok) {
    const status = principal.error === 'invalid_bearer' || principal.error === 'auth_required' ? 401 : 503
    return Response.json({ _error: principal.error, traceId }, { status })
  }

  const handoff = await createHandoff(supabase, {
    authUserId: principal.authUserId,
    audience,
  })
  if (!handoff.ok) {
    const status = handoff.error === 'invalid_audience' ? 400 : 503
    return Response.json({ _error: handoff.error, traceId }, { status })
  }

  return Response.json({
    data: {
      ticket: handoff.ticket,
      audience: handoff.audience,
      expires_at: handoff.expiresAt,
    },
    traceId,
  }, { status: 201, headers: { 'Cache-Control': 'no-store' } })
}
