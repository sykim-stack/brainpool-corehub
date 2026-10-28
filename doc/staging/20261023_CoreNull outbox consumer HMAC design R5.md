# CoreHub CoreNull outbox consumer 설계 R5

_상태: 설계 초안 — 코드·DB migration·배포 미실행_
_기준일: 2026-10-23_
_관련: CoreNull Message outbox 설계 v1, CoreHub PR #2, R5 HMAC/device 주체 스케치_

## 1. 목적

CoreNull durable outbox worker가 전송하는 Message event를 CoreHub가 수신·검증·멱등 처리·격리하는 consumer 경계를 정의한다.

R5에서는 두 가지 POST 주체를 분리한다.

```text
Bearer user request
  → verified auth.users.id
  → 기존 user/house ownership contract

CoreHub-HMAC worker request
  → verified device_id claim
  → device-scoped event contract
```

두 주체를 하나의 느슨한 `owner_id` 분기로 처리하지 않는다. worker의 `device_id`를 `owner_id`, `owner_key`, `house_id`로 변환하거나 추정하지 않는다.

이 문서는 consumer 설계만 정의한다. 실제 reference DB 생성, migration, secret 발급, 운영 endpoint 활성화는 별도 승인 대상이다.

## 2. R5 결정 요약

### 결정 A — 인증 주체별 POST 분기

`authenticateRequest`는 다음 중 하나를 반환한다.

```js
{ kind: 'user', userId: '<verified auth.users.id>' }
{ kind: 'worker', deviceId: '<verified registered device id>' }
```

실패 시 다음을 구분한다.

```text
401 invalid/missing Bearer or HMAC
403 disabled/unregistered device or scope violation
503 auth/key registry unavailable
```

### 결정 B — worker는 body identity를 보내지 않음

worker request body에서 다음 필드를 권한 근거로 받지 않는다.

```text
owner_id
owner_key
auth_user_id
device_id
```

`device_id`는 HMAC credential lookup 결과에서만 얻는다. body의 `device_id`가 있어도 거부한다.

### 결정 C — worker의 top-level `house_id`는 거부

R5 worker POST에서는 top-level `house_id`를 허용하지 않는다. worker가 임의 house UUID를 보내 권한을 확장하는 것을 막기 위함이다.

house-scoped 처리로 확장하려면 다음 별도 계약이 모두 필요하다.

- device → house allowlist registry
- registry 기반 server-side house resolution
- device/house 복합 멱등성
- cross-house isolation test
- 별도 승인된 R5.x contract

그 전까지 worker event의 CoreHub 처리 scope는 `device_id`다. payload 내부에 들어온 `house_id`도 authorization 근거로 사용하지 않는다.

## 3. 수신 endpoint 계약

```http
POST /api/corehub/facts
Authorization: Bearer <Supabase access token>
Idempotency-Key: <stable event key>
Content-Type: application/json
```

또는:

```http
POST /api/corehub/facts
Authorization: CoreHub-HMAC <signature>
X-CoreHub-Device-Id: <registered device id>
X-CoreHub-Timestamp: <unix seconds>
X-CoreHub-Nonce: <one-time nonce>
Idempotency-Key: <stable event key>
Content-Type: application/json
```

HMAC header의 최종 이름과 canonical string은 R5 ADR에서 확정한다. 위 이름은 설계 placeholder이며 임의의 구현을 승인하지 않는다.

## 4. HMAC 검증 절차

### 4.1 검증 순서

1. HTTP method와 path를 확인한다.
2. `X-CoreHub-Device-Id`, timestamp, nonce, signature의 존재를 확인한다.
3. device registry에서 활성 device와 key version을 조회한다.
4. timestamp 허용 window를 확인한다.
5. raw body bytes의 SHA-256을 계산한다.
6. canonical signing string을 구성한다.
7. 저장된 secret으로 HMAC을 계산한다.
8. constant-time compare를 수행한다.
9. nonce replay를 원자적으로 차단한다.
10. 성공한 경우에만 `deviceId`를 consumer context에 전달한다.

### 4.2 제안 canonical string

```text
POST
/api/corehub/facts
<timestamp>
<nonce>
<sha256(raw_body)>
```

```text
signature = base64url(HMAC-SHA256(device_secret, canonical_string))
```

다음은 서명 대상에 포함하지 않는다.

- parsed body에서 다시 만든 JSON
- owner_key
- client가 보낸 device_id
- house_id
- access token

raw body와 payload canonicalization을 혼동하지 않는다. HMAC transport integrity는 raw body hash로, event idempotency는 event payload hash로 각각 검증한다.

### 4.3 Replay 방지

- timestamp가 허용 window를 벗어나면 `401` 또는 `403`으로 거부한다.
- nonce는 `(device_id, nonce)` unique로 저장하거나 동등한 atomic replay cache로 보호한다.
- 같은 nonce를 다른 body로 재사용해도 통과시키지 않는다.
- retry는 같은 event_id와 Idempotency-Key를 유지하되, transport nonce/signature는 새로 발급할 수 있다.
- replay cache 장애는 fail open하지 않고 `503`으로 처리한다.

## 5. 공통 event envelope

CoreNull outbox가 보내는 Stage A event는 다음 형식을 사용한다.

```json
{
  "source": "CoreNull",
  "event_type": "space.message.created",
  "event_id": "corenull:messages:<message_id>:v<source_revision>",
  "source_record_id": "<message_id>",
  "source_revision": 1,
  "occurred_at": "2026-10-23T00:00:00.000Z",
  "payload": {
    "message_id": "<message_id>",
    "room_id": "<room_id-or-null>",
    "type": "post",
    "content": "<original-content>",
    "meta": {},
    "relations": {},
    "language": "ko",
    "translated_ko": null,
    "translation_status": "completed",
    "harvested_at": null,
    "created_at": "2026-10-23T00:00:00.000Z"
  },
  "payload_sha256": "<canonical-payload-sha256>"
}
```

필수 규칙:

- `event_id`는 retry 때 변경하지 않는다.
- `source_record_id + source_revision + event_type`는 하나의 source event를 식별한다.
- body에 `owner_id`, `owner_key`, `auth_user_id`, `device_id`가 있으면 user/worker 모두 거부한다.
- worker body의 top-level `house_id`는 거부한다.
- payload의 `house_id`가 존재하더라도 worker 권한 검증에 사용하지 않는다.
- source revision과 payload hash가 event identity와 일치해야 한다.

## 6. POST 처리 분기

### 6.1 Bearer user

기존 PR #2 경로를 유지한다.

```text
authenticateRequest → userId
  → body identity fields reject
  → house_id가 있으면 verified user ownership query
  → corehub.process_fact_event
  → owner_id=userId
```

user request는 `house_id`를 사용할 수 있지만, canonical CoreNull house mapping과 verified Auth UID가 staging에서 확정된 경우에만 허용한다.

### 6.2 HMAC worker

worker 경로는 기존 user RPC에 `owner_id=null`을 억지로 넣지 않는다.

```text
authenticateRequest → deviceId
  → body identity fields reject
  → top-level house_id reject
  → source/event allowlist check
  → event schema + revision + payload hash check
  → corehub.process_device_fact_event
  → device_id=deviceId, owner_id=NULL
```

`process_device_fact_event`는 user RPC와 별도의 security-definer RPC로 설계한다. 단순히 기존 RPC에 nullable owner를 추가하면 다음 위험이 생긴다.

- user/device Fact의 unique key 충돌
- owner 기반 connection matching에 device event 혼입
- device A와 device B의 event 연결
- `owner_id IS NULL` legacy row와 새 worker row 혼합
- house ownership 우회

## 7. Device-scoped storage contract

기존 `corehub.facts`를 확장할지 별도 ingress table을 둘지는 migration review에서 결정한다. R5 minimum contract는 다음 필드를 필요로 한다.

```text
subject_type       text   -- user | device
owner_id           uuid   null
subject_device_id  text   null
event_id           text   not null
source             text   not null
fact_type          text   not null
source_record_id   text   not null
source_revision    bigint not null
occurred_at        timestamptz not null
payload            jsonb not null
payload_sha256     text not null
processed          boolean not null default false
```

제약:

```text
user event:   subject_type='user',   owner_id is not null, subject_device_id is null
device event: subject_type='device', owner_id is null,     subject_device_id is not null
```

멱등성 unique scope:

```text
(user_id,   source, event_id)
(device_id, source, event_id)
```

`event_id`만 전역 unique로 강제할지는 source contract가 전역 namespace를 보장하는지 확인한 후 결정한다.

## 8. Device RPC 처리 계약

논리 signature:

```text
corehub.process_device_fact_event(
  p_device_id,
  p_source,
  p_fact_type,
  p_event_id,
  p_source_record_id,
  p_source_revision,
  p_occurred_at,
  p_payload,
  p_payload_sha256
) returns jsonb
```

RPC 내부 처리:

1. `p_device_id`가 request context의 HMAC claim과 같은지 확인한다.
2. `source='CoreNull'`이고 `fact_type='space.message.created'`인지 allowlist 확인한다.
3. source record/revision/payload hash를 검증한다.
4. device-scoped idempotency row를 insert한다.
5. 같은 event ID·같은 hash면 duplicate response를 반환한다.
6. 같은 event ID·다른 hash면 `409` conflict를 발생시킨다.
7. device-scoped source event 또는 mirror row를 transaction 안에 저장한다.
8. user/house ownership 기반 derived connection을 자동 생성하지 않는다.
9. 처리 결과와 audit identity를 반환한다.

R5 Stage A에서는 CoreNull Message event를 바로 user-owned `connections`, `meanings`, `opportunities`로 해석하지 않는다. 먼저 source event/mirror integrity를 증명한다.

## 9. CoreNull Message mirror 처리

최소 mirror record는 다음 provenance를 갖는다.

```text
source_core       = CoreNull
source_table      = messages
source_record_id  = messages.id
source_revision   = messages.source_revision
source_event_id   = outbox.event_id
source_fingerprint= payload_sha256
snapshot_payload  = immutable Message snapshot
captured_at       = CoreHub receive/commit time
subject_device_id = HMAC device claim
```

mirror는 원본이 아니다.

- CoreHub가 Message content를 수정하지 않는다.
- CoreHub의 derived interpretation은 Message snapshot을 대체하지 않는다.
- duplicate 수신은 새 mirror row를 만들지 않는다.
- 같은 source identity에 다른 payload가 오면 conflict/quarantine한다.
- 승인 없이 CoreNull로 promotion하지 않는다.

## 10. conversation_id 계약

R5에서 translated와 chat을 device scope로 연결하려면 두 event가 같은 안정적인 `payload.conversation_id`를 보내야 한다.

권장 규칙:

```text
conversation_id = CoreRing/CoreNull가 합의한 stable room/thread identifier
```

금지:

- 매 요청마다 새 random UUID
- content hash만으로 conversation 생성
- 최근 시간/같은 device라는 이유만으로 자동 연결
- room_id를 별도 합의 없이 conversation_id로 가정

Stage R5의 cross-language matching은 다음 조건을 모두 요구한다.

```text
subject_device_id 동일
payload.conversation_id 동일
language.translated가 먼저 도착
두 event의 source/event schema가 allowlist
```

`conversation_id` 합의가 없으면 translated와 chat은 수신하되 연결하지 않는다. 존재하지 않는 연결을 추론하지 않는다.

## 11. 응답 및 retry 의미

| 상황 | HTTP | Worker 동작 |
|---|---:|---|
| 신규 처리 성공 | 201 | `sent` |
| 동일 event·동일 payload replay | 200 | `sent`, duplicate metric |
| malformed JSON/schema | 400 | quarantine |
| HMAC invalid/expired | 401 | credential audit 후 quarantine |
| device disabled/scope denied | 403 | quarantine |
| same key·different payload | 409 | quarantine/conflict |
| replay cache/key registry unavailable | 503 | 같은 event retry |
| database/RPC transient error | 503 | 같은 event retry |

Retry 시 다음은 유지한다.

```text
event_id
source_record_id
source_revision
payload
payload_sha256
Idempotency-Key
```

Transport timestamp, nonce, HMAC signature는 새 전송 시 새로 만들 수 있다.

## 12. 관측·감사

로그에는 다음만 남긴다.

```text
trace_id
event_id
source_record_id
source_revision
device_id 또는 user_id
subject_type
http_status
result: accepted|duplicate|conflict|quarantined|retry
latency_ms
```

다음은 로그에 남기지 않는다.

- HMAC secret
- Bearer token
- raw signature
- Message content 전체
- payload 내 민감정보 전체

운영 metric:

```text
corehub_consumer_received_total{source,subject_type,event_type}
corehub_consumer_accepted_total{source,subject_type}
corehub_consumer_duplicate_total{source,subject_type}
corehub_consumer_conflict_total{source,subject_type}
corehub_consumer_quarantine_total{reason}
corehub_consumer_retry_total{status}
corehub_hmac_replay_rejected_total{device_id}
corehub_consumer_lease_stale_total
```

`device_id`를 metric label로 사용할 때 cardinality와 민감도 정책을 별도 확인한다.

## 13. Reference DB 최소 구성 제안

원본 DB가 삭제되어도 CoreHub가 받은 provenance와 snapshot을 보존할 수 있도록, 별도 reference/staging DB에는 최소한 다음 영역만 둔다.

```text
corehub.device_registry
corehub.device_nonces
corehub.source_events
corehub.message_mirror
corehub.consumer_quarantine
corehub.consumer_audit
```

역할:

- `device_registry`: device id, source allowlist, active/key version, enabled status. secret 원문 저장 금지.
- `device_nonces`: HMAC replay 방지 TTL record.
- `source_events`: immutable ingress event와 payload hash.
- `message_mirror`: CoreNull Message snapshot/provenance.
- `consumer_quarantine`: 자동 재처리하지 않는 conflict/auth/schema 사건.
- `consumer_audit`: 처리 결과와 trace metadata append-only 기록.

이 reference DB는 CoreNull 원본 DB의 대체 소유자가 아니다. 삭제된 원본을 복원할 수 있다는 보장도 하지 않는다. CoreHub가 실제로 수신·commit한 snapshot만 보존한다.

## 14. Staging 검증 matrix

### Authentication

- [ ] 정상 Bearer user는 user branch로만 처리
- [ ] 정상 HMAC worker는 device branch로만 처리
- [ ] Bearer와 HMAC이 동시에 있으면 명확한 우선순위 또는 거부
- [ ] body device_id/owner_id/owner_key 위조는 거부
- [ ] invalid signature, expired timestamp, reused nonce 차단
- [ ] disabled/unregistered device 차단
- [ ] key registry 장애는 503 fail closed

### Scope

- [ ] device A event가 device B storage/connection과 섞이지 않음
- [ ] worker top-level house_id는 거부
- [ ] payload house_id는 권한 근거로 사용하지 않음
- [ ] user event와 device event가 동일 idempotency namespace를 공유하지 않음
- [ ] device event는 user-owned derived relation을 만들지 않음

### Integrity

- [ ] source_record_id + revision + event type duplicate
- [ ] same key/same hash → 200 duplicate
- [ ] same key/different hash → 409 quarantine
- [ ] payload hash 변조 → reject
- [ ] revision 2 before revision 1 → pending/quarantine policy 적용
- [ ] retry 후 source event snapshot 불변

### Conversation

- [ ] translated/chat 양쪽에 동일 conversation_id가 있으면 같은 device scope에서만 연결
- [ ] conversation_id 불일치 시 연결하지 않음
- [ ] conversation_id 누락 시 연결하지 않음
- [ ] 다른 device의 같은 conversation_id를 연결하지 않음

### Reliability

- [ ] CoreHub 503 후 같은 event retry
- [ ] 401/403/409는 무한 retry하지 않음
- [ ] worker lease expiry 후 stale completion 차단
- [ ] duplicate 수신에서 mirror 중복 생성 없음
- [ ] CoreHub commit 전 응답 손실 후 retry가 안전함

## 15. 구현 순서와 게이트

1. R5 ADR에서 HMAC header, canonical string, device registry ownership을 확정한다.
2. CoreNull과 CoreRing에서 device_id 및 conversation_id source contract를 확정한다.
3. disposable reference DB에 device registry, nonce, source event, mirror, quarantine schema를 제안한다.
4. user RPC와 별도의 device RPC pure tests를 작성한다.
5. HMAC replay·body identity reject·house reject 테스트를 통과한다.
6. CoreNull outbox worker와 CoreHub staging consumer를 E2E로 연결한다.
7. same event duplicate/conflict와 503 retry/lease takeover를 검증한다.
8. evidence를 R5 checklist에 기록한다.
9. 이후에만 실제 staging migration을 별도 승인받아 실행한다.
10. 운영 HMAC credential 발급과 endpoint activation은 별도 승인한다.

현재 문서 작성만으로는 reference DB 생성, HMAC secret 발급, CoreHub API 활성화, CoreNull 원본 변경, CoreRing 호출부 변경을 승인하지 않는다.
