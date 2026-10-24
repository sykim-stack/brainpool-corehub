# CoreHub PR #2 통합 테스트 및 Outbox 검토

- 검토일: 2026-10-18
- PR: `sykim-stack/brainpool-corehub#2`
- 검토 head: `7378f976c57d5df69804fc546cdce7de43386212`
- 현재 상태: Open / Draft / merge state `CLEAN`
- 결론: **consumer-side 검증은 통과했지만 staging 통합·RPC·durable outbox 검증은 미실행이며, 운영 승인 불가**

## 1. 확인된 통과 항목

| 항목 | 결과 | 근거 |
|---|---|---|
| `npm test` | PASS, 12/12 | local Node test runner |
| `npm run build` | PASS | Next.js 15.5.27 production build |
| `git diff --check` | PASS | working tree validation |
| Vercel Preview checks | PASS, 2 deployments + preview comments | PR status checks |
| Bearer token 형식 검사 | PASS | `test/corehub-integrity.test.mjs` |
| Auth UID가 검증 token에서 유도됨 | PASS | pure unit test |
| House query가 `corenull.houses` + verified UID 사용 | PASS | pure helper test |
| matching의 owner/house/time 경계 | PASS | pure matching tests |

이 결과는 route와 SQL RPC의 실제 배포·DB 실행을 의미하지 않는다.

## 2. 통합 테스트 상태

### 2.1 실행된 테스트의 한계

현재 12개 테스트는 모두 Node 기반 pure/unit test다. 다음을 실제로 호출하지 않는다.

- Next route에 HTTP 요청을 보내는 통합 테스트
- Supabase Auth `getUser` 실제 호출
- `corenull.houses` ownership query 실제 실행
- `corehub.process_fact_event` 실제 PostgreSQL RPC
- RLS 및 PostgREST grant 경계
- duplicate/409/503 응답의 실제 route-to-RPC 경로
- CoreNull producer와 CoreHub의 실제 네트워크 연결

따라서 `OWN-001~010`, `EVT-001~008`, `MIG-001~006` 매트릭스는 문서상 모두 `not run` 상태다.

### 2.2 연결된 Supabase project의 read-only 상태

현재 연결된 project에 대해 read-only metadata를 확인했으며 migration은 적용되지 않은 상태로 보인다.

| table | 현재 상태 |
|---|---|
| `corehub.facts` | 89 rows, legacy columns만 확인; `owner_id`, `idempotency_key` 없음 |
| `corehub.connections` | 33 rows, `owner_id`, `dedupe_key` 없음 |
| `corehub.meanings` | 28 rows, `owner_id`, `source_connection_id` 없음 |
| `corehub.opportunities` | 26 rows, `target_owner_id` 없음 |
| `corehub.learning_logs` | 8 rows, `owner_id` 없음 |
| `corehub.process_fact_event` | migration 적용 여부를 실제 RPC 호출로 검증하지 않음 |

이 project는 명시적으로 staging이라고 확인되지 않았으므로 SQL write는 실행하지 않았다.

## 3. RPC migration 코드 검토

### PASS 또는 양호한 부분

1. `owner_id`, `source`, `idempotency_key`, `fact_type`, `occurred_at` 필수값을 확인한다.
2. `(owner_id, source, idempotency_key)` partial unique index로 동일 이벤트 재전송을 방어한다.
3. 동일 key에 다른 body를 보내면 `idempotency_key_reused_with_different_event` 오류를 발생시킨다.
4. advisory transaction lock으로 동일 owner/house에 대한 동시 처리를 직렬화한다.
5. Fact와 connection/meaning/opportunity 생성을 하나의 RPC transaction에 묶는다.
6. verified owner/house/time 조건을 매칭 query에 포함한다.
7. RPC execute 권한을 `service_role`로 제한한다.
8. RLS select policy는 `auth.uid()`와 각 owner column을 비교하도록 작성되어 있다.

### 수정 전 해결해야 하는 문제

#### HIGH: migration 재실행성이 완전하지 않음

다음 구문은 `if not exists`가 없다.

```sql
alter table corehub.meanings
  add constraint meanings_source_connection_id_fkey
  foreign key (source_connection_id)
  references corehub.connections(id)
  on delete cascade;
```

migration을 재실행하거나 일부 적용 후 복구하면 `constraint already exists`로 중단될 수 있다. 배포 전 constraint 존재 여부를 확인하는 `DO $$ ... IF NOT EXISTS ... $$` 형태 또는 명시적 migration version 관리가 필요하다.

#### HIGH: `p_owner_id`와 인증 주체의 연결은 API 밖에서 보장되지 않음

RPC는 `p_owner_id`를 인자로 받고 `service_role`에 실행 권한을 준다. Facts route가 verified Bearer token에서 owner를 유도하는 것은 확인했지만, worker 인증 ADR은 아직 승인되지 않았고 실제 worker도 없다. 따라서 향후 worker가 임의 owner UUID를 넣지 못하도록 서비스 인증과 signed ownership assertion을 먼저 구현·검증해야 한다.

#### MEDIUM: 실제 schema/RLS/grant에서 RPC 계약이 미검증

local test는 `security definer`, `search_path`, role grants, RLS policy, partial unique index, trigger와 foreign key 동작을 검증하지 않는다. 별도 disposable staging에서 실제 migration을 적용하고 SQL-level assertions를 실행해야 한다.

#### MEDIUM: migration 전후 legacy 데이터 보존 검증 미실행

SQL은 legacy row를 자동 link하지 않도록 설계되어 있으나, 실제 적용 전후 다음을 비교해야 한다.

- 각 legacy table row count
- `owner_key` NULL/non-NULL count
- `house_id`와 source payload 보존
- 기존 derived row count
- RLS policy 및 grant 변화

## 4. Durable outbox 및 worker 검토

### 판정: NOT IMPLEMENTED / NOT RUN

CoreNull 저장소에는 다음 구현이 없다.

- durable outbox table migration
- domain mutation + outbox same-transaction write
- stable event revision/idempotency key 생성
- worker process 또는 scheduled runner
- claim query
- lease token/expiry update
- retry/backoff
- quarantined state transition
- stale completion 방어
- CoreNull → CoreHub Bearer/service authentication

CoreHub 저장소에는 outbox **설계 문서와 verification gate만** 존재한다. 설계 문서는 구현 결과가 아니다.

따라서 다음 항목은 모두 실행 결과가 없다.

| 시나리오 | 상태 |
|---|---|
| mutation rollback 시 outbox 미생성 | NOT RUN |
| outbox insert 실패 시 mutation rollback | NOT RUN |
| 동일 key 재전송 | NOT RUN |
| network/503 exponential backoff | NOT RUN |
| 401/403/409 quarantine | NOT RUN |
| lease expiry 후 re-claim | NOT RUN |
| stale worker completion 차단 | NOT RUN |
| 두 worker 동시 claim | NOT RUN |
| token/private key가 outbox에 저장되지 않음 | NOT RUN |

현재 CoreNull `pushFact()`는 request lifecycle에서 직접 fire-and-forget HTTP 요청을 수행하며, `Authorization` 및 `Idempotency-Key`를 보내지 않는다. 이 경로는 PR #2 consumer 계약을 만족하지 않는다.

## 5. Supabase advisor 관찰

연결 project advisor는 `corehub.facts`, `connections`, `meanings`, `opportunities`, `learning_logs`에 RLS가 활성화되었지만 policy가 없다고 보고했다. 이는 현재 연결 project의 상태이며, PR #2 migration이 아직 적용되지 않았음을 뒷받침하는 read-only 신호다.

PR #2 migration은 policy를 생성하도록 작성되어 있으므로, staging 적용 후 다음을 별도로 확인해야 한다.

- policy가 실제로 생성됐는가
- `authenticated`가 자기 row만 select 가능한가
- `anon`과 `authenticated`가 직접 write할 수 없는가
- `service_role`이 RPC에만 필요한 권한을 갖는가
- `SECURITY DEFINER` function의 `search_path`와 execute privilege가 의도와 일치하는가

## 6. 운영 판정

현재 PR #2는 다음 범위에서만 승인 가능하다.

- consumer-side source code review
- local unit test
- production build
- Vercel Preview deployment

다음 항목이 완료되기 전에는 staging 또는 production Fact 송신을 승인하지 않는다.

1. 명시적으로 분리된 staging project ref 확정
2. CoreHub migration 적용 및 SQL-level schema/RLS/grant 검증
3. CoreNull Auth UID·House ownership 경로 구현
4. CoreNull durable outbox와 worker 구현
5. worker authentication ADR 승인
6. same-transaction outbox, retry, lease, stale completion 테스트
7. CoreNull producer → CoreHub staging E2E
8. 결과를 PR에 테스트 ID·실행 시각·commit·project ref와 함께 기록

**최종 판정: PR #2 consumer는 준비됐지만, 통합 producer와 durable delivery path는 준비되지 않았다. 운영 사용은 차단한다.**
