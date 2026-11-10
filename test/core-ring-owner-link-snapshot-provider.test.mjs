import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OWNER_LINK_SNAPSHOT_PROVIDER_VERSION,
  OwnerLinkSnapshotContractError,
  createOwnerLinkSnapshotProvider,
  normalizeOwnerLinkSnapshot,
} from '../lib/corehub/core-ring-owner-link-snapshot.mjs'
import { createOwnerLinkSnapshotProviderDouble } from './support/owner-link-snapshot-provider-double.mjs'

const SNAPSHOT = {
  source: 'corenull',
  snapshot_id: 'snapshot-1',
  observed_at: '2033-05-18T03:33:20.000Z',
  fresh_until: '2033-05-18T03:33:50.000Z',
  session_id: 'session-1',
  session_status: 'active',
  session_revoked_at: null,
  link_id: 'link-1',
  link_revision: 'rev-2',
  owner_binding: 'owner-binding-1',
  link_status: 'active',
  link_expires_at: '2033-05-18T03:34:20.000Z',
}

const INPUT = {
  subject: 'subject-1',
  sessionId: 'session-1',
  ownerKey: 'owner-1',
}

test('provider contract exposes a stable version and accepts only verified identity inputs', async () => {
  const { provider, calls } = createOwnerLinkSnapshotProviderDouble({ snapshot: SNAPSHOT })
  const result = await provider.resolve(INPUT)

  assert.equal(OWNER_LINK_SNAPSHOT_PROVIDER_VERSION, 'corering-owner-link-snapshot-v1')
  assert.deepEqual(calls, [INPUT])
  assert.deepEqual(result, SNAPSHOT)
  assert.equal(Object.isFrozen(calls[0]), true)
  assert.equal(Object.isFrozen(result), true)
})

test('provider may return null for an unresolved server-side link', async () => {
  const { provider } = createOwnerLinkSnapshotProviderDouble({ snapshot: null })
  assert.equal(await provider.resolve(INPUT), null)
})

test('test double can deterministically inject provider failure', async () => {
  const failure = new Error('snapshot store unavailable')
  const { provider } = createOwnerLinkSnapshotProviderDouble({ error: failure })
  await assert.rejects(provider.resolve(INPUT), failure)
})

test('provider input rejects missing, empty, or client-shaped identity values', async () => {
  const provider = createOwnerLinkSnapshotProvider(async () => null)

  await assert.rejects(
    provider.resolve({ subject: 'subject-1', sessionId: 'session-1' }),
    OwnerLinkSnapshotContractError,
  )
  await assert.rejects(
    provider.resolve({ ...INPUT, ownerKey: '' }),
    OwnerLinkSnapshotContractError,
  )
  await assert.rejects(
    provider.resolve({ ...INPUT, deviceId: 'client-device' }),
    OwnerLinkSnapshotContractError,
  )
})

test('snapshot output rejects non-CoreNull or incomplete state', () => {
  assert.throws(
    () => normalizeOwnerLinkSnapshot({ ...SNAPSHOT, source: 'client' }),
    OwnerLinkSnapshotContractError,
  )
  assert.throws(
    () => normalizeOwnerLinkSnapshot({ ...SNAPSHOT, fresh_until: 'not-a-time' }),
    OwnerLinkSnapshotContractError,
  )
  assert.throws(
    () => normalizeOwnerLinkSnapshot({ ...SNAPSHOT, session_status: 'unknown' }),
    OwnerLinkSnapshotContractError,
  )
  assert.throws(
    () => normalizeOwnerLinkSnapshot({ ...SNAPSHOT, link_status: 'unknown' }),
    OwnerLinkSnapshotContractError,
  )
})

test('snapshot normalization preserves explicit revoke and expiry state', () => {
  const normalized = normalizeOwnerLinkSnapshot({
    ...SNAPSHOT,
    session_status: 'revoked',
    session_revoked_at: '2033-05-18T03:33:25.000Z',
    link_status: 'expired',
  })

  assert.equal(normalized.session_status, 'revoked')
  assert.equal(normalized.session_revoked_at, '2033-05-18T03:33:25.000Z')
  assert.equal(normalized.link_status, 'expired')
})
