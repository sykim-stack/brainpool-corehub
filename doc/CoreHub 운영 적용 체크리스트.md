# CoreHub 운영 적용 체크리스트

> 목적: PR #2의 코드 머지와 운영 스키마 적용을 분리하고, Auth UID·멱등 처리·CoreNull 연동을 승인 가능한 단위로 검증한다.
>
> **중요:** 이 문서는 절차 문서다. 아래 체크리스트를 승인하기 전 공유 운영 DB `grlfocvlfatuvphkyivd`에 PR #2 migration을 적용하지 않는다.

## 0. 변경 식별

- [ ] PR #2 `feat(corehub): enforce Auth UID and idempotent Fact processing` 검토자 지정
- [ ] PR base가 `main`인지 확인
- [ ] 적용할 migration 파일과 commit SHA를 변경 기록에 고정
- [ ] 이번 변경의 범위가 CoreHub Auth UID, Fact RPC, RLS, idempotency인지 확인
- [ ] CoreNull `interests` 등 별도 Advisor/RLS 이슈는 별도 티켓으로 분리

## 1. 코드 게이트

- [ ] PR이 `main` 기준으로 clean mergeable인지 확인
- [ ] `npm ci` 성공
- [ ] `npm test` 성공
- [ ] `npm run build` 성공
- [ ] Bearer 토큰이 없거나 잘못되면 `401`
- [ ] Supabase Auth 장애는 `503` 및 재시도 가능한 오류로 반환
- [ ] 요청 본문의 `owner_id`, `owner_key`, `target_owner_id`는 거부
- [ ] house-scoped Fact는 검증된 UID와 `corenull.houses.owner_id`가 일치할 때만 허용
- [ ] `Idempotency-Key` 형식과 request body 크기 검증 확인

## 2. disposable PostgreSQL 16 / staging 게이트

PR 본문에 적힌 수동 검증을 staging 또는 disposable PostgreSQL 16에서 실행하고 결과를 PR 또는 릴리스 기록에 남긴다.

### 2.1 스키마·권한

- [ ] migration이 중단 없이 적용됨
- [ ] `corehub.facts.owner_id`, `idempotency_key` 컬럼 존재
- [ ] `corehub.connections.owner_id`, `dedupe_key` 컬럼 존재
- [ ] `corehub.meanings.owner_id`, `source_connection_id` 컬럼과 FK 존재
- [ ] `corehub.opportunities.target_owner_id` 컬럼 존재
- [ ] `corehub.learning_logs.owner_id` 컬럼 존재
- [ ] `(owner_id, source, idempotency_key)` partial unique index 존재
- [ ] connection/meaning/opportunity/learning log의 dedupe index 존재
- [ ] `corehub.process_fact_event`가 `SECURITY DEFINER`이고 `search_path`가 `pg_catalog, corehub`인지 확인
- [ ] RPC `EXECUTE` 권한은 `service_role`만 보유
- [ ] authenticated 사용자는 본인 owner/target_owner 행만 SELECT 가능
- [ ] authenticated/anon의 직접 INSERT·UPDATE·DELETE가 거부됨

### 2.2 Auth UID 및 house 소유권

- [ ] 유효한 Supabase access token으로 요청하면 token의 `user.id`가 owner로 저장됨
- [ ] 본문에 다른 `owner_id`를 넣어도 요청이 `400 owner_fields_not_accepted`
- [ ] 타인의 `house_id`로 요청하면 `403 house_not_owned_by_user`
- [ ] 존재하지 않는 house와 타인 house를 구분할 때 정보 노출이 없는지 확인
- [ ] legacy `owner_key`/`device_id` 행은 자동 backfill되지 않음

### 2.3 멱등성·원자성·동시성

- [ ] 새 key + 새 body → `201`
- [ ] 같은 key + 동일 body 재전송 → `200 duplicate`
- [ ] 같은 key + 다른 fact type/house/time/payload → `409`
- [ ] Fact 후 derived row 삽입 중 오류를 주입하면 Fact, Connection, Meaning, Opportunity가 모두 롤백됨
- [ ] 동일 owner/house의 동시 seed·fruit 이벤트가 connection/opportunity를 중복 생성하지 않음
- [ ] 서로 다른 owner 또는 house의 동일 seed/conversation 값이 서로 매칭되지 않음
- [ ] fruit이 seed보다 이른 occurred_at이면 completion으로 처리되지 않음
- [ ] abandonment는 명시적인 `space.seed.abandonment_due` 없이는 생성되지 않음
- [ ] 이미 `processed=true`인 이벤트의 재전송이 결과를 재현하고 추가 derived row를 만들지 않음

## 3. CoreNull 연동 게이트

- [ ] CoreNull 현재 구현 조사: `owner_key`/`device_id` 경로와 Auth UID 경로를 분리 확인
- [ ] 기존 `device_id`를 Auth UID로 자동 승격하지 않는 신규 House 경로 확인
- [ ] CoreNull House API의 오류 계약을 CoreHub의 `401/403/409/503` 계약과 정렬
- [ ] CoreNull 실제 domain version 반환 경로와 전송 worker가 확인되기 전 실데이터 연결 금지
- [ ] 워커 인증 모델을 ADR로 결정: 사용자 위임 토큰 또는 승인된 서비스 간 인증
- [ ] `service_role`을 사용자 인증의 대체물로 사용하지 않음
- [ ] 사용자 access token 저장·갱신·폐기·사용자별 격리 방식을 검토
- [ ] 신규 CoreNull house 생성 시 서버가 Supabase Auth UID를 제안된 canonical `public.corenull_houses.owner_id`에 기록
- [ ] brainpool-os `ADR-IDENTITY-OWNERSHIP-001`이 사람 승인되고 CoreHub route가 canonical `public.corenull_houses`를 조회함
- [ ] `public.corenull_houses.owner_id` staging migration과 Auth UID fixture 검증이 완료되기 전 house-scoped 송신이 차단됨
- [ ] 클라이언트가 제출한 owner UID를 저장하지 않음
- [ ] CoreNull 도메인 변경과 outbox 삽입이 하나의 DB 트랜잭션으로 묶임
- [ ] 도메인 update가 정확히 한 행을 변경하고 실제 확정 version을 반환함
- [ ] outbox `idempotency_key`가 실제 확정 version에서 생성되며 규칙이 문서화됨
- [ ] canonical JSON 및 payload hash 계산 규칙이 고정됨
- [ ] 동일 key·동일 hash는 중복으로 처리하고, 다른 hash는 conflict 감사 행을 남김
- [ ] 워커가 `Authorization: Bearer <access_token>`와 동일 key를 사용함
- [ ] request body에 owner 필드를 넣지 않음
- [ ] `200/201`은 sent, `503/5xx`·네트워크 오류는 backoff 재시도
- [ ] `401/403/409`와 재시도 상한 초과는 `quarantined`로 전환함
- [ ] `quarantined` 행은 자동 claim 대상에 포함되지 않음
- [ ] 각 claim마다 새 `lease_token`을 발급하고 성공·실패 갱신에서 token을 검증함
- [ ] lease 만료 행을 재claim하는 복구 절차가 검증됨
- [ ] CoreNull 연동 전까지 house-scoped CoreHub 트래픽이 0인지 확인

## 4. 운영 적용 승인

다음 담당자가 각각 서명 또는 명시적 승인한다.

- [ ] 코드 리뷰 승인: __________________ / 날짜: __________
- [ ] staging 통합 검증 승인: __________________ / 날짜: __________
- [ ] CoreNull Auth UID 계약 승인: __________________ / 날짜: __________
- [ ] CoreNull outbox/워커 운영 책임자 승인: __________________ / 날짜: __________
- [ ] 운영 migration 승인: __________________ / 날짜: __________
- [ ] 롤백/복구 담당자 확인: __________________ / 날짜: __________

승인 전에는 PR을 머지할 수는 있어도 운영 migration을 자동·수동으로 실행하지 않는다. PR 머지는 스키마 적용 승인이 아니다.

## 5. 적용 후 확인

- [ ] migration 실행 로그와 적용 SHA 보관
- [ ] 신규 컬럼의 NULL 비율을 확인하고 NULL legacy 행을 자동 연결하지 않음
- [ ] 인증 없는 요청은 계속 `401`, 토큰 요청만 `200/201`
- [ ] Advisor에서 변경 테이블의 RLS policy 존재 확인
- [ ] RPC 오류율, 409, 503, duplicate 비율 관찰
- [ ] CoreNull outbox oldest age와 failed/quarantine 건수 관찰
- [ ] 이상 시 신규 house-scoped 트래픽을 차단하고 동일 key 재시도부터 중지

## 6. 롤백·복구 원칙

- 운영 데이터 `DELETE`로 되돌리지 않는다.
- 신규 컬럼·인덱스는 forward-only로 취급하고, 필요하면 후속 migration으로 수정한다.
- `CREATE OR REPLACE FUNCTION` 전 기존 함수 정의를 별도 보관한다.
- policy 변경은 이전 policy 정의를 릴리스 기록에 남긴 뒤 되돌린다.
- partial processing이 의심되면 같은 idempotency key로 상태를 조회·재시도하고, key를 바꾸어 중복 이벤트를 만들지 않는다.
- Auth UID/house 소유권 불일치는 데이터 정합성을 수동 검토하며 자동 backfill하지 않는다.
