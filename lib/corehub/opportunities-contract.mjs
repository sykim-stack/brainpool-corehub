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

export function isVisibleOpportunity(row, now = new Date()) {
  if (!row || row.is_consumed === true) return false
  if (row.expires_at == null) return true
  return new Date(row.expires_at).getTime() > new Date(now).getTime()
}

export function canAccessOpportunity(row, ownerKeys) {
  return Boolean(row && Array.isArray(ownerKeys) && ownerKeys.includes(row.target_owner_key))
}

export function canConsumeOpportunity(row, ownerKeys) {
  return canAccessOpportunity(row, ownerKeys) && row.is_consumed === false
}
