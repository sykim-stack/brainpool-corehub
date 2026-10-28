# Worker·Outbox 검증 Gate

## 전제

이 문서는 Auth UID ↔ House ownership 계약이 staging에서 통과한 뒤에만 실행한다. ownership assertion이 미확정인 상태에서 worker retry를 먼저 검증하지 않는다.

## Outbox 원자성

1. House/Room/Fruit domain mutation과 outbox insert가 같은 transaction에서 commit된다.
2. domain mutation rollback 시 outbox row도 없어야 한다.
3. outbox insert 실패 시 domain mutation도 rollback된다.
4. outbox payload에는 canonical body hash, stable idempotency key, owner_id, house_id, event revision이 있다.
5. outbox row에는 access token, refresh token, HMAC private key를 저장하지 않는다.

## Claim/lease

1. worker가 `pending` row를 claim하면 lease token과 lease expiry가 기록된다.
2. 같은 row를 두 worker가 동시에 성공 처리하지 못한다.
3. lease expiry 뒤 새 worker가 재claim할 수 있다.
4. 이전 worker의 stale completion은 새 lease 상태를 덮어쓰지 못한다.
5. 성공 completion은 같은 lease token을 요구한다.

## Retry/quarantine

| 응답 | 동작 |
|---|---|
| `201` | `sent` 처리 |
| duplicate `200` | `sent` 처리, duplicate metric 기록 |
| `400`/schema error | 자동 retry 금지, `quarantined` |
| `401`/`403` | 자동 retry 금지, ownership/auth audit 후 `quarantined` |
| `409` | producer conflict 기록, 자동 retry 금지 |
| `503`/network error | exponential backoff, 동일 key 재시도 |

## 필수 시나리오

- 정상 User A → House A 이벤트 전송
- User B의 House A 이벤트 차단
- unlinked House 이벤트 quarantine
- 잘못된 token 이벤트 차단
- 동일 event 재전송 duplicate
- 동일 key·다른 payload conflict
- network failure 후 retry
- lease expiry 후 takeover
- stale worker completion 차단
- owner/house/event revision 혼합 방지

## 운영 gate

다음 항목이 모두 충족되기 전에는 운영 worker를 활성화하지 않는다.

- [ ] canonical ownership schema 승인
- [ ] 신규/기존 사용자 mapping 절차 승인
- [ ] staging ownership matrix 전체 통과
- [ ] staging migration rollback 계획 검토
- [ ] outbox 원자성 통과
- [ ] lease/retry/quarantine 통과
- [ ] secret rotation 및 로그 비노출 확인
- [ ] 운영 migration과 실데이터 연결 별도 승인
