# Auth UID ↔ House ownership 매핑 검증 보고서

- 검증일: 2026-10-16
- 대상: CoreNull 현재 default branch, CoreHub PR #2 `security/corehub-event-integrity-2026-10-05`
- 판정: **BLOCKED — 현재 매핑 계약과 schema가 연결되어 있지 않음**
- 운영 DB 변경: 없음
- staging DB query: 실행하지 않음

## 1. 결론

현재 CoreNull에는 Supabase Auth UID를 House owner로 저장하고 검증하는 경로가 없다. CoreNull의 실제 API·생성 타입은 `public.corenull_houses.owner_key`를 사용하며, House 생성 body와 조회·수정 권한도 client-supplied `owner_key`를 기준으로 한다.

반면 CoreHub PR #2의 Facts API는 검증된 Supabase access token에서 `user.id`를 얻은 뒤, 다음 query를 실행한다.

```js
supabase
  .schema('corenull')
  .from('houses')
  .select('id')
  .eq('id', houseId)
  .eq('owner_id', userId)
  .maybeSingle()
```

즉 PR #2는 `corenull.houses.owner_id`라는 별도 schema/table/column 계약을 기대한다. CoreNull 저장소에는 이 구조를 만드는 migration이나 generated type가 확인되지 않았다. CoreNull에는 `corenull_owner_identities`를 호출하는 route는 있지만 해당 table의 migration/type도 저장소에서 확인되지 않았다.

따라서 현재는 **Auth UID와 House ownership 매핑이 검증된 상태가 아니며, CoreNull과 CoreHub가 같은 Supabase project를 사용한다면 CoreHub ownership query가 schema/table 불일치로 실패할 가능성이 높다.** 실제 project가 분리되어 있다면 두 project 사이의 ownership assertion 계약이 별도로 필요하다.

## 2. 증거 대조

| 확인 항목 | CoreNull | CoreHub PR #2 | 판정 |
|---|---|---|---|
| 사용자 canonical ID | Google subject를 `owner_key`에 연결 | Supabase `auth.users.id` | 불일치 |
| House table | `public.corenull_houses` | `corenull.houses` | 불일치 |
| House owner column | `owner_key` | `owner_id` | 불일치 |
| House 생성 | body `owner_key`를 admin client로 insert | owner는 Bearer token의 `user.id` | 불일치 |
| House read | `house_id`만 있으면 owner 검증 없이 조회 가능 | `house_id + user.id` ownership query | 불일치 |
| identity mapping | route가 `corenull_owner_identities`를 참조 | mapping을 사용하지 않고 token UID 사용 | 연결 계약 없음 |
| migration/type | owner_id 및 mapping table 정의 미확인 | CoreHub migration은 CoreHub 자체 owner_id만 추가 | 연결 미완료 |

### CoreNull 증거

- `app/api/auth/google/route.js:34-80`
  - Google ID token을 서버에서 검증하지만 응답에는 `owner_key`만 반환한다.
  - access token/refresh token/session을 브라우저에 전달하지 않는다.
- `app/api/identity/sync/route.js:37-79`
  - `corenull_owner_identities`에서 Google subject ↔ `owner_key`를 조회/insert한다.
  - Auth UID 또는 `auth.users.id`를 저장하지 않는다.
- `app/api/corenull/houses/route.js:50-112`
  - House 조회·생성이 `owner_key` 기반이다.
  - POST body의 `owner_key`를 `getSupabaseAdmin()`으로 직접 `corenull_houses.owner_key`에 저장한다.
- `app/api/corenull/houses/route.js:115-175`
  - PATCH 권한도 body의 `owner_key`와 House의 `owner_key` 비교로 결정한다.
- `lib/database.types.ts:549-580`
  - `corenull_houses` Row/Insert/Update에는 `owner_key`가 있고 `owner_id`가 없다.
- `supabase/migrations/`
  - 저장소에 확인되는 migration은 House image 관련 두 파일이며, `owner_id`, `corenull_owner_identities`, `create schema corenull` 정의는 확인되지 않았다.
- CoreNull linked project metadata는 `grlfocvlfatuvphkyivd`이지만, 이 파일만으로 staging/production 구분을 승인하지 않는다.

### CoreHub 증거

- `app/api/corehub/facts/route.js:16-23`
  - `authenticateUser()`가 access token에서 `userId`를 얻는다.
- `app/api/corehub/facts/route.js:121-134`
  - `.schema('corenull').from('houses')`에서 `owner_id = userId`를 확인한다.
- `supabase/migrations/20261005150000_corehub_auth_idempotent_processing.sql:3-8, 60-63`
  - CoreHub 자체 Fact/Opportunity 계열에 Auth UID 컬럼을 추가한다.
  - 이 migration은 CoreNull House table을 만들거나 `corenull_houses.owner_key`를 Auth UID로 연결하지 않는다.
- `lib/supabase.ts:7-18`
  - CoreHub는 환경변수의 Supabase URL/service-role key로 연결한다.
  - 실제 project가 CoreNull과 동일한지는 staging 설정 확인 없이는 단정하지 않는다.

## 3. 매핑 상태

| 매핑 | 상태 | 근거 |
|---|---|---|
| Google subject → `owner_key` | 부분 구현 | `identity/sync` route 존재 |
| Google subject → Auth UID | 미확인 | Auth user는 검증하지만 저장/반환 contract 없음 |
| Auth UID → House | 미구현 | `corenull_houses.owner_id` 없음 |
| `owner_key` → House | 구현 | `corenull_houses.owner_key` 비교 |
| CoreNull House → CoreHub House | 미연결 | table/schema/column 계약 불일치 |
| worker identity → CoreHub Auth UID | 미결정 | worker credential/ownership assertion 없음 |

## 4. staging에서 검증해야 할 SQL·시나리오

운영 project에는 실행하지 않는다. 별도 staging project에서만 다음을 확인한다.

### Schema 확인

```sql
select table_schema, table_name, column_name, data_type
from information_schema.columns
where (table_schema = 'public' and table_name in ('corenull_houses', 'corenull_owner_identities'))
   or (table_schema = 'corenull' and table_name = 'houses')
order by table_schema, table_name, ordinal_position;
```

확인해야 할 결과는 하나의 명확한 계약이다.

- 선택지 A: `public.corenull_houses.owner_id uuid references auth.users(id)`를 canonical House owner로 채택
- 선택지 B: `corenull.houses.owner_id uuid`를 canonical House owner로 채택하고 CoreNull과 동기화/공유
- 선택지 C: 두 table을 유지하되 `house_id → owner_id` ownership assertion을 명시적으로 관리

현재는 어느 선택지도 승인되지 않았다.

### Auth/ownership fixture

1. staging Auth user A와 B를 만든다.
2. 검증된 Auth session으로 House A를 생성한다.
3. House A row의 canonical owner가 A인지 확인한다.
4. user B token으로 House A를 Fact POST하면 `403`이어야 한다.
5. user A token으로 House A를 Fact POST하면 `201`이어야 한다.
6. CoreNull의 legacy `owner_key`만 아는 요청은 Auth UID로 자동 승격되지 않아야 한다.
7. mapping 충돌은 명시적인 `409` 또는 quarantine으로 처리한다.
8. legacy House는 backfill 승인 전까지 CoreHub Fact 송신 대상에서 제외한다.

## 5. 권고 결정

현재 상태에서는 CoreHub PR #2를 수정해 `owner_key`를 다시 신뢰하도록 만들지 않는다. PR #2의 핵심 보안 원칙인 “owner는 검증된 Auth token에서 유도”를 유지한다.

먼저 별도 ADR에서 다음을 결정해야 한다.

1. canonical House table/schema
2. `owner_id uuid references auth.users(id)` 도입 위치
3. 기존 `owner_key`와 Auth UID의 수동 연결 절차
4. Google identity와 Auth UID의 관계
5. legacy House의 처리 범위
6. CoreNull API가 client-supplied owner 값을 제거하는 시점
7. CoreNull worker가 CoreHub에 사용자 Bearer token을 사용할지, 별도 서비스 인증을 사용할지

## 최종 판정

**Auth UID ↔ House ownership 매핑: FAIL / BLOCKED**

현재 코드에서 확인되는 것은 Google subject ↔ `owner_key` 연결뿐이다. CoreHub PR #2가 요구하는 Auth UID ↔ House ownership 연결은 schema·API·staging fixture 모두 확정되지 않았다. 이 매핑을 확정하고 별도 staging 검증을 통과하기 전에는 CoreNull → CoreHub Fact 송신이나 운영 migration을 진행하지 않는다.
