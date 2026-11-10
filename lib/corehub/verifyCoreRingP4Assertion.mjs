import { createPublicKey, verify as verifySignature } from 'node:crypto';
import {
  evaluateOwnerLinkState,
  ownerLinkHttpPolicy,
} from './core-ring-owner-link-contract.mjs';

const HEADER_KEYS = new Set(['alg', 'kid', 'typ']);
const CLAIM_KEYS = new Set([
  'iss', 'aud', 'sub', 'session_id', 'owner_key', 'purpose',
  'jti', 'iat', 'exp', 'contract_version',
  'link_id', 'link_revision', 'owner_binding',
]);

const DEFAULTS = Object.freeze({
  issuer: 'https://identity.corering.test',
  audience: 'corehub-p4',
  purpose: 'corehub.resource.access',
  contractVersion: 'corering-p4-assertion-v1',
  algorithm: 'EdDSA',
  typ: 'JWT',
  clockSkewSeconds: 5,
  maxLifetimeSeconds: 60,
  maxTokenBytes: 8192,
});

export class VerificationError extends Error {
  constructor(code, status = 401, message = code) {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status = 401) {
  throw new VerificationError(code, status);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeBase64Url(segment, label) {
  if (typeof segment !== 'string' || segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    fail('invalid_token');
  }
  try {
    return Buffer.from(segment, 'base64url');
  } catch {
    fail('invalid_token');
  }
}

function decodeJson(segment, label) {
  try {
    return JSON.parse(decodeBase64Url(segment, label).toString('utf8'));
  } catch {
    fail('invalid_token');
  }
}

function assertExactKeys(object, allowed) {
  if (!isPlainObject(object)) fail('invalid_token');
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail('invalid_token');
  }
}

function assertNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function assertInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseAuthorization(headers) {
  const values = headers?.authorization ?? headers?.Authorization;
  if (Array.isArray(values)) {
    if (values.length !== 1) fail('invalid_token');
    return parseAuthorization({ authorization: values[0] });
  }
  if (typeof values !== 'string' || values.length === 0) fail('auth_required');
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(values);
  if (!match) fail('invalid_token');
  return match[1];
}

function validateHeader(header) {
  assertExactKeys(header, HEADER_KEYS);
  if (header.alg !== DEFAULTS.algorithm || header.typ !== DEFAULTS.typ || !assertNonEmptyString(header.kid)) {
    fail('invalid_token');
  }
}

function validateClaims(claims, config) {
  assertExactKeys(claims, CLAIM_KEYS);
  const required = ['iss', 'aud', 'sub', 'session_id', 'owner_key', 'purpose', 'jti', 'iat', 'exp', 'contract_version'];
  for (const key of required) {
    if (!(key in claims)) fail('invalid_token');
  }
  for (const key of ['iss', 'aud', 'sub', 'session_id', 'owner_key', 'purpose', 'jti', 'contract_version']) {
    if (!assertNonEmptyString(claims[key])) fail('invalid_token');
  }
  if (claims.iss !== config.issuer || claims.aud !== config.audience ||
      claims.purpose !== config.purpose || claims.contract_version !== config.contractVersion) {
    fail('invalid_token');
  }
  if (!assertInteger(claims.iat) || !assertInteger(claims.exp) || claims.exp <= claims.iat) {
    fail('invalid_token');
  }
  const lifetime = claims.exp - claims.iat;
  if (lifetime > config.maxLifetimeSeconds) fail('invalid_token');
  return claims;
}

function validateTime(claims, now, config) {
  if (!Number.isSafeInteger(now) || now < 0) fail('identity_verification_unavailable', 503);
  // Future-issued assertions may tolerate bounded clock skew; expired assertions never do.
  if (claims.iat > now + config.clockSkewSeconds) fail('invalid_token');
  if (now >= claims.exp) fail('invalid_token');
}

function getKey(keyRegistry, kid) {
  try {
    const key = typeof keyRegistry.getPublicKey === 'function'
      ? keyRegistry.getPublicKey(kid)
      : keyRegistry.get?.(kid);
    if (!key) fail('invalid_token');
    return key.type === 'public' ? key : createPublicKey(key);
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    fail('identity_verification_unavailable', 503);
  }
}

function verifyJws(token, keyRegistry, config) {
  const parts = token.split('.');
  if (parts.length !== 3 || Buffer.byteLength(token, 'utf8') > config.maxTokenBytes) fail('invalid_token');
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader, 'header');
  const claims = decodeJson(encodedPayload, 'payload');
  validateHeader(header);
  const publicKey = getKey(keyRegistry, header.kid);
  const valid = verifySignature(
    null,
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    decodeBase64Url(encodedSignature, 'signature'),
  );
  if (!valid) fail('invalid_token');
  return { header, claims };
}

function normalizeResolverResult(result) {
  if (!isPlainObject(result) || typeof result.kind !== 'string') {
    fail('identity_verification_unavailable', 503);
  }
  return result;
}

async function resolveOwner(ownerResolver, claims) {
  let result;
  try {
    result = normalizeResolverResult(await ownerResolver.resolve({
      subject: claims.sub,
      sessionId: claims.session_id,
      ownerKey: claims.owner_key,
    }));
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    fail('identity_verification_unavailable', 503);
  }

  if (result.kind === 'unresolved') fail('principal_mapping_unavailable', 403);
  if (result.kind === 'conflict') fail('principal_mapping_conflict', 409);
  if (result.kind === 'unavailable') fail('identity_verification_unavailable', 503);
  if (result.kind === 'mismatch') fail('principal_mapping_unavailable', 403);
  if (result.kind !== 'single' || result.ownerKey !== claims.owner_key) {
    fail('principal_mapping_unavailable', 403);
  }
  return result;
}

async function enforceOwnerLinkState(ownerLinkResolver, claims, owner, nowSeconds) {
  if (!ownerLinkResolver) return;
  if (typeof ownerLinkResolver.resolve !== 'function') {
    fail('identity_verification_unavailable', 503);
  }

  let snapshot;
  try {
    snapshot = await ownerLinkResolver.resolve({
      subject: claims.sub,
      sessionId: claims.session_id,
      ownerKey: owner.ownerKey,
    });
  } catch {
    fail('identity_verification_unavailable', 503);
  }

  const decision = evaluateOwnerLinkState({
    snapshot,
    principal: {
      session_id: claims.session_id,
      link_id: claims.link_id,
      link_revision: claims.link_revision,
      owner_binding: claims.owner_binding ?? claims.owner_key,
      expires_at: new Date(claims.exp * 1000).toISOString(),
    },
    now: new Date(nowSeconds * 1000).toISOString(),
  });
  if (decision === 'allow') return;

  const policy = ownerLinkHttpPolicy(decision);
  if (!policy) fail('identity_verification_unavailable', 503);
  fail(policy.code, policy.httpStatus);
}

function rejectClientOwnerFields(input) {
  const forbidden = [
    'owner_key', 'target_owner_key', 'owner_id', 'device_id', 'corering_device_id',
  ];
  if (!isPlainObject(input)) return;
  if (forbidden.some((key) => Object.prototype.hasOwnProperty.call(input, key))) {
    fail('owner_fields_not_accepted', 400);
  }
}

function safeErrorBody(error, traceId = cryptoTraceId()) {
  const code = error instanceof VerificationError ? error.code : 'identity_verification_unavailable';
  const status = error instanceof VerificationError ? error.status : 503;
  return {
    status,
    body: { error: code, _error: code, traceId },
  };
}

function cryptoTraceId() {
  // Opaque per-request identifier. Replace with the service tracing utility in integration.
  return `p4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Verifies a CoreRing P4 assertion and returns a server-side principal.
 *
 * Required interfaces:
 *   keyRegistry.getPublicKey(kid) -> KeyObject | PEM | DER
 *   replayLedger.consume({ issuer, jti, expiresAt }) -> Promise<boolean>
 *   ownerResolver.resolve({ subject, sessionId, ownerKey })
 *     -> { kind: 'single', ownerKey } | { kind: 'unresolved'|'conflict'|'mismatch'|'unavailable' }
 */
export async function verifyCoreRingAssertion({
  headers,
  body,
  keyRegistry,
  replayLedger,
  ownerResolver,
  ownerLinkResolver,
  nowSeconds = Math.floor(Date.now() / 1000),
  config = {},
}) {
  const effective = { ...DEFAULTS, ...config };
  rejectClientOwnerFields(body);
  const token = parseAuthorization(headers);
  const { header, claims } = verifyJws(token, keyRegistry, effective);
  validateClaims(claims, effective);
  validateTime(claims, nowSeconds, effective);
  const owner = await resolveOwner(ownerResolver, claims);
  await enforceOwnerLinkState(ownerLinkResolver, claims, owner, nowSeconds);

  let consumed;
  try {
    consumed = await replayLedger.consume({
      issuer: claims.iss,
      jti: claims.jti,
      expiresAt: claims.exp,
    });
  } catch {
    fail('identity_verification_unavailable', 503);
  }
  if (consumed !== true) fail('token_replayed');

  return Object.freeze({
    scheme: 'corering-p4-assertion',
    issuer: claims.iss,
    keyId: header.kid,
    subject: claims.sub,
    sessionId: claims.session_id,
    ownerKey: owner.ownerKey,
    purpose: claims.purpose,
    assertionId: claims.jti,
    expiresAt: claims.exp,
  });
}

/**
 * Route helper: converts verifier failures into the existing error/_error contract.
 * Never returns token, cookie, provider_sub, or owner candidate details.
 */
export async function authenticateCoreRingRequest(options) {
  try {
    const principal = await verifyCoreRingAssertion(options);
    return { ok: true, principal };
  } catch (error) {
    return { ok: false, ...safeErrorBody(error, options.traceId) };
  }
}

export { DEFAULTS, rejectClientOwnerFields, safeErrorBody };
