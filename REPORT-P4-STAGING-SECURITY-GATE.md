# P4 Staging E2E·Security Gate Report

검토 시각: 2026-11-05

## 판정

**배포 승인: BLOCKED**

승인 차단 사유는 두 가지다.

1. 실제 Staging Bearer token과 테스트 fixture가 세션에 주입되지 않아 소유자·타인·매핑 없음·만료·이미 소비된 Opportunity의 실제 API E2E를 실행하지 못했다.
2. 실제 E2E와 CoreRing production proxy 배포가 아직 완료되지 않았다. DB 경계 migration은 적용했지만, 검증 전에는 Production 반영을 승인하지 않는다.

## Staging E2E

`npm run test:p4:e2e` 실행 결과:

```text
SKIP: COREHUB_STAGING_URL and COREHUB_STAGING_BEARER are required for Staging E2E.
```

환경변수 네 가지는 모두 현재 세션에서 `UNSET`이었다.

```text
COREHUB_STAGING_URL
COREHUB_STAGING_BEARER
COREHUB_STAGING_OWNED_OPPORTUNITY_ID
COREHUB_STAGING_OTHER_OPPORTUNITY_ID
```

Vercel에는 P4 branch의 READY 배포가 확인되지만 최신 branch 배포의 target은 `production`이며, 별도의 명시적인 Staging URL·유효 Bearer token·소유자/타인 fixture가 제공되지 않았다. 따라서 production URL을 임의로 Staging으로 간주하지 않았다.

P4 단위 회귀 테스트는 migration 적용 후에도 9/9 통과했다. E2E는 여전히 Bearer와 fixture가 없어 `SKIP`이다.

## CoreRing 실제 인증 경로

My Browser로 `https://corering.vercel.app`을 열어 확인했다.

- 화면에는 CoreRing/CorePhrase/KIIP 번역 UI만 있다.
- 로그인·회원가입·OAuth callback·Supabase Auth UI가 없다.
- 저장소 코드와 live JS bundle에서 `supabase.auth`, `access_token`, `Authorization: Bearer`, `SERVICE_ROLE` marker를 확인하지 못했다.
- 현재 UI의 CoreHub 호출은 `owner_key` query와 localStorage device ID 기반이다.
- 실제 live URL의 `/api/corehub/opportunities` 및 `?owner_key=...`는 `404`를 반환했다. 즉 현재 CoreRing production에는 수정된 P4 proxy route가 배포되어 있지 않다.

결론적으로 CoreRing proxy 코드가 Bearer를 처리할 수 있다는 것과 별개로, 현재 사용자 UI는 Bearer를 생성·보유·전달하지 않는다.

## Supabase 보안 검토

대상 프로젝트: `grlfocvlfatuvphkyivd`

`public.corenull_owner_identities`와 다음 CoreHub 테이블을 확인했다.

```text
corehub.connections
corehub.facts
corehub.meanings
corehub.opportunities
corehub.learning_logs
```

적용 전 각 대상 테이블은 RLS enabled 상태지만, `pg_policies`에는 정책이 없었다. Security advisor도 `rls_enabled_no_policy`를 대상 테이블들에 대해 보고했다.

적용 전 권한 조회에서는 `anon`과 `authenticated`에 다음 권한이 모두 부여되어 있었다.

```text
SELECT, INSERT, UPDATE, DELETE,
TRUNCATE, REFERENCES, TRIGGER
```

특히 `public.corenull_owner_identities`와 `corehub.opportunities`에 대한 직접 anonymous/authenticated 접근이 허용된 상태였고, 이를 차단하는 migration을 적용했다.

### 적용 완료

Staging 프로젝트에 migration `lock_corehub_client_access`가 적용됐다.

- 대상은 지정한 6개 테이블로 제한
- `anon`, `authenticated`의 전체 테이블 권한 철회
- 각 테이블에 `AS RESTRICTIVE` `deny_direct_client_access` policy 생성
- `service_role`의 SELECT/INSERT/UPDATE 및 기존 권한 유지 확인
- Supabase migration history에 `20261105020951 lock_corehub_client_access` 기록 확인
- Service-role MCP 경계에서 identity/facts/opportunities/learning_logs 조회 정상

적용 후 대상 6개 테이블에는 더 이상 `anon`·`authenticated` table grant가 없고, 모두 restrictive policy가 존재한다. Security Advisor의 `rls_enabled_no_policy` 대상에서도 이 6개 테이블이 사라졌다.

Security Advisor에는 다른 테이블 47건의 RLS no-policy 정보, 기존 Security Definer view 2건, 함수 search_path 및 실행 권한 경고, leaked password protection 경고가 남아 있다. 이 잔여 항목은 이번 6개 테이블 migration의 범위를 벗어나며 Production 승인 전 별도 검토 대상이다.

추가 security advisor 결과에는 다음도 포함됐다.

- Security Definer view 2건
- anonymous/authenticated가 실행 가능한 Security Definer function 경고
- leaked password protection disabled

## Service Role 노출

실제 CoreRing production JavaScript bundle 8개를 검사했으며 다음 marker가 없었다.

```text
SUPABASE_SERVICE_ROLE_KEY
SERVICE_ROLE
service_role
supabase.auth
access_token
Authorization: Bearer
```

따라서 현재 확인 범위에서 Service Role 키가 브라우저 bundle에 노출된 증거는 없다. 서버 코드의 Service Role 사용 여부와 브라우저 노출 여부는 별개이며, 현재 live bundle에는 노출되지 않았다.

## 배포 전 필수 조치

1. CoreRing에 실제 Supabase Auth 로그인 또는 상위 인증 공급 경로를 구현한다. 로컬에는 세션이 있을 때 Bearer를 전달하는 helper를 추가했지만, 로그인 UI는 아직 없다.
2. P4 CoreRing proxy route를 Staging에 배포한다. 현재 `corering.vercel.app/api/corehub/opportunities`는 404다.
3. URL·유효 Bearer token·소유자 fixture·타인 fixture를 주입해 P4 E2E를 재실행한다.
4. 소유자/타인/매핑 없음/만료/소비 완료 시나리오가 모두 통과한 뒤에만 배포 승인을 재검토한다.

Staging DB migration은 적용 완료됐다. Production DB 변경과 Production 배포는 수행하지 않았다.
