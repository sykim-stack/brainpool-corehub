# CoreHub R5 reference DB 적용 검증 보고서

_검증일: 2026-10-23_
_검증 방식: Supabase metadata 및 read-only SQL 조회_
_변경: 검증 보고서 문서만 추가; 검증 중 INSERT/UPDATE/DELETE 미실행_

## 1. 대상 project

R5 reference DB SQL은 다음 project에 적용되어 있다.

```text
project: Jena-Voca-01
ref: grlfocvlfatuvphkyivd
status: ACTIVE_HEALTHY
```

다음 project에는 R5 reference schema가 없다.

```text
project: hajunai
ref: yqbypcqkgrdyvslzbtid
corehub tables: 없음
```

따라서 현재 R5 reference DB의 staging 대상은 `Jena-Voca-01`로 기록한다. 이 project가 실제 의도한 staging 대상인지 운영 전 별도 확인이 필요하다.

## 2. 실제 존재 확인

다음 6개 table이 `corehub` schema에 존재한다.

```text
corehub.device_registry
corehub.device_nonces
corehub.source_events
corehub.message_mirror
corehub.consumer_quarantine
corehub.consumer_audit
```

모든 R5 table에 `relrowsecurity=true`가 확인됐다.

다음 함수가 존재한다.

```text
corehub.claim_device_nonce(text, text, timestamptz)
```

함수 실행 권한은 metadata상 다음 역할에 있다.

```text
postgres
service_role
```

R5 table에는 `anon` 또는 `authenticated` 직접 권한이 확인되지 않았고, 별도 policy도 확인되지 않았다. RLS enabled + policy 없음은 authenticated/anon의 default-deny 상태로 해석한다. 실제 API service role 경로에서 필요한 작업만 허용되는지 staging test로 확인해야 한다.

## 3. 현재 row 상태

적용 직후 read-only count 결과:

| Table | Rows |
|---|---:|
| `device_registry` | 0 |
| `device_nonces` | 0 |
| `source_events` | 0 |
| `message_mirror` | 0 |
| `consumer_quarantine` | 0 |
| `consumer_audit` | 0 |

아직 HMAC device가 등록되지 않았고, CoreNull event도 수신되지 않았다.

## 4. 기존 CoreHub schema와의 차이

`Jena-Voca-01`의 기존 `corehub.facts`는 현재 PR #2 migration 이후 계약과 일치하지 않는다. 읽기 결과에서 기존 Fact table에는 다음 R5/PR2 필드가 확인되지 않았다.

```text
owner_id
idempotency_key
```

현재 기존 `corehub.facts`는 legacy schema로 남아 있다. 따라서 이번 R5 reference DB 적용만으로 다음 기능이 활성화된 것은 아니다.

- Bearer user Fact 처리
- HMAC worker consumer
- `process_device_fact_event`
- CoreNull Message mirror ingress
- HMAC secret verification
- device registry enrollment
- CoreHub/CoreNull E2E

특히 R5 reference SQL에는 `process_device_fact_event`가 포함되어 있지 않으며, 현재 검증된 함수도 `claim_device_nonce`뿐이다.

## 5. 현재 상태 판정

```text
reference tables: PASS
RLS enabled: PASS
nonce claim function exists: PASS
HMAC device enrollment: NOT STARTED
source event ingestion: NOT STARTED
message mirror ingestion: NOT STARTED
worker consumer endpoint: NOT IMPLEMENTED
PR2 legacy facts migration on this project: NOT VERIFIED / NOT APPLIED
R5 E2E: NOT RUN
```

## 6. 다음 게이트

실제 event를 보내기 전 다음을 먼저 확인한다.

- [ ] `Jena-Voca-01`이 의도한 disposable staging project인지 확인
- [ ] PR #2 Auth/idempotency migration을 이 project에 별도로 적용할지 결정
- [ ] `process_device_fact_event` RPC 설계·migration 초안 작성
- [ ] R5 HMAC device registry 초기값과 secret-manager key version 승인
- [ ] HMAC verifier가 secret을 DB에 저장하지 않는지 확인
- [ ] CoreNull outbox의 `conversation_id` 규칙 확정
- [ ] CoreNull worker와 CoreHub endpoint 구현
- [ ] nonce replay, duplicate, conflict, quarantine, retry 테스트
- [ ] 실제 staging E2E 전후 row count·payload hash 검증

현재 reference DB는 **구조만 생성된 빈 staging 저장 공간**이다. device 등록·event 송신·운영 DB 연결·promotion은 별도 승인 전까지 실행하지 않는다.
