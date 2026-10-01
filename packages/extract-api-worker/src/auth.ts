const DEFAULT_REPLAY_WINDOW_SECONDS = 300;
const HEX_64 = /^[a-f0-9]{64}$/;
const HMAC_KEY_PREFIX = 'OPERATOR_HMAC_KEY_';
const encoder = new TextEncoder();

export type SignatureSecretEnv = Readonly<Record<string, unknown>>;

export interface SignatureVerificationResult {
  readonly keyId: string;
  readonly timestamp: string;
  readonly contentSha256: string;
  readonly rawPathAndQuery: string;
}

export class AuthError extends Error {
  readonly status = 401;
  readonly reason:
    | 'missing_signature_headers'
    | 'stale_timestamp'
    | 'body_hash_mismatch'
    | 'unknown_key_id'
    | 'signature_mismatch';

  constructor(reason: AuthError['reason']) {
    super(reason);
    this.name = 'AuthError';
    this.reason = reason;
  }
}

export async function verifySignedRequest(
  request: Request,
  env: SignatureSecretEnv,
  now: Date = new Date(),
  replayWindowSeconds = DEFAULT_REPLAY_WINDOW_SECONDS,
): Promise<SignatureVerificationResult> {
  const headerValues = readSignatureHeaders(request);
  const bodyHash = await sha256Hex(await request.clone().arrayBuffer());

  if (bodyHash !== headerValues.contentSha256) {
    throw new AuthError('body_hash_mismatch');
  }

  const timestampSeconds = parseTimestamp(headerValues.timestamp);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > replayWindowSeconds) {
    throw new AuthError('stale_timestamp');
  }

  const secret = readHmacSecret(env, headerValues.keyId);
  if (secret === undefined) {
    throw new AuthError('unknown_key_id');
  }

  const rawPathAndQuery = extractRawPathAndQuery(request.url);
  const signingPayload = canonicalizeSignatureInput(
    request.method,
    rawPathAndQuery,
    headerValues.timestamp,
    bodyHash,
  );
  const expectedSignature = await hmacSha256Hex(signingPayload, secret);
  if (!constantTimeEqual(expectedSignature, headerValues.signature)) {
    throw new AuthError('signature_mismatch');
  }

  return {
    keyId: canonicalKeyId(headerValues.keyId),
    timestamp: headerValues.timestamp,
    contentSha256: bodyHash,
    rawPathAndQuery,
  };
}

export function canonicalizeSignatureInput(
  method: string,
  rawPathAndQuery: string,
  timestamp: string,
  bodySha256: string,
): string {
  return [
    method.toUpperCase(),
    rawPathAndQuery,
    timestamp,
    bodySha256.toLowerCase(),
  ].join('\n');
}

export function extractRawPathAndQuery(url: string): string {
  const parsed = new URL(url);
  const pathAndQuery = url.slice(parsed.origin.length);
  return pathAndQuery === '' ? '/' : pathAndQuery;
}

export async function sha256Hex(body: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', body);
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Hex(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(payload),
  );
  return bytesToHex(new Uint8Array(signature));
}

function readSignatureHeaders(request: Request): {
  readonly keyId: string;
  readonly timestamp: string;
  readonly contentSha256: string;
  readonly signature: string;
} {
  const keyIdHeader = request.headers.get('x-wsa-key-id');
  const timestampHeader = request.headers.get('x-wsa-timestamp');
  const contentSha256Header = request.headers.get('x-wsa-content-sha256');
  const signatureHeader = request.headers.get('x-wsa-signature');

  if (
    keyIdHeader === null ||
    timestampHeader === null ||
    contentSha256Header === null ||
    signatureHeader === null
  ) {
    throw new AuthError('missing_signature_headers');
  }

  const keyId = keyIdHeader.trim();
  const timestamp = timestampHeader.trim();
  const contentSha256 = contentSha256Header.trim().toLowerCase();
  const signature = signatureHeader.trim().toLowerCase();

  if (!HEX_64.test(contentSha256) || !HEX_64.test(signature) || keyId === '') {
    throw new AuthError('missing_signature_headers');
  }

  return {
    keyId,
    timestamp,
    contentSha256,
    signature,
  };
}

function parseTimestamp(timestamp: string): number {
  const parsed = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(parsed)) {
    throw new AuthError('stale_timestamp');
  }
  return parsed;
}

function readHmacSecret(
  env: SignatureSecretEnv,
  keyId: string,
): string | undefined {
  const value = env[`${HMAC_KEY_PREFIX}${canonicalKeyId(keyId)}`];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function canonicalKeyId(keyId: string): string {
  return keyId.replace(/[^A-Za-z0-9_]/g, '_');
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }

  return mismatch === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join(
    '',
  );
}
