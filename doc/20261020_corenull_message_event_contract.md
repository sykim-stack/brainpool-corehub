# CoreHub ← CoreNull Message Event 수신 계약 v1

*상태: 설계 초안 — 운영 migration·DB write·수신 경로 변경 미실행*
*기준일: 2026-10-20*
*소유자: CoreHub 수신 / CoreNull producer 계약과 공동 검토 필요*
*관련: CoreNull `CORENULL_COREHUB_MESSAGE_OUTBOX_DESIGN_v1.md` (PR #24)*

## 1. 목적과 불변 원칙

CoreNull durable outbox가 전송하는 `space.message.created` event를 안정적으로 수신·저장한다.

이 문서는 구현·migration 실행 문서가 아니다. 현재 운영 DB와 수신 경로에는 아무 변경도 적용하지 않는다.

고정 원칙:

- CoreHub는 CoreNull Message 원본의 **관찰 event**만 수신한다. 승인·promotion·판단은 하지 않는다.
- 기존 `owner_key` 중심 Fact 모델과의 호환을 깨지 않으면서, verified Auth UID 기반 계약을 병행 도입한다.
- 동일 `event_id`의 재전송은 멱등(idempotent)으로 처리한다. 중복 생성하지 않는다.
- CoreNull outbox가 보낸 payload를 임의로 재해석하거나 content를 변경하지 않는다.
- 수신 실패(인증 실패, revision conflict, schema 불일치)는 CoreNull outbox를 quarantine으로 유도할 수 있는 명확한 HTTP status로 응답한다.
- Stage A에서는 `space.message.created`만 수신 대상으로 한다.

## 2. 현재 확인된 상태

### 2.1 기존 Facts API (`POST /api/corehub/facts`)

현재 구현 특성:

- Authorization 헤더 검증 없음
- Idempotency-Key / event_id 검증 없음
- `owner_key`를 body에서 직접 신뢰
- 중복 방지 unique 제약 없음
- HTTP 200/500만 사용 (기존 코딩 계약)
- fire-and-forget Connection 탐지

이 경로는 기존 CoreNull `pushFact()` 및 다른 Core들의 단순 Fact push와 호환을 위해 **당분간 유지**한다.

새로운 CoreNull Message outbox 경로는 **별도 수신 계약**을 사용한다. 기존 `/api/corehub/facts`를 바로 교체하지 않는다.

### 2.2 CoreNull producer 계약 요약 (대칭)

CoreNull 쪽:

- Message write + outbox insert를 동일 transaction으로 수행
- event_id = `corenull:messages:<message_id>:v<source_revision>`
- Stage A: `space.message.created`만 전송
- verified `auth_user_id`만 CoreHub producer 활성화
- 401/403/409 → quarantine, 5xx/429 → retry

## 3. 수신 엔드포인트 제안

### 3.1 권장 경로

```text
POST /api/corehub/events/space-message
```

또는 (기존 구조 유지 선호 시)

```text
POST /api/corehub/facts
```

에 `event_id` + `source_revision` + Authorization이 있으면 **새 계약 경로**로 분기.

문서에서는 명확성을 위해 **전용 경로**를 권장한다. 최종 경로는 구현 시 확정.

### 3.2 Request Headers

| Header | 필수 | 의미 |
|--------|------|------|
| `Authorization` | 필수 | Bearer token 또는 CoreNull worker용 shared secret (ADR로 확정) |
| `Idempotency-Key` | 권장 | `event_id`와 동일 값 권장 |
| `Content-Type` | 필수 | `application/json` |
| `X-CoreNull-Source` | 선택 | `CoreNull` |

### 3.3 Request Body (Event Envelope)

CoreNull outbox가 보내는 envelope를 그대로 수신한다.

```json
{
  "source": "CoreNull",
  "event_type": "space.message.created",
  "event_id": "corenull:messages:<message_id>:v<source_revision>",
  "source_record_id": "<messages.id>",
  "source_revision": 1,
  "occurred_at": "<transaction-time ISO8601>",
  "owner_id": "<verified-auth.users.id>",
  "house_id": "<messages.house_id>",
  "room_id": "<messages.room_id>",
  "payload": {
    "message_id": "<messages.id>",
    "house_id": "<messages.house_id>",
    "room_id": "<messages.room_id>",
    "type": "post",
    "content": "<original>",
    "meta": {},
    "relations": {},
    "language": "ko",
    "translated_ko": null,
    "translation_status": "completed",
    "harvested_at": null,
    "created_at": "<messages.created_at>"
  },
  "payload_sha256": "<canonical-json-sha256>"
}
```

필수 필드:

```text
source
event_type
event_id
source_record_id
source_revision
occurred_at
owner_id
payload
payload_sha256
```

`house_id`, `room_id`는 가능하면 포함. 없어도 수신 자체는 거부하지 않는다 (Stage A).

### 3.4 필드 매핑 (CoreHub 내부)

| Envelope 필드 | CoreHub 내부 의미 | 비고 |
|---------------|-------------------|------|
| `owner_id` | verified Auth UID | CoreNull의 `auth_user_id` |
| `source` | Fact source | 기존 `source` 컬럼과 동일 |
| `event_type` | fact_type | `space.message.created` |
| `event_id` | 멱등 키 | UNIQUE |
| `source_revision` | ordering / conflict 판단 | |
| `payload` | Fact payload | 원본 snapshot 보존 |
| `payload_sha256` | integrity check | |

기존 `owner_key` 컬럼과의 관계:

- Stage A에서는 `owner_id`(Auth UID)를 primary actor로 저장한다.
- legacy `owner_key`가 필요한 하위 엔진(Connection/Meaning)이 있으면, CoreHub 내부 mapping table 또는 join으로 해석한다.
- envelope의 `owner_id`를 `owner_key` 자리에 그대로 넣지 않는다.

## 4. 멱등성 (Idempotency) 규칙

### 4.1 키

```text
event_id  (예: corenull:messages:550e8400-e29b-41d4-a716-446655440000:v1)
```

### 4.2 동작

1. 동일 `event_id`가 이미 존재하고 `payload_sha256`이 동일하면 → **200 OK** (또는 201과 구분하여 200) + 기존 fact_id 반환. 새로 insert하지 않음.
2. 동일 `event_id`가 존재하는데 `payload_sha256`이 다르면 → **409 EVENT_PAYLOAD_CONFLICT**.
3. `event_id`는 없고 `(source_record_id, source_revision, event_type)` 조합이 이미 있으면 → **409 EVENT_IDENTITY_CONFLICT** (또는 동일 취급).
4. 신규이면 insert 후 **201 Created** (또는 기존 계약에 맞춰 200 + data).

### 4.3 권장 unique 제약 (논리)

```text
UNIQUE(event_id)
UNIQUE(source, source_record_id, source_revision, event_type)
```

## 5. Source revision 처리

### 5.1 Stage A 범위

- `space.message.created`만 수신.
- 동일 `source_record_id`에 대해 revision 1만 기대.

### 5.2 미래 확장 (현 단계 구현하지 않음)

```text
space.message.updated
space.message.archived
space.message.deleted
space.message.harvested
```

이 event들이 추가될 때:

- 동일 `source_record_id`에 대해 revision이 단조 증가하는지 검증 가능.
- revision N이 없는데 N+1이 먼저 도착하면 CoreHub policy로 pending 또는 quarantine.
- Stage A에서는 이 로직을 구현하지 않는다.

### 5.3 현재 권장 응답

- revision이 1이 아닌 `space.message.created` → **422** 또는 **409 REVISION_UNEXPECTED** (정책 확정 후).
- 당장은 유연하게 수신하고 로그만 남겨도 됨 (구현 시 결정).

## 6. 인증·인가

### 6.1 원칙

- CoreNull worker만 이 경로를 호출할 수 있어야 한다.
- client / browser / 임의 Core가 직접 호출하는 경로가 아니다.

### 6.2 후보 방식 (ADR로 확정)

| 방식 | 장점 | 단점 |
|------|------|------|
| Shared secret (Bearer 또는 X-CoreNull-Token) | 구현 단순 | 키 관리 필요 |
| Supabase service role + 추가 claim 검증 | 기존 인프라 활용 | 범위 과다 위험 |
| mTLS / Vercel 내부 네트워크 | 강력 | Hobby 플랜 제약 |

**권장 (초안)**: CoreNull worker 환경변수에 주입된 shared secret을 `Authorization: Bearer <secret>`으로 전달. CoreHub는 환경변수와 constant-time 비교.

### 6.3 실패 응답

| 상황 | HTTP Status | error_code 예 |
|------|-------------|----------------|
| Authorization 없음/불일치 | 401 | UNAUTHORIZED |
| secret은 맞지만 허용되지 않은 source | 403 | FORBIDDEN_SOURCE |
| 필수 필드 누락 | 400 또는 422 | VALIDATION_ERROR |
| event_id 중복 + payload 불일치 | 409 | EVENT_PAYLOAD_CONFLICT |
| 내부 오류 | 500 / 503 | INTERNAL_ERROR |

CoreNull outbox worker는:

- 401 / 403 / 409 → quarantine
- 408 / 429 / 5xx / network → retry

이 매핑을 깨지 않도록 status를 안정적으로 유지한다.

## 7. 저장 모델 제안 (논리)

기존 `corehub.facts`를 확장하거나, Message 전용 수신 테이블을 둘 수 있다.

### 옵션 A — 기존 facts 확장 (권장 검토)

```text
corehub.facts 에 추가 컬럼 (논리)
---------------------------------
event_id          text unique
source_record_id  uuid
source_revision   bigint
owner_id          uuid          -- verified Auth UID
payload_sha256    text
```

기존 `owner_key` 컬럼은 nullable로 유지하거나, legacy Fact용으로만 사용.

### 옵션 B — 전용 테이블

```text
corehub.message_events
----------------------
id uuid primary key
event_id text not null unique
source text not null
event_type text not null
source_record_id uuid not null
source_revision bigint not null
owner_id uuid not null
house_id uuid
room_id uuid
payload jsonb not null
payload_sha256 text not null
occurred_at timestamptz not null
received_at timestamptz not null default now()
fact_id uuid null          -- 후속 Fact로 promote된 경우
```

옵션 B는 기존 Fact 파이프라인과 격리되어 안전하지만, Connection/Meaning 엔진 연동을 추가 작업으로 남겨둔다.

**Stage A 권장**: 옵션 A 또는 B 중 하나를 선택하되, **기존 `/api/corehub/facts` 동작과 row를 변경하지 않는** 방향으로 진행.

## 8. Response 계약

### 성공 (신규)

```json
{
  "data": {
    "event_id": "corenull:messages:...",
    "fact_id": "<uuid>",
    "status": "accepted"
  },
  "traceId": "<uuid>"
}
```
HTTP 201 (또는 기존 계약 유지 시 200)

### 성공 (멱등 재전송)

```json
{
  "data": {
    "event_id": "corenull:messages:...",
    "fact_id": "<existing-uuid>",
    "status": "duplicate"
  },
  "traceId": "<uuid>"
}
```
HTTP 200

### 실패 예

```json
{
  "_error": "EVENT_PAYLOAD_CONFLICT",
  "message": "event_id exists with different payload_sha256",
  "traceId": "<uuid>"
}
```
HTTP 409

## 9. 처리 파이프라인과의 관계

수신 직후:

1. event를 durable하게 저장 (멱등).
2. 기존 Connection → Meaning → Opportunity 파이프라인 트리거는 **선택적**으로 연결.
3. Stage A에서는 저장 성공만으로 CoreNull outbox를 `sent` 처리할 수 있게 한다.
4. 파이프라인 실패가 수신 자체를 실패로 만들지 않는다 (fire-and-forget 또는 별도 큐).

CoreHub는 “관찰 event를 받았음”을 보장할 뿐, Opportunity 생성까지를 수신 성공 조건으로 삼지 않는다.

## 10. RLS·credential 경계

- 이 수신 경로는 service/worker 전용. client RLS로 노출하지 않는다.
- CoreNull shared secret은 CoreHub 환경변수로만 주입. DB나 response에 기록하지 않는다.
- payload content 전체를 일반 로그에 남기지 않는다. `event_id`, `source_record_id`, `status`, `traceId` 위주.
- 기존 Facts API(인증 없음)와 새 계약 경로를 명확히 분리하여, 구 경로가 신 계약의 보안 경계를 우회하지 못하게 한다.

## 11. Staging 검증 시나리오

### Auth

- [ ] 올바른 secret → 수신 성공
- [ ] secret 없음/틀림 → 401
- [ ] 허용되지 않은 source → 403

### Idempotency

- [ ] 동일 event_id + 동일 payload_sha256 재전송 → 200 duplicate, row 증가 없음
- [ ] 동일 event_id + 다른 payload_sha256 → 409
- [ ] 서로 다른 event_id는 각각 저장

### Envelope

- [ ] 필수 필드 누락 → 4xx
- [ ] payload_sha256 불일치(서버 재계산 vs 전송값) → 정책에 따라 422 또는 경고 로그
- [ ] owner_id가 Auth UID 형식인지 기본 검증

### CoreNull 연동

- [ ] CoreNull outbox worker가 201/200을 받으면 sent로 finalize
- [ ] 401/403/409를 받으면 quarantine
- [ ] 503을 받으면 retry_wait

### 격리

- [ ] 기존 `/api/corehub/facts` (legacy) 동작 불변
- [ ] 기존 facts row count / payload 불변

## 12. 구현 순서 (CoreHub)

1. 이 계약 문서를 CoreNull producer 문서와 교차 검토·승인.
2. Authentication ADR (shared secret vs 다른 방식) 확정.
3. 저장 모델(옵션 A/B) 선택 및 staging SQL 초안 작성 (실행하지 않음).
4. 수신 핸들러 pure contract 테스트 (멱등, status code).
5. disposable staging에서 CoreNull outbox worker와 E2E.
6. 기존 Facts API와의 공존 확인.
7. 승인 후에만 운영 반영 검토.

## 13. 운영 적용 차단 조건

다음 조건 전에는 CoreNull 실데이터 수신 경로를 활성화하지 않는다.

- [ ] CoreNull producer 문서와 이 수신 계약의 교차 승인
- [ ] Authentication ADR 승인
- [ ] event_id / source_revision 멱등 규칙 승인
- [ ] 저장 모델(옵션 A 또는 B) 승인
- [ ] CoreNull + CoreHub disposable staging E2E 통과
- [ ] 기존 `/api/corehub/facts` 동작 불변 확인
- [ ] 401/403/409/5xx status 매핑이 CoreNull quarantine/retry 규칙과 일치
- [ ] 운영 rollback 절차 승인

현재 이 문서는 설계 제안이며, 운영 DB·staging DB·수신 코드에 migration이나 write를 실행하지 않았다.

## 14. CoreNull 문서와의 대칭 요약

| 항목 | CoreNull (producer) | CoreHub (receiver) |
|------|---------------------|--------------------|
| 책임 | Message 보존 + outbox 생성 | 관찰 event 수신·멱등 저장 |
| Auth | verified auth_user_id만 producer 활성화 | worker secret 검증 |
| 멱등 키 | event_id 생성 | event_id로 중복 방지 |
| 실패 처리 | 401/403/409 → quarantine | 해당 status 반환 |
| Stage A | space.message.created만 전송 | 동 event만 수신 |
| 원본 | content 변경 금지 | payload 재해석/변경 금지 |
| 기존 경로 | legacy pushFact 비활성화 목표 | 기존 /facts 유지 |

---

*문서 끝. CoreNull PR #24 문서와 함께 검토할 것.*
