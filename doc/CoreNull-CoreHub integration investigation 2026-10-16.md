# CoreNull → CoreHub 연결 조사 보고서

> 조사일: 2026-10-16
> 대상: `sykim-stack/brainpool-corenull` 현재 default branch와 `brainpool-corehub` PR #2
> 범위: Auth/세션, House 소유권, 도메인 version, Fact 전송, staging readiness
> 결론: **운영 연결 및 운영 migration은 아직 차단**

## 1. Executive summary

CoreNull에는 Google 로그인 진입점은 있지만, 현재 구현은 Supabase Auth 세션을 브라우저에 전달하는 사용자 인증 체계가 아니다. 서버 route가 Google `id_token`을 `signInWithIdToken`으로 검증하고, 그 결과의 Google identity를 기존 `owner_key`와 매핑한 뒤 `owner_key`만 클라이언트에 반환한다.

House와 대부분의 도메인 API는 여전히 localStorage의 `owner_key`를 요청 본문/query에 넣고, 서버가 service-role 클라이언트로 그 값을 `corenull_houses.owner_key`와 비교한다. `corenull_houses.owner_id`는 확인되지 않았다.

CoreHub PR #2의 Facts consumer는 반대로 Bearer access token, Auth UID 유도, House ownership, Idempotency-Key, 401/403/409/503 계약을 구현하고 있다. 문제는 CoreNull producer가 아직 이 계약을 충족하지 않는다는 점이다. CoreNull의 Fact 전달은 `rooms/route.js`와 `posts/route.js`에서 CoreHub URL로 직접 fire-and-forget `fetch`하는 방식이며, `Authorization`, `Idempotency-Key`, durable outbox, retry/backoff, lease, payload hash가 없다. 실제 도메인 테이블에는 `version` 컬럼이 확인되지 않았고, `created_at`/`updated_at`만 존재한다.

따라서 지금은 outbox migration이나 worker를 staging에도 적용할 구현물이 아직 없으며, 운영 연결을 진행할 수 없다. 먼저 Auth 계약과 신규 House 소유권 경로를 정하고, 도메인 version 또는 명시적 이벤트 revision을 도입한 뒤, staging에서만 통합 검증해야 한다.

## 2.1 CoreHub PR #2 계약 대조

PR #2의 현재 브랜치(`security/corehub-event-integrity-2026-10-05`, draft)는 Facts API consumer 계약을 구현한다. 따라서 위험은 “CoreHub API 개방”이 아니라 “CoreNull producer와 CoreHub consumer의 계약 불일치”로 기록해야 한다.

| 상황 | PR #2 실제 동작 | 근거 |
|---|---|---|
| Bearer 없음 | `401 authentication_required` | `app/api/corehub/facts/route.js:16-23`; `lib/corehub/auth.mjs:10-13` |
| 잘못된 token | `401 invalid_access_token` | `lib/corehub/auth.mjs:15-30` |
| Auth service 장애 | `503 authentication_service_unavailable` | `lib/corehub/auth.mjs:19-24, 31-32` |
| House ownership 불일치 | `403 house_not_owned_by_user` | `app/api/corehub/facts/route.js:121-134` |
| Idempotency-Key 없음/오류 | `400 valid_idempotency_key_required` | `app/api/corehub/facts/route.js:76-80` |
| 동일 key·동일 event | `200` duplicate 결과 | `app/api/corehub/facts/route.js:148-156` |
| 동일 key·다른 event | `409 idempotency_key_reused_with_different_event` | `app/api/corehub/facts/route.js:148-150` |
| RPC 처리 장애 | `503 fact_processing_failed_retry_with_same_key` | `app/api/corehub/facts/route.js:151-153` |

CoreNull의 현재 `pushFact()`에는 Bearer와 Idempotency-Key가 없으므로 현재 direct push는 이 계약을 만족하지 않는다.

## 2. Auth·세션 조사

### 확인된 구현

- `app/api/auth/google/route.js:16-81`
  - `POST /api/auth/google`가 Google `id_token`을 받는다.
  - 서버 Supabase client에서 `supabase.auth.signInWithIdToken({ provider: 'google', token: id_token })`을 호출한다.
  - `user.identities`에서 Google subject를 추출한다.
  - `/api/identity/sync`에 `provider_sub`와 선택적인 기존 `current_owner_key`를 전달한다.
  - 응답에는 `owner_key`, `is_new_user`, `linked`만 포함된다. Supabase `access_token`/`refresh_token` 또는 세션이 클라이언트에 반환되지 않는다.
- `hooks/useGoogleLogin.ts:62-75`
  - 브라우저는 Google credential을 `/api/auth/google`로 보내고 반환된 `owner_key`만 저장한다.
- `lib/ownerKey.ts:24-36`
  - localStorage의 `corenull_owner_key`를 사용한다.
  - 값이 없고 `corenull_device_id`가 있으면 device ID를 owner key로 승격한다.
- `app/api/identity/sync/route.js`
  - Google subject와 UUID 형식의 `owner_key`를 매핑한다.

### 판정

- **Google identity 확인:** 부분적으로 존재
- **Supabase Auth 사용자 생성/검증:** `signInWithIdToken` 호출로 서버 내부에서 수행
- **브라우저 세션 생성·유지:** 미확인/미구현
- **CoreHub가 검증할 owner UID를 CoreNull 요청에 담는 경로:** 없음
- **워커가 장기 재시도할 인증 자격:** 없음

현재 `signInWithIdToken` 호출은 CoreNull API 요청의 사용자 세션 계약으로 사용할 수 없다. 워커가 사용자의 access token을 어떻게 보유·갱신할지 결정되지 않았기 때문이다.

## 3. House 소유권 조사

### 확인된 구현

- `app/api/corenull/houses/route.js:50-82`
  - GET은 `owner_key` query로 House를 조회한다.
  - `house_id`만 있으면 소유권 조건 없이 House를 조회한다.
- `app/api/corenull/houses/route.js:84-112`
  - POST body에서 `owner_key`, `title` 등을 받는다.
  - `getSupabaseAdmin()`으로 `corenull_houses.owner_key`를 직접 저장한다.
  - 기본 Room도 별도 insert한다.
- `app/api/corenull/houses/route.js:115-175`
  - PATCH 역시 body의 `owner_key`와 `corenull_houses.owner_key`를 비교한다.
- `lib/database.types.ts:549-580`
  - `corenull_houses` 타입에 `owner_key`는 있으나 `owner_id`는 없다.
- `lib/ownerKey.ts:30-36`
  - 기존 device ID를 owner key로 자동 승격한다.

### 판정

신규 House 생성의 Auth UID 경로는 현재 **없다**. CoreHub 계약에 맞추려면 신규 경로는 다음처럼 별도로 만들어야 한다.

1. 요청의 Supabase access token을 CoreNull 서버가 검증한다.
2. 서버가 검증된 `user.id`를 `corenull_houses.owner_id`에 기록한다.
3. 클라이언트 body의 owner 값은 무시하거나 거부한다.
4. `house_id` 접근은 `id = house_id AND owner_id = verified_user_id`로 검사한다.
5. 기존 `owner_key`/`device_id` 행은 자동 backfill하지 않는다.

기존 Google subject ↔ owner_key 매핑을 Auth UID 매핑으로 간주해서는 안 된다. 두 식별자는 별도 계약과 수동 migration 승인이 필요하다.

## 4. 도메인 version·Fact 후보 조사

### 확인된 테이블/필드

`lib/database.types.ts`에서 확인한 주요 테이블은 다음과 같다.

| 테이블 | 소유/연결 필드 | 시간 필드 | version |
|---|---|---|---|
| `corenull_houses` | `owner_key`, `id` | `created_at`, `updated_at` | 없음 |
| `corenull_rooms` | `house_id` | `created_at`, `updated_at`, `bloom_date` | 없음 |
| `messages` | `owner_key`, `house_id`, `room_id`, `type`, `relations` | `created_at`, `harvested_at` | 없음 |
| `corenull_footprints` | `owner_key`, `room_id` | `visited_at` | 없음 |
| `corenull_bookmarks` | `owner_key`, `room_id`/`message_id` | `created_at` | 없음 |
| `corenull_house_members` | `device_id`, `house_id` | `joined_at` | 없음 |

`lib/roomStage.js`는 `seed_mode`, `created_at`, `bloom_date`, `messages.type = 'fruit'`, `harvested_at`를 이용해 상태를 계산하지만, 이를 저장하는 monotonic version은 없다.

### 현재 Fact 전송 지점

- `app/api/corenull/rooms/route.js:5-10, 107-130`
  - seed Room 생성 후 `space.seed.created`를 fire-and-forget 전송한다.
  - body에 `owner_key`가 들어간다.
  - `Authorization`/`Idempotency-Key`가 없다.
- `app/api/corenull/posts/route.js:5-11, 101-151`
  - fruit 생성 후 `space.fruit.created`를 await하지만 실패를 무시한다.
  - body에 `owner_key`가 들어간다.
- `app/api/corenull/posts/route.js:256-283`
  - harvest 후 `space.fruit.harvested`를 전송한다.
  - 역시 durable 기록이나 재시도가 없다.

### 권장 첫 이벤트 범위

staging의 첫 E2E는 실제 코드에 이미 존재하는 두 이벤트만 대상으로 한다.

1. `corenull_rooms.seed_mode`가 false → true로 확정된 Room 변경: `space.seed.created`
2. `messages.type = 'fruit'` 삽입: `space.fruit.created`

각 이벤트에는 최소한 `house_id`, `room_id` 또는 `post_id`, 그리고 도메인 변경에서 확정된 `revision`이 필요하다. 현재 version 컬럼이 없으므로 다음 중 하나를 먼저 선택해야 한다.

- 해당 도메인 테이블에 `revision bigint not null`을 추가하고 변경 트랜잭션에서 증가
- 별도 event sequence를 같은 트랜잭션에서 생성
- DB trigger로 변경 revision을 발급

`created_at`만으로 idempotency key를 만들거나 임의의 `v3`를 넣는 것은 채택하지 않는다.

## 5. 워커·전송 조사

CoreNull 저장소에서 `worker`, `queue`, `cron`, `outbox`, `idempotency`, `backoff` 구현은 확인되지 않았다. 현재 `pushFact`는 CoreNull API request lifecycle 안에서 직접 CoreHub를 호출한다.

따라서 다음 요소가 모두 미구현이다.

- durable outbox row
- same-transaction domain + outbox write
- claim/lease/lease token
- retry/backoff
- `quarantined` 상태
- payload canonicalization/hash
- `Authorization` 발급/갱신 모델
- 성공/중복/409/503 관측과 알림

## 6. Worker 인증 ADR 결론 후보

현재 사실만으로는 사용자 위임 token 방식은 실행할 수 없다. CoreNull이 브라우저 세션/access token을 유지하거나 워커에 안전하게 전달하는 계약이 없기 때문이다.

따라서 **서비스 간 인증을 우선 후보로 권고**한다. 단, 이는 사용자의 승인을 거쳐야 하는 ADR 결정이며 아직 승인된 사항이 아니다. CoreHub PR #2에는 사용자 Bearer 계약이 이미 구현되어 있다. 서비스 간 인증을 선택할 경우에만 별도 service-auth 경로와 ownership assertion 검증을 추가해야 한다.

- CoreNull worker의 mTLS 또는 HMAC 서명 검증
- 서명된 claim의 `owner_id`, `house_id`, `source`, `idempotency_key`, `payload_sha256`, timestamp/nonce 검증
- CoreHub가 claim의 owner와 House 소유권을 별도로 확인
- `service_role`은 DB RPC 호출용으로만 사용하고 사용자 인증 대체물로 사용하지 않음
- 인증 실패는 `401`, House 소유권 불일치는 `403`, 재생 공격/서명 불일치는 별도 감사 및 차단

상세 선택지는 별도 ADR 초안에 기록했다.

## 7. Staging readiness

현재는 **CoreNull→CoreHub staging E2E 실행 불가** 판정이다. CoreHub PR #2 자체의 consumer-side unit/integration 검증과는 구분한다. 이유는 다음과 같다.

- CoreNull에 outbox migration이 없음
- CoreNull에 worker가 없음
- Auth UID/House owner_id 계약이 없음
- domain revision 계약이 없음
- staging DB/project selector와 격리된 CoreHub endpoint가 지정되지 않음

운영 DB에 연결하지 않고 다음 순서로 진행해야 한다.

1. ADR 승인: 서비스 간 인증 또는 사용자 위임 token 중 하나 선택
2. CoreNull staging migration: `owner_id`, domain revision, outbox, conflict audit, lease token
3. 신규 House/Auth UID 경로만 staging에서 구현
4. 첫 두 Fact 이벤트에 대해 worker를 구현
5. disposable PostgreSQL 16에서 원자성·중복·409·503·lease 만료 검증
6. staging Supabase/CoreHub endpoint에서 Auth/House ownership 검증
7. 결과 기록 후 운영 migration과 실데이터 연결을 별도 승인

이 보고서 작성 시점에는 운영 DB 및 운영 migration을 건드리지 않았다.
