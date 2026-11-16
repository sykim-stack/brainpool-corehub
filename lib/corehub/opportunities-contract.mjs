export const OWNER_FIELD_KEYS = [
  'owner_key',
  'owner_id',
  'target_owner_key',
  'target_owner_id',
  'device_id',
]

export function errorPayload(code, details = {}) {
  return { ...details, error: code, _error: code }
}

export function parseBearerAuthorization(value) {
  const match = String(value || '').match(/^Bearer\s+(\S+)$/i)
  return match ? match[1] : null
}

export function hasOwnerFieldClaims(url, body) {
  return OWNER_FIELD_KEYS.some((key) =>
    url?.searchParams?.has(key) || Boolean(body && Object.prototype.hasOwnProperty.call(body, key)),
  )
}

export function isHmacRequest(headers) {
  const authorization = headers?.get?.('authorization') || ''
  return (
    /^CoreHub-HMAC\s+/i.test(authorization) ||
    Boolean(headers?.get?.('x-corehub-device-id')) ||
    Boolean(headers?.get?.('x-corehub-timestamp'))
  )
}

export function ownerScope(ownerKeys) {
  const keys = [...new Set((ownerKeys || []).filter((key) => typeof key === 'string' && key.length > 0))]
  return { ownerKeys: keys, owner_linked: keys.length > 0 }
}

// A-4/33 (2026-11-16 사람 확정): 가시성은 "만료"만 본다.
// is_consumed 는 미사용 표기다 — 소비는 조회이고, 소비자별 상태는 소비자 자기 공간에 둔다.
export function isVisibleOpportunity(row, now = new Date()) {
  if (!row) return false
  if (row.expires_at == null) return true
  return new Date(row.expires_at).getTime() > new Date(now).getTime()
}

export function canAccessOpportunity(row, ownerKeys) {
  return Boolean(row && Array.isArray(ownerKeys) && ownerKeys.includes(row.target_owner_key))
}

// DEPRECATED (A-4/33, 2026-11-16): 소비 처리(PATCH) 폐지. 계약 하위호환용으로만 남긴다.
export function canConsumeOpportunity(row, ownerKeys) {
  return canAccessOpportunity(row, ownerKeys) && row.is_consumed === false
}
