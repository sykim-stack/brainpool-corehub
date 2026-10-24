# CoreHub PR #2 검증 보고서

- 검증일: 2026-10-18 보완
- 브랜치: `security/corehub-event-integrity-2026-10-05`
- HEAD: `7378f97`
- PR: #2, draft, base `main`

## 결과 요약

CoreHub PR #2의 로컬 테스트와 production build는 통과했다. Vercel Preview 관련 checks도 성공 상태다. 그러나 이 검증은 CoreNull producer와 staging Supabase를 연결한 E2E 검증이 아니므로, 운영 적용 승인을 의미하지 않는다.

| 검증 항목 | 결과 | 비고 |
|---|---|---|
| `npm test` | PASS | 12 tests passed, 0 failed |
| `npm run build` | PASS | Next.js 15.5.27 production build |
| `git diff --check` | PASS | whitespace 오류 없음 |
| Vercel Preview Comments | SUCCESS | PR status check |
| Vercel brainpool-corehub | SUCCESS | PR status check |
| Vercel brainpool-corehub-frhk | SUCCESS | PR status check |
| CoreNull staging producer → CoreHub staging E2E | NOT RUN | CoreNull outbox/worker/Auth UID 계약 미구현 |
| 실제 Supabase `process_fact_event` RPC 검증 | NOT RUN | staging project/fixture 미지정 |

상세 검토 결과는 [CoreHub PR2 integration and outbox review 2026-10-18](./CoreHub%20PR2%20integration%20and%20outbox%20review%202026-10-18.md)에 기록했다. 결론은 consumer-side 검증 PASS, CoreNull producer·durable outbox·worker·staging E2E NOT RUN이다.

## 통과한 로컬 테스트 범위

현재 테스트는 다음을 확인한다.

- owner 또는 House가 다른 Fact가 서로 섞이지 않음
- seed보다 fruit가 시간상 먼저 처리되지 않음
- conversation 범위 밖의 translation/chat link가 연결되지 않음
- 명시적 due event 없이 visit 부재를 abandonment로 판단하지 않음
- evidence type을 보존한 meaning/opportunity mapping
- 문법적으로 유효한 Bearer token만 인증 입력으로 허용
- owner ID는 request body가 아니라 검증된 token의 사용자 ID에서 유도
- token 누락/오류는 fail closed
- Auth 장애는 재시도 가능한 503으로 분류

## PR #2 route 계약 확인

`app/api/corehub/facts/route.js`와 `lib/corehub/auth.mjs` 기준으로 다음 계약이 구현되어 있다.

- Bearer 없음: `401 authentication_required`
- 잘못된 access token: `401 invalid_access_token`
- Auth 서비스 장애: `503 authentication_service_unavailable`
- body의 `owner_id`/`owner_key`: 거부
- House 미소유: `403 house_not_owned_by_user`
- Idempotency-Key 없음/오류: `400 valid_idempotency_key_required`
- 동일 key·동일 event: duplicate `200`
- 동일 key·다른 event: `409`
- RPC 처리 오류: 동일 key 재시도를 안내하는 `503`

## 아직 남은 검증 blocker

### 1. CoreNull producer 계약

CoreNull의 현재 `pushFact()`는 `Authorization`과 `Idempotency-Key`를 전송하지 않는다. 또한 `owner_key`를 body에 넣는 현재 구조는 PR #2의 Auth UID 기반 owner 결정과 맞지 않는다.

### 2. Durable outbox와 worker

CoreNull에는 아직 domain mutation과 원자적으로 기록되는 outbox, claim/lease, retry/backoff, quarantine, stable event key가 없다. 따라서 네트워크 오류나 CoreHub 503 시 이벤트 보존을 확인할 수 없다.

### 3. 실제 Supabase RPC

로컬 테스트는 RPC와 실제 RLS/권한 경계를 호출하지 않는다. staging fixture를 지정한 뒤 다음을 별도로 확인해야 한다.

- `process_fact_event`의 transaction/idempotency 동작
- `corehub.facts`와 canonical `corenull.houses`의 schema 권한
- 기존 `corenull.houses.owner_id` FK 및 `public.corenull_owner_identities` Auth UID 확장 migration 검증
- brainpool-os [ADR-IDENTITY-OWNERSHIP-001](https://github.com/sykim-stack/brainpool-os/pull/1)의 사람 승인 여부
- Auth UID와 House owner mapping
- 동일 key의 동일/상이한 body 처리
- RPC 실패 시 503과 worker retry 상호작용

## 다음 staging gate

다음 순서가 완료되기 전에는 운영 Fact 송신을 시작하지 않는다.

1. CoreNull Auth UID와 House ownership 계약 승인
2. staging `public.corenull_owner_identities.auth_user_id` migration 적용 및 기존 `corenull.houses.owner_id` route schema 검증
3. domain revision/event sequence와 stable idempotency key 승인
4. CoreNull outbox migration과 worker 구현
5. 별도 staging Supabase/CoreHub endpoint 및 test fixture 지정
6. CoreNull producer → CoreHub PR #2 E2E 실행
7. duplicate, 409, 401/403, 503, lease expiry, stale completion 검증
8. 결과 검토 후 운영 migration/worker 배포를 별도 승인

## 판정

**PR #2 자체: 검증 통과.**

**CoreNull 통합: 아직 차단.**

PR #2를 production use로 전환하는 조건은 CoreHub 코드 품질이 아니라 CoreNull의 Auth UID·ownership·outbox·worker가 PR #2 consumer 계약을 충족하는지 staging에서 입증하는 것이다.
