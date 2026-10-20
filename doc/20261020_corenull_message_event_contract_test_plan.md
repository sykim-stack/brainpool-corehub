# CoreHub Message Event Receiver — Contract Test Plan

- Status: test specification only; no receiver implementation or test execution is claimed
- Date: 2026-10-20
- Scope: proposed Stage A `POST /api/corehub/events/space-message`
- Related: `20261020_corenull_message_event_contract.md`

## 1. Goal and boundaries

These tests define the observable contract for the proposed CoreNull Message event receiver. They are not tests of the existing `/api/corehub/facts` endpoint and must not mutate its contract.

Stage A must:
- authenticate the CoreNull worker;
- validate the event envelope and canonical payload hash;
- accept only `source=CoreNull`, `event_type=space.message.created`, and `source_revision=1`;
- durably store an event in the dedicated receive-only `corehub.message_events` model;
- enforce idempotency atomically at the database layer;
- return success only after durable commit;
- never trigger Facts, Connection, Meaning, Opportunity, approval, or promotion processing.

The current repository `package.json` does not define a test script or a test runner. Do not report these tests as passing until a runner and the receiver implementation exist and CI/local execution records the result.

## 2. Canonical payload hash contract

`payload_sha256` is lowercase hexadecimal SHA-256 of the UTF-8 bytes of the canonical JSON serialization of the `payload` object only. Use RFC 8785 JSON Canonicalization Scheme (JCS), or document and approve a compatible alternative before implementation.

Requirements:
- producer and receiver use the same canonicalization rules;
- receiver recomputes the hash rather than trusting the submitted value;
- object-key order does not change the canonical hash;
- semantically distinct payload values must not accidentally normalize to the same canonical bytes;
- test vectors must be shared with CoreNull before end-to-end activation;
- the hash is an integrity check, not producer authentication or a digital signature.

## 3. HTTP and persistence test matrix

| ID | Scenario | Expected result | Persistence assertion |
|---|---|---|---|
| CT-01 | Valid authenticated event, revision 1, correct hash | 201 `accepted` | Exactly one event row committed |
| CT-02 | Exact retry: same event ID and all immutable fields | 200 `duplicate` | No additional row |
| CT-03 | Same event ID, payload differs but hash is updated to match changed payload | 409 `EVENT_IDEMPOTENCY_CONFLICT` | Original row unchanged |
| CT-04 | Same event ID, owner_id differs | 409 `EVENT_IDEMPOTENCY_CONFLICT` | Original row unchanged |
| CT-05 | Same event ID, request source is not allowlisted | 403 `FORBIDDEN_SOURCE` before idempotency lookup | Original row unchanged |
| CT-06 | Same event ID, `space.message.created` revision is not 1 | 422 `REVISION_UNEXPECTED` before idempotency lookup | Original row unchanged |
| CT-07 | Same event ID, occurred_at differs | 409 `EVENT_IDEMPOTENCY_CONFLICT` | Original row unchanged |
| CT-08 | Different event ID reuses same (source, source_record_id, source_revision, event_type) | 409 `EVENT_IDENTITY_CONFLICT` | Original row unchanged |
| CT-09 | Submitted hash does not match receiver-recomputed hash | 422 `PAYLOAD_HASH_MISMATCH` | No row created |
| CT-10 | `space.message.created` with revision other than 1 | 422 `REVISION_UNEXPECTED` | No row created |
| CT-11 | Missing required envelope field / malformed JSON | 400 or 422 validation response, fixed by implementation contract | No row created |
| CT-12 | Missing/invalid HMAC signature, expired timestamp, or replayed nonce | 401 `UNAUTHORIZED` | No row created |
| CT-13 | Authenticated request uses disallowed source | 403 `FORBIDDEN_SOURCE` | No row created |
| CT-14 | Two concurrent identical requests | One 201 and one 200 (or equivalent serialized outcome) | Exactly one row |
| CT-15 | Database insert/commit fails | 5xx, never 200/201 | No partial row |
| CT-16 | Receiver commits but response is lost; producer retries identical event | Retry returns 200 `duplicate` | Exactly one row |
| CT-17 | Receiver stores a valid event | 201 only after commit | No Facts/Connection/Meaning/Opportunity/approval/promotion side effects |
| CT-18 | Logs emitted on success/failure | No secret, bearer value, or full message content | Only approved metadata such as event_id, source_record_id, status, traceId |
| CT-19 | Canonicalization test vector with reordered object keys | Same canonical bytes and hash | No database required |
| CT-20 | Canonicalization test vector with changed string/null/number value | Hash changes when canonical JSON changes | No database required |

### Immutable fields for exact duplicate comparison

Preflight validation order is: verify approved worker HMAC (once ADR-001 is accepted) → validate envelope shape → enforce allowed source/event type/revision → recompute payload hash → perform atomic idempotency lookup/insert. A request that fails preflight returns its designated 4xx code before any duplicate lookup; it must not create or alter a row.

For requests that pass preflight, the duplicate comparison must include all of:
- `source`
- `event_type`
- `source_record_id`
- `source_revision`
- normalized `occurred_at`
- `owner_id`
- canonical `payload`
- `payload_sha256`

Matching `event_id` and `payload_sha256` alone is insufficient. Do not treat a secondary identity conflict as a duplicate.

## 4. Database concurrency requirements

Application pre-checks are not sufficient. Database uniqueness and atomic conflict handling must enforce both:

```text
UNIQUE(event_id)
UNIQUE(source, source_record_id, source_revision, event_type)
```

On unique conflict, reload the existing row in the same well-defined transaction flow and compare the complete immutable set. Return duplicate only for an exact match. Any mismatch returns the designated 409 conflict code.

## 5. Test layering

1. **Pure unit tests:** envelope schema, allowed source/type, revision rule, canonicalization, hash recomputation, immutable-field comparison, response classification.
2. **Database integration tests:** unique constraints, concurrent duplicate requests, identity collision, commit failure behavior, response-loss replay.
3. **Route tests:** authentication boundary, stable status/error mapping, no secret/content logging, no downstream pipeline calls.
4. **CoreNull/CoreHub disposable-staging E2E:** create a single test Message, verify one outbox event and one receiver row, replay the event, and verify row count remains unchanged.

No production data may be used for test fixtures. Never enable the producer against production until the auth ADR, shared hash vectors, migration approval, staging E2E, and rollback/quarantine replay procedure are approved.

## 6. Exit criteria

- [ ] ADR-001 is approved, including HMAC signing fields, key rotation, replay protection, and owner/house ownership verification.
- [ ] Test runner and script are selected and added to the implementation PR.
- [ ] All pure tests pass.
- [ ] Database integration tests pass against disposable PostgreSQL/Supabase staging.
- [ ] Concurrent duplicate and response-loss retry tests prove exactly-once storage effect (not exactly-once network delivery).
- [ ] Existing `/api/corehub/facts` tests and behavior remain unchanged.
- [ ] No downstream learning/Opportunity pipeline is triggered in Stage A.
- [ ] CoreNull and CoreHub canonicalization vectors match byte-for-byte.
- [ ] Test results are recorded with commit SHA and environment; no unrun test is marked passed.
