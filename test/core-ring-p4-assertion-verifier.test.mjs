import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import {
  authenticateCoreRingRequest,
  verifyCoreRingAssertion,
} from '../lib/corehub/verifyCoreRingP4Assertion.mjs';

const NOW = 2_000_000_000;
const NOW_ISO = new Date(NOW * 1000).toISOString();
const FRESH_UNTIL_ISO = new Date((NOW + 30) * 1000).toISOString();
const CONFIG = {
  issuer: 'https://identity.corering.test',
  audience: 'corehub-p4',
  purpose: 'corehub.resource.access',
  contractVersion: 'corering-p4-assertion-v1',
};
const { privateKey, publicKey } = generateKeyPairSync('ed25519');

function b64(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function makeToken({ header = {}, claims = {}, mutateSigningInput = false } = {}) {
  const fullHeader = {
    alg: 'EdDSA',
    kid: 'test-kid',
    typ: 'JWT',
    ...header,
  };
  const fullClaims = {
    iss: CONFIG.issuer,
    aud: CONFIG.audience,
    sub: 'crsync_test_subject',
    session_id: 'sess_test_opaque',
    owner_key: 'owner_test_verified',
    purpose: CONFIG.purpose,
    jti: `jti-${Math.random().toString(36).slice(2)}`,
    iat: NOW,
    exp: NOW + 45,
    contract_version: CONFIG.contractVersion,
    ...claims,
  };
  const encodedHeader = b64(fullHeader);
  const encodedClaims = b64(fullClaims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = sign(null, Buffer.from(mutateSigningInput ? `${signingInput}x` : signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}

function deps({ resolverKind = 'single', ownerKey = 'owner_test_verified', consumed = new Set(), consumeDelay = 0 } = {}) {
  return {
    keyRegistry: { getPublicKey: () => publicKey },
    replayLedger: {
      async consume({ jti }) {
        if (consumeDelay) await new Promise((resolve) => setTimeout(resolve, consumeDelay));
        if (consumed.has(jti)) return false;
        consumed.add(jti);
        return true;
      },
    },
    ownerResolver: {
      async resolve() {
        if (resolverKind === 'single') return { kind: 'single', ownerKey };
        return { kind: resolverKind };
      },
    },
  };
}

function options(token, extra = {}) {
  return {
    headers: { authorization: `Bearer ${token}` },
    body: {},
    nowSeconds: NOW,
    config: CONFIG,
    ...deps(),
    ...extra,
  };
}

test('valid assertion returns a verified server principal', async () => {
  const result = await verifyCoreRingAssertion(options(makeToken()));
  assert.equal(result.scheme, 'corering-p4-assertion');
  assert.equal(result.ownerKey, 'owner_test_verified');
  assert.equal(result.expiresAt, NOW + 45);
});

test('injected fresh owner-link snapshot allows access before replay consume', async () => {
  const events = [];
  const shared = deps();
  const consume = shared.replayLedger.consume;
  shared.replayLedger.consume = async (...args) => {
    events.push('replay');
    return consume(...args);
  };
  const result = await authenticateCoreRingRequest(options(makeToken({
    claims: { link_id: 'link-1', link_revision: 'rev-2' },
  }), {
    ...shared,
    ownerLinkResolver: {
      async resolve() {
        events.push('owner-link');
        return {
          source: 'corenull',
          observed_at: NOW_ISO,
          fresh_until: FRESH_UNTIL_ISO,
          session_id: 'sess_test_opaque',
          session_status: 'active',
          session_revoked_at: null,
          link_id: 'link-1',
          link_revision: 'rev-2',
          owner_binding: 'owner_test_verified',
          link_status: 'active',
          link_expires_at: new Date((NOW + 60) * 1000).toISOString(),
        };
      },
    },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(events, ['owner-link', 'replay']);
});

test('stale owner-link state returns 503 and does not consume replay jti', async () => {
  const events = [];
  const shared = deps();
  const consume = shared.replayLedger.consume;
  shared.replayLedger.consume = async (...args) => {
    events.push('replay');
    return consume(...args);
  };
  const result = await authenticateCoreRingRequest(options(makeToken({
    claims: { link_id: 'link-1', link_revision: 'rev-2' },
  }), {
    ...shared,
    ownerLinkResolver: {
      async resolve() {
        events.push('owner-link');
        return {
          source: 'corenull',
          observed_at: NOW_ISO,
          fresh_until: NOW_ISO,
          session_id: 'sess_test_opaque',
          session_status: 'active',
          session_revoked_at: null,
          link_id: 'link-1',
          link_revision: 'rev-2',
          owner_binding: 'owner_test_verified',
          link_status: 'active',
          link_expires_at: new Date((NOW + 60) * 1000).toISOString(),
        };
      },
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'owner_link_state_stale');
  assert.equal(result.body.error, result.body._error);
  assert.deepEqual(events, ['owner-link']);
});

test('revoked owner-link state returns 401 before replay consume', async () => {
  const events = [];
  const shared = deps();
  const consume = shared.replayLedger.consume;
  shared.replayLedger.consume = async (...args) => {
    events.push('replay');
    return consume(...args);
  };
  const result = await authenticateCoreRingRequest(options(makeToken({
    claims: { link_id: 'link-1', link_revision: 'rev-2' },
  }), {
    ...shared,
    ownerLinkResolver: {
      async resolve() {
        events.push('owner-link');
        return {
          source: 'corenull',
          observed_at: NOW_ISO,
          fresh_until: FRESH_UNTIL_ISO,
          session_id: 'sess_test_opaque',
          session_status: 'revoked',
          session_revoked_at: NOW_ISO,
          link_id: 'link-1',
          link_revision: 'rev-2',
          owner_binding: 'owner_test_verified',
          link_status: 'active',
          link_expires_at: new Date((NOW + 60) * 1000).toISOString(),
        };
      },
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'session_revoked');
  assert.deepEqual(events, ['owner-link']);
});

test('expired owner-link state returns 403 before replay consume', async () => {
  const events = [];
  const shared = deps();
  const consume = shared.replayLedger.consume;
  shared.replayLedger.consume = async (...args) => {
    events.push('replay');
    return consume(...args);
  };
  const result = await authenticateCoreRingRequest(options(makeToken({
    claims: { link_id: 'link-1', link_revision: 'rev-2' },
  }), {
    ...shared,
    ownerLinkResolver: {
      async resolve() {
        events.push('owner-link');
        return {
          source: 'corenull',
          observed_at: NOW_ISO,
          fresh_until: FRESH_UNTIL_ISO,
          session_id: 'sess_test_opaque',
          session_status: 'active',
          session_revoked_at: null,
          link_id: 'link-1',
          link_revision: 'rev-2',
          owner_binding: 'owner_test_verified',
          link_status: 'active',
          link_expires_at: NOW_ISO,
        };
      },
    },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'owner_link_expired');
  assert.deepEqual(events, ['owner-link']);
});

test('wrong issuer is rejected', async () => {
  const result = await authenticateCoreRingRequest(options(makeToken({ claims: { iss: 'https://evil.test' } })));
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.body.error, 'invalid_token');
  assert.equal(result.body.error, result.body._error);
});

test('expired assertion is rejected', async () => {
  const result = await authenticateCoreRingRequest(options(makeToken({ claims: { exp: NOW } })));
  assert.equal(result.body.error, 'invalid_token');
});

test('replayed jti is rejected', async () => {
  const token = makeToken({ claims: { jti: 'same-jti' } });
  const shared = deps();
  const first = await authenticateCoreRingRequest(options(token, shared));
  const second = await authenticateCoreRingRequest(options(token, shared));
  assert.equal(first.ok, true);
  assert.equal(second.body.error, 'token_replayed');
});

test('owner mapping conflict is fail-closed', async () => {
  const result = await authenticateCoreRingRequest(options(makeToken(), deps({ resolverKind: 'conflict' })));
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'principal_mapping_conflict');
});

test('owner_key and device_id client injection is rejected', async () => {
  const result = await authenticateCoreRingRequest(options(makeToken(), {
    body: { owner_key: 'attacker-owner', device_id: 'attacker-device' },
  }));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'owner_fields_not_accepted');
});

test('tampered signature is rejected', async () => {
  const result = await authenticateCoreRingRequest(options(makeToken({ mutateSigningInput: true })));
  assert.equal(result.body.error, 'invalid_token');
});

test('lifetime above 60 seconds is rejected', async () => {
  const result = await authenticateCoreRingRequest(options(makeToken({ claims: { exp: NOW + 61 } })));
  assert.equal(result.body.error, 'invalid_token');
});

test('same jti concurrent race has exactly one winner', async () => {
  const token = makeToken({ claims: { jti: 'race-jti' } });
  const shared = deps({ consumeDelay: 5 });
  const results = await Promise.all(
    Array.from({ length: 16 }, () => authenticateCoreRingRequest(options(token, shared))),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => r.body?.error === 'token_replayed').length, 15);
});

test('ledger failure fails closed', async () => {
  const result = await authenticateCoreRingRequest(options(makeToken(), {
    replayLedger: { async consume() { throw new Error('ledger down'); } },
  }));
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'identity_verification_unavailable');
});
