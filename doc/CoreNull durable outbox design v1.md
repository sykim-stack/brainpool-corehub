# CoreNull → CoreHub durable outbox 설계 v1

> 상태: **설계 스케치 / 운영 DB 미적용**  
> 목적: CoreNull의 비즈니스 트랜잭션과 Fact 전달을 분리하되, 이벤트 유실과 중복 처리를 방지한다.

## 1. 적용 범위와 불변식

- CoreNull이 **Fact 이벤트의 생산자**이며, CoreHub는 인증된 요청을 원자적으로 처리하는 소비자다.
- 비즈니스 상태 변경과 outbox 행 삽입은 **같은 CoreNull PostgreSQL 트랜잭션**에서 수행한다.
- `idempotency_key`는 이벤트의 논리적 버전에 대해 안정적이어야 한다. 예: `core:null:item:42:v3`.
- 재시도할 때는 반드시 **같은 키와 동일한 요청 body**를 사용한다.
- CoreHub의 요청 owner는 본문 필드가 아니라 Supabase Auth Bearer token에서 결정된다.
- 기존 `owner_key`/`device_id`만 있는 레거시 데이터는 자동으로 Auth UID에 연결하지 않는다.

## 2. Outbox SQL 스케치

아래 SQL은 CoreNull 저장소의 staging/disposable DB에서 검토·수정한 뒤 적용한다. **이 저장소의 Supabase 운영 DB나 공유 DB에는 실행하지 않는다.**

```sql
begin;

create schema if not exists corenull;

create table if not exists corenull.corehub_outbox (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  house_id uuid null,
  source text not null,
  fact_type text not null,
  idempotency_key text not null,
  occurred_at timestamptz not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0
    check (attempts >= 0),
  last_error text null,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz null,
  locked_by text null,
  sent_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, source, idempotency_key)
);

create index if not exists corehub_outbox_pending_idx
  on corenull.corehub_outbox (next_attempt_at, created_at)
  where status in ('pending', 'failed');

create index if not exists corehub_outbox_lease_idx
  on corenull.corehub_outbox (locked_at)
  where status = 'sending';

comment on table corenull.corehub_outbox is
  'Durable CoreHub Fact delivery queue; never populated by a client directly.';
comment on column corenull.corehub_outbox.idempotency_key is
  'Stable event identity; retries must reuse this key and the same body.';

commit;
```

### 생산자 트랜잭션 예시

```sql
begin;

-- 1) CoreNull의 도메인 상태를 변경한다.
update corenull.some_domain_table
   set version = version + 1, updated_at = now()
 where id = $1 and owner_id = $2;

-- 2) 위 변경과 같은 트랜잭션에서 outbox를 기록한다.
insert into corenull.corehub_outbox (
  owner_id, house_id, source, fact_type, idempotency_key,
  occurred_at, payload
) values (
  $2, $3, 'corenull', 'some.domain.changed',
  format('corenull:some_domain:%s:v%s', $1, $4),
  now(), $5::jsonb
)
on conflict (owner_id, source, idempotency_key) do nothing;

commit;
```

`ON CONFLICT DO NOTHING`은 같은 비즈니스 이벤트가 애플리케이션 재시작으로 다시 생성되는 것을 흡수한다. 단, 같은 키에 다른 payload를 조용히 덮어쓰면 안 된다. 워커가 409를 받으면 해당 행을 자동으로 재생성하지 않고 알림·수동 조치 대상으로 격리한다.

## 3. 워커 처리 흐름

### 3.1 Claim

한 번에 소량을 claim하고, 짧은 lease를 둔다. 워커 장애 시 lease가 만료된 `sending` 행은 다시 `pending` 후보가 된다.

```sql
with candidates as (
  select id
    from corenull.corehub_outbox
   where (status in ('pending', 'failed') and next_attempt_at <= now())
      or (status = 'sending' and locked_at < now() - interval '10 minutes')
   order by next_attempt_at, created_at
   for update skip locked
   limit 50
)
update corenull.corehub_outbox o
   set status = 'sending',
       attempts = o.attempts + 1,
       locked_at = now(),
       locked_by = $worker_id,
       updated_at = now()
  from candidates c
 where o.id = c.id
returning o.*;
```

### 3.2 전송

각 행에 대해 CoreHub `POST /api/corehub/facts`를 호출한다.

```http
Authorization: Bearer <Supabase access token for owner_id>
Idempotency-Key: <outbox.idempotency_key>
Content-Type: application/json

{
  "source": "<outbox.source>",
  "fact_type": "<outbox.fact_type>",
  "occurred_at": "<outbox.occurred_at>",
  "payload": <outbox.payload>,
  "house_id": "<outbox.house_id>"
}
```

- 요청 본문에 `owner_id` 또는 `owner_key`를 넣지 않는다.
- `house_id`가 있으면 해당 Auth UID가 소유한 house인지 CoreHub가 검증한다.
- 토큰 만료/교체 정책은 워커가 사용하는 CoreNull 서버 세션 정책으로 별도 결정한다. 다른 사용자의 토큰으로 재시도하지 않는다.

### 3.3 결과별 상태 전이

| 응답 | 처리 | 다음 상태 |
|---|---|---|
| `200` duplicate 또는 `201` created | 전달 성공으로 기록 | `sent` |
| `401` | 인증 설정/토큰 문제 알림. 무한 재시도 금지 | `failed` + 긴 backoff 또는 quarantine |
| `403` | house 소유권 데이터 확인. 자동 키 재생성 금지 | `failed` + quarantine |
| `409` | 같은 키의 다른 body 또는 키 설계 버그. payload 변경/재생성 금지 | `failed` + quarantine |
| `429` | 서버가 허용하는 범위에서 backoff | `pending` |
| `500`/`503`/네트워크 오류 | 일시 장애로 간주하고 지수 backoff | `pending` |

성공 시 다음처럼 갱신한다.

```sql
update corenull.corehub_outbox
   set status = 'sent', sent_at = now(), locked_at = null,
       locked_by = null, last_error = null, updated_at = now()
 where id = $1 and locked_by = $worker_id;
```

실패 시 최소 backoff 예시는 `min(2^attempts * 30 seconds, 1 hour)`이며, jitter를 추가한다.

```sql
update corenull.corehub_outbox
   set status = case when attempts >= 20 then 'failed' else 'pending' end,
       next_attempt_at = now() + $backoff,
       last_error = left($error, 2000),
       locked_at = null, locked_by = null, updated_at = now()
 where id = $1 and locked_by = $worker_id;
```

## 4. 관측·알림

필수 지표와 알림 기준은 staging 검증 후 확정한다.

- `pending`/`failed` 건수와 oldest age
- 시간당 `401`, `403`, `409`, `5xx`, 네트워크 실패 건수
- `sending` lease 만료 건수
- 성공 latency와 attempts 분포
- `409` 발생 시 `owner_id`, source, key, payload hash를 감사 로그에 남기되 access token은 기록하지 않음

## 5. 운영 전 검증 시나리오

- 도메인 롤백 시 outbox도 함께 롤백되는지 확인
- 동일 키·동일 body 재전송 → CoreHub `200 duplicate`
- 동일 키·다른 body → CoreHub `409`, 자동 재생성 없음
- 워커 종료 후 lease 만료 → 다른 워커가 재claim
- CoreHub 503/네트워크 단절 → backoff 후 동일 키 재시도
- owner/house 불일치 → 403 격리
- 20회 실패 행의 수동 재처리·quarantine 절차 확인
