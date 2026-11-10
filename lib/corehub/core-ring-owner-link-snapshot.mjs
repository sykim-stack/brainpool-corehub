/**
 * Server-owned owner-link snapshot provider contract.
 *
 * This module is intentionally transport-free. A real provider may later read
 * an approved materialized view, but this contract itself performs no I/O.
 */

const REQUIRED_INPUT_FIELDS = ['subject', 'sessionId', 'ownerKey']
const SESSION_STATUSES = new Set(['active', 'revoked'])
const LINK_STATUSES = new Set(['active', 'expired', 'revoked'])

export const OWNER_LINK_SNAPSHOT_PROVIDER_VERSION = 'corering-owner-link-snapshot-v1'

export class OwnerLinkSnapshotContractError extends Error {
  constructor(message) {
    super(message)
    this.name = 'OwnerLinkSnapshotContractError'
    this.code = 'owner_link_snapshot_contract_invalid'
  }
}

function requireOpaqueString(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new OwnerLinkSnapshotContractError(`${field} must be a non-empty opaque string`)
  }
  return value
}

function requireTimestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new OwnerLinkSnapshotContractError(`${field} must be an ISO timestamp`)
  }
  return value
}

export function normalizeOwnerLinkSnapshotInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new OwnerLinkSnapshotContractError('provider input must be an object')
  }
  for (const field of REQUIRED_INPUT_FIELDS) requireOpaqueString(input[field], field)
  const unexpectedFields = Object.keys(input).filter(
    (field) => !REQUIRED_INPUT_FIELDS.includes(field),
  )
  if (unexpectedFields.length > 0) {
    throw new OwnerLinkSnapshotContractError('provider input contains unexpected fields')
  }
  return Object.freeze({
    subject: input.subject,
    sessionId: input.sessionId,
    ownerKey: input.ownerKey,
  })
}

export function normalizeOwnerLinkSnapshot(snapshot) {
  if (snapshot === null) return null
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new OwnerLinkSnapshotContractError('snapshot must be an object or null')
  }

  const normalized = {
    source: snapshot.source,
    snapshot_id: requireOpaqueString(snapshot.snapshot_id, 'snapshot_id'),
    observed_at: requireTimestamp(snapshot.observed_at, 'observed_at'),
    fresh_until: requireTimestamp(snapshot.fresh_until, 'fresh_until'),
    session_id: requireOpaqueString(snapshot.session_id, 'session_id'),
    session_status: snapshot.session_status,
    session_revoked_at: snapshot.session_revoked_at,
    link_id: requireOpaqueString(snapshot.link_id, 'link_id'),
    link_revision: requireOpaqueString(snapshot.link_revision, 'link_revision'),
    owner_binding: requireOpaqueString(snapshot.owner_binding, 'owner_binding'),
    link_status: snapshot.link_status,
    link_expires_at: requireTimestamp(snapshot.link_expires_at, 'link_expires_at'),
  }

  if (normalized.source !== 'corenull') {
    throw new OwnerLinkSnapshotContractError('snapshot source must be corenull')
  }
  if (!SESSION_STATUSES.has(normalized.session_status)) {
    throw new OwnerLinkSnapshotContractError('invalid session_status')
  }
  if (!LINK_STATUSES.has(normalized.link_status)) {
    throw new OwnerLinkSnapshotContractError('invalid link_status')
  }
  if (normalized.session_revoked_at !== null) {
    normalized.session_revoked_at = requireTimestamp(
      normalized.session_revoked_at,
      'session_revoked_at',
    )
  }

  return Object.freeze(normalized)
}

/**
 * Wraps a provider implementation with input/output validation. The wrapped
 * resolver is the only place allowed to obtain a snapshot in a future adapter.
 */
export function createOwnerLinkSnapshotProvider(resolve) {
  if (typeof resolve !== 'function') {
    throw new OwnerLinkSnapshotContractError('resolve must be a function')
  }
  return Object.freeze({
    async resolve(input) {
      const normalizedInput = normalizeOwnerLinkSnapshotInput(input)
      const snapshot = await resolve(normalizedInput)
      return normalizeOwnerLinkSnapshot(snapshot)
    },
  })
}
