# ADR-001: CoreNull → CoreHub worker 인증 모델

- 상태: **Proposed — 승인 대기**
- 작성일: 2026-10-16
- 범위: CoreNull durable outbox worker가 CoreHub Fact API를 호출하는 인증
- 관련 PR: CoreHub PR #2

## Context

현재 CoreNull은 Google `id_token`을 `/api/auth/google`에서 검증하고 Google subject를 기존 `owner_key`와 연결한다. 클라이언트에는 `owner_key`만 반환하며, 장기 worker가 사용할 Supabase access token은 발급·보관·갱신·전달하지 않는다.

현재 CoreHub PR #2는 `Authorization: Bearer <Supabase access token>`을 검증해 owner UID를 결정하고, request body의 `owner_id`/`owner_key`를 거부한다. 또한 House ownership, `Idempotency-Key`, duplicate/409/503 처리를 구현한다. CoreNull의 현재 `pushFact`는 인증 헤더와 `Idempotency-Key` 없이 request body에 `owner_key`를 넣어 직접 호출하므로 consumer 계약과 불일치한다.

따라서 지금 상태에서 사용자 위임 token 방식을 바로 적용할 수 없다. `service_role`을 사용자 인증의 대체물로 사용하는 것도 허용하지 않는다.

## Options

### A. 사용자 위임 token

CoreNull worker가 각 owner의 Supabase access token을 확보하고 만료 시 갱신한다.

- 장점: 현재 CoreHub Bearer 계약을 그대로 활용 가능
- 단점: 사용자별 token 저장·암호화·갱신·폐기와 로그아웃 후 재시도 정책이 필요
- 현재 상태: 필요한 세션 전달·token vault·worker credential 계약이 없음

### B. 서비스 간 인증 — 권고 후보

CoreNull worker와 CoreHub 사이에 별도 서비스 인증을 둔다. mTLS 또는 HMAC 서명된 요청을 사용하고, 서명된 `owner_id`/`house_id` claim을 CoreHub가 검증한다.

- 장점: 사용자 token을 장기 저장하지 않고 백그라운드 재시도 가능
- 단점: CoreHub API에 별도 서비스 인증 경로와 claim/House 소유권 검증을 추가해야 함; 현재 PR #2의 사용자 Bearer 경로를 대체하지 않음
- 주의: claim의 owner를 무조건 신뢰하지 않고 CoreNull의 승인된 ownership assertion 또는 공유 DB의 검증 가능한 매핑을 확인해야 함

### C. service_role을 사용자 인증으로 사용

- 결정: **거부**
- 이유: service_role은 DB 권한이며 사용자 identity assertion이 아니다. 키 유출 시 owner 경계가 사라진다.

## Proposed decision

**B를 권고한다. 단, 이 ADR은 아직 승인되지 않았다.** 승인 전에는 실제 CoreNull → CoreHub worker를 배포하지 않는다.

초기 구현은 다음 계약을 목표로 한다.

```http
POST /api/corehub/facts
Authorization: CoreHub-HMAC key_id="...", timestamp="...", nonce="...", signature="..."
Idempotency-Key: <stable-event-key>
Content-Type: application/json

{
  "source": "corenull",
  "fact_type": "space.seed.created",
  "occurred_at": "...",
  "house_id": "...",
  "payload": {
    "room_id": "...",
    "revision": 12
  }
}
```

서명 대상에는 method, path, timestamp, nonce, body의 canonical JSON hash를 포함한다. CoreHub는 다음을 검증한다.

1. key id가 활성 상태인지 확인
2. timestamp 허용 오차와 nonce 재사용 여부 확인
3. signature 검증
4. payload hash와 서명된 body 일치 확인
5. `house_id`가 claim의 owner/테넌시 범위에 속하는지 확인
6. 같은 `Idempotency-Key`의 동일 body는 duplicate 성공, 다른 body는 `409`
7. 인증 실패는 `401`, House 불일치는 `403`, 일시 장애는 `503`

### Owner claim의 미결정 부분

서비스 서명이 유효하다는 사실만으로 request body의 `owner_id`를 신뢰해서는 안 된다. 다음 중 하나를 별도 설계해야 한다.

- CoreNull과 CoreHub가 같은 Supabase project의 `auth.users`/House ownership 매핑을 조회
- CoreNull이 서명된 ownership assertion을 발행하고 CoreHub가 짧은 TTL과 nonce로 검증
- CoreHub가 승인된 내부 service credential과 `house_id → owner_id` 매핑을 별도 관리

이 부분이 확정되기 전에는 ADR을 **Accepted**로 바꾸지 않는다.

## Consequences

- CoreHub PR #2의 현재 사용자 Bearer route는 이미 구현되어 있다. 서비스 인증을 선택할 때만 별도 경로를 추가하고, 기존 사용자 경로와 권한 경계를 유지해야 한다.
- CoreNull은 신규 House 생성 시 검증된 Auth UID와 ownership mapping을 저장해야 한다.
- 기존 `owner_key`/`device_id` 데이터는 자동 backfill하지 않는다.
- worker는 access token을 로그에 남기지 않으며, HMAC key/mTLS private key는 DB outbox row에 저장하지 않는다.
- staging에서 replay, wrong-house, bad-signature, duplicate, 409, 503, lease expiry를 먼저 검증해야 한다.

## Approval checklist

- [ ] CoreNull Auth UID와 신규 House ownership 경로 승인
- [ ] ownership assertion/매핑 방식 승인
- [ ] mTLS 또는 HMAC와 key rotation 방식 승인
- [ ] CoreHub API 변경 승인
- [ ] staging E2E 통과
- [ ] 운영 migration 및 실데이터 연결은 별도 승인

**현재 승인 상태: 미승인.**
