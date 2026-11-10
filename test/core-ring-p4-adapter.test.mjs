import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import {
  REPLAY_RPC,
  createCoreNullOwnerResolver,
  createCoreNullOwnerLinkSnapshotProvider,
  createCoreRingP4KeyRegistry,
  createCoreRingP4VerifierDependencies,
  createSupabaseReplayLedger,
  OWNER_LINK_SNAPSHOT_COLUMNS,
  OWNER_LINK_SNAPSHOT_TABLE,
} from '../lib/corehub/core-ring-p4-adapter.mjs';

const { publicKey } = generateKeyPairSync('ed25519');

function fakeOwnerSupabase(result) {
  return {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        limit() { return Promise.resolve(result); },
      };
    },
  };
}

test('key registry accepts only the configured kid', () => {
  const registry = createCoreRingP4KeyRegistry({ kid: 'known', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });
  assert.equal(registry.getPublicKey('known').type, 'public');
  assert.equal(registry.getPublicKey('unknown'), null);
});

test('invalid or missing public key fails closed', () => {
  const registry = createCoreRingP4KeyRegistry({ kid: 'known', publicKey: 'not-a-key' });
  assert.equal(registry.getPublicKey('known'), null);
});

test('replay adapter calls the atomic RPC contract', async () => {
  const calls = [];
  const ledger = createSupabaseReplayLedger({
    schema(name) {
      assert.equal(name, 'corehub');
      return {
        async rpc(rpcName, args) {
          calls.push({ name: rpcName, args });
          return { data: true, error: null };
        },
      };
    },
  });
  assert.equal(await ledger.consume({ issuer: 'iss', jti: 'jti', expiresAt: 2_000_000_045 }), true);
  assert.equal(calls[0].name, REPLAY_RPC);
  assert.equal(calls[0].args.p_issuer, 'iss');
  assert.equal(calls[0].args.p_jti, 'jti');
});

test('replay adapter rejects a missing RPC', async () => {
  const ledger = createSupabaseReplayLedger({ schema: () => null });
  await assert.rejects(() => ledger.consume({ issuer: 'iss', jti: 'jti', expiresAt: 1 }), /replay ledger unavailable/);
});

test('Owner resolver accepts a known server-side owner binding', async () => {
  const resolver = createCoreNullOwnerResolver(fakeOwnerSupabase({ data: [{ owner_key: 'owner-a' }], error: null }));
  assert.deepEqual(await resolver.resolve({ ownerKey: 'owner-a' }), { kind: 'single', ownerKey: 'owner-a' });
});

test('Owner resolver returns unresolved for an unknown binding', async () => {
  const resolver = createCoreNullOwnerResolver(fakeOwnerSupabase({ data: [], error: null }));
  assert.deepEqual(await resolver.resolve({ ownerKey: 'owner-missing' }), { kind: 'unresolved' });
});

test('Owner resolver fails closed when the mapping query fails', async () => {
  const resolver = createCoreNullOwnerResolver(fakeOwnerSupabase({ data: null, error: new Error('db down') }));
  assert.deepEqual(await resolver.resolve({ ownerKey: 'owner-a' }), { kind: 'unavailable' });
});

test('owner-link snapshot adapter performs a bounded read with server-owned filters', async () => {
  const calls = [];
  const snapshot = { source: 'corenull', snapshot_id: 'snapshot-1' };
  const provider = createCoreNullOwnerLinkSnapshotProvider({
    from(table) {
      calls.push({ table });
      return {
        select(columns) {
          calls.push({ columns });
          return this;
        },
        eq(field, value) {
          calls.push({ field, value });
          return this;
        },
        limit(value) {
          calls.push({ limit: value });
          return Promise.resolve({ data: [snapshot], error: null });
        },
      };
    },
  });

  assert.deepEqual(
    await provider.resolve({ subject: 'subject-1', sessionId: 'session-1', ownerKey: 'owner-1' }),
    snapshot,
  );
  assert.deepEqual(calls, [
    { table: OWNER_LINK_SNAPSHOT_TABLE },
    { columns: OWNER_LINK_SNAPSHOT_COLUMNS },
    { field: 'subject', value: 'subject-1' },
    { field: 'session_id', value: 'session-1' },
    { field: 'owner_key', value: 'owner-1' },
    { limit: 2 },
  ]);
});

test('owner-link snapshot adapter returns null for no matching snapshot', async () => {
  const provider = createCoreNullOwnerLinkSnapshotProvider({
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        limit() { return Promise.resolve({ data: [], error: null }); },
      };
    },
  });
  assert.equal(
    await provider.resolve({ subject: 'subject-1', sessionId: 'session-1', ownerKey: 'owner-1' }),
    null,
  );
});

test('owner-link snapshot adapter fails closed on ambiguity or read error', async () => {
  const ambiguous = createCoreNullOwnerLinkSnapshotProvider({
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        limit() { return Promise.resolve({ data: [{}, {}], error: null }); },
      };
    },
  });
  await assert.rejects(
    ambiguous.resolve({ subject: 'subject-1', sessionId: 'session-1', ownerKey: 'owner-1' }),
    /ambiguous/,
  );

  const unavailable = createCoreNullOwnerLinkSnapshotProvider({
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        limit() { return Promise.resolve({ data: null, error: new Error('db down') }); },
      };
    },
  });
  await assert.rejects(
    unavailable.resolve({ subject: 'subject-1', sessionId: 'session-1', ownerKey: 'owner-1' }),
    /query failed/,
  );
});

test('verifier dependency factory keeps owner-link enforcement opt-in', () => {
  const dependencies = createCoreRingP4VerifierDependencies({
    supabase: {},
    issuer: 'https://identity.corering.test',
    kid: 'test-kid',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
  });
  assert.equal('ownerLinkResolver' in dependencies, false);
});

test('verifier dependency factory wraps an injected server-owned snapshot provider', async () => {
  const calls = [];
  const dependencies = createCoreRingP4VerifierDependencies({
    supabase: {},
    issuer: 'https://identity.corering.test',
    kid: 'test-kid',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    ownerLinkResolver: {
      async resolve(input) {
        calls.push(input);
        return {
          source: 'corenull',
          snapshot_id: 'snapshot-1',
          observed_at: '2033-05-18T03:33:20.000Z',
          fresh_until: '2033-05-18T03:33:50.000Z',
          session_id: 'session-1',
          session_status: 'active',
          session_revoked_at: null,
          link_id: 'link-1',
          link_revision: 'rev-2',
          owner_binding: 'owner-1',
          link_status: 'active',
          link_expires_at: '2033-05-18T03:34:20.000Z',
        };
      },
    },
  });
  const snapshot = await dependencies.ownerLinkResolver.resolve({
    subject: 'subject-1',
    sessionId: 'session-1',
    ownerKey: 'owner-1',
  });

  assert.equal(snapshot.source, 'corenull');
  assert.equal(Object.isFrozen(snapshot), true);
  assert.deepEqual(calls, [{
    subject: 'subject-1',
    sessionId: 'session-1',
    ownerKey: 'owner-1',
  }]);
});
