/**
 * Map authenticated subject → owner_keys in scope.
 * Client-supplied owner_key is never trusted.
 *
 * Looks up corehub.auth_owner_links (auth_user_id → owner_key).
 * Empty list is valid (principal has no linked owners yet).
 */
export async function resolveOwnerKeysFromBearer(supabase, principal) {
  const authUserId = principal?.id || principal?.authUserId
  if (typeof authUserId !== 'string' || !authUserId.trim()) {
    return { ok: false, error: 'invalid_user' }
  }

  try {
    const { data, error } = await supabase
      .schema('corehub')
      .from('auth_owner_links')
      .select('owner_key')
      .eq('auth_user_id', authUserId)
      .is('revoked_at', null)

    if (error) {
      // Table missing or RLS — treat as mapping unavailable
      return { ok: false, error: 'principal_mapping_unavailable' }
    }

    const ownerKeys = (data || [])
      .map((row) => row.owner_key)
      .filter((k) => typeof k === 'string' && k.trim())

    return {
      ok: true,
      ownerKeys: [...new Set(ownerKeys)],
      owner_linked: ownerKeys.length > 0,
    }
  } catch {
    return { ok: false, error: 'principal_mapping_unavailable' }
  }
}
