-- CoreHub identity handoff tables
-- Run on shared Supabase (corehub schema) before enabling handoff routes in prod.
-- Safe to re-run: uses IF NOT EXISTS.

CREATE SCHEMA IF NOT EXISTS corehub;

-- Short-lived one-time tickets (TTL ~60s)
CREATE TABLE IF NOT EXISTS corehub.auth_handoffs (
  ticket_hash   TEXT PRIMARY KEY,
  auth_user_id  TEXT NOT NULL,
  audience      TEXT NOT NULL CHECK (audience IN ('corenull', 'corering')),
  expires_at    TIMESTAMPTZ NOT NULL,
  used_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_handoffs_expires_idx
  ON corehub.auth_handoffs (expires_at)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_handoffs_auth_user_idx
  ON corehub.auth_handoffs (auth_user_id);

-- Opaque sessions issued after successful redeem (TTL up to 30d)
CREATE TABLE IF NOT EXISTS corehub.auth_sessions (
  token_hash    TEXT PRIMARY KEY,
  auth_user_id  TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_sessions_auth_user_idx
  ON corehub.auth_sessions (auth_user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx
  ON corehub.auth_sessions (expires_at)
  WHERE revoked_at IS NULL;

-- Principal → owner_key scope for opportunities & shared owner (SHARED-OWNER-001)
CREATE TABLE IF NOT EXISTS corehub.auth_owner_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id  TEXT NOT NULL,
  owner_key     TEXT NOT NULL,
  source        TEXT, -- e.g. 'corenull' | 'manual' | 'import'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ,
  UNIQUE (auth_user_id, owner_key)
);

CREATE INDEX IF NOT EXISTS auth_owner_links_auth_user_idx
  ON corehub.auth_owner_links (auth_user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS auth_owner_links_owner_key_idx
  ON corehub.auth_owner_links (owner_key)
  WHERE revoked_at IS NULL;

-- Notes:
-- 1) CoreNull still resolves Owner via public.corenull_owner_identities
--    (provider='supabase'|'auth', provider_sub=auth_user_id). No auto-create.
-- 2) Service role is used by CoreHub API; tighten RLS if anon keys ever touch these tables.
-- 3) Do not store raw tickets/session tokens — only SHA-256 hashes.
