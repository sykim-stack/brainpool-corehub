/**
 * Pure R1 contract draft for CoreNull-backed owner-link freshness checks.
 *
 * This module deliberately has no Supabase, HTTP, fetch, route, or clock I/O.
 * A future adapter must provide the server-owned snapshot and an explicit now.
 */

const TERMINAL_STATUS = new Set(['revoked'])

export const OWNER_LINK_FRESHNESS_POLICY = Object.freeze({
  maxFreshnessSeconds: 30,
  stale: Object.freeze({
    code: 'owner_link_state_stale',
    httpStatus: 503,
    retryable: true,
    retryAfterSeconds: 1,
  }),
})

const DECISION_HTTP_POLICIES = Object.freeze({
  owner_link_state_stale: OWNER_LINK_FRESHNESS_POLICY.stale,
  identity_verification_unavailable: Object.freeze({
    code: 'identity_verification_unavailable',
    httpStatus: 503,
    retryable: true,
    retryAfterSeconds: 1,
  }),
  owner_link_unresolved: Object.freeze({
    code: 'owner_link_unresolved',
    httpStatus: 403,
    retryable: false,
  }),
  session_revoked: Object.freeze({
    code: 'session_revoked',
    httpStatus: 401,
    retryable: false,
  }),
  owner_link_revoked: Object.freeze({
    code: 'owner_link_revoked',
    httpStatus: 403,
    retryable: false,
  }),
  owner_link_expired: Object.freeze({
    code: 'owner_link_expired',
    httpStatus: 403,
    retryable: false,
  }),
  owner_link_conflict: Object.freeze({
    code: 'owner_link_conflict',
    httpStatus: 409,
    retryable: false,
  }),
  assertion_expired: Object.freeze({
    code: 'assertion_expired',
    httpStatus: 401,
    retryable: false,
  }),
})

const MAX_FRESHNESS_MS = OWNER_LINK_FRESHNESS_POLICY.maxFreshnessSeconds * 1000

function asTime(value) {
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

function isStale(snapshot, now) {
  const freshUntil = asTime(snapshot?.fresh_until)
  const observedAt = asTime(snapshot?.observed_at)
  const current = asTime(now)
  return (
    freshUntil === null ||
    observedAt === null ||
    current === null ||
    freshUntil <= current ||
    freshUntil - observedAt > MAX_FRESHNESS_MS
  )
}

/**
 * Returns a stable logical outcome for the owner-link contract.
 * This is not wired into the existing P4 route yet.
 */
export function evaluateOwnerLinkState({ snapshot, principal, now }) {
  if (!snapshot) return 'owner_link_unresolved'
  if (snapshot.source !== 'corenull') return 'identity_verification_unavailable'
  if (isStale(snapshot, now)) return 'owner_link_state_stale'

  if (
    snapshot.session_id !== principal?.session_id ||
    snapshot.link_id !== principal?.link_id
  ) {
    return 'owner_link_conflict'
  }

  if (
    snapshot.session_status === 'revoked' ||
    snapshot.session_revoked_at !== null
  ) {
    return 'session_revoked'
  }

  if (snapshot.link_status === 'revoked') return 'owner_link_revoked'

  const linkExpiresAt = asTime(snapshot.link_expires_at)
  const current = asTime(now)
  if (linkExpiresAt === null || current === null || linkExpiresAt <= current) {
    return 'owner_link_expired'
  }

  if (
    snapshot.link_revision !== principal?.link_revision ||
    snapshot.owner_binding !== principal?.owner_binding
  ) {
    return 'owner_link_conflict'
  }

  const assertionExpiresAt = asTime(principal?.expires_at)
  if (assertionExpiresAt === null || assertionExpiresAt <= current) {
    return 'assertion_expired'
  }

  return 'allow'
}

/**
 * Maps a logical decision to transport-neutral HTTP metadata.
 * The route remains responsible for adding the trace ID and the compatible
 * { error, _error } response body; no user-controlled fields are accepted.
 */
export function ownerLinkHttpPolicy(decision) {
  return DECISION_HTTP_POLICIES[decision] ?? null
}

/**
 * Applies a snapshot without allowing an older active state to resurrect a
 * terminal revoked state. Ordering uses the server-owned observed_at timestamp
 * rather than lexical comparison of opaque revision strings. Callers must
 * reject same-revision conflicting payloads before applying them.
 */
export function applyMonotonicOwnerLinkSnapshot(current, incoming) {
  if (!current) return incoming
  if (
    TERMINAL_STATUS.has(current.session_status) ||
    TERMINAL_STATUS.has(current.link_status)
  ) {
    return current
  }

  const currentObservedAt = asTime(current.observed_at)
  const incomingObservedAt = asTime(incoming?.observed_at)
  if (incomingObservedAt === null) return current
  if (currentObservedAt !== null && incomingObservedAt < currentObservedAt) return current
  return incoming
}
