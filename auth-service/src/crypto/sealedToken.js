import crypto from 'crypto';

/**
 * ============================================================================
 * INTERVIEW RECALL: Sealed AEAD Opaque Token (crypto/sealedToken.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * - Solves the "SaaS Multi-Replica vs On-Prem Local Verification" problem.
 * - To the outside world (browser, proxies, CDN, XSS attackers), the token is
 *   completely opaque: 'xlt_opq_' + high-entropy Base64URL string (zero claim leakage).
 * - Under the hood, it is an Authenticated Encryption with Associated Data (AEAD)
 *   envelope (AES-256-GCM) sealed with a cluster-shared 256-bit key.
 * - Any service holding the key can verify expiration and extract clientId locally
 *   in < 0.05ms without network roundtrips or centralized distributed caches (Redis).
 */

const RAW_KEY = process.env.TOKEN_ENCRYPTION_KEY || 'xalts_master_token_secret_key_2026_iteration_3_production_key';
// Ensure exactly 32 bytes key via SHA-256 digest
const ENCRYPTION_KEY = crypto.createHash('sha256').update(RAW_KEY).digest();
const TOKEN_PREFIX = 'xlt_opq_';

/**
 * Seals client claims into an opaque AEAD token string
 * @param {Object} params
 * @param {string} params.clientId - Enterprise Tenant ID
 * @param {string} [params.userId='service_operator']
 * @param {number} [params.ttlSeconds=3600]
 * @returns {string} Sealed opaque token
 */
export const sealToken = ({ clientId, userId = 'service_operator', ttlSeconds = 3600 }) => {
  const now = Date.now();
  const expiresAt = now + ttlSeconds * 1000;

  const payload = JSON.stringify({
    clientId,
    userId,
    iat: now,
    exp: expiresAt,
    entropy: crypto.randomBytes(8).toString('hex'), // Extra randomness
  });

  const iv = crypto.randomBytes(12); // Standard 96-bit IV for AES-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);

  let ciphertext = cipher.update(payload, 'utf8', 'base64url');
  ciphertext += cipher.final('base64url');
  const authTag = cipher.getAuthTag().toString('base64url');

  const envelope = `${iv.toString('base64url')}.${ciphertext}.${authTag}`;
  return `${TOKEN_PREFIX}${envelope}`;
};

/**
 * Unseals and cryptographically verifies an opaque AEAD token string locally
 * @param {string} tokenString
 * @returns {{ valid: boolean, clientId?: string, userId?: string, expiresAt?: number, error?: string }}
 */
export const unsealToken = (tokenString) => {
  if (!tokenString || typeof tokenString !== 'string' || !tokenString.startsWith(TOKEN_PREFIX)) {
    return { valid: false, error: 'INVALID_PREFIX' };
  }

  const envelope = tokenString.slice(TOKEN_PREFIX.length);
  const parts = envelope.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'MALFORMED_ENVELOPE' };
  }

  const [ivB64, ciphertextB64, authTagB64] = parts;

  try {
    const iv = Buffer.from(ivB64, 'base64url');
    const authTag = Buffer.from(authTagB64, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertextB64, 'base64url', 'utf8');
    decrypted += decipher.final('utf8');

    const payload = JSON.parse(decrypted);
    const now = Date.now();

    if (payload.exp && payload.exp < now) {
      return {
        valid: false,
        error: 'EXPIRED',
        clientId: payload.clientId,
        expiresAt: payload.exp,
      };
    }

    return {
      valid: true,
      clientId: payload.clientId,
      userId: payload.userId,
      expiresAt: payload.exp,
      issuedAt: payload.iat,
    };
  } catch (err) {
    return { valid: false, error: 'CIPHER_TAMPERED' };
  }
};
