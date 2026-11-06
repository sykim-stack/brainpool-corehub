import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getCoreRingP4Config,
  isCoreRingP4Configured,
  looksLikeCoreRingP4Assertion,
} from '../lib/corehub/core-ring-p4-request.mjs';

function token(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `Bearer ${encode({ alg: 'EdDSA', kid: 'test', typ: 'JWT' })}.${encode(payload)}.signature`;
}

test('CoreRing purpose identifies an assertion candidate without trusting it', () => {
  assert.equal(looksLikeCoreRingP4Assertion(token({ purpose: 'corehub.resource.access' })), true);
  assert.equal(looksLikeCoreRingP4Assertion(token({ purpose: 'other' })), false);
});

test('CoreRing contract version identifies an assertion candidate', () => {
  assert.equal(looksLikeCoreRingP4Assertion(token({ contract_version: 'corering-p4-assertion-v1' })), true);
});

test('malformed or ordinary Supabase JWT is not classified as CoreRing', () => {
  assert.equal(looksLikeCoreRingP4Assertion('Bearer not.a.jwt'), false);
  assert.equal(looksLikeCoreRingP4Assertion(token({ sub: 'supabase-user' })), false);
});

test('configuration requires explicit enable flag and all key settings', () => {
  const complete = {
    COREHUB_CORERING_P4_ASSERTION_ENABLED: 'true',
    COREHUB_CORERING_P4_ISSUER: 'https://identity.corering.test',
    COREHUB_CORERING_P4_KID: 'corering-p4-1',
    COREHUB_CORERING_P4_PUBLIC_KEY: 'pem',
  };
  assert.equal(isCoreRingP4Configured(complete), true);
  assert.equal(isCoreRingP4Configured({ ...complete, COREHUB_CORERING_P4_ASSERTION_ENABLED: 'false' }), false);
  assert.equal(isCoreRingP4Configured({ ...complete, COREHUB_CORERING_P4_PUBLIC_KEY: '' }), false);
  assert.deepEqual(getCoreRingP4Config(complete), {
    enabled: true,
    issuer: 'https://identity.corering.test',
    kid: 'corering-p4-1',
    publicKey: 'pem',
  });
});
