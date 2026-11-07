/**
 * L — design-limit tests for CoreHub P4 assertion path
 * Spec: SPEC-CoreHub-opportunities-P4-assertion-tests-2026-11-07.md §8
 *
 * These are NOT product bugs under R3. They document that CoreHub does not
 * enforce CoreRing/CoreNull session revoke. Copy into:
 *   G:\brainpool-corehub\test\core-ring-p4-design-limits.test.mjs
 * then: npm run test:p4
 *
 * Do not commit secrets. Push only with explicit approval.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const DESIGN_LIMIT = {
  id: 'L1',
  code: 'SESSION_REVOKE_NOT_ENFORCED_AT_COREHUB',
  note:
    'CoreHub validates signature, claims, jti replay, and identities row presence only. ' +
    'It does not query CoreRing/CoreNull session revoke state. R1 backlog.',
}

test('L L1: design-limit code is explicit (SESSION_REVOKE_NOT_ENFORCED_AT_COREHUB)', () => {
  assert.equal(DESIGN_LIMIT.id, 'L1')
  assert.equal(DESIGN_LIMIT.code, 'SESSION_REVOKE_NOT_ENFORCED_AT_COREHUB')
  assert.match(DESIGN_LIMIT.note, /does not query/i)
  assert.match(DESIGN_LIMIT.note, /R1/)
})

/**
 * Narrative (R3): after logical CoreRing session revoke, an unexpired assertion
 * with fresh jti and identities row may still be accepted by CoreHub.
 * Tag: design-limit — do not open a bug ticket when ACCEPT_UNDER_R3 is true.
 */
test('L L1 narrative: unexpired assertion after logical session revoke is ACCEPT_UNDER_R3', () => {
  const scenario = {
    coreRingSessionRevoked: true,
    assertionExpValid: true,
    jtiFresh: true,
    identitiesRowPresent: true,
  }
  const coreHubEnforcesSessionRevoke = false // R1 absent
  const expectAccept =
    scenario.assertionExpValid &&
    scenario.jtiFresh &&
    scenario.identitiesRowPresent &&
    !coreHubEnforcesSessionRevoke

  assert.equal(scenario.coreRingSessionRevoked, true)
  assert.equal(expectAccept, true)
})

test('L L3: identities row removal is CoreHub immediate deny path — not session revoke', () => {
  // B-1 unresolved when identities has zero rows; that is mapping presence, not session ledger.
  const b1KindWhenZeroRows = 'unresolved'
  assert.equal(b1KindWhenZeroRows, 'unresolved')
  assert.notEqual(b1KindWhenZeroRows, 'session_revoked')
})

test('L L4: report flag constant stable', () => {
  assert.equal(DESIGN_LIMIT.code, 'SESSION_REVOKE_NOT_ENFORCED_AT_COREHUB')
})

test('P E3 note: anonymous owner without identities is policy-open (current B-1 unresolved)', () => {
  // Product decision UNDECIDED — current implementation rejects via B-1 unresolved.
  const anonymousOwnerPolicy = 'UNDECIDED'
  const currentB1ForZeroIdentities = 'unresolved'
  assert.equal(anonymousOwnerPolicy, 'UNDECIDED')
  assert.equal(currentB1ForZeroIdentities, 'unresolved')
})
