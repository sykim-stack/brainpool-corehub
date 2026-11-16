import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canAccessOpportunity,
  canConsumeOpportunity,
  errorPayload,
  hasOwnerFieldClaims,
  isHmacRequest,
  isVisibleOpportunity,
  ownerScope,
  parseBearerAuthorization,
} from '../lib/corehub/opportunities-contract.mjs'

test('인증 실패: Bearer가 없거나 형식이 틀리면 토큰을 추출하지 않는다', () => {
  assert.equal(parseBearerAuthorization(''), null)
  assert.equal(parseBearerAuthorization('Basic token'), null)
  assert.equal(parseBearerAuthorization('Bearer '), null)
  assert.equal(parseBearerAuthorization('Bearer staging-token'), 'staging-token')
})

test('오류 응답 호환: 신규 error와 기존 _error를 동시에 반환한다', () => {
  assert.deepEqual(errorPayload('auth_required'), {
    error: 'auth_required',
    _error: 'auth_required',
  })
})

test('관련 오류 코드 전체가 동일한 error/_error 값을 갖는다', () => {
  const routeErrorCodes = [
    'method_not_allowed',
    'invalid_json',
    'owner_fields_not_accepted',
    'hmac_not_implemented',
    'supabase_init_failed',
    'auth_required',
    'invalid_token',
    'principal_mapping_unavailable',
    'opportunity_not_found',
    'query_failed',
    'id_required',
  ]
  for (const code of routeErrorCodes) {
    const payload = errorPayload(code)
    assert.equal(payload.error, code)
    assert.equal(payload._error, code)
  }
})

test('매핑 없음: ownerKeys가 비어 있고 owner_linked가 false다', () => {
  assert.deepEqual(ownerScope([]), { ownerKeys: [], owner_linked: false })
  assert.deepEqual(ownerScope(['owner-a', 'owner-a']), { ownerKeys: ['owner-a'], owner_linked: true })
})

test('타인 데이터 접근: 허용된 ownerKeys 밖의 Opportunity는 차단한다', () => {
  const row = { id: 'opp-a', target_owner_key: 'owner-a', is_consumed: false }
  assert.equal(canAccessOpportunity(row, ['owner-a']), true)
  assert.equal(canAccessOpportunity(row, ['owner-b']), false)
  assert.equal(canConsumeOpportunity(row, ['owner-b']), false)
})

test('owner 관련 query/body 입력은 인증 소유권 근거로 받지 않는다', () => {
  assert.equal(hasOwnerFieldClaims(new URL('https://corehub.test/opportunities?owner_key=owner-a'), null), true)
  assert.equal(hasOwnerFieldClaims(new URL('https://corehub.test/opportunities'), { device_id: 'device-a' }), true)
  assert.equal(hasOwnerFieldClaims(new URL('https://corehub.test/opportunities'), { outcome: 'shown' }), false)
})

test('HMAC 표식은 Bearer 경로로 흘려보내지 않는다', () => {
  const hmac = new Headers({ authorization: 'CoreHub-HMAC abc', 'x-corehub-timestamp': '1' })
  const bearer = new Headers({ authorization: 'Bearer abc' })
  assert.equal(isHmacRequest(hmac), true)
  assert.equal(isHmacRequest(bearer), false)
})

test('만료·소비 필터: 활성 미소비 데이터만 노출한다', () => {
  const now = new Date('2026-11-04T00:00:00.000Z')
  assert.equal(isVisibleOpportunity({ is_consumed: false, expires_at: '2026-11-05T00:00:00.000Z' }, now), true)
  assert.equal(isVisibleOpportunity({ is_consumed: false, expires_at: '2026-11-03T23:59:59.000Z' }, now), false)
  assert.equal(isVisibleOpportunity({ is_consumed: true, expires_at: '2026-11-05T00:00:00.000Z' }, now), false)
})

test('PATCH 경합 계약: 첫 소비 후 같은 행은 두 번째 소비 대상이 아니다', () => {
  const row = { id: 'opp-a', target_owner_key: 'owner-a', is_consumed: false }
  assert.equal(canConsumeOpportunity(row, ['owner-a']), true)
  row.is_consumed = true
  assert.equal(canConsumeOpportunity(row, ['owner-a']), false)
})
