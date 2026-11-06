const CORE_RING_PURPOSE = 'corehub.resource.access';
const CORE_RING_CONTRACT_VERSION = 'corering-p4-assertion-v1';

function decodePayloadFromAuthorization(value) {
  const match = String(value || '').match(/^Bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i);
  if (!match) return null;
  try {
    const payload = JSON.parse(Buffer.from(match[2], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

export function looksLikeCoreRingP4Assertion(authorization) {
  const payload = decodePayloadFromAuthorization(authorization);
  return payload?.purpose === CORE_RING_PURPOSE ||
    payload?.contract_version === CORE_RING_CONTRACT_VERSION;
}

export function getCoreRingP4Config(env = process.env) {
  return {
    enabled: env.COREHUB_CORERING_P4_ASSERTION_ENABLED === 'true',
    issuer: env.COREHUB_CORERING_P4_ISSUER || '',
    kid: env.COREHUB_CORERING_P4_KID || '',
    publicKey: env.COREHUB_CORERING_P4_PUBLIC_KEY || '',
  };
}

export function isCoreRingP4Configured(env = process.env) {
  const config = getCoreRingP4Config(env);
  return config.enabled && Boolean(config.issuer && config.kid && config.publicKey);
}

export { CORE_RING_CONTRACT_VERSION, CORE_RING_PURPOSE };
