export const CORNULL_HOUSE_TABLE = 'corenull_houses'

/**
 * Build the canonical CoreNull House ownership query.
 * The caller must provide a verified Supabase Auth UID; request body values
 * are intentionally not accepted here.
 */
export function ownedHouseQuery(supabase, houseId, userId) {
  return supabase
    .from(CORNULL_HOUSE_TABLE)
    .select('id')
    .eq('id', houseId)
    .eq('owner_id', userId)
    .maybeSingle()
}
