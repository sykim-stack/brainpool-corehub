-- P4 security gate: CoreHub ownership data is server/API-owned.
-- Apply only after review in Staging. This migration is intentionally not applied by this task.

REVOKE ALL PRIVILEGES ON TABLE
  public.corenull_owner_identities,
  corehub.facts,
  corehub.connections,
  corehub.meanings,
  corehub.opportunities,
  corehub.learning_logs
FROM anon, authenticated;

-- Keep RLS deny-by-default explicit for PostgREST roles.
DO $$
DECLARE
  target_table regclass;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'public.corenull_owner_identities'::regclass,
    'corehub.facts'::regclass,
    'corehub.connections'::regclass,
    'corehub.meanings'::regclass,
    'corehub.opportunities'::regclass,
    'corehub.learning_logs'::regclass
  ] LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %s',
      'deny_direct_client_access',
      target_table
    );
    EXECUTE format(
      'CREATE POLICY %I ON %s AS RESTRICTIVE FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)',
      'deny_direct_client_access',
      target_table
    );
  END LOOP;
END $$;

COMMENT ON TABLE public.corenull_owner_identities IS
  'Server/API-owned identity-to-owner mapping; direct anon/authenticated table access denied.';
COMMENT ON TABLE corehub.opportunities IS
  'Server/API-owned opportunities; direct anon/authenticated table access denied.';
