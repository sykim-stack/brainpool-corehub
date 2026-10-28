# CoreHub 첫 vertical slice 조사 및 범위 결정

_기준일: 2026-10-20_
_상태: 조사·범위 제안 — 운영 적용 전_
_관련: CoreHub 연결·승인 DB 설계 v1 · CoreHub 이벤트 무결성 계약 v2 · CoreHub PR #2_

## 1. 결론

첫 vertical slice는 **CoreNull Message → CoreHub mirror 수신**으로 시작한다.

첫 단계에서는 원본 DB에 promotion하지 않는다.

```text
CoreNull messages 원본
        ↓ 읽기 / 인증된 source event
CoreHub facts 또는 연결 mirror
        ↓
소유권·멱등·payload 보존 검증
        ↓
사람이 결과 확인
```

이 범위가 먼저인 이유는 다음과 같다.

- CoreNull은 BRAINPOOL의 Message 원본을 실제로 보유하고 있다.
- CoreHub PR #2는 이미 인증된 Fact 수신·owner/house 경계·idempotency·atomic processing을 구현하고 있다.
- CoreNull 쪽에는 아직 Auth UID 기반 producer, domain version, durable outbox, worker가 없다.
- CoreRing 쪽 공식 데이터는 확인됐지만 현재 service-role 기반 직접 저장 경로이며, 승인 후 adapter 경계가 아직 없다.
- 따라서 첫 단계에서 CoreRing promotion까지 함께 시도하면 두 개의 미완성 경계를 동시에 디버깅하게 된다.

## 2. 실제 확인 결과

### 2.1 CoreNull

CoreNull 저장소에서 다음 원본 데이터 사용이 확인됐다.

```text
messages
  ├─ id
  ├─ room_id
  ├─ content
  ├─ meta
  ├─ type
  ├─ harvested_at
  └─ created_at
```

코드에서 `messages`는 `roomStage`, post 조회, room 화면, library, bookmark 등 여러 경로의 원본으로 사용된다. `type='fruit'`, `harvested_at`, `room_id`, `content`, `meta`가 현재 CoreNull domain 흐름에 중요하다.

그러나 현재 확인된 연결 blocker는 다음과 같다.

- 현재 API/UI는 `owner_key`와 `device_id`를 사용한다.
- 검증된 Supabase Auth UID를 Message producer가 안정적으로 전달하는 계약이 없다.
- Message 변경의 확정 version을 반환하는 계약이 없다.
- durable outbox와 retry worker가 없다.
- 현재 CoreHub PR #2가 요구하는 `Authorization`, `Idempotency-Key` 전송 경로가 없다.

따라서 현재 CoreNull Message를 운영 CoreHub에 자동 전송하거나 promotion 대상으로 삼지 않는다.

### 2.2 CoreRing

CoreRing migration과 코드에서 다음 공식 데이터 구조가 확인됐다.

| 테이블 | 의미 | 현재 소유 |
|---|---|---|
| `tb_trans_logs` | 번역·분석 이력 / archive 성격의 원본 log | CoreRing 저장 pipeline |
| `language_knowledge` | 반복 관찰 후 재사용 가능한 언어 지식 | CoreRing |
| `tp_lexicon` | 어휘·언어쌍 lexicon | CoreRing |
| `tp_phrases` | 번역 문장쌍·구문 | CoreRing |

CoreRing migration은 `language_knowledge`의 `candidate`, `verified`, `deprecated` 상태와 `tp_phrases.source_message_id`, `tb_trans_log_id` provenance 필드를 이미 정의한다.

그러나 현재 코드에는 다음이 남아 있다.

- `SUPABASE_SERVICE_ROLE_KEY`를 사용하는 직접 저장 함수
- `tp_lexicon` 및 `tp_phrases`에 대한 즉시 upsert 경로
- Proposal/approval request와 연결된 adapter 없음
- CoreHub 승인 후 promotion을 받는 endpoint 또는 worker 없음
- source event의 Auth UID·idempotency·version contract 없음

따라서 CoreRing을 첫 promotion target으로 바로 확정하지 않는다. CoreRing은 첫 mirror 수신 이후 별도 target adapter contract를 작성한다.

## 3. 첫 단계와 두 번째 단계의 분리

### 단계 A — Mirror 수신 검증

목표는 **원본을 변경하지 않고 CoreHub가 source Message를 안전하게 받을 수 있는지** 증명하는 것이다.

```text
CoreNull Message
  → source event / outbox contract
  → CoreHub Fact API 또는 mirror ingress
  → facts에 보존
  → owner/house/time/idempotency 검증
```

검증 항목:

- source Message ID가 payload에 안정적으로 보존되는가
- `room_id`, `type`, `content`, `meta`, `created_at`이 손실 없이 전달되는가
- source owner와 Auth UID가 분리·검증되는가
- 같은 Message event 재전송이 duplicate가 되는가
- 같은 key에 다른 payload가 conflict가 되는가
- 다른 owner/house Message가 섞이지 않는가
- CoreNull 원본은 전혀 변경되지 않는가

### 단계 B — 승인·promotion

단계 A가 통과한 뒤에만 다음을 별도 contract로 정한다.

```text
CoreHub mirror/fact
  → CoreRing domain proposal
  → 사람 승인
  → CoreRing adapter
  → language_knowledge / tp_phrases / 기타 공식 record
```

단계 B에서 결정할 것:

- 첫 target을 `language_knowledge`, `tp_phrases`, `tp_lexicon` 중 무엇으로 할지
- `payload.domain`과 target schema mapping
- CoreRing adapter의 인증·권한
- candidate와 approved의 관계
- source Message 또는 `tb_trans_log` provenance 연결
- version/fingerprint와 idempotency
- CoreRing의 기존 service-role 직접 저장 경로를 어떻게 분리할지

## 4. 현재 선택하지 않는 범위

첫 vertical slice에서 다음을 하지 않는다.

- CoreNull 운영 Message를 자동으로 CoreHub에 대량 복제
- CoreRing 공식 table에 자동 INSERT/UPDATE
- `tp_phrases` 또는 `language_knowledge`를 첫 target으로 확정
- CoreNull `owner_key`를 Auth UID로 자동 변환
- CoreNull DB에 outbox migration 적용
- CoreHub PR #2 migration을 운영 project에 적용
- 연결 DB 전체를 어느 원본 DB에 덮어쓰기
- 승인 없는 AI 결과를 공식 데이터로 승격

## 5. 첫 단계 수용 기준

첫 단계는 다음을 모두 만족해야 한다.

1. 명시적으로 분리된 disposable staging DB/ref를 사용한다.
2. CoreNull producer가 검증된 인증 주체를 사용한다.
3. source Message ID와 원본 payload hash가 보존된다.
4. 동일 event key와 동일 body는 한 번만 처리된다.
5. 동일 key와 다른 body는 `409/conflict`로 남는다.
6. 타 owner 또는 타 house의 Message가 매칭·혼합되지 않는다.
7. 네트워크 실패 시 producer outbox가 event를 잃지 않는다.
8. lease 만료 worker의 stale completion이 최신 상태를 덮지 못한다.
9. CoreNull 원본 row count와 payload가 전후 동일하다.
10. CoreHub consumer 테스트와 producer→CoreHub E2E 결과를 commit/ref와 함께 기록한다.

## 6. 다음 작업

1. CoreNull의 Auth UID·House ownership·Message version 계약을 별도 검토한다.
2. CoreNull에 운영 적용하지 않는 outbox/producer 설계 초안을 작성한다.
3. CoreHub에 Message source event용 payload contract와 test fixture를 만든다.
4. disposable staging에서 consumer-side와 producer-side를 연결한다.
5. 단계 A가 통과한 뒤 CoreRing target adapter를 별도로 설계한다.

이 문서는 첫 vertical slice의 범위만 정한다. 실제 DB 생성·migration·원본 write·promotion은 별도 승인 전까지 실행하지 않는다.
