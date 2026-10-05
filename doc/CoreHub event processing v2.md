# CoreHub 이벤트 무결성 계약 v2

- **상태:** 코드 및 migration 초안. GitHub 리뷰/검증 대상이며 **운영 Supabase에는 적용하지 않음**.
- **소유권 기준:** 새 자료는 검증된 Supabase Auth 사용자 UID (`auth.users.id`)만 사용.
- **기존 자료:** 자동 owner 연결·backfill 금지. `owner_id IS NULL`인 기존 Fact/Connection/Meaning/Opportunity는 새 API와 사용자 RLS에서 보이지 않음.

## 1. 인증·인가

- Facts와 Opportunities API는 `Authorization: Bearer <Supabase access token>`을 필수로 받는다.
- API는 `supabase.auth.getUser(token)`으로 토큰을 검증하고 owner UID를 서버에서 얻는다. Request body/query의 `owner_id`나 `owner_key`는 권한 근거로 받지 않는다.
- 새 Fact에 `house_id`가 있으면 `corenull.houses.id = house_id AND owner_id = auth user UID`인 경우에만 수락한다. 기존 집이 Auth 계정에 연결되지 않았으면 403으로 거절한다.
- `corehub` 테이블은 RLS를 켜고 `auth.uid()`와 일치하는 행만 authenticated 역할에 SELECT 허용한다. 클라이언트 직접 쓰기는 허용하지 않는다. RPC 실행은 비밀 `SUPABASE_SERVICE_ROLE_KEY`를 사용하는 서버만 가능하다.
- 현재 CoreNull API/UI는 `owner_key` URL capability와 브라우저 `device_id`를 사용한다. Supabase Auth 통합 및 새 house `owner_id` 기록이 아직 없으므로, 해당 source가 Auth token을 전달하도록 별도로 연결되기 전까지 house-scoped CoreHub 이벤트는 사용할 수 없다. 소유권 검증을 완화해 우회하지 않는다.

## 2. Fact 요청 계약

```http
POST /api/corehub/facts
Authorization: Bearer <Supabase access token>
Idempotency-Key: <source가 재시도 내내 유지하는 이벤트 고유 키>
Content-Type: application/json
```

```json
{
  "source": "CoreNull",
  "fact_type": "space.seed.created",
  "house_id": "<Auth UID와 연결된 house UUID>",
  "occurred_at": "2026-10-05T00:00:00Z",
  "payload": {
    "seed_id": "<CoreNull에서 안정적으로 유지되는 seed ID>",
    "room_id": "<room UUID>",
    "bloom_date": "2026-12-31"
  }
}
```

- `owner_id` 또는 `owner_key`를 body에 보내지 않는다. UID는 검증된 JWT에서만 얻는다.
- `Idempotency-Key`는 논리적 source event마다 하나이며 `owner_id + source` 범위에서 unique하다. 재전송 시 key와 본문을 동일하게 유지한다. 같은 key에 다른 본문을 보내면 `409`다.
- `occurred_at`은 재시도 때도 변하지 않는 실제 이벤트 시각이어야 한다.
- 처리 성공은 `201`, 동일 이벤트 replay는 `200`; 인증 실패 `401`, house 소유권 불일치 `403`, 입력 오류 `400`, 동일 키/다른 이벤트 `409`, 재시도 가능한 DB/Auth 장애 `503`이다.

## 3. 정확한 Fact → Connection → Meaning 규칙

| Connection | 연결 조건 | Meaning | Opportunity |
|---|---|---|---|
| `seed.to.fruit.achieved` | 같은 `owner_id`, 같은 nullable `house_id`; `space.seed.created`와 `space.fruit.created`의 `payload.seed_id`가 동일하며 seed 시각이 먼저 | `goal.achieved` | `celebrate.achievement` |
| `cross.language.relationship` | 같은 owner/house; `language.translated`와 `relation.chat.sent`의 `payload.conversation_id`가 동일하며 translation 시각이 먼저 | `new.relationship.forming` | `suggest.translation.help` |
| `seed.abandonment.risk` | 같은 owner/house; seed와 source가 명시적으로 보낸 `space.seed.abandonment_due`의 `payload.seed_id`가 동일하며 seed 시각이 먼저 | `seed.at.risk` | `nudge.seed.owner` |

- `fact_ids`/`source_fact_ids`에는 위 조건을 충족한 **정확히 두 Fact**만 들어간다. 집·사용자 경계를 넘는 매칭은 금지한다.
- `room_id`나 최근 10개 Fact에 함께 보인다는 사실만으로 seed와 fruit를 연결하지 않는다. 두 이벤트 모두 안정적인 동일 `seed_id`를 보내야 한다.
- 특정 기간 방문/열매가 없다는 사실만으로 abandonment를 추론하지 않는다. source 도메인이 기한이 지났다고 판단했을 때 explicit due 이벤트를 보내야 한다.

## 4. 멱등·원자 처리

- `corehub.process_fact_event` RPC가 Fact 저장부터 Connection·Meaning·Opportunity 생성과 `processed=true`까지 단일 PostgreSQL transaction으로 실행한다.
- 오류 시 트랜잭션 전체가 rollback된다. 호출자는 같은 idempotency key와 같은 이벤트 본문으로 재시도한다.
- advisory transaction lock은 같은 사용자/집의 동시 이벤트를 직렬화한다.
- DB unique index: Fact `(owner_id, source, idempotency_key)`, Connection dedupe key, Meaning source connection, Opportunity `(source_meaning_id, opportunity_type)`, Learning Log `(opportunity_id, owner_id, outcome)`.
- 이 보장은 **CoreHub가 요청을 받아 transaction이 commit된 이후**의 재전송·중복 효과를 막는다. 송신 전/응답 전 네트워크 실패까지 보장하려면 producer가 event를 source DB에 먼저 보관하고 동일 key로 재시도하는 durable outbox가 필요하다. 현재 CoreNull repo에는 실제 CoreHub Fact producer가 없으므로 end-to-end outbox/integration은 아직 제공되지 않는다. 과거 설계의 fire-and-forget 계약은 사용하지 않는다.

## 5. Migration과 배포 게이트

1. Migration은 공유 DB의 기존 `corehub` 테이블이 있는 상태에서 적용하는 **forward migration**이다. 새 데이터에 Auth UID 칼럼을 추가하고 RLS/정책/유일 인덱스/RPC를 설정한다.
2. 운영 데이터의 owner 값을 유추하거나 backfill하지 않는다. 기존 house/Facts는 증명된 별도 계정 연결 절차가 없으면 계속 격리된다.
3. 이 변경은 현재 CoreNull UI의 로그인/house creation API를 자동으로 Auth로 바꾸지 않는다. CoreNull Auth integration, 신규 house에 `owner_id` 기록, source outbox가 완료되기 전에는 운영 배포·실사용을 열지 않는다.
4. SQL migration은 로컬 PostgreSQL 16 mock schema에서 DDL/RPC, duplicate key, conflict, RLS, 동시 seed/fruit 처리를 테스트했다. **운영 Supabase에는 적용하지 않았고, 실제 Supabase에서 실행·회귀 검증하지 않았다.**

## 6. 별도 공유 DB RLS 경고

Supabase Security Advisor에서 `corenull.interests`, `corenull.post_comments`, `corenull.post_reactions`, `corenull.reactions`의 RLS 비활성 상태가 확인되었다. 이 migration은 이 4개 테이블을 바꾸지 않는다. 아래는 검토 SQL이며 **실행되지 않았다**.

```sql
ALTER TABLE "corenull"."interests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "corenull"."post_comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "corenull"."post_reactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "corenull"."reactions" ENABLE ROW LEVEL SECURITY;
```

정책 없이 RLS만 켜면 현 API가 실패할 수 있으므로 각 테이블 소유자가 접근 정책과 기존 서비스 영향부터 결정해야 한다.
