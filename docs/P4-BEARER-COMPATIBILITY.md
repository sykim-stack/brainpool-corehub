# P4 Bearer·Owner 호환 계약

## 오류 응답

기존 CoreHub 클라이언트가 `_error`를 읽고, P4 계약이 `error`를 사용하므로 오류 응답은 두 필드를 같은 코드로 반환한다.

```json
{
  "error": "auth_required",
  "_error": "auth_required",
  "traceId": "..."
}
```

성공 응답의 기존 `data`와 P4의 `meta.owner_linked`, `meta.auth`는 그대로 유지한다. 기존 클라이언트가 `_error`만 읽어도 동작하고, 신규 클라이언트가 `error`를 읽어도 같은 결과를 얻는 것이 목적이다.

## Staging 매핑 테이블 확인

CoreHub 설계가 참조하는 공유 Supabase 프로젝트는 `grlfocvlfatuvphkyivd`이다. 읽기 전용 확인 결과 다음 테이블이 존재한다.

```text
public.corenull_owner_identities
  id
  provider
  provider_sub
  owner_key
  created_at
```

`(provider, provider_sub)`에는 unique constraint가 있다. 따라서 P4.2 resolver는 다음 매핑만 사용한다.

```text
verified Supabase user identity
  → normalized provider + provider_sub
  → public.corenull_owner_identities
  → owner_key[]
```

매핑이 없으면 `ownerKeys: []`, `owner_linked: false`이며 자동 ID 생성이나 백필을 수행하지 않는다. 조회 장애는 `principal_mapping_unavailable`로 분리한다.

Staging 확인 시에는 raw identity 값이나 토큰을 로그로 남기지 않고 다음만 확인한다.

- 대상 project ref와 환경
- 테이블·컬럼·unique constraint 존재 여부
- provider별 row 수와 distinct count
- CoreHub 대상 테이블의 RLS/policy 상태
- 테스트 사용자별 매핑 여부와 소유권 결과

현재 공유 DB에서 CoreHub와 매핑 테이블은 RLS enabled지만 대상 테이블에 조회된 policy가 없었다. Service Role API만으로 접근되는지, 외부 API에서 노출되지 않는지 별도 보안 검토가 필요하다.

## CoreRing 경로 분리

- Bearer 헤더가 있으면 `COREHUB_API_URL`의 P4 route로 전달한다.
- Bearer 경로에서는 client query/body의 `owner_key`나 `device_id`를 CoreHub로 전달하지 않는다.
- Bearer 헤더가 없으면 기존 `device_id → owner_key` 익명 경로를 `COREHUB_LEGACY_API_URL`로 보낸다.
- `COREHUB_LEGACY_API_URL`을 P4 endpoint와 같은 값으로 설정하면 익명 요청은 `owner_fields_not_accepted`로 fail-closed 된다.
- 현재 CoreRing UI는 Supabase access token을 생성하거나 저장하는 경로가 확인되지 않았으므로, Bearer E2E를 위해서는 상위 인증 흐름 또는 호출자가 `Authorization` 헤더를 제공해야 한다.

## 검증 범위

`npm run test:p4`는 인증 실패, 매핑 없음, 타인 데이터 접근, owner 입력 거부, HMAC 분리, 만료·소비 필터, 조건부 PATCH 경합 계약을 검증한다.

`npm run test:p4:e2e`는 Staging URL·Bearer token·선택적 owned/other Opportunity fixture가 환경변수로 제공될 때만 실제 API를 호출한다. 값이 없으면 실행하지 않은 시나리오를 `SKIP`으로 표시하며 통과로 취급하지 않는다.
