# Auth UID ↔ House ownership 통합 테스트 매트릭스

- 상태: staging 실행 대기
- 운영 실행: 금지
- 전제: canonical `public.corenull_houses.owner_id`, CoreHub route query 정렬, 테스트 Auth users

## Fixtures

| Fixture | 값/조건 |
|---|---|
| User A | valid Supabase Auth UID + access token |
| User B | 다른 valid Auth UID + access token |
| House A | `owner_id = User A`, legacy `owner_key` 보존 |
| House B | `owner_id = User B` |
| Legacy House L | `owner_id IS NULL`, legacy `owner_key` 존재 |
| Invalid token | malformed/expired token |
| Event K | stable source + idempotency key + payload |

## Ownership/Auth 테스트

| ID | 시나리오 | 기대 결과 | 상태 |
|---|---|---|---|
| OWN-001 | User A token으로 House A Fact POST | `201`, `owner_id = A`로 처리 | not run |
| OWN-002 | User B token으로 House A Fact POST | `403 house_not_owned_by_user`, Fact 없음 | not run |
| OWN-003 | Invalid token으로 House A Fact POST | `401`, Fact 없음 | not run |
| OWN-004 | Bearer 없는 요청 | `401 authentication_required` | not run |
| OWN-005 | body에 `owner_id = B`를 넣고 User A token 사용 | `400 owner_fields_not_accepted` | not run |
| OWN-006 | User A token으로 House B 접근 | `403`, cross-owner read/write 없음 | not run |
| OWN-007 | User A token으로 Legacy House L 접근 | `403` 또는 명시적 `unlinked_house`, 자동 연결 없음 | not run |
| OWN-008 | owner_key만 알고 House L 접근 | Auth UID 승격·backfill 없음 | not run |
| OWN-009 | 신규 House 생성 요청에 다른 owner_key 제출 | server verified User A로 생성되거나 요청 거부 | not run |
| OWN-010 | 기존 identity가 User B에 연결된 상태에서 User A link 시도 | `409 IDENTITY_CONFLICT`, mapping 불변 | not run |

## Idempotency/Fact 테스트

| ID | 시나리오 | 기대 결과 | 상태 |
|---|---|---|---|
| EVT-001 | User A + House A + Event K 최초 전송 | `201` | not run |
| EVT-002 | 동일 User/House/K/body 재전송 | `200 duplicate`, derived row 중복 없음 | not run |
| EVT-003 | 동일 User/House/K, 다른 payload | `409`, 원본 보존 | not run |
| EVT-004 | User B가 User A의 동일 K 사용 | owner scope가 달라 별도 권한 검사 후 `403` | not run |
| EVT-005 | House A와 House B에 같은 K 사용 | owner/house scope 정책에 따른 명시 결과, cross-owner 혼합 없음 | not run |
| EVT-006 | RPC failure | `503`, 같은 K로 retry 가능 | not run |
| EVT-007 | malformed `house_id` | `400 invalid_house_id` | not run |
| EVT-008 | missing Idempotency-Key | `400 valid_idempotency_key_required` | not run |

## Migration 검증

| ID | 시나리오 | 기대 결과 | 상태 |
|---|---|---|---|
| MIG-001 | draft migration을 staging에 적용 | owner_id/index/mapping table 생성 | not run |
| MIG-002 | 기존 House 조회 | owner_key 보존, owner_id NULL | not run |
| MIG-003 | owner_id 없는 House 목록 | 모두 unlinked로 분류 | not run |
| MIG-004 | owner_id=A House를 B로 임의 update | 권한/RLS/API에서 거부 | not run |
| MIG-005 | provider_sub 중복 insert | unique violation 또는 controlled conflict | not run |
| MIG-006 | auth_user_id가 다른 owner_key에 재연결 | unique/conflict로 거부 | not run |

## 실행 전 gate

- [ ] staging project ref와 CoreNull/CoreHub URL 확인
- [ ] test users A/B 생성 및 token 확보
- [ ] CoreNull API가 Auth UID를 검증하는 staging build 배포
- [ ] CoreHub ownership query가 canonical table을 조회하도록 정렬
- [ ] draft migration review 및 staging 승인
- [ ] 운영 secret/실데이터가 fixture에 포함되지 않음

현재 실제 staging project와 fixture가 지정되지 않아 테스트는 실행하지 않았다.
