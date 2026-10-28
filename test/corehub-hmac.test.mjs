import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createCanonicalRequest,
  createHmacSignature,
  isHmacRequest,
  sha256Hex,
  verifyHmacRequest,
} from '../lib/corehub/hmac.mjs'

const secret = 'staging-only-test-secret-not-for-production'
const timestamp = 1_800_000_000
const nonce = 'nonce-20261023-00000001'
const body = JSON.stringify({
  source: 'CoreNull',
  event_type: 'space.message.created',
  event_id: 'corenull:messages:m-1:v1',
  source_record_id: 'm-1',
  source_revision: 1,
  payload: { message_id: 'm-1', content: 'original' },
})

function signedRequest(rawBody = body, overrides = {}) {
  const method = overrides.method ?? 'POST'
  const url = overrides.url ?? 'https://corehub.example.test/api/corehub/facts'
  const timestampText = String(overrides.timestamp ?? timestamp)
  const requestNonce = overrides.nonce ?? nonce
  const canonical = createCanonicalRequest({
    method,
    path: new URL(url).pathname,
    timestamp: timestampText,
    nonce: requestNonce,
    bodySha256: sha256Hex(rawBody),
  })
  const signature = createHmacSignature(secret, canonical)
  return new Request(url, {
    method,
    headers: {
      Authorization: `CoreHub-HMAC ${signature}`,
      'X-CoreHub-Device-Id': 'corenull-staging-worker-20261023',
      'X-CoreHub-Timestamp': timestampText,
      'X-CoreHub-Nonce': requestNonce,
    },
  })
}

function deviceLookup() {
  return {
    enabled: true,
    sourceCore: 'CoreNull',
    keyVersion: 'corehub-r5-staging-v1',
    secret,
  }
}

test('verifies a valid CoreHub-HMAC request and claims nonce once', async () => {
  const claimed = []
  const result = await verifyHmacRequest(
    signedRequest(),
    body,
    {
      lookupDevice: async (deviceId) => {
        assert.equal(deviceId, 'corenull-staging-worker-20261023')
        return deviceLookup()
      },
      claimNonce: async (claim) => {
        claimed.push(claim)
        return true
      },
      nowMs: () => timestamp * 1000,
    },
  )

  assert.equal(result.ok, true)
  assert.equal(result.kind, 'worker')
  assert.equal(result.deviceId, 'corenull-staging-worker-20261023')
  assert.equal(result.sourceCore, 'CoreNull')
  assert.equal(result.keyVersion, 'corehub-r5-staging-v1')
  assert.equal(result.bodySha256, sha256Hex(body))
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0].deviceId, result.deviceId)
  assert.equal(claimed[0].nonce, nonce)
  assert.equal(isHmacRequest(signedRequest()), true)
})

test('signatures cover the exact raw body', async () => {
  let claimCalls = 0
  const result = await verifyHmacRequest(
    signedRequest(body),
    `${body} `,
    {
      lookupDevice: async () => deviceLookup(),
      claimNonce: async () => { claimCalls += 1; return true },
      nowMs: () => timestamp * 1000,
    },
  )

  assert.deepEqual(result, { ok: false, error: 'invalid_hmac_signature', status: 401 })
  assert.equal(claimCalls, 0)
})

test('rejects an expired timestamp before looking up the device', async () => {
  let lookupCalls = 0
  const result = await verifyHmacRequest(
    signedRequest(body, { timestamp: timestamp - 301 }),
    body,
    {
      lookupDevice: async () => { lookupCalls += 1; return deviceLookup() },
      claimNonce: async () => true,
      nowMs: () => timestamp * 1000,
      maxSkewSeconds: 300,
    },
  )

  assert.deepEqual(result, { ok: false, error: 'hmac_timestamp_out_of_window', status: 401 })
  assert.equal(lookupCalls, 0)
})

test('rejects a live nonce replay after signature verification', async () => {
  const result = await verifyHmacRequest(
    signedRequest(),
    body,
    {
      lookupDevice: async () => deviceLookup(),
      claimNonce: async () => false,
      nowMs: () => timestamp * 1000,
    },
  )

  assert.deepEqual(result, { ok: false, error: 'hmac_replay_detected', status: 401 })
})

test('disabled or secretless devices fail closed', async () => {
  const result = await verifyHmacRequest(
    signedRequest(),
    body,
    {
      lookupDevice: async () => ({ enabled: false, sourceCore: 'CoreNull', keyVersion: 'v1' }),
      claimNonce: async () => { throw new Error('must not be called') },
      nowMs: () => timestamp * 1000,
    },
  )

  assert.deepEqual(result, { ok: false, error: 'device_not_registered_or_disabled', status: 403 })
})

test('registry and nonce service failures are retryable', async () => {
  const registryFailure = await verifyHmacRequest(
    signedRequest(), body,
    {
      lookupDevice: async () => { throw new Error('registry down') },
      claimNonce: async () => true,
      nowMs: () => timestamp * 1000,
    },
  )
  assert.deepEqual(registryFailure, { ok: false, error: 'device_registry_unavailable', status: 503 })

  const nonceFailure = await verifyHmacRequest(
    signedRequest(), body,
    {
      lookupDevice: async () => deviceLookup(),
      claimNonce: async () => { throw new Error('nonce store down') },
      nowMs: () => timestamp * 1000,
    },
  )
  assert.deepEqual(nonceFailure, { ok: false, error: 'nonce_registry_unavailable', status: 503 })
})
