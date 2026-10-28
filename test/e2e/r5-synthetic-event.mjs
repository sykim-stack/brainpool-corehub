#!/usr/bin/env node

/**
 * R5 synthetic event E2E draft.
 *
 * Dry-run by default. Sending requests requires --execute.
 * Required environment for --execute:
 *   COREHUB_STAGING_URL=https://<staging-host>
 *   COREHUB_HMAC_SECRET_COREHUB_R5_STAGING_V1=<secret>
 *
 * Optional:
 *   COREHUB_R5_DEVICE_ID=corenull-staging-worker-20261023
 *   COREHUB_R5_PATH=/api/corehub/facts
 */

import { createHash, createHmac, randomUUID } from 'node:crypto'

const DEVICE_ID = process.env.COREHUB_R5_DEVICE_ID ?? 'corenull-staging-worker-20261023'
const SECRET = process.env.COREHUB_HMAC_SECRET_COREHUB_R5_STAGING_V1 ?? ''
const BASE_URL = process.env.COREHUB_STAGING_URL ?? ''
const PATH = process.env.COREHUB_R5_PATH ?? '/api/corehub/facts'
const SOURCE = 'CoreNull'
const EVENT_TYPE = 'space.message.created'
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
    throw new Error(
      'COREHUB_HMAC_SECRET_COREHUB_R5_STAGING_V1 is required with --execute',
    )
  }
  if (!/^https?:\/\//i.test(BASE_URL)) {
    throw new Error('COREHUB_STAGING_URL must include http:// or https://')
  }
}

function endpoint() {
  return new URL(PATH, BASE_URL || 'https://staging.invalid').toString()
}

function payloadFor(runId, suffix = '') {
  return {
    message_id: `r5-staging-message-${runId}${suffix}`,
    conversation_id: `r5-staging-conversation-${runId}`,
    content: `R5 synthetic message ${runId}${suffix}`,
    language: 'ko',
  }
}

function eventFor(runId, payload, suffix = '') {
  const sourceRecordId = payload.message_id
  const eventId = `corenull:messages:${sourceRecordId}:v1${suffix}`
  const sourcePayload = JSON.stringify(payload)
  return {
    source: SOURCE,
    event_type: EVENT_TYPE,
    event_id: eventId,
    source_record_id: sourceRecordId,
    source_revision: 1,
    occurred_at: new Date().toISOString(),
    payload_sha256: sha256(sourcePayload),
    payload,
  }
}

function buildRequest(event, { nonce = `nonce-${randomUUID()}`, timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const rawBody = JSON.stringify(event)
  const signature = sign(SECRET || 'dry-run-secret', 'POST', PATH, timestamp, nonce, rawBody)
  return {
    url: endpoint(),
    rawBody,
    nonce,
    timestamp,
    headers: {
      Authorization: `CoreHub-HMAC ${signature}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': event.event_id,
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

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

async function main() {
  assertConfig()

  const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const initialPayload = payloadFor(runId)
  const initialEvent = eventFor(runId, initialPayload)
  const initialRequest = buildRequest(initialEvent)

  console.log(`R5 synthetic E2E run=${runId}`)
  console.log(`device=${DEVICE_ID}`)
  console.log(`endpoint=${endpoint()}`)
  console.log(`mode=${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}`)

  // 1. First delivery must be accepted and mirrored.
  await send('first delivery', initialRequest, 201)

  // 2. Same event with a new transport nonce must be an idempotent duplicate.
  await send('same event duplicate', buildRequest(initialEvent), 200)

  // 3. Same event_id with a different payload must conflict.
  const conflictPayload = payloadFor(runId, '-changed')
  const conflictEvent = {
    ...eventFor(runId, conflictPayload),
    event_id: initialEvent.event_id,
    source_record_id: initialEvent.source_record_id,
    source_revision: initialEvent.source_revision,
  }
  await send('same event different payload', buildRequest(conflictEvent), 409)

  // 4. Reusing the exact transport nonce must be rejected before RPC processing.
  await send('replayed transport nonce', initialRequest, 401)

  // 5. A fresh nonce with a damaged signature must be rejected.
  const badSignatureRequest = buildRequest(eventFor(runId, payloadFor(runId, '-bad-signature')))
  badSignatureRequest.headers.Authorization = `${badSignatureRequest.headers.Authorization.slice(0, -1)}x`
  await send('invalid signature', badSignatureRequest, 401)

  // 6. A correctly signed but expired request must be rejected.
  const staleRequest = buildRequest(
    eventFor(runId, payloadFor(runId, '-stale')),
    { timestamp: Math.floor(Date.now() / 1000) - MAX_SKEW_SECONDS - 1 },
  )
  await send('expired timestamp', staleRequest, 401)

  // 7. Worker-supplied identity must be rejected after HMAC verification.
  const identityEvent = eventFor(runId, payloadFor(runId, '-identity'))
  identityEvent.device_id = DEVICE_ID
  await send('worker body identity field', buildRequest(identityEvent), 400)

  // 8. Worker-supplied top-level house_id must be rejected.
  const houseEvent = eventFor(runId, payloadFor(runId, '-house'))
  houseEvent.house_id = '00000000-0000-4000-8000-000000000001'
  await send('worker top-level house_id', buildRequest(houseEvent), 400)

  // Keep clone imported/used deliberately: this is the fixture-copy boundary for
  // adding future mutation cases without sharing references.
  assertConfig(clone(initialEvent))
  console.log('R5 synthetic E2E sequence completed.')
}

main().catch((error) => {
  console.error(`R5 synthetic E2E failed: ${error.message}`)
  process.exitCode = 1
})
