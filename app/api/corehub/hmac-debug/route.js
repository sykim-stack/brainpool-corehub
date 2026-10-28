export const dynamic = 'force-dynamic'

/** Temporary probe — does not return secret value. Remove after E2E. */
export async function GET() {
  const key = 'COREHUB_HMAC_SECRET_COREHUB_R5_STAGING_V1'
  const value = process.env[key]
  const set = typeof value === 'string' && value.length > 0
  return Response.json({
    key,
    set,
    length: set ? value.length : 0,
    hasLeadingOrTrailingSpace: set
      ? value !== value.trim()
      : false,
    nodeEnv: process.env.NODE_ENV ?? null,
    vercelEnv: process.env.VERCEL_ENV ?? null,
  })
}
