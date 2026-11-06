import crypto from 'crypto';

/** Important : now these must be saved with security in mind now one should be able to use then to sign any things
 * ============================================================================
 * INTERVIEW RECALL: Base Crypto Provider Interface (cryptoProvider.interface.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * - Implements the Strategy Pattern for non-custodial cryptography.
 * - Enforces the "Asymmetric Operation Partitioning" Staff-level design:
 *   1. PUBLIC KEY OPS (In-Process):
 *      - Encrypt for bank using Bank's public key (via Envelope Encryption AES-256-GCM).
 *      - Verify bank signature using Bank's public key.
 *      - Runs 100% in-process with zero network hops, zero KMS API costs, sub-millisecond latency.
 *   2. PRIVATE KEY OPS (Delegated to Non-Custodial Provider):
 *      - Sign payload digest: Only the 32-byte SHA-256 digest is transmitted to KMS/Webhook.
 *      - Decrypt payload: Only the 32-byte wrapped data key (DEK) is decrypted by KMS/Webhook.
 *      - Zero private key custody in the orchestrator service!
 */

export class CryptoProviderInterface {
  constructor(config = {}) {
    this.config = config;
  }

  /**
   * Return provider identifier (e.g., 'AWS_KMS', 'AZURE_VAULT', 'REMOTE_WEBHOOK', 'LOCAL_MOCK')
   * @returns {string}
   */
  getProviderType() {
    throw new Error('Method getProviderType() must be implemented');
  }

  /**
   * DELEGATED PRIVATE KEY OP: Sign a 32-byte SHA-256 payload digest.
   * Transmits only the 32-byte digest rather than the multi-megabyte trade document!
   * @param {Buffer} digestBuffer - 32-byte SHA-256 hash
   * @returns {Promise<string>} Hex or Base64 encoded signature
   */
  async signDigest(digestBuffer) {
    throw new Error('Method signDigest() must be implemented by provider');
  }

  /**
   * DELEGATED PRIVATE KEY OP: Decrypt encrypted envelope payload using client's private identity.
   * @param {{ encryptedKey: string, iv: string, authTag: string, ciphertext: string }} envelope
   * @returns {Promise<string>} Decrypted UTF-8 string payload
   */
  async decryptPayload(envelope) {
    throw new Error('Method decryptPayload() must be implemented by provider');
  }

  // ==========================================================================
  // IN-PROCESS PUBLIC KEY OPERATIONS (Sub-millisecond, Zero KMS cost)
  // ==========================================================================

  /**
   * IN-PROCESS PUBLIC KEY OP: Encrypts payload for the target bank using Hybrid Envelope Encryption.
   * 1. Generates ephemeral 256-bit AES-GCM data encryption key (DEK).
   * 2. Encrypts arbitrary payload with AES-GCM (high performance, AEAD integrity).
   * 3. Wraps the 32-byte DEK with Bank's RSA Public Key (RSA-OAEP with SHA-256).
   * @param {string | object} payload
   * @param {string} bankPublicKeyPem
   * @returns {{ encryptedKey: string, iv: string, authTag: string, ciphertext: string }}
   */
  encryptForBank(payload, bankPublicKeyPem) {
    const rawData = typeof payload === 'string' ? payload : JSON.stringify(payload);

    // 1. Generate ephemeral AES-256 DEK & 12-byte IV
    const dek = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);

    // 2. Encrypt payload with AES-256-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
    let ciphertext = cipher.update(rawData, 'utf8', 'base64');
    ciphertext += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');

    // 3. Encrypt the 32-byte DEK with Bank's RSA Public Key (RSA-OAEP)
    const encryptedKey = crypto.publicEncrypt(
      {
        key: bankPublicKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      dek
    ).toString('base64');

    return {
      encryptedKey,
      iv: iv.toString('base64'),
      authTag,
      ciphertext,
    };
  }

  /**
   * IN-PROCESS PUBLIC KEY OP: Verifies bank's signature over a response payload.
   * @param {string | Buffer} payload
   * @param {string} signatureBase64
   * @param {string} bankPublicKeyPem
   * @returns {boolean}
   */
  verifyBankSignature(payload, signatureBase64, bankPublicKeyPem) {
    const dataBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
    const verify = crypto.createVerify('RSA-SHA256');
    verify.update(dataBuffer);
    return verify.verify(bankPublicKeyPem, Buffer.from(signatureBase64, 'base64'));
  }
}
