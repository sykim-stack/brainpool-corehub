# CoreNull Message → CoreHub event/outbox 계약 초안

_상태: staging 설계 초안 — 운영 적용·migration 미승인_
_기준일: 2026-10-20_
_소유자: CoreHub 계약 초안 / CoreNull producer 구현 필요_

## 1. 목적

CoreNull의 `messages` 원본을 변경하지 않고 CoreHub에 안정적으로 전달하기 위한 최소 event contract를 정의한다.

이 문서는 CoreNull에 migration을 적용하거나 CoreHub 운영 API를 여는 문서가 아니다. 현재 코드의 fire-and-forget 전송을 운영 계약으로 인정하지 않고, producer가 충족해야 할 조건을 기록한다.

## 2. 현재 CoreNull 실제 Message 필드

현재 generated type과 `app/api/corenull/posts/route.js`에서 다음 필드가 확인됐다.

```text
messages.id
messages.room_id
messages.house_id
messages.owner_key
messages.user_id
messages.device_id
messages.type
messages.content
messages.meta
messages.relations
messages.language
messages.translated_ko
messages.translation_status
messages.translations
messages.harvested_at
messages.created_at
```

현재 `messages`에는 CoreHub event ordering에 필요한 명시적 monotonic `version`/`revision` 필드가 없다. `updated_at`도 generated type상 확인되지 않았다. `created_at`만으로 수정 순서를 표현하거나 idempotency key를 만들지 않는다.

현재 소유권도 `owner_key`/`device_id` 중심이며, CoreHub PR #2가 요구하는 verified Auth UID와 동일한 계약으로 확정되지 않았다.

## 3. Stage A 허용 범위

첫 vertical slice에서는 원본 promotion 없이 다음 event만 검증한다.

```text
space.message.created
```

`updated`, `archived`, `deleted`, `harvested` event는 source revision과 변경 transaction 계약이 확정된 뒤 추가한다. 현재 CoreNull의 `fruit`/`harvest` Fact 호출은 Message event mirror 계약과 별개이며, 기존 CoreHub PR #2의 Fact contract를 자동으로 대체하지 않는다.

## 4. Event envelope

CoreNull producer가 outbox에 보관하고 CoreHub에 전송할 논리 envelope은 다음과 같다.

```json
{
  "source": "CoreNull",
  "event_type": "space.message.created",
  "event_id": "<stable-source-event-id>",
  "source_record_id": "<messages.id>",
  "source_revision": 1,
  "occurred_at": "2026-10-20T00:00:00.000Z",
  "owner_id": "<verified-auth.users.id>",
  "house_id": "<canonical-house-id-or-null>",
  "room_id": "<messages.room_id-or-null>",
  "payload": {
    "message_id": "<messages.id>",
    "house_id": "<messages.house_id-or-null>",
    "room_id": "<messages.room_id-or-null>",
    "type": "post",
    "content": "<original-content>",
    "meta": {},
    "relations": {},
    "language": "ko",
    "translated_ko": null,
    "translation_status": "completed",
    "harvested_at": null,
    "created_at": "2026-10-20T00:00:00.000Z"
  },
  "payload_sha256": "<canonical-json-sha256>"
}
```

### 4.1 권위 필드

- `owner_id`는 request body 또는 localStorage의 `owner_key`에서 얻지 않는다. CoreNull의 서버가 검증한 Auth identity에서만 얻는다.
- `source_record_id`는 `messages.id`다.
- `source_revision`은 동일 Message의 변경 순서를 나타내는 source Core의 확정 값이다.
- `event_id`는 retry 때 바뀌지 않는다.
- `payload_sha256`은 canonical JSON serialization 규칙이 승인된 뒤 계산한다.

### 4.2 금지 payload

- Supabase access token
- `SUPABASE_SERVICE_ROLE_KEY`
- 임의 SQL
- table/column write path
- client-supplied owner assertion
- 승인 상태나 promotion 결과

## 5. Idempotency 계약

권장 key 형식:

```text
corenull:messages:<message_id>:v<source_revision>
```

조건:

1. 같은 Message와 같은 revision은 언제나 같은 key를 사용한다.
2. 같은 key와 같은 canonical payload는 duplicate replay로 처리한다.
3. 같은 key와 다른 payload hash는 conflict로 처리한다.
4. `created_at`, 현재 시각, random UUID만으로 key를 만들지 않는다.
5. source revision이 확정되기 전에는 Message update event를 운영 전송하지 않는다.

## 6. CoreNull producer/outbox 요구사항

CoreNull 구현이 충족해야 하는 조건이다.

- Message insert와 outbox insert가 같은 DB transaction에 속한다.
- transaction commit 전에는 CoreHub 전송을 시작하지 않는다.
- network failure와 HTTP 503은 outbox row를 보존한 채 retry한다.
- 401, 403, 409와 payload hash conflict는 무한 retry하지 않고 quarantine한다.
- worker claim마다 새 lease token을 발급한다.
- success/failure finalize는 `outbox_id + lease_token`을 함께 조건으로 사용한다.
- stale worker는 최신 lease 결과를 덮어쓰지 못한다.
- retry 때 event body와 idempotency key를 바꾸지 않는다.
- access token과 service credential은 outbox payload·로그에 저장하지 않는다.

## 7. CoreHub 수신 처리

CoreHub는 수신 시 다음을 검증한다.

1. 허용된 `source=CoreNull`, `event_type=space.message.created` 조합인지 확인
2. verified Auth UID와 house ownership을 확인
3. `source_record_id`, `source_revision`, payload 필수 field 확인
4. canonical payload hash 계산 또는 producer hash 검증
5. `(owner_id, source, event_id)` 또는 승인된 idempotency key uniqueness 확인
6. 동일 key·동일 hash는 duplicate response
7. 동일 key·다른 hash는 `409 conflict`
8. 원본 CoreNull DB에는 쓰지 않음
9. CoreHub mirror/fact 처리와 audit result를 transaction으로 기록

기존 PR #2의 Fact API가 사용하는 Bearer·`Idempotency-Key` 계약과 정확한 endpoint mapping은 producer 인증 ADR 승인 후 확정한다.

## 8. 현재 구현과의 차이

현재 CoreNull `posts/route.js`와 `rooms/route.js`의 `pushFact()`는 다음 형태다.

```text
fetch(CoreHub URL)
  └─ Authorization 없음
  └─ Idempotency-Key 없음
  └─ owner_id 대신 owner_key 전송
  └─ response 확인 없음
  └─ 실패 시 catch 후 소실
```

이 경로는 CoreHub PR #2의 운영 수신 계약을 만족하지 않는다. 기존 호출을 단순히 header만 추가하는 것으로 완료 처리하지 않는다. 먼저 source transaction, Auth UID, revision, durable outbox, worker lease를 구현·검증해야 한다.

## 9. Staging fixture

구현 전 pure test fixture는 다음 조건을 사용한다.

- owner A / house A / message M1 / revision 1 → accepted candidate
- 같은 event 재전송 → duplicate
- 같은 event ID, content 변경 → conflict
- owner B 또는 house B로 변조 → rejected
- owner assertion이 body에만 있고 verified token이 없음 → rejected
- revision 2가 revision 1보다 먼저 도착 → ordering policy에 따라 quarantine 또는 pending
- lease 1이 만료된 뒤 lease 2가 claim → lease 1 finalize는 no-op
- CoreHub 처리 실패 → CoreNull 원본은 unchanged

## 10. 완료 조건

다음이 모두 통과하기 전에는 CoreNull 실데이터를 CoreHub에 연결하지 않는다.

- [ ] CoreNull Auth UID/House ownership mapping 확정
- [ ] Message source revision 정의와 transaction 구현
- [ ] durable outbox migration을 disposable staging에서 검증
- [ ] worker retry/backoff/quarantine/lease 검증
- [ ] CoreHub Bearer 또는 승인된 service-to-service 인증 방식 확정
- [ ] 동일 key·동일 body duplicate 검증
- [ ] 동일 key·다른 body conflict 검증
- [ ] 타 owner/house 격리 검증
- [ ] CoreNull 원본 전후 불변 검증
- [ ] producer → CoreHub staging E2E 결과를 commit/ref와 함께 기록

현재 문서는 계약 초안이며 DB 생성, migration, 원본 write, 운영 전송을 승인하지 않는다.
