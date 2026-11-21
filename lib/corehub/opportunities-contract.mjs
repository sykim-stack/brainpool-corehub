/** Shared error shape for opportunities API */
export function errorPayload(code) {
  const messages = {
    auth_required: 'Authentication required',
    invalid_bearer: 'Invalid or expired credential',
    owner_fields_not_accepted: 'Client must not send owner fields; scope is derived from principal',
    hmac_not_implemented: 'HMAC device auth is not implemented on this endpoint',
    opportunity_not_found: 'Opportunity not found or not in principal scope',
    id_required: 'opportunity_id or id is required',
    method_not_allowed: 'Method not allowed',
    invalid_json: 'Invalid JSON body',
    principal_mapping_unavailable: 'Could not resolve owner keys for principal',
    supabase_init_failed: 'Database unavailable',
    session_store_unavailable: 'Session store unavailable',
  }
  return {
    error: code,
    message: messages[code] || code,
  }
}
