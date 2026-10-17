# CoreNull → CoreHub durable outbox 설계 v1.1

> 상태: **설계 스케치 / 운영 DB 미적용**
> 기준: CoreHub PR #2의 현재 코드 계약 검토 결과 반영
> 목적: CoreNull의 비즈니스 트랜잭션과 Fact 전달을 분리하되, 이벤트 유실·중복·소유권 오인을 방지한다.

## 1. 적용 범위와 확정 전제

- CoreNull이 Fact 이벤트의 생산자이며, CoreHub는 인증된 요청을 원자적으로 처리하는 소비자다.
- 비즈니스 상태 변경과 outbox 행 삽입은 **같은 CoreNull PostgreSQL 트랜잭션**에서 수행한다.
- `idempotency_key`는 실제로 확정된 도메인 버전에서 결정하며, 임의의 `v3` 같은 상수를 사용하지 않는다.
- 재시도할 때는 반드시 같은 키와 동일한 요청 body를 사용한다.
- CoreHub의 owner는 요청 본문이 아니라 Supabase Auth Bearer token의 검증된 `user.id`에서 결정된다.
- 기존 `owner_key`/`device_id` 데이터는 자동으로 Auth UID에 연결하지 않는다.
- 운영 DB와 기존 RLS 정책은 별도 승인 없이는 변경하지 않는다.

> **운영 차단 조건:** CoreNull의 실제 Auth 세션/서비스 인증 모델, House 생성·소유권 코드, 도메인 버전 컬럼, 전송 워커 구현을 확인하기 전에는 이 설계를 운영 계약으로 확정하거나 migration을 적용하지 않는다.

## 2. 워커 인증 모델 — 먼저 결정해야 하는 ADR

현재 설계의 가장 큰 미결정 사항은 백그라운드 워커가 어떤 인증 주체로 CoreHub에 전송하는가이다. 사용자의 브라우저 access token을 장기 저장하는 방식은 기본안으로 채택하지 않는다. 사용자가 로그아웃한 뒤에도 재시도해야 하며, 토큰 만료·탈취·다른 사용자 토큰 대체 문제가 있기 때문이다. `service_role` 키를 사용자 인증의 대체물로 사용하는 것도 금지한다.

CoreNull 운영 담당자는 다음 중 하나를 ADR로 결정해야 한다.

| 방식 | CoreHub 계약 | 주의점 |
|---|---|---|
| 사용자 위임 토큰 | 워커가 해당 owner의 유효한 access token을 안전하게 확보·갱신 | 토큰 저장·갱신·폐기·사용자별 격리 설계가 필수 |
| 서비스 간 인증 | CoreHub가 별도 mTLS/HMAC/서명된 service credential을 검증하고, 검증된 `owner_id` claim과 House 소유권을 별도 확인 | CoreHub API·키 관리·감사 모델을 함께 변경해야 함 |
| 현재 `service_role` 직접 사용 | **채택 금지** | service_role은 DB 권한이지 사용자 인증의 대체가 아님 |

이 ADR이 승인되기 전까지 아래 HTTP 예시는 계약 초안일 뿐이다.

## 3. Outbox SQL 스케치

아래 SQL은 CoreNull 저장소의 staging/disposable DB에서 검토·수정한 뒤 적용한다. **이 저장소의 Supabase 운영 DB나 공유 DB에는 실행하지 않는다.**

`quarantined`를 별도 상태로 두어 자동 재시도 가능 상태와 조사 대상을 분리한다. 동일 key 충돌은 별도 audit 행으로 남기며 기존 이벤트를 덮어쓰지 않는다.

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
  domain_version bigint not null,
  payload jsonb not null default '{}'::jsonb,
  payload_sha256 text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'quarantined')),
  attempts integer not null default 0
    check (attempts >= 0),
  last_error text null,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz null,
  locked_by text null,
  lease_token uuid null,
  sent_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, source, idempotency_key)
);

create table if not exists corenull.corehub_outbox_conflicts (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references corenull.corehub_outbox(id),
  owner_id uuid not null,
  source text not null,
  idempotency_key text not null,
  original_payload_sha256 text not null,
  conflicting_payload_sha256 text not null,
  observed_at timestamptz not null default now(),
  detail text null
);

create index if not exists corehub_outbox_pending_idx
  on corenull.corehub_outbox (next_attempt_at, created_at)
  where status = 'pending';

create index if not exists corehub_outbox_lease_idx
  on corenull.corehub_outbox (locked_at)
  where status = 'sending';

comment on table corenull.corehub_outbox is
  'Durable CoreHub Fact delivery queue; never populated by a client directly.';
comment on column corenull.corehub_outbox.idempotency_key is
  'Stable event identity from the committed domain version.';
comment on column corenull.corehub_outbox.lease_token is
  'Unique per claim; stale workers cannot finalize a later lease.';

commit;
```

실제 환경에서 `gen_random_uuid()`와 SHA-256 계산 방식의 extension/런타임 지원을 먼저 확인한다. payload hash는 canonical JSON 직렬화 규칙을 고정한 뒤 계산해야 한다.

## 4. 생산자 트랜잭션과 key 충돌

도메인 update가 정확히 한 행을 변경하고 실제 확정 버전을 반환한 경우에만 outbox를 삽입한다. 둘 중 하나라도 실패하면 전체 트랜잭션을 rollback한다.

```sql
begin;

-- 도메인 소유권과 현재 버전을 함께 검증한다.
update corenull.some_domain_table
   set version = version + 1, updated_at = now()
 where id = $1
   and owner_id = $2
returning id, owner_id, house_id, version, updated_at;
-- 애플리케이션은 반환 행이 정확히 1개인지 확인한다.

insert into corenull.corehub_outbox (
  owner_id, house_id, source, fact_type, idempotency_key,
  occurred_at, domain_version, payload, payload_sha256
) values (
  $owner_id, $house_id, 'corenull', 'some.domain.changed',
  format('corenull:some_domain:%s:v%s', $domain_id, $committed_version),
  $occurred_at, $committed_version, $canonical_payload, $payload_sha256
)
on conflict (owner_id, source, idempotency_key) do nothing;

-- 충돌 시 기존 행을 읽어 hash를 비교한다.
-- hash가 같으면 정상 중복, 다르면 corehub_outbox_conflicts에 기록하고
-- 현재 트랜잭션을 실패시켜 자동 덮어쓰기·재생성을 막는다.

commit;
```

단순 `ON CONFLICT DO NOTHING`만으로는 다른 payload를 생산자 단계에서 발견할 수 없다. 실제 구현은 conflict 후 기존 `payload_sha256`와 비교하고, 불일치이면 명시적 오류와 감사 행을 남겨야 한다.

## 5. 워커 claim과 세대가 있는 lease

`locked_by`는 관측용 식별자일 뿐 소유권 증명이 아니다. **매 claim마다 새로운 `lease_token`**을 발급하고 성공·실패 갱신에서 `id + lease_token`을 함께 조건으로 사용한다.

```sql
with candidates as (
  select id
    from corenull.corehub_outbox
   where (status = 'pending' and next_attempt_at <= now())
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
       lease_token = gen_random_uuid(),
       updated_at = now()
  from candidates c
 where o.id = c.id
returning o.*;
```

성공·실패 갱신은 반드시 claim 결과의 `lease_token`을 사용한다.

```sql
update corenull.corehub_outbox
   set status = 'sent', sent_at = now(), locked_at = null,
       locked_by = null, lease_token = null, last_error = null,
       updated_at = now()
 where id = $id
   and status = 'sending'
   and lease_token = $lease_token;
```

영향받은 행이 0이면 lease가 만료됐거나 다른 워커가 재claim한 것이므로, 오래된 워커는 결과를 덮어쓰지 않고 응답을 폐기한다. Lease 만료 행을 재claim할 때도 새 token을 발급한다.

## 6. CoreHub 전송과 응답 계약

현재 CoreHub PR #2 구현에서 확인한 계약은 다음과 같다.

- 새 Fact 처리: `201`, 중복 replay: `200`
- 같은 key에 다른 `fact_type`, `house_id`, `occurred_at`, `payload`: `409`
- Bearer 누락/유효하지 않은 토큰: `401`
- house 소유권 불일치: `403`
- RPC/일시적 처리 실패: `503`
- 요청 body의 `owner_id`/`owner_key`: `400`
- 성공 응답 body에는 처리 결과와 `traceId`가 포함된다.

이 계약은 현재 route 코드와 단위 테스트 기준이며, PostgreSQL RPC의 실제 통합 테스트 결과로 최종 확정해야 한다. 워커는 상태 코드만 보지 말고 `duplicate` 결과와 `traceId`를 로그에 남긴다. access token은 로그에 남기지 않는다.

```http
Authorization: Bearer <ADR에서 승인한 인증 주체의 token>
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

응답별 상태 전이는 다음과 같다.

| 응답 | 처리 | 다음 상태 |
|---|---|---|
| `200` duplicate 또는 `201` created | 전달 성공 기록 | `sent` |
| `401` | 인증 ADR/토큰 설정 조사, 무한 재시도 금지 | `quarantined` |
| `403` | House 소유권 조사, key 재생성 금지 | `quarantined` |
| `409` | key/payload 불일치 조사, 덮어쓰기 금지 | `quarantined` |
| `429` | 허용 범위 내 backoff | `pending` |
| `500`/`503`/네트워크 오류 | 일시 장애로 간주, 지수 backoff | `pending` |

자동 재시도 상한에 도달한 일시 오류도 `quarantined`로 전환한다. `quarantined`는 claim 대상에 포함하지 않으며, 조사 후 명시적인 수동 재처리 절차로만 `pending`으로 되돌린다.

## 7. 재시도와 관측

재시도 backoff 예시는 `min(2^attempts * 30 seconds, 1 hour)`에 jitter를 추가하는 방식이다. 실패 갱신도 `id + lease_token`이 일치할 때만 허용한다.

필수 지표는 `pending`/`quarantined` 건수와 oldest age, 응답 코드별 실패 수, lease 만료·재claim 수, 성공 latency, attempts 분포, key conflict 수다. `409`에는 owner, source, key, 원본/충돌 payload hash만 감사 로그에 남기며 access token은 기록하지 않는다.

## 8. 운영 전 차단 체크

- CoreNull Auth/House 소유권/도메인 버전 구현 확인
- 워커 인증 ADR 승인
- canonical JSON 및 payload hash 규칙 승인
- `quarantined` 상태와 수동 복구 절차 구현
- lease token을 이용한 stale worker 보호 검증
- domain update의 정확히 한 행 변경 및 실제 version 반환 검증
- 동일 key·동일 body, 동일 key·다른 body, 401, 403, 503 통합 테스트
- disposable PostgreSQL 16에서 원자성·중복·lease 만료·동시성 검증
- 운영 migration/RLS 별도 승인

위 조건을 확인하기 전에는 CoreNull → CoreHub 실데이터 연결이나 운영 migration을 시작하지 않는다.

## 9. CoreNull 현재 구현 조사 결과

조사 대상: `https://github.com/sykim-stack/brainpool-corenull`의 현재 default branch. 이 조사는 코드를 변경하지 않고 연결 전제만 확인한 것이다.

현재 확인된 사실은 다음과 같다.

- `lib/ownerKey.ts`는 `corenull_owner_key`를 localStorage에 보관하며, 기존 `corenull_device_id`가 있으면 owner key로 승격한다.
- `app/api/corenull/houses/route.js`의 House 조회·생성·수정은 `owner_key`를 요청 query/body에서 받아 비교한다.
- House 생성은 `getSupabaseAdmin()`의 service-role 클라이언트로 `owner_key`를 저장하며, 검증된 Supabase Auth UID를 저장하지 않는다.
- 현재 House API는 구현 계약상 대부분의 오류를 `500`으로 반환하며, CoreHub가 기대하는 `401/403/409/503` 계약과 직접 연결되어 있지 않다.
- 검색된 migration에는 `corenull_houses.owner_id` 또는 durable outbox 테이블이 없다.
- CoreNull 저장소에서 CoreHub 전송 worker, `idempotency_key`, lease claim 구현은 확인되지 않았다.

따라서 현재 상태에서 **CoreNull → CoreHub 실데이터 연결은 승인할 수 없다.** 특히 `device_id → Auth UID` 자동 승격은 CoreHub 운영 원칙과 충돌하므로 새 Auth UID 경로를 별도로 도입해야 한다. 다음 설계 단계는 CoreNull의 Supabase Auth 세션 생성/전달, 신규 House 생성 시 서버가 `auth.uid()`를 기록하는 경로, 그리고 domain version을 반환하는 트랜잭션을 별도 ADR과 staging migration으로 확정하는 것이다.
