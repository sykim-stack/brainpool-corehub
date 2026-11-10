/**
 * Contract vectors for the P4 owner-link freshness/revocation design note.
 *
 * These tests intentionally do not call CoreNull, CoreHub, Supabase, fetch, or
 * any route. They freeze the target semantics before an R1 implementation is
 * connected to the existing assertion path.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyMonotonicOwnerLinkSnapshot,
  evaluateOwnerLinkState,
  OWNER_LINK_FRESHNESS_POLICY,
  ownerLinkHttpPolicy,
} from '../lib/corehub/core-ring-owner-link-contract.mjs'

const NOW = '2026-11-10T12:00:00.000Z'
const FRESH_UNTIL = '2026-11-10T12:00:30.000Z'
const EXPIRES_AT = '2026-11-10T12:01:00.000Z'

function activeSnapshot(overrides = {}) {
  return {
    source: 'corenull',
    observed_at: NOW,
    fresh_until: FRESH_UNTIL,
    session_id: 'session-1',
    session_status: 'active',
    session_revoked_at: null,
    link_id: 'link-1',
    link_revision: 'rev-2',
    owner_binding: 'owner-binding-1',
    link_status: 'active',
    link_expires_at: EXPIRES_AT,
    ...overrides,
  }
}

function principal(overrides = {}) {
  return {
    session_id: 'session-1',
    link_id: 'link-1',
    link_revision: 'rev-2',
    owner_binding: 'owner-binding-1',
    expires_at: '2026-11-10T12:00:20.000Z',
    ...overrides,
  }
}

function decide({ snapshot, principal, now = NOW }) {
  return evaluateOwnerLinkState({ snapshot, principal, now })
}

test('freshness policy is a bounded 30-second window with retryable HTTP 503 stale state', () => {
  assert.equal(OWNER_LINK_FRESHNESS_POLICY.maxFreshnessSeconds, 30)
  assert.deepEqual(OWNER_LINK_FRESHNESS_POLICY.stale, {
    code: 'owner_link_state_stale',
    httpStatus: 503,
    retryable: true,
    retryAfterSeconds: 1,
  })
})

test('logical decisions map to stable HTTP policy without exposing internal fields', () => {
  assert.deepEqual(ownerLinkHttpPolicy('owner_link_state_stale'), {
    code: 'owner_link_state_stale',
    httpStatus: 503,
    retryable: true,
    retryAfterSeconds: 1,
  })
  assert.deepEqual(ownerLinkHttpPolicy('session_revoked'), {
    code: 'session_revoked',
    httpStatus: 401,
    retryable: false,
  })
  assert.deepEqual(ownerLinkHttpPolicy('owner_link_expired'), {
    code: 'owner_link_expired',
    httpStatus: 403,
    retryable: false,
  })
  assert.deepEqual(ownerLinkHttpPolicy('owner_link_conflict'), {
    code: 'owner_link_conflict',
    httpStatus: 409,
    retryable: false,
  })
  assert.equal(ownerLinkHttpPolicy('allow'), null)
  assert.equal(ownerLinkHttpPolicy('unknown'), null)
})

test('active session and active link with a fresh snapshot are allowed', () => {
  assert.equal(decide({ snapshot: activeSnapshot(), principal: principal() }), 'allow')
})

test('a revoked session is denied even when the assertion has a fresh jti and exp', () => {
  assert.equal(
    decide({
      snapshot: activeSnapshot({ session_status: 'revoked' }),
      principal: principal({ assertion_id: 'new-jti' }),
    }),
    'session_revoked',
  )
  assert.equal(
    decide({
      snapshot: activeSnapshot({ session_revoked_at: '2026-11-10T11:59:59.000Z' }),
      principal: principal({ assertion_id: 'another-new-jti' }),
    }),
    'session_revoked',
  )
})

test('link revocation is distinct from session revocation', () => {
  assert.equal(
    decide({ snapshot: activeSnapshot({ link_status: 'revoked' }), principal: principal() }),
    'owner_link_revoked',
  )
})

test('link expiry uses a hard inclusive boundary and wins over assertion exp', () => {
  assert.equal(
    decide({
      snapshot: activeSnapshot({ link_expires_at: NOW }),
      principal: principal({ expires_at: '2026-11-10T12:05:00.000Z' }),
    }),
    'owner_link_expired',
  )
  assert.equal(
    decide({
      snapshot: activeSnapshot({ link_expires_at: '2026-11-10T11:59:59.999Z' }),
      principal: principal({ expires_at: '2026-11-10T12:05:00.000Z' }),
    }),
    'owner_link_expired',
  )
})

test('a stale snapshot fails closed instead of continuing to resource access', () => {
  assert.equal(
    decide({ snapshot: activeSnapshot({ fresh_until: NOW }), principal: principal() }),
    'owner_link_state_stale',
  )
})

test('missing or non-CoreNull snapshot never allows access', () => {
  assert.equal(decide({ snapshot: null, principal: principal() }), 'owner_link_unresolved')
  assert.equal(
    decide({ snapshot: activeSnapshot({ source: 'client' }), principal: principal() }),
    'identity_verification_unavailable',
  )
})

test('session and link identity mismatches are fail-closed conflicts', () => {
  assert.equal(
    decide({ snapshot: activeSnapshot({ session_id: 'session-other' }), principal: principal() }),
    'owner_link_conflict',
  )
  assert.equal(
    decide({ snapshot: activeSnapshot({ link_id: 'link-other' }), principal: principal() }),
    'owner_link_conflict',
  )
})

test('revision and owner binding mismatches do not select an arbitrary candidate', () => {
  assert.equal(
    decide({ snapshot: activeSnapshot({ link_revision: 'rev-1' }), principal: principal() }),
    'owner_link_conflict',
  )
  assert.equal(
    decide({ snapshot: activeSnapshot({ owner_binding: 'owner-other' }), principal: principal() }),
    'owner_link_conflict',
  )
})

test('stale state takes precedence over an otherwise hidden revoke reason', () => {
  assert.equal(
    decide({
      snapshot: activeSnapshot({ fresh_until: NOW, session_status: 'revoked' }),
      principal: principal(),
    }),
    'owner_link_state_stale',
  )
})

test('a snapshot whose advertised freshness exceeds 30 seconds is stale', () => {
  assert.equal(
    decide({
      snapshot: activeSnapshot({
        observed_at: '2026-11-10T11:59:59.000Z',
        fresh_until: '2026-11-10T12:00:30.000Z',
      }),
      principal: principal(),
    }),
    'owner_link_state_stale',
  )
})

test('an expired assertion remains denied after link checks pass', () => {
  assert.equal(
    decide({
      snapshot: activeSnapshot(),
      principal: principal({ expires_at: NOW }),
    }),
    'assertion_expired',
  )
})

test('an out-of-order active snapshot cannot restore a revoked state', () => {
  const revoked = activeSnapshot({ session_status: 'revoked', link_revision: 'rev-3' })
  const olderActive = activeSnapshot({ session_status: 'active', link_revision: 'rev-2' })
  const result = applyMonotonicOwnerLinkSnapshot(revoked, olderActive)
  assert.equal(result.session_status, 'revoked')
  assert.equal(result.link_revision, 'rev-3')
})

test('snapshot ordering does not rely on lexical revision-string comparison', () => {
  const current = activeSnapshot({
    observed_at: '2026-11-10T12:00:10.000Z',
    link_revision: 'rev-10',
  })
  const older = activeSnapshot({
    observed_at: '2026-11-10T12:00:09.000Z',
    link_revision: 'rev-9',
  })
  const result = applyMonotonicOwnerLinkSnapshot(current, older)

  assert.equal(result.link_revision, 'rev-10')
  assert.equal(result.observed_at, '2026-11-10T12:00:10.000Z')
})

test('identity-row removal is not mislabeled as session revocation', () => {
  assert.equal(decide({ snapshot: null, principal: principal() }), 'owner_link_unresolved')
  assert.notEqual(decide({ snapshot: null, principal: principal() }), 'session_revoked')
})
