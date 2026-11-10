import { createPublicKey } from 'node:crypto';
import { createOwnerLinkSnapshotProvider } from './core-ring-owner-link-snapshot.mjs';

const REPLAY_RPC = 'corehub_consume_corering_p4_jti';
export const OWNER_LINK_SNAPSHOT_TABLE = 'corenull_owner_link_snapshots';
export const OWNER_LINK_SNAPSHOT_COLUMNS = [
  'source', 'snapshot_id', 'observed_at', 'fresh_until',
  'session_id', 'session_status', 'session_revoked_at',
  'link_id', 'link_revision', 'owner_binding', 'link_status',
  'link_expires_at',
].join(',');

function failClosed(message) {
  throw new Error(message);
}

function configuredPublicKey(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return createPublicKey(value);
  } catch {
    return null;
  }
}

/**
 * Key registry for the CoreRing P4 adapter.
 * Only the configured kid is accepted; no remote key URL is followed.
 */
export function createCoreRingP4KeyRegistry({ kid, publicKey }) {
  const key = configuredPublicKey(publicKey);
  return {
    getPublicKey(requestedKid) {
      if (!key || !kid || requestedKid !== kid) return null;
      return key;
    },
  };
}

/**
 * Replay ledger adapter. The RPC must atomically insert (issuer, jti) and
 * return a single boolean: true for the first consume, false for replay.
 * Missing RPC or RPC errors deliberately fail closed in the verifier.
 */
export function createSupabaseReplayLedger(supabase) {
  return {
    async consume({ issuer, jti, expiresAt }) {
      const corehub = supabase?.schema?.('corehub');
      if (!corehub || typeof corehub.rpc !== 'function') {
        failClosed('replay ledger unavailable');
      }
      const { data, error } = await corehub.rpc(REPLAY_RPC, {
        p_issuer: issuer,
        p_jti: jti,
        p_expires_at: new Date(expiresAt * 1000).toISOString(),
      });
      if (error) failClosed('replay ledger rpc failed');
      if (typeof data !== 'boolean') failClosed('replay ledger contract invalid');
      return data;
    },
  };
}

/**
 * B-1 Owner binding recheck. CoreRing signs owner_key only after its own
 * durable-session/link verification; CoreHub additionally requires that the
 * signed owner binding exists in the server-owned CoreNull identity mapping.
 * Multiple identity rows for one owner are allowed; zero rows are unresolved.
 */
export function createCoreNullOwnerResolver(supabase) {
  return {
    async resolve({ ownerKey }) {
      if (!supabase || typeof supabase.from !== 'function') {
        return { kind: 'unavailable' };
      }
      if (typeof ownerKey !== 'string' || ownerKey.length === 0) {
        return { kind: 'unresolved' };
      }
      try {
        const result = await supabase
          .from('corenull_owner_identities')
          .select('owner_key')
          .eq('owner_key', ownerKey)
          .limit(2);
        if (result.error) return { kind: 'unavailable' };
        const rows = Array.isArray(result.data) ? result.data : [];
        if (rows.length === 0) return { kind: 'unresolved' };
        return { kind: 'single', ownerKey };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}

/**
 * Read-only adapter for an approved, server-owned materialized snapshot.
 * This helper does not create tables, write rows, call CoreNull, or perform
 * network I/O outside the supplied Supabase client.
 */
export function createCoreNullOwnerLinkSnapshotProvider(supabase) {
  return {
    async resolve({ subject, sessionId, ownerKey }) {
      if (!supabase || typeof supabase.from !== 'function') {
        throw new Error('owner-link snapshot store unavailable');
      }
      const result = await supabase
        .from(OWNER_LINK_SNAPSHOT_TABLE)
        .select(OWNER_LINK_SNAPSHOT_COLUMNS)
        .eq('subject', subject)
        .eq('session_id', sessionId)
        .eq('owner_key', ownerKey)
        .limit(2);
      if (result?.error) throw new Error('owner-link snapshot query failed');
      const rows = Array.isArray(result?.data) ? result.data : [];
      if (rows.length > 1) throw new Error('owner-link snapshot is ambiguous');
      return rows[0] ?? null;
    },
  };
}

export function createCoreRingP4VerifierDependencies({
  supabase,
  issuer,
  kid,
  publicKey,
  ownerLinkResolver,
}) {
  const ownerLinkProvider = ownerLinkResolver
    ? createOwnerLinkSnapshotProvider(ownerLinkResolver.resolve.bind(ownerLinkResolver))
    : null;
  return {
    config: {
      issuer,
      audience: 'corehub-p4',
      purpose: 'corehub.resource.access',
      contractVersion: 'corering-p4-assertion-v1',
    },
    keyRegistry: createCoreRingP4KeyRegistry({ kid, publicKey }),
    replayLedger: createSupabaseReplayLedger(supabase),
    ownerResolver: createCoreNullOwnerResolver(supabase),
    ...(ownerLinkProvider ? { ownerLinkResolver: ownerLinkProvider } : {}),
  };
}

export { REPLAY_RPC };
