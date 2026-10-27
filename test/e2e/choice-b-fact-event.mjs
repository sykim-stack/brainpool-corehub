#!/usr/bin/env node

/**
 * Choice B CoreRing Fact E2E (worker → process_fact_event + device_id).
 *
 * Dry-run by default. Sending requires --execute and:
 *   COREHUB_STAGING_URL=https://<staging-host>
 *   COREHUB_HMAC_SECRET_COREHUB_R5_STAGING_V1=<secret>
 *
 * Optional:
 *   COREHUB_R5_DEVICE_ID=corering-staging-device-001
 *   COREHUB_R5_PATH=/api/corehub/facts
 *
 * Prerequisite: device_registry row for DEVICE_ID with source_core CoreRing
 * and key_version corehub-r5-staging-v1; Choice B migration applied.
 */

import { createHash, createHmac, randomUUID } from 'node:crypto'

const DEVICE_ID = process.env.COREHUB_R5_DEVICE_ID ?? 'corering-staging-device-001'
const SECRET = process.env.COREHUB_HMAC_SECRET_COREHUB_R5_STAGING_V1 ?? ''
const BASE_URL = process.env.COREHUB_STAGING_URL ?? ''
const PATH = process.env.COREHUB_R5_PATH ?? '/api/corehub/facts'
const SOURCE = 'CoreRing'
const MAX_SKEW_SECONDS = 300
const EXECUTE = process.argv.includes('--execute')

function sha256(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')
}

function sign(secret, method, path, timestamp, nonce, rawBody) {
  const bodyHash = sha256(rawBody)
  const canonical = [method.toUpperCase(), path, String(timestamp), nonce, bodyHash].join('\n')
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('base64url')
}

function assertConfig() {
  if (!EXECUTE) return
  if (!BASE_URL) throw new Error('COREHUB_STAGING_URL is required with --execute')
  if (!SECRET) {
    throw new Error('COREHUB_HMAC_SECRET_COREHUB_R5_STAGING_V1 is required with --execute')
  }
  if (!/^https?:\/\//i.test(BASE_URL)) {
    throw new Error('COREHUB_STAGING_URL must include http:// or https://')
  }
}

function endpoint() {
  return new URL(PATH, BASE_URL || 'https://staging.invalid').toString()
}

function factFor(runId, suffix = '') {
  const conversationId = `choice-b-conv-${runId}`
  return {
    source: SOURCE,
    fact_type: 'language.translated',
    occurred_at: new Date().toISOString(),
    payload: {
      conversation_id: conversationId,
      text: `Choice B synthetic translation ${runId}${suffix}`,
      target_lang: 'ko',
    },
  }
}

function buildRequest(fact, idempotencyKey, {
  nonce = `nonce-${randomUUID()}`,
  timestamp = Math.floor(Date.now() / 1000),
} = {}) {
  const rawBody = JSON.stringify(fact)
  const signature = sign(SECRET || 'dry-run-secret', 'POST', PATH, timestamp, nonce, rawBody)
  return {
    url: endpoint(),
    rawBody,
    nonce,
    timestamp,
    headers: {
      Authorization: `CoreHub-HMAC ${signature}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      'X-CoreHub-Device-Id': DEVICE_ID,
      'X-CoreHub-Timestamp': String(timestamp),
      'X-CoreHub-Nonce': nonce,
    },
  }
}

async function send(label, request, expectedStatus) {
  if (!EXECUTE) {
    console.log(`[dry-run] ${label}: POST ${request.url} expected=${expectedStatus}`)
    return { status: expectedStatus, body: { dryRun: true } }
  }

  const response = await fetch(request.url, {
    method: 'POST',
    headers: request.headers,
    body: request.rawBody,
  })
  const text = await response.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text.slice(0, 500) }
  }

  console.log(`${label}: status=${response.status}`, JSON.stringify(body))
  if (response.status !== expectedStatus) {
    throw new Error(`${label}: expected HTTP ${expectedStatus}, got ${response.status}`)
  }
  return { status: response.status, body }
}

async function main() {
  assertConfig()

  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const idemKey = `corering:language.translated:${runId}:v1`
  const initialFact = factFor(runId)
  const initialRequest = buildRequest(initialFact, idemKey)

  console.log(`Choice B Fact E2E run=${runId}`)
  console.log(`device=${DEVICE_ID}`)
  console.log(`endpoint=${endpoint()}`)
  console.log(`mode=${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}`)

  await send('F1 first delivery', initialRequest, 201)
  await send('F2 same fact duplicate', buildRequest(initialFact, idemKey), 200)

  const conflictFact = factFor(runId, '-changed')
  await send('F3 same key different payload', buildRequest(conflictFact, idemKey), 409)

  await send('F4 replayed transport nonce', initialRequest, 401)

  const badSig = buildRequest(factFor(runId, '-bad-sig'), `corering:language.translated:${runId}:bad-sig`)
  badSig.headers.Authorization = `${badSig.headers.Authorization.slice(0, -1)}x`
  await send('F5 invalid signature', badSig, 401)

  const stale = buildRequest(
    factFor(runId, '-stale'),
    `corering:language.translated:${runId}:stale`,
    { timestamp: Math.floor(Date.now() / 1000) - MAX_SKEW_SECONDS - 1 },
  )
  await send('F6 expired timestamp', stale, 401)

  const withDevice = { ...factFor(runId, '-identity'), device_id: DEVICE_ID }
  await send(
    'F7 worker body device_id',
    buildRequest(withDevice, `corering:language.translated:${runId}:identity`),
    400,
  )

  const withHouse = {
    ...factFor(runId, '-house'),
    house_id: '00000000-0000-4000-8000-000000000001',
  }
  await send(
    'F8 worker top-level house_id',
    buildRequest(withHouse, `corering:language.translated:${runId}:house`),
    400,
  )

  const withOwner = { ...factFor(runId, '-owner'), owner_key: 'should-reject' }
  await send(
    'F9 worker body owner_key',
    buildRequest(withOwner, `corering:language.translated:${runId}:owner`),
    400,
  )

  console.log('Choice B Fact E2E sequence completed.')
}

main().catch((error) => {
  console.error(`Choice B Fact E2E failed: ${error.message}`)
  process.exitCode = 1
})
