# Hermes 조사 브리프

## CoreNull → CoreHub 통합을 위한 Identity·Auth·RLS·Worker 조사

- 문서 상태: 조사 실행용
- 작성일: 2026-10-16
- 조사 대상: `brainpool-corenull`, `brainpool-corehub`, `brainpool-clean`, `hajuncore-app`, `brainpool-os`
- 현재 원칙: **코드 변경 금지, 운영 DB 변경 금지, 운영 migration 실행 금지**

---

## 1. 조사 목적

CoreNull에서 발생한 실제 도메인 이벤트를 CoreHub로 안전하게 전달하기 전에, 현재 시스템의 인증·식별자·House 소유권·RLS·서버 간 인증 상태를 사실 기반으로 정리한다.

최종적으로 다음 질문에 답해야 한다.

> 누가 사용자인가?
> 어떤 식별자가 어느 시스템의 권위 있는 ID인가?
> House 소유권은 무엇으로 검증하는가?
> 백그라운드 worker는 어떤 자격으로 CoreHub에 전송하는가?
> 이벤트의 동일성과 재시도는 무엇으로 보장하는가?

조사 결과는 **구현 승인 전의 사실 확인 자료**다. 조사자가 임의로 인증 방식, owner mapping, RLS 정책 또는 migration을 확정하지 않는다.

## 2. 반드시 지킬 제한사항

- 소스 코드 수정 금지
- 운영 Supabase 프로젝트 접속·변경 금지
- 운영 migration 및 RLS policy 실행 금지
- 기존 `device_id`, `owner_key`, Google subject를 Auth UID로 자동 매핑하지 않음
- 사용자 access token, refresh token, service key를 로그·문서·커밋에 기록하지 않음
- `service_role`을 사용자 인증의 대체물로 승인하지 않음
- 문서의 주장만 근거로 현재 구현이라고 판단하지 않음
- 모든 결론에 파일 경로, 줄 번호 또는 SQL/로그 증거를 붙임
- 발견하지 못한 것은 “없음”이 아니라 “조사 범위에서 확인되지 않음”으로 기록

## 3. 저장소별 조사 범위

### 3.1 CoreNull

저장소: `sykim-stack/brainpool-corenull`

조사할 항목:

- Google/Supabase Auth 로그인 진입점
- `signInWithIdToken`, `getUser`, `getSession`, cookie/session 저장 여부
- 서버 API가 Authorization header를 검증하는지
- `owner_key`, `device_id`, Google subject의 생성·저장·복구·연결 경로
- `corenull_houses`의 실제 schema와 신규 House 생성 경로
- House 조회·수정·멤버십 검증 경로
- `messages`, `corenull_rooms`, `corenull_footprints`, `corenull_bookmarks`의 이벤트 후보
- `version`, `revision`, optimistic locking, `updated_at` 사용 여부
- 현재 CoreHub 호출부와 전송 실패 처리
- worker, queue, cron, webhook, outbox 구현 여부

### 3.2 CoreHub

저장소: `sykim-stack/brainpool-corehub`

조사할 항목:

- Fact API의 인증 계약과 실제 route 구현
- `owner_id`가 어디에서 유도되는지
- `house_id` House ownership 검증 방식
- `Idempotency-Key` validation과 duplicate/conflict 응답
- RPC transaction boundary와 advisory lock
- 서비스 간 인증을 추가할 경우 필요한 API 변경 범위
- RLS policy, grant/revoke, `SECURITY DEFINER`, `search_path`
- 현재 staging/disposable PostgreSQL 검증 방법 존재 여부

### 3.3 CoreRing / brainpool-clean

저장소: `sykim-stack/brainpool-clean`

조사할 항목:

- `device_id` 생성·전달·저장 경로
- CoreNull 또는 CoreHub와의 식별자 연결 여부
- CoreRing에서 발생하는 이벤트와 소유자 표현
- 문서에 기재된 RLS 상태와 실제 migration/policy의 일치 여부
- 서버 간 호출의 Authorization, service key, placeholder 존재 여부

### 3.4 HajunAI / hajuncore-app

저장소: `sykim-stack/hajuncore-app`

조사할 항목:

- webhook/API 수신 인증
- CoreRing/CoreNull/CoreHub 호출 인증
- owner 또는 user identity claim 처리
- 환경변수 이름과 secret 사용 방식
- retry, idempotency, trace/audit logging

### 3.5 brainpool-os

저장소: `sykim-stack/brainpool-os`

조사할 항목:

- Identity Platform Architecture 문서
- `clo3`, `clo4`, `clo5`의 인증·식별자 관련 계약
- `device_id` 기반 구 참조 구현과 `owner_key` 기반 신 구현의 관계
- `(ctx) => ctx` 계약이 인증 실패나 client-supplied identity를 어떻게 다루는지
- 현재 운영 시스템에 적용되는 문서인지, 구 참조 구현인지
- Identity Platform 구현 책임의 소유 저장소

## 4. 핵심 조사 질문

### A. Auth와 세션

1. 실제 로그인 provider는 무엇인가?
2. Supabase Auth `auth.users.id`가 실제 사용자 canonical ID로 사용되는가?
3. 로그인 후 브라우저에 access token/session cookie가 생기는가?
4. 서버 API가 매 요청 token을 검증하는가?
5. 백그라운드 worker가 사용자 세션 없이도 재시도할 수 있는가?
6. token 저장·갱신·폐기 책임자는 누구인가?

### B. Identity mapping

다음 표를 사실로 채운다.

| 식별자 | 생성 위치 | 저장 위치 | 의미 | 권위 시스템 | 다른 ID와 매핑 |
|---|---|---|---|---|---|
| `device_id` |  |  |  |  |  |
| `owner_key` |  |  |  |  |  |
| Google subject |  |  |  |  |  |
| Supabase `auth.users.id` |  |  |  |  |  |
| CoreHub `owner_id` |  |  |  |  |  |

특히 다음을 명시한다.

- 자동 mapping이 있는가?
- mapping이 one-to-one인가?
- 기존 데이터에 적용 가능한가?
- 충돌 시 누가 승인하는가?
- mapping을 별도 `owner_identities` table에 저장해야 하는가?

### C. House ownership

1. 신규 House 생성 시 서버가 검증한 user ID를 저장하는가?
2. 현재 `owner_key`는 client-supplied 값인가?
3. `GET /houses?house_id=...`가 소유권 검증 없이 데이터를 반환하는가?
4. House owner와 member 권한이 분리되어 있는가?
5. CoreHub가 `house_id`를 받을 때 확인할 authoritative mapping은 무엇인가?
6. 레거시 House는 자동 backfill 대상인가? 기본값은 “아니오”다.

### D. Domain event와 version

최소 두 개의 실제 이벤트 후보를 조사한다.

- `space.seed.created`
- `space.fruit.created`

각 이벤트에 대해 다음 표를 작성한다.

| Fact type | 생산 테이블 | 발생 mutation | stable entity ID | occurred_at | version/revision | 현재 전송 방식 | 유실 가능성 |
|---|---|---|---|---|---|---|---|
| `space.seed.created` |  |  |  |  |  |  |  |
| `space.fruit.created` |  |  |  |  |  |  |  |

`created_at`만으로 version을 대신할 수 있는지 판단하지 않는다. 다음 중 어떤 방식이 필요한지 비교한다.

- domain row의 monotonic `revision`
- 별도 event sequence
- DB trigger
- 같은 transaction에서 생성하는 outbox sequence

### E. Worker 인증

다음 선택지를 실제 구현 가능성 기준으로 비교한다.

| 방식 | 필요한 구현 | 장점 | 위험 | 현재 준비도 |
|---|---|---|---|---|
| 사용자 위임 Supabase token |  |  |  |  |
| HMAC 서비스 인증 |  |  |  |  |
| mTLS 서비스 인증 |  |  |  |  |
| `service_role` 직접 사용 | 금지 사유 |  |  |  |

서비스 간 인증을 선택할 경우 반드시 확인한다.

- 서명 대상 canonical request
- timestamp/nonce/replay 방지
- key rotation
- `owner_id`/`house_id` ownership assertion 검증
- CoreHub의 401/403 계약
- 감사 로그와 secret 비노출

### F. RLS와 권한

각 대상 table/policy에 대해 실제 SQL 증거를 기록한다.

| 저장소/프로젝트 | table | RLS enabled | policy 수 | SELECT 조건 | write 권한 | `auth.uid()` 사용 | 비고 |
|---|---|---:|---:|---|---|---:|---|
|  |  |  |  |  |  |  |  |

문서에 “RLS enabled”라고 적혀 있어도 실제 `CREATE POLICY`, `GRANT`, `REVOKE`를 확인하기 전에는 보호된 것으로 판정하지 않는다.

## 5. CoreHub 계약과 대조

현재 CoreHub PR #2 기준으로 다음 계약을 실제 코드와 대조한다.

| 상황 | 기대 응답 | 확인 파일/줄 | 실제 결과 | 불일치 조치 |
|---|---:|---|---|---|
| Bearer 없음/잘못된 token | 401 |  |  |  |
| House 소유권 불일치 | 403 |  |  |  |
| 동일 key·동일 body | 200 duplicate |  |  |  |
| 동일 key·다른 body | 409 |  |  |  |
| 일시적 RPC/Auth 장애 | 503 |  |  |  |
| 서비스 인증 실패 | 401 |  |  |  |

`traceId`는 관측용 correlation ID이며, 이벤트 idempotency key로 사용하지 않는다.

## 6. Staging 검증 계획

조사 단계에서는 실행하지 않고, 준비 조건과 테스트 케이스만 정의한다.

### 사전 조건

- 별도 Supabase staging/disposable project
- 운영과 분리된 CoreHub endpoint
- 테스트 Auth users와 House fixtures
- outbox migration이 staging에만 적용됨
- worker secret은 staging secret manager에서 관리
- 운영 데이터가 staging으로 복사되지 않거나 익명화됨

### 필수 시나리오

1. domain mutation과 outbox insert가 같은 transaction에서 commit됨
2. domain mutation 실패 시 outbox가 생성되지 않음
3. outbox insert 실패 시 domain mutation이 rollback됨
4. 동일 key·동일 body 재전송은 CoreHub duplicate 성공
5. 동일 key·다른 body는 producer conflict 및 CoreHub 409
6. 503/network failure는 같은 key로 backoff retry
7. 401/403/409는 `quarantined`로 전환되고 자동 claim되지 않음
8. lease 만료 후 새 worker가 재claim함
9. 이전 worker의 stale completion이 새 lease를 덮어쓰지 못함
10. 타 owner/타 House 이벤트가 매칭되지 않음
11. payload hash와 canonical body가 일치함
12. token·HMAC key·refresh token이 로그에 남지 않음

## 7. 최종 산출물 형식

조사자는 다음 파일 또는 동일 구조의 보고서를 제출한다.

1. `Hermes 조사 결과 - YYYY-MM-DD.md`
2. `Hermes identity mapping matrix - YYYY-MM-DD.md`
3. `ADR-identity-and-worker-auth.md` 초안
4. 발견된 위험 목록: `RISK-001`부터 번호 부여
5. staging 실행 전제와 테스트 결과

각 발견은 다음 형식을 따른다.

```markdown
### FINDING-001: 제목

- 심각도: blocker / high / medium / low
- 상태: confirmed / partial / unknown
- 영향: 무엇이 잘못될 수 있는가
- 증거: 저장소, 파일 경로, 줄 번호, 관련 SQL
- 재현: 필요한 경우 명령 또는 요청 예시
- 권고: 코드/문서/ADR/migration 중 무엇이 필요한가
- 운영 적용 가능 여부: yes / no / approval required
```

## 8. 현재 조사에 대한 예상 결론 템플릿

다음 문장은 증거 확인 후에만 확정한다.

> 현재 CoreNull은 `owner_key`/`device_id` 기반이며 Supabase Auth UID 기반 House ownership과 durable outbox worker가 없다. CoreHub는 검증된 Auth UID를 요구하므로 현재 direct pushFact 경로는 운영 연결에 사용할 수 없다. 먼저 Identity mapping, 신규 House owner_id, worker 인증, domain revision, staging outbox를 확정하고 검증해야 한다. 운영 DB와 레거시 데이터는 별도 승인 전까지 변경하지 않는다.

## 9. 승인 경계

조사 보고서 제출은 다음을 승인하는 행위가 아니다.

- 서비스 간 인증 방식의 최종 승인
- 기존 identity 자동 migration
- 운영 RLS 변경
- 운영 outbox migration
- 운영 worker 배포
- CoreNull → CoreHub 실데이터 송신 개시

이 문서는 **Hermes가 사실을 수집하고 의사결정용 자료를 만드는 작업 지시서**다.
