# P4 Staging Replay Ledger 적용·검증 보고서

- 실행 상태: **staging 적용 완료 / probe 검증 완료**
- 대상 Supabase: `Jena-Voca-01`
- project ref: `grlfocvlfatuvphkyivd`
- migration name: `corering_p4_assertion_replay_ledger`
- migration version: `20261106161908`
- 작업 branch: `poc/corering-p4-assertion-verifier`
- 적용 범위: CoreRing P4 assertion replay ledger와 atomic consume RPC만
- Production 적용: 없음
- CoreHub route 활성화: 없음
- 기존 CoreHub resource data 변경: 없음

## Preflight

적용 전 다음을 확인했다.

- `grlfocvlfatuvphkyivd`가 접근 가능한 `Jena-Voca-01` staging project로 확인됨
- 기존 migration에 `lock_corehub_client_access`가 적용되어 있음
- 대상 `corehub.corering_p4_assertion_replays` 테이블과
  `corehub.corehub_consume_corering_p4_jti` RPC가 적용 전에는 존재하지 않음
- 기존 `corehub`/`public` 보안 상태를 advisor로 확인함

## 적용된 객체

### Table

```text
corehub.corering_p4_assertion_replays
```

컬럼:

- `issuer`
- `jti`
- `first_seen_at`
- `expires_at`

primary key:

```text
(issuer, jti)
```

raw assertion, cookie, `owner_key`, `provider_sub`, `device_id`는 저장하지 않는다.

### RPC

```text
corehub.corehub_consume_corering_p4_jti(
  text,
  text,
  timestamptz
) returns boolean
```

동작:

- 첫 non-expired `(issuer, jti)`: `true`
- 동일 `(issuer, jti)` 재사용: `false`
- 만료 입력: `false`
- `ON CONFLICT (issuer, jti) DO NOTHING`
- `SECURITY DEFINER`
- `search_path = pg_catalog`

### 권한

확인 결과:

```text
anon table SELECT: false
authenticated table SELECT: false
anon RPC EXECUTE: false
authenticated RPC EXECUTE: false
service_role RPC EXECUTE: true
```

테이블 RLS는 enabled이며, `anon`·`authenticated`에 restrictive deny policy가 존재한다.

## Runtime probe 결과

전용 probe issuer를 사용해 RPC를 실행했다.

### 최초 사용·재사용·만료

```text
first_consume:  true
replay_consume: false
expired_consume: false
```

### 동일 jti 동시성

동일 `(issuer, jti)`를 16회 호출했다.

```text
accepted_count: 1
rejected_count: 15
```

atomic primary-key conflict semantics가 기대대로 동작했다.

## Cleanup

probe용 issuer의 test row를 삭제했다.

```text
remaining_probe_rows: 0
```

staging에 probe 데이터는 남기지 않았다.

## Advisor 결과

migration 적용 후 advisor를 다시 확인했다. 기존 staging baseline에는 다음 유형의 기존 경고가 있다.

- 다른 테이블의 RLS enabled/no policy
- 기존 security-definer view
- 기존 mutable function search path
- 기존 public schema extension
- 기존 anon/authenticated security-definer function 권한
- leaked password protection disabled

이번 replay ledger table/RPC가 새로 해당 advisor finding에 추가된 것은 확인되지 않았다. 기존 baseline 경고는 이번 migration의 범위 밖이며 자동 수정하지 않았다.

## 미수행 범위

다음은 이번 단계에서 수행하지 않았다.

- CoreHub route에 신규 issuer 활성화
- CoreRing public key 등록
- 실제 CoreRing assertion 발급 E2E
- staging anon/authenticated HTTP client를 통한 REST RPC 호출
- replay row cleanup scheduler
- production migration
- 기존 Opportunities/Facts 권한 변경

## 판정

staging에서 migration 적용과 database-level atomic replay contract 검증은 통과했다.

다만 이 결과만으로 CoreRing assertion 경로가 운영 가능해진 것은 아니다. 다음 단계에서는 public key/issuer 환경변수, CoreRing signer, route dispatch, staging read-only E2E를 별도로 연결·검증해야 한다.
