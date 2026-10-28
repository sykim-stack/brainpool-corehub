# CoreHub R5 device RPC 적용 검증

_검증일: 2026-10-23_
_대상: Jena-Voca-01 (`grlfocvlfatuvphkyivd`)_
_검증 방식: Supabase migration 적용 후 read-only metadata/SQL 조회_

## 1. 적용 결과

다음 migration을 Jena-Voca-01에 적용했다.

```text
name: r5_device_event_rpc_stage_a_20261023
```

적용 대상은 `corehub.process_device_fact_event(...)` 함수와 service-role 실행 권한뿐이다.

기존 `corehub.facts`와 기존 R5 table의 row에는 INSERT/UPDATE/DELETE를 수행하지 않았다.

## 2. 함수 확인

```text
corehub.process_device_fact_event(
  text,
  text,
  text,
  text,
  text,
  bigint,
  timestamptz,
  jsonb,
  text
) returns jsonb
```

함수 실행 권한:

```text
postgres
service_role
```

`public`, `anon`, `authenticated`에는 실행 권한을 부여하지 않았다.

## 3. R5 table 불변 확인

적용 후 row count:

| Table | Rows |
|---|---:|
| `device_registry` | 0 |
| `device_nonces` | 0 |
| `source_events` | 0 |
| `message_mirror` | 0 |
| `consumer_quarantine` | 0 |
| `consumer_audit` | 0 |

아직 device 등록과 event ingestion은 시작하지 않았다.

## 4. Legacy facts 불변 확인

Jena-Voca-01의 기존 `corehub.facts`에서 확인된 ownership 관련 컬럼은 다음과 같다.

```text
owner_key text
house_id uuid
```

PR #2의 다음 항목은 아직 이 project에 적용되지 않았다.

```text
owner_id
idempotency_key
```

따라서 R5 device RPC는 legacy `corehub.facts`를 사용하지 않고 `source_events`와 `message_mirror`만 처리한다.

## 5. 현재 가능한 범위

현재 DB는 다음 준비 상태다.

```text
reference tables       준비 완료
nonce claim function   준비 완료
device event RPC       준비 완료
HMAC device registry   비어 있음
HMAC verifier          미구현
source event           0건
Message mirror         0건
CoreNull E2E           미실행
```

RPC는 등록·활성화된 device와 허용 event type이 없으면 처리하지 않는다. 따라서 현재는 어떤 worker event도 성공할 수 없다.

## 6. 다음 게이트

- [ ] R5 테스트용 device ID와 source/event allowlist 승인
- [ ] 외부 secret manager의 HMAC key version 준비
- [ ] `device_registry` 단일 초기 row 등록 승인
- [ ] HMAC verifier 구현 및 timestamp/nonce/body hash 검증
- [ ] 정상 event 1건 staging 수신
- [ ] 동일 event duplicate 검증
- [ ] 동일 key·변경 payload conflict 검증
- [ ] invalid/replay/disabled device quarantine 검증
- [ ] CoreNull outbox worker와 E2E 연결

현재 실제 event, device registration, secret 발급, 운영 endpoint 활성화는 실행하지 않았다.
