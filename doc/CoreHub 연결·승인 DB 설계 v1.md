# CoreHub 연결·승인 DB 설계 v1

_상태: 설계 초안 — 운영 DB 미적용_
_작성일: 2026-10-20_
_소유자: CoreHub_
_관련: CoreHub 이벤트 무결성 계약 v2 · CoreHub PR #2 · CoreNull durable outbox 설계 v1.1 · BRAINPOOL Proposal DB ADR_

## 1. 결정 요약

CoreHub는 BRAINPOOL 각 Core의 공식 원본 DB를 소유하거나 대체하지 않는다. 대신 Core 간 연결·승인·반영을 위한 **공통 연결 DB의 schema와 계약**을 소유한다.

연결 DB는 다음 두 층으로 구성한다.

```text
CoreHub 연결 DB
├─ Core별 공식 DB에서 읽어온 연결용 mirror/snapshot
├─ approval_requests       제안·승인 요청
├─ approval_history        승인·수정·거절·반영 이력
└─ promotion_runs          원본 Core 반영 시도·결과
```

- CoreNull, CoreRing, HajunAI 등 각 Core는 자기 공식 원본의 최종 소유권을 유지한다.
- 각 Core는 CoreHub가 정한 연결 계약에 맞춰 mirror producer와 promotion adapter를 구현한다.
- AI와 Core producer는 원본 DB에 직접 쓰지 않는다.
- 승인 DB에 저장된 row는 공식 원본이 아니다.
- 사람 승인 후에도 연결 DB 전체를 원본 DB에 복사하지 않고, 승인된 변경 한 건만 대상 Core adapter로 promotion한다.
- 이 문서는 schema와 workflow의 기준을 제안하며, 실제 `CREATE/ALTER/INSERT/UPDATE/DELETE`나 운영 migration을 실행하지 않는다.

## 2. 기존 CoreHub 구조와의 관계

현재 CoreHub PR #2의 `corehub.facts`, `connections`, `meanings`, `opportunities`, `learning_logs`는 검증된 Fact 수신과 derived connection 처리를 위한 실행 schema다.

이번 연결·승인 DB는 이를 폐기하거나 덮어쓰지 않는다.

| 영역 | 책임 |
|---|---|
| `corehub.facts` | 인증된 source event 수신, 멱등 처리, Fact 원본성 보존 |
| `corehub.connections` | Fact 사이의 검증된 연결 |
| `corehub.meanings` | CoreHub가 계산한 의미 |
| `corehub.opportunities` | 제안 가능한 다음 기회·행동 |
| 연결 mirror | 다른 Core의 공식 데이터를 연결·검토 목적으로 표현 |
| `approval_requests` | 공식 원본 반영 전의 승인 요청 |
| `approval_history` | 사람 결정과 workflow 이력 |
| `promotion_runs` | 승인된 변경의 target Core 반영 실행 결과 |

CoreHub 내부에서 계산된 Meaning이나 Opportunity도 사람의 승인 없이 대상 Core의 공식 데이터로 승격하지 않는다.

## 3. 전체 흐름

```text
Core 공식 원본 DB
      │
      │ read / snapshot / signed source event
      ▼
CoreHub 연결 mirror
      │
      │ CoreHub·HajunAI·CoreRing의 제안
      ▼
approval_requests (pending)
      │
      ├─ rejected
      ├─ needs_revision
      └─ approved
             │
             ▼
      대상 Core promotion adapter
             │
             ├─ applied
             ├─ conflict
             └─ failed
```

promotion은 다음을 만족해야 한다.

1. 승인된 `approval_request`와 정확한 revision만 사용한다.
2. 대상 Core와 허용된 adapter를 확인한다.
3. 연결 DB의 snapshot 시점 이후 원본이 변경되지 않았는지 확인한다.
4. 변경·삭제는 expected version 또는 fingerprint가 일치할 때만 실행한다.
5. 성공 여부를 `promotion_runs`에 기록한다.
6. 실패·충돌 시 원본을 덮어쓰지 않는다.

## 4. Mirror 원칙

### 4.1 Mirror는 원본이 아니다

Mirror row는 CoreHub가 연결·검토·승인에 필요한 표현이다. 해당 row가 공식 데이터가 되려면 source Core의 adapter가 승인된 promotion을 성공적으로 적용해야 한다.

```text
Source Core 공식 record
  └─ source_record_id + source_version
       ↓
CoreHub mirror snapshot
       ↓ 승인된 변경
Source Core adapter
       ↓
Source Core 공식 record의 새 version
```

### 4.2 자유형 복제 금지

각 Core가 자기 내부 DB 전체를 CoreHub에 복제하지 않는다. CoreHub와 합의한 mirror contract만 전달한다.

Mirror contract에는 최소한 다음이 포함된다.

```text
source_core
source_schema
source_table
source_record_id
source_version 또는 source_fingerprint
snapshot_payload
captured_at
```

`source_schema`, `source_table`, `snapshot_payload`는 SQL 실행 경로나 credential을 담지 않는다. CoreHub는 받은 table 문자열을 이용해 임의 SQL을 실행하지 않는다.

### 4.3 원본 보존

- Message 원문은 변경하지 않는다.
- 번역·분석·학습·연결·context는 Message의 대체물이 아니다.
- Mirror snapshot은 원본의 provenance를 보존하기 위한 연결 표현이다.
- 기존 원본 수정은 mirror 전체 복사가 아니라 명시적인 change proposal로 처리한다.

## 5. 연결 DB 논리 schema

물리 table명과 전체 mirror column은 각 Core contract 검토 후 migration 문서에서 확정한다. 아래는 CoreHub가 소유하는 최소 공통 구조다.

### 5.1 `corehub.approval_requests`

승인 요청의 identity와 현재 상태를 보유한다.

```text
id uuid primary key
source_core text not null
target_core text not null
operation text not null       -- insert, update, delete, interpret, suggest
source_schema text null
source_table text null
source_record_id text null
source_version text null
source_fingerprint text null
mirror_record_id uuid null
current_revision_no integer not null default 1
status text not null          -- pending, needs_revision, approved,
                              -- rejected, applying, applied, conflict, failed
idempotency_key text not null
created_by_type text not null -- corering, corehub, hajunai, human, system
created_by_id text null
created_at timestamptz not null
submitted_at timestamptz null
approved_at timestamptz null
applied_at timestamptz null
```

`operation`은 처리 의도다. `learning_item`, `link`, `meaning_view` 같은 domain은 operation이 아니라 revision payload의 domain으로 전달한다.

허용 operation은 초기 기준으로 다음만 사용한다.

```text
insert
update
delete
interpret
suggest
```

등록되지 않은 operation은 fail closed로 거부한다.

### 5.2 `corehub.approval_revisions`

승인 요청의 불변 변경 내용을 보유한다.

```text
id uuid primary key
approval_request_id uuid not null
revision_no integer not null
payload_schema_version integer not null
domain text not null
payload jsonb not null
reason text null
created_by_type text not null
created_by_id text null
created_at timestamptz not null
```

권장 payload 형태:

```json
{
  "payload_schema_version": 1,
  "domain": "learning_item",
  "data": {}
}
```

payload에 다음을 넣지 않는다.

- status
- approval decision
- actor 권한
- SQL
- table/column 실행 경로
- credential 또는 secret
- arbitrary command

revision 제출 후 기존 payload는 수정하지 않는다. 수정은 새 revision으로 기록한다.

### 5.3 `corehub.approval_history`

사람과 workflow의 모든 중요한 상태 변화를 append-only로 기록한다.

```text
id uuid primary key
approval_request_id uuid not null
revision_id uuid null
action text not null       -- submit, approve, approve_with_changes,
                           -- reject, revise, start_promotion, conflict,
                           -- fail, apply
actor_type text not null
actor_id text null
reason text null
created_at timestamptz not null
```

`approve_with_changes`는 적용 승인으로 해석하지 않는다. `needs_revision`으로 돌아가며 새 revision과 새 `approve`가 필요하다.

### 5.4 `corehub.promotion_runs`

승인된 변경의 개별 적용 시도와 결과를 기록한다.

```text
id uuid primary key
approval_request_id uuid not null
revision_id uuid not null
target_core text not null
adapter_name text not null
adapter_version text not null
status text not null       -- started, applied, conflict, failed
expected_version text null
expected_fingerprint text null
result_record_id text null
result_version text null
result_fingerprint text null
error_code text null
error_message text null
started_at timestamptz not null
finished_at timestamptz null
```

재시도는 기존 run을 덮어쓰지 않고 새 run을 추가한다. `applied`는 target Core adapter가 성공을 확인한 경우에만 기록한다.

## 6. Core별 책임

| 주체 | 책임 |
|---|---|
| CoreHub | 연결 DB schema, 상태 전이, RLS 기준, idempotency, promotion 계약 소유 |
| CoreNull | Message·House·Room 등 공식 원본 소유; mirror producer와 CoreNull adapter 구현 |
| CoreRing | 언어·학습 공식 데이터 소유; CoreHub contract에 맞는 domain payload와 adapter 구현 |
| HajunAI | understanding·context 공식 구조 소유; 제안 payload와 context adapter 구현 |
| 사람 승인자 | 특정 revision에 대한 승인·수정 후 승인·거절 결정 |
| Promotion worker | 승인된 revision을 allowlisted adapter로 전달; 임의 SQL 금지 |

CoreHub는 다른 Core의 내부 공식 schema를 재정의하지 않는다. 다른 Core가 자기 공식 구조를 바꾸면 해당 Core가 mirror/adapter contract 변경안을 제출하고, CoreHub가 연결 계약을 검토한다.

## 7. 권한 경계

```text
AI/Core producer
  └─ approval request/revision/evidence 생성

Human reviewer
  └─ approval decision 기록

Promotion worker
  └─ 승인된 revision 적용 시도

Target Core adapter
  └─ 최종 ownership·version·idempotency 검증 후 자기 DB에 반영
```

금지 사항:

- AI producer가 `approved`, `applied`를 직접 설정
- CoreHub가 다른 Core DB에 자유형 SQL 실행
- 모든 Core에 service role credential을 배포
- 연결 DB 전체를 source DB에 덮어쓰기
- 승인되지 않은 mirror row를 공식 원본으로 노출
- 같은 proposal을 target Core 여러 곳에 무단 broadcast
- client body의 `owner_id`, `owner_key`를 신뢰

## 8. 상태 전이

```text
pending
  ├─ needs_revision → 새 revision → pending
  ├─ rejected       → terminal
  └─ approved       → applying
                         ├─ applied  → terminal success
                         ├─ conflict → 조사·재제출
                         └─ failed   → 재시도 또는 재검토
```

`approve_with_changes`는 별도 적용 상태가 아니다. 해당 action은 `needs_revision`으로 projection하고, 기존 revision을 적용하지 않는다.

승인 후 target Core의 원본 version 또는 fingerprint가 바뀌면 자동 적용하지 않고 `conflict`로 중단한다.

## 9. 멱등성과 동시성

- producer는 재시도 동안 같은 `idempotency_key`를 사용한다.
- 동일 key와 동일 payload는 idempotent replay다.
- 동일 key와 다른 payload는 `409` 또는 `conflict`로 기록하며 기존 요청을 덮어쓰지 않는다.
- 같은 approval request를 두 worker가 적용해도 target Core의 공식 record가 중복 생성되지 않아야 한다.
- `update`·`delete`는 expected version 또는 fingerprint를 요구한다.
- version과 fingerprint를 모두 제공하면 AND 조건으로 비교한다.
- lease를 사용하는 worker는 매 claim마다 새로운 lease token을 발급하고, stale worker가 최신 run을 덮어쓰지 못하게 한다.

## 10. RLS와 운영 기본선

- producer는 자기 source_core의 요청과 revision을 생성할 수 있다.
- producer는 승인 decision과 promotion result를 임의로 수정할 수 없다.
- reviewer는 승인된 review scope에 대해서만 decision을 기록한다.
- promotion worker는 approved 상태의 정확한 revision만 읽는다.
- `approval_history`와 `promotion_runs`는 append-only로 운영한다.
- authenticated client의 직접 INSERT/UPDATE/DELETE는 허용하지 않는다.
- RPC 또는 서버 adapter만 상태 변경 권한을 가진다.
- 실제 RLS, grant, function security, target registry는 disposable staging에서 검증한다.

## 11. 첫 구현 범위

처음부터 모든 Core와 모든 mirror를 연결하지 않는다. 첫 vertical slice는 다음 중 하나를 별도로 선정한 후 시작한다.

```text
CoreNull Message snapshot
  → CoreHub mirror
  → approval request
  → 사람 승인
  → CoreNull 또는 CoreRing adapter promotion
```

첫 target Core, 물리 mirror table, adapter 이름, domain schema는 이 문서만으로 확정하지 않는다. 해당 Core 담당자가 자기 공식 schema와 payload를 검토한 뒤 별도 contract 문서로 제안한다.

## 12. 운영 전 차단 조건

다음 조건을 충족하기 전에는 운영 원본 DB에 promotion하지 않는다.

- [ ] CoreHub 연결 DB의 별도 staging project/ref 확정
- [ ] CoreHub schema migration과 rollback/forward 정책 승인
- [ ] 각 Core의 mirror contract와 adapter 계약 승인
- [ ] 사람 reviewer identity와 RLS 검증
- [ ] 동일 key·다른 payload conflict 검증
- [ ] 승인 전 원본 불변 검증
- [ ] 승인 후 version/fingerprint conflict 검증
- [ ] 두 worker 동시 promotion 및 stale lease 검증
- [ ] promotion 실패 시 원본 rollback 또는 no-write 검증
- [ ] 실제 CoreNull/CoreRing/HajunAI producer E2E 검증

## 13. 하지 않는 것

- CoreHub가 BRAINPOOL 전체 원본 DB를 소유하는 것
- 모든 Core의 내부 테이블을 하나의 거대 schema로 통합하는 것
- 기존 원본 DB를 연결 DB로 자동 이전하는 것
- 연결 DB 전체를 원본 DB에 복사하는 것
- Proposal/approval row를 공식 데이터로 자동 승격하는 것
- CoreHub PR #2 migration을 승인 없이 운영 project에 적용하는 것
- `owner_key`·`device_id`를 Auth UID로 자동 backfill하는 것
- 실제 target registry가 없는데 특정 물리 table을 allow-list하는 것

## 14. 다음 작업

1. 이 설계를 CoreHub 기준 문서로 검토한다.
2. CoreNull·CoreRing·HajunAI가 자기 공식 schema와 mirror contract를 확인한다.
3. 첫 vertical slice의 source Core·target Core·payload domain을 하나만 선택한다.
4. CoreHub의 별도 staging schema migration 초안을 작성한다.
5. RLS, idempotency, revision, approval, promotion conflict를 staging에서 검증한다.
6. 검증 결과와 승인 후에만 운영 migration과 실제 promotion을 논의한다.

현재 문서만으로는 DB 생성, 운영 migration, 원본 DB write를 실행하지 않는다.
