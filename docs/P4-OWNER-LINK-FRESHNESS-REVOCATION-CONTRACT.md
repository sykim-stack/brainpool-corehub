# P4 Owner-link Freshness·Revocation Contract 설계 Note

- **상태:** Draft / 설계 검토용
- **대상 브랜치:** `poc/corering-p4-assertion-verifier`
- **작성일:** 2026-11-10
- **관련 계약:** `corering-p4-assertion-v1`, P4 B-1 owner binding, replay ledger
- **범위:** CoreNull과 CoreHub 사이의 session revoke 및 owner-link expiry 무효화 의미론
- **이 문서에서 하지 않는 것:** 네트워크 호출 추가, CoreNull API 호출 구현, Supabase migration 적용, deploy, backfill, 기존 verifier 동작 변경

## 1. 목적과 현재 판정

현재 P4 assertion 경로에서 CoreHub는 서명, issuer/audience/purpose, 시간 claim, `jti` replay, 그리고 서버 소유 CoreNull identity mapping의 존재를 확인한다. 현재 adapter는 CoreHub가 CoreRing/CoreNull의 durable session revoke 상태를 직접 조회하지 않는다는 한계를 명시하고 있다.

따라서 다음 시나리오는 현재 R3 동작에서 허용될 수 있다.

```text
CoreNull session revoke = revoked
assertion exp          = valid
assertion jti          = fresh
CoreNull identity row  = present
→ CoreHub: ACCEPT_UNDER_R3
```

이 문서는 위 한계를 버그로 수정하는 구현 문서가 아니라, 이후 구현이 따라야 할 **권위 데이터, freshness, revocation, expiry의 계약**을 고정하기 위한 설계 초안이다. 구현 전까지 기존 판정 코드는 `SESSION_REVOKE_NOT_ENFORCED_AT_COREHUB` 한계를 계속 가진다.

## 2. 권위와 신뢰 경계

### 2.1 CoreNull이 권위인 상태

CoreNull은 다음 상태의 단일 권위(source of truth)다.

| 상태 | 의미 | CoreHub가 임의 생성·추론하면 안 되는 값 |
|---|---|---|
| `session_id` | CoreRing durable session 식별자 | 예 |
| `session_status` | `active` 또는 `revoked` | 예 |
| `session_revoked_at` | 해당 session이 무효화된 시각 | 예 |
| `link_id` | session과 owner link의 관계 식별자 | 예 |
| `owner_key` | 서버가 관리하는 Owner 식별자 | 예 |
| `link_status` | `active`, `expired`, `revoked` 등 link 상태 | 예 |
| `link_expires_at` | owner link의 hard expiry 시각 | 예 |
| `link_revision` | link 변경·무효화 세대 | 예 |

`owner_key`, `provider_sub`, `device_id`를 request query/body에서 받아 권한 근거로 삼지 않는다. assertion 안에 owner binding이 포함되더라도, CoreHub는 서명 검증만으로 link의 현재 유효성을 추론하지 않고 CoreNull 권위 상태와의 계약을 적용해야 한다.

### 2.2 CoreHub가 신뢰하는 입력

CoreHub는 다음 두 종류의 입력만 권한 판정에 사용한다.

1. 검증된 CoreRing assertion의 서명·고정 issuer·claim
2. CoreNull에서 승인된 server-owned 상태의 CoreHub 측 materialized view/snapshot 또는 동등한 server-owned resolver 결과

이 note는 2번 상태를 CoreHub가 어떻게 운반받는지 결정하지 않는다. 특히 CoreHub에서 CoreNull로 가는 새로운 HTTP/fetch/Supabase 원격 호출을 추가하지 않는다. 동기화 방식은 별도 승인 항목이다.

## 3. 최소 계약 객체

다음은 wire format을 확정하는 JSON schema가 아니라, 구현 간 의미를 고정하는 논리 객체다. 값은 raw token이나 client 제출값이 아니라 서버가 검증·생성한 값이어야 한다.

### 3.1 검증된 assertion principal

```text
AssertionPrincipal {
  issuer: string
  subject: string
  session_id: string
  assertion_id: string       // jti
  issued_at: timestamp       // iat
  expires_at: timestamp      // exp
  owner_binding: opaque-ref  // owner_key 자체를 새로 노출하자는 뜻이 아님
  link_id: string | null
  link_revision: string | null
}
```

기존 P4 verifier가 반환하는 `sessionId`, `assertionId`, `expiresAt`, `ownerKey`와의 매핑은 별도 호환 설계가 필요하다. 이 문서만으로 claim 이름이나 기존 token payload를 변경하지 않는다.

### 3.2 CoreHub 측 freshness snapshot

```text
OwnerLinkFreshnessSnapshot {
  snapshot_id: string
  source: "corenull"
  observed_at: timestamp
  fresh_until: timestamp
  session_id: string
  session_status: "active" | "revoked"
  session_revoked_at: timestamp | null
  link_id: string
  link_revision: string
  owner_binding: opaque-ref
  link_status: "active" | "expired" | "revoked"
  link_expires_at: timestamp
}
```

불변식:

- `source`가 CoreNull이 아니거나 `observed_at`, `fresh_until`이 없으면 유효한 snapshot으로 취급하지 않는다.
- `fresh_until <= now`이면 snapshot은 **stale**다.
- `link_status = active`여도 `now >= link_expires_at`이면 hard expiry가 우선한다.
- `session_status = active`여도 `session_revoked_at <= now`이면 revoked로 재분류한다.
- 동일한 `(session_id, link_id)`에 대해 더 오래된 `observed_at`/revision 상태를 새 상태로 덮어쓰지 않는다. opaque revision 문자열을 사전식 비교하지 않는다.
- owner binding, session, link의 조합이 맞지 않거나 여러 후보가 있으면 `conflict`로 fail-closed 한다.

### 3.3 Server-owned snapshot provider 입력 인터페이스

실제 CoreNull 연결 전에 provider 경계를 다음으로 고정한다.

```text
OwnerLinkSnapshotProvider.resolve({
  subject: string,    // verified assertion sub
  sessionId: string,  // verified assertion session_id
  ownerKey: string,   // existing server-side owner resolver result
}) -> Promise<OwnerLinkFreshnessSnapshot | null>
```

계약 규칙:

- 입력은 verifier가 검증한 값만 사용한다. request body/query의 `owner_key`, `device_id`, `provider_sub`를 provider 입력으로 전달하지 않는다.
- provider는 `now`를 받지 않는다. 시간 판정은 CoreHub verifier가 명시적으로 전달한 `now`로 수행해 provider와 verifier의 clock 책임을 분리한다.
- `null`은 server-owned snapshot이 없음을 뜻하며 allow가 아니다. 현재 정책에서는 unresolved/fail-closed로 분류한다.
- 반환 snapshot은 `source = corenull`, `snapshot_id`, 상태 enum, timestamp, session/link/binding/revision을 모두 포함해야 한다.
- provider 오류와 snapshot contract 위반은 `identity_verification_unavailable`(503)로 변환한다. raw storage error를 client에 반환하지 않는다.
- 이번 단계의 provider wrapper는 입력·출력을 검증할 뿐이며 HTTP, Supabase, CoreNull 호출을 수행하지 않는다.
- P4 dependency factory는 `ownerLinkResolver`를 선택적으로 받아 provider wrapper로 감싼다. 인자를 생략하면 기존 verifier dependencies와 route 동작은 그대로 유지된다.

테스트 double은 다음 세 가지를 결정적으로 주입한다.

1. 호출 인자 기록: `subject/sessionId/ownerKey`만 전달됐는지 검증
2. 정상 snapshot 또는 `null` 반환: active/revoked/expired/stale fixture 선택
3. provider 장애 throw: 503 변환 및 replay 전 차단 검증

실제 materialized view, 동기화 job, RLS, 네트워크 transport는 이 인터페이스 뒤의 별도 작업으로 남긴다.

### 3.4 Read-only materialized snapshot adapter

현재 설계한 read-only adapter의 source는 승인 전제의 `corenull_owner_link_snapshots`이며, 다음 조건으로 최대 2건만 조회한다.

```text
subject = verified subject
and session_id = verified sessionId
and owner_key = server-owned ownerKey
limit 2
```

adapter 계약은 다음과 같다.

- 0건이면 `null`을 반환한다.
- 정확히 1건이면 snapshot provider wrapper가 schema를 검증한 뒤 반환한다.
- 2건이면 동일 identity에 대한 ambiguity이므로 throw하고 verifier에서 503으로 fail-closed 한다.
- query error, missing Supabase client, malformed result는 모두 성공으로 취급하지 않는다.
- adapter는 `insert/update/delete/upsert`를 호출하지 않으며, table 생성·migration·CoreNull 호출도 수행하지 않는다.
- 현재 dependency factory에는 자동 연결하지 않는다. 실제 table schema와 RLS 승인 전에는 기존 route 동작을 변경하지 않는다.

## 4. 판정 순서

CoreHub의 목표 판정 순서는 다음과 같다. 순서는 정보 노출과 우회 가능성을 줄이기 위해 고정한다.

```text
1. assertion 형식·서명·issuer/audience/purpose/contract 확인
2. exp/iat 및 허용 clock skew 확인
3. jti replay atomic consume
4. server-owned CoreNull link snapshot 조회
5. snapshot freshness 확인
6. session revoke 확인
7. owner-link status 및 hard expiry 확인
8. session/link/revision/binding 일치 확인
9. owner-scoped resource query 실행
```

현재 R1 순수 verifier 초안에서 `ownerLinkResolver`를 주입한 경우의 실제 순서는 다음과 같다.

```text
verified assertion
  → existing ownerResolver
  → injected ownerLinkResolver / freshness decision
  → replay consume
  → verified principal
```

따라서 stale/revoked/expired 상태는 replay `jti`를 소비하기 전에 차단되고, fresh active snapshot만 replay consume으로 진행한다. 기존 opportunities route는 아직 이 선택적 resolver를 주입하지 않으므로 route의 R3 동작은 변하지 않는다.

실패 시 client가 제출한 owner 정보나 내부 상태를 응답에 반영하지 않고 기존 safe error envelope를 사용한다.

권장 오류 분류는 다음과 같다.

| 조건 | 권장 결과 | 의미 |
|---|---|---|
| snapshot 없음 | `owner_link_unresolved` 또는 기존 `unresolved` | 매핑/상태 증거 없음 |
| snapshot 조회·검증 불가 | `identity_verification_unavailable` (503) | 보안 상태를 확인할 수 없음 |
| `fresh_until` 경과 또는 freshness window 초과 | `owner_link_state_stale` (**503**) | 최신 revoke를 증명할 수 없음; 일시적 상태 확인 불능 |
| session revoked | `session_revoked` (401) | CoreNull session이 무효 |
| link revoked | `owner_link_revoked` (403) | link만 무효 |
| `now >= link_expires_at` | `owner_link_expired` (403) | hard expiry 도달 |
| revision/binding 불일치 | `owner_link_conflict` (403/409) | 임의 선택 금지 |
| assertion `exp` 경과 | 기존 만료 오류 | assertion 자체 만료 |
| jti 중복 | 기존 `token_replayed` | 동일 assertion 재사용 |

### 4.1 확정된 freshness·stale HTTP 정책

이번 설계 게이트에서 다음 정책을 확정한다.

- **Freshness window:** snapshot의 `observed_at`부터 `fresh_until`까지 최대 **30초**다. `fresh_until <= now`이면 stale이며, `fresh_until - observed_at > 30초`인 snapshot도 stale로 거부한다.
- **Assertion과의 상한:** snapshot이 assertion `exp`보다 오래 유효하다고 표시되어도 assertion 만료가 우선한다. 동기화자는 가능한 경우 `fresh_until`을 assertion 수명보다 길게 발행하지 않는다.
- **Stale HTTP status:** `503 Service Unavailable`이다. `403`이 아닌 이유는 권한이 없다고 확정한 것이 아니라 최신 CoreNull 상태를 확인할 수 없기 때문이다.
- **Error code:** `owner_link_state_stale`을 `error`와 기존 호환 필드 `_error`에 동일하게 넣는다. 응답에는 trace ID만 포함하고 owner/session/link 내부 값은 포함하지 않는다.
- **Retry:** `Retry-After: 1`을 사용하며 `Cache-Control: no-store`를 적용한다. retryable 상태이지만 이미 replay consume된 assertion을 그대로 재전송해서는 안 된다. 호출자는 새 assertion/new `jti`를 발급받아 재시도해야 한다.
- **Fail-closed:** stale 상태에서는 resource query를 수행하지 않고 허용 응답을 반환하지 않는다. 반복 재시도·backoff·최대 시도 수는 호출자/운영 정책의 별도 사항이다.
- **구분:** `identity_verification_unavailable`(snapshot 조회·검증 장애)도 503이지만, stale의 계약 코드와 원인은 구분한다.

이 정책은 현재 route에 즉시 연결한다는 뜻이 아니다. 연결 시 기존 `error`/`_error` envelope와 trace ID 관례를 보존해야 한다.

## 5. Session revoke 계약

### 5.1 의미

`session_revoked`는 특정 CoreRing durable session을 더 이상 인증 근거로 사용할 수 없다는 뜻이다. revoke는 해당 session에서 발급된 assertion의 남은 `exp`나 새로운 `jti` 여부와 무관하게 효력을 가진다.

```text
if snapshot.session_id != principal.session_id:
  deny(owner_link_conflict)

if snapshot.session_status == "revoked":
  deny(session_revoked)

if snapshot.session_revoked_at != null
   and snapshot.session_revoked_at <= now:
  deny(session_revoked)
```

정책 선택이 필요한 부분은 `session_revoked_at` 이전에 발급된 assertion만 무효화할지, session 전체를 무효화할지다. 기본 권장안은 **session 전체 무효화**다. 부분 무효화가 필요하면 반드시 `session_generation`/`assertion_iat` 비교 계약을 별도 확정해야 하며, 현재 P4 verifier에 암묵적으로 도입하지 않는다.

### 5.2 revoke 전파 지연

CoreHub가 CoreNull의 최신 상태를 확인하지 못하는 동안 revoke를 즉시 보장할 수 없다. 따라서 목표 계약은 다음과 같이 명시한다.

- `fresh_until` 이전이고 30초 window 안: snapshot 기준으로 판정한다.
- `fresh_until` 이후 또는 30초 window 초과: **허용하지 않는다**. CoreHub는 stale 상태에서 보호 자원 접근을 계속하지 않는다.
- stale 상태에서 CoreNull로 재조회하는 네트워크 호출은 이 note의 구현 범위가 아니다.
- `fresh_until`은 assertion `exp`보다 길게 설정하지 않는다.

이 규칙은 “revoke가 발생했지만 아직 CoreHub가 모르는 시간”을 제거하지는 않지만, 승인된 **30초 freshness window** 안에서만 접근을 허용하도록 위험을 제한한다.

## 6. Owner-link expiry 계약

### 6.1 Hard expiry

`link_expires_at`은 서버가 정한 hard boundary다.

```text
if now >= link_expires_at:
  deny(owner_link_expired)
```

- 경계는 `>=`로 판정한다.
- client clock이나 UI 표시 시간은 근거가 아니다.
- assertion의 `exp`가 더 늦더라도 link expiry가 우선한다.
- link expiry를 연장하려면 CoreNull이 새 `link_revision`을 발행하고 CoreHub snapshot이 그 revision을 반영해야 한다.
- 만료된 link를 “최근 사용했으므로” 자동 연장하지 않는다.

### 6.2 Revocation과 expiry의 우선순위

동시에 여러 사유가 있으면 외부 응답은 과도한 상태 정보를 노출하지 않는 공통 인증 실패로 축약할 수 있지만, 내부 보안 로그의 원인은 다음 우선순위를 사용한다. 단, stale은 최신 상태를 증명할 수 없으므로 아래 상태 확인 전에 먼저 fail-closed 한다.

```text
snapshot stale/unavailable
  > session revoked
  > link revoked
  > link expired
  > binding/revision conflict
```

단, snapshot 자체가 stale이면 최신 revoke/expiry를 증명할 수 없으므로 보호 자원 접근은 먼저 중단해야 한다. 운영 로그에는 raw token, cookie, `provider_sub`, `owner_key`, `device_id`를 기록하지 않고 trace ID와 비식별화된 상태 코드만 남긴다.

## 7. State transition 계약

CoreNull의 권위 상태 변화는 다음과 같이 단조적이어야 한다.

```text
link:   active → expired
link:   active → revoked
session: active → revoked
```

- `expired`/`revoked` 상태를 이전 `active` snapshot이 되돌릴 수 없다.
- 재연결은 기존 link를 부활시키는 대신 새 `link_id` 또는 명시적으로 증가한 `link_revision`을 만든다.
- 동일 revision의 payload가 달라지면 충돌로 처리한다.
- CoreHub snapshot 반영은 순서가 뒤바뀌어도 더 최신의 server-owned `observed_at`와 monotonic revision을 보존해야 한다. revision은 opaque 값이므로 문자열 정렬로 순서를 추론하지 않는다.
- `jti` replay ledger는 session revoke나 link expiry의 대체물이 아니다. replay 방지는 assertion 재사용만 막는다.

## 8. 현재 구현과 목표 계약의 차이

| 항목 | 현재 브랜치 동작 | 이 note의 목표 |
|---|---|---|
| 서명/issuer/시간 claim | verifier에서 확인 | 유지 |
| `(issuer, jti)` replay | atomic ledger consume | 유지 |
| identity mapping 존재 | CoreNull identity row 존재 시 binding 통과 | freshness snapshot의 link/session 상태까지 확인 |
| CoreNull session revoke | route에 resolver 미주입; R3에서는 조회하지 않음 | resolver 연결 시 최신 상태가 revoked면 replay 전 deny |
| owner-link expiry | 별도 hard expiry 판정 없음 | `now >= link_expires_at`이면 deny |
| stale 상태 | route에 resolver 미주입; 별도 상태 없음 | resolver 연결 시 replay 전 fail-closed |
| identities row 삭제 | `unresolved`가 될 수 있음 | `session_revoked`로 오인하지 않음; 원인 분리 |
| 익명 owner 정책 | 현재 B-1 unresolved, 제품 정책 미확정 | 이 note에서 허용하지 않음; 별도 제품 결정 필요 |

따라서 이 문서는 현재 테스트의 `ACCEPT_UNDER_R3` 판정을 변경하지 않는다. 구현이 시작되기 전에는 설계 목표와 현재 보장 범위를 혼동하지 않아야 한다.

## 9. 네트워크 호출을 추가하지 않는 구현 경계

이번 작업에서 허용되는 변경은 문서·계약·fixture·read-only 검토뿐이다.

다음은 이 note의 후속 작업이며 이번 브랜치 작업에 포함하지 않는다.

1. CoreHub가 사용할 snapshot/materialized state의 저장 위치와 동기화 주기 결정
2. CoreNull이 revoke/expiry 변경을 발행·반영하는 단방향 동기화 방식 결정
3. `owner_link_state_stale`의 503 envelope는 이 note의 확정 정책을 그대로 구현
4. 기존 opportunities route에 server-owned snapshot resolver를 실제 주입할지 승인
5. resolver 주입 route에 대한 resource access 통합 테스트 추가
6. migration, RLS, cleanup, deploy 및 staging/production rollout 승인

직접 CoreHub→CoreNull HTTP 호출을 추가하는 것은 이 계약의 기본안이 아니다. 호출이 필요하다고 판단되면 latency, timeout, fail-open 여부, 인증 주체, 재시도, replay와의 순서를 별도 ADR로 승인해야 한다.

## 10. 수용 기준 초안

구현 승인 전 최소한 다음 시나리오를 계약 테스트로 고정한다.

| 시나리오 | 기대 |
|---|---|
| active session + active link + fresh snapshot + unexpired assertion | allow |
| session revoked + fresh jti + unexpired assertion | deny: `session_revoked` |
| link revoked + active session | deny: `owner_link_revoked` |
| `now == link_expires_at` | deny: `owner_link_expired` |
| `now > link_expires_at`, assertion exp는 유효 | deny: `owner_link_expired` |
| snapshot `fresh_until` 경과 | deny/fail-closed: `owner_link_state_stale` |
| snapshot 없음 | unresolved 또는 unavailable; allow 금지 |
| session/link/revision mismatch | deny: conflict; 임의 후보 선택 금지 |
| identity row 삭제만 발생 | session revoke로 분류하지 않음 |
| revoked 상태 후 새 `jti` 발급 | 여전히 deny |
| expired link 후 동일 link revision 재사용 | deny |
| out-of-order active snapshot 도착 | 이미 관측한 revoke/expiry를 되살리지 않음 |
| replay된 assertion | 기존 `token_replayed` |

## 11. 승인 게이트

다음 질문에 답하기 전에는 R1 구현이나 migration을 시작하지 않는다.

- CoreNull 권위 상태를 CoreHub가 받는 materialization 경계는 무엇인가?
- session revoke는 session 전체 무효화인가, `iat`/generation 기준의 부분 무효화인가?
- owner link 재연결 시 기존 `link_id`를 부활시키지 않는 정책에 동의하는가?
- `identity_verification_unavailable`의 세부 운영 재시도·backoff 정책은 무엇인가?
- anonymous owner가 identities 없이 접근할 수 있는 제품 정책을 별도로 승인할 것인가?

**결론:** 현재 P4는 assertion 만료와 replay를 검증하지만 CoreNull session revoke 및 owner-link expiry의 최신 상태를 보장하지 않는다. 목표 계약은 CoreNull을 권위로 두고, CoreHub가 freshness가 입증된 server-owned 상태만 사용하며, revoke·expiry·stale·충돌을 모두 fail-closed로 처리하는 것이다. 이 문서만으로 네트워크 경로나 DB schema를 추가하지 않는다.
