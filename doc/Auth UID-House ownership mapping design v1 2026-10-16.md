# Auth UID ↔ House ownership 매핑 설계 v1

- 상태: **Draft — 승인 전**
- 기준일: 2026-10-16
- 운영 DB 적용: 금지
- canonical 선택 제안: **`public.corenull_houses` 유지 + nullable `owner_id` 추가**

## 1. canonical 계약

CoreNull의 실제 도메인 테이블을 canonical House table로 유지한다.

```text
public.corenull_houses.id          = House ID
public.corenull_houses.owner_id    = verified Supabase auth.users.id, nullable
public.corenull_houses.owner_key   = legacy CoreNull identifier, preserved
```

`owner_id IS NULL`은 **미연결 House**를 의미한다. NULL을 임의 사용자와 연결하거나 `owner_key`를 UUID라는 이유만으로 Auth UID로 해석하지 않는다.

CoreHub PR #2의 현재 `.schema('corenull').from('houses').eq('owner_id', userId)` query는 canonical table에 맞춰 별도 수정해야 한다. 두 개의 House table을 만들어 복제하는 방식은 drift를 만들 수 있으므로 채택하지 않는다.

## 2. Identity mapping 계약

`public.corenull_owner_identities`를 identity mapping table로 사용한다. 기존 `provider`, `provider_sub`, `owner_key`는 보존하고 다음을 추가한다.

| 컬럼 | 의미 | nullable |
|---|---|---:|
| `provider` | `google`, `kakao` 등 | no |
| `provider_sub` | provider의 immutable subject | no |
| `owner_key` | legacy CoreNull owner | no |
| `auth_user_id` | Supabase `auth.users.id` | yes |
| `linked_at` | Auth UID 연결 시각 | yes |
| `link_method` | `new_signup`, `explicit_link`, `manual_review` | yes |

`auth_user_id IS NULL`인 row는 legacy identity로만 취급한다. `provider_sub`와 Auth UID의 연결은 서버가 검증한 Auth user identity를 근거로 해야 한다.

## 3. 신규 사용자 절차

1. 사용자가 Google/GIS로 로그인한다.
2. CoreNull 서버가 Google ID token을 Supabase Auth로 검증한다.
3. 서버가 검증된 `user.id`와 `user.identities`의 provider subject를 함께 얻는다.
4. `corenull_owner_identities`에 `(provider, provider_sub, auth_user_id)`를 원자적으로 insert/upsert한다.
5. 충돌 시 기존 `auth_user_id`와 다르면 `409 IDENTITY_CONFLICT`로 중단한다.
6. 신규 House 생성은 client `owner_key`를 신뢰하지 않고 검증된 `user.id`를 `owner_id`에 저장한다.
7. legacy 호환을 위해 서버가 별도 `owner_key`를 생성·보존할 수 있으나, ownership 판단은 `owner_id`를 우선한다.

## 4. 기존 사용자 절차

기존 `owner_key`와 House를 자동으로 Auth UID에 연결하지 않는다.

1. 사용자가 로그인해 검증된 `user.id`와 provider subject를 확보한다.
2. 현재 owner key가 기존 identity row와 일치하는지 서버에서 확인한다.
3. 해당 provider subject가 이미 다른 `auth_user_id`에 연결되어 있으면 중단한다.
4. 사용자가 명시적으로 “기존 House 연결”을 요청한 경우에만 `auth_user_id`를 기록한다.
5. 연결 시 `owner_key`와 기존 House row는 보존한다.
6. 연결된 House만 `owner_id` 기반 CoreHub Fact 송신 대상이 된다.
7. 검증되지 않은 legacy House는 계속 `owner_id IS NULL`로 남기고 Fact 송신을 quarantine한다.

## 5. 검증 규칙

- client body/query의 `owner_id`는 절대 신뢰하지 않는다.
- `owner_key`는 legacy correlation 값이지 Auth UID가 아니다.
- 같은 `(provider, provider_sub)`가 두 Auth UID에 연결될 수 없다.
- 같은 `(provider, auth_user_id)`가 두 owner key에 연결될 수 없다.
- 한 Auth UID가 여러 House를 소유할 수 있으므로 `owner_id` 단독 unique constraint는 두지 않는다.
- House ownership check는 `house_id + verified user.id`로 수행한다.
- member 권한과 owner 권한은 별도 계약으로 유지한다.
- legacy House의 자동 backfill은 금지한다.

## 6. CoreHub 연결

CoreHub Facts API는 다음 순서로 처리해야 한다.

1. Bearer token에서 `user.id` 검증
2. canonical `public.corenull_houses`에서 `id = house_id AND owner_id = user.id` 확인
3. 실패 시 `403`
4. 성공 후 `corehub.process_fact_event(p_owner_id = user.id, ...)` 실행

현재 PR #2의 `corenull.houses` 참조는 이 계약과 맞지 않으므로, staging migration보다 먼저 route/schema 계약을 정렬해야 한다.

## 7. 승인 전 금지사항

- `owner_key`를 `owner_id`로 일괄 복사
- Google subject를 Auth UID로 저장
- 운영 House 전체 backfill
- CoreHub에 두 번째 House table 생성
- 미연결 House의 Fact 송신
- worker 인증 방식 확정 전 outbox worker 배포
