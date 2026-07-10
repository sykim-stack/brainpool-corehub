// lib/supabase.ts
import { createClient } from '@supabase/supabase-js'

let supabaseInstance: ReturnType<typeof createClient> | null = null

export function getSupabase() {
  if (supabaseInstance) return supabaseInstance

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY

  if (!url || !key) {
    console.error('[corehub] Supabase env missing')
    return null
  }

  try {
    supabaseInstance = createClient(url, key, {
      db: { schema: 'corehub' },
    })
    return supabaseInstance
  } catch (error) {
    console.error('[corehub] Supabase init failed:', error)
    return null
  }
}