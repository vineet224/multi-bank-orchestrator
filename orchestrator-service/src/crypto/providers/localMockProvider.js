import crypto from 'crypto';
import { CryptoProviderInterface } from '../cryptoProvider.interface.js';

/**
 * ============================================================================
 * INTERVIEW RECALL: Local Mock Non-Custodial Provider (localMockProvider.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * - Simulates a client-side Hardware Security Module (HSM) or KMS locally.
 * - Generates and isolates a real RSA-2048 keypair in memory.
 * - Allows full cryptographic execution (RSA-OAEP, AES-256-GCM, RSA-SHA256 signing)
 *   during development and interview walkthroughs without requiring real AWS/Azure bills.
 */
export class LocalMockProvider extends CryptoProviderInterface {
  constructor(config = {}) {
    super(config);

    // If pre-generated keys are passed in config, use them; otherwise generate isolated RSA-2048 keypair
    if (config.publicKeyPem && config.privateKeyPem) {
      this.publicKeyPem = config.publicKeyPem;
      this._isolatedPrivateKeyPem = config.privateKeyPem;
    } else {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      this.publicKeyPem = publicKey;
      this._isolatedPrivateKeyPem = privateKey;
    }
  }

  getProviderType() {
    return 'LOCAL_MOCK';
  }

  /**
   * Return client's public key in PEM format
   * @returns {string}
   */
  getPublicKeyPem() {
    return this.publicKeyPem;
  }

  /**
   * Sign a 32-byte SHA-256 digest using simulated client private key
   * @param {Buffer} digestBuffer 
   * @returns {Promise<string>} Base64 signature
   */
  async signDigest(digestBuffer) {
    // In production KMS: kms.sign({ KeyId, Message: digestBuffer, MessageType: 'DIGEST' })
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(digestBuffer);
    signer.end();
    const signature = signer.sign(this._isolatedPrivateKeyPem);
    return signature.toString('base64');
  }

  /**
   * Decrypt incoming bank envelope:
   * 1. Decrypt 32-byte DEK using client's private key (RSA-OAEP)
   * 2. Decrypt ciphertext using AES-256-GCM with unbundled auth tag & IV
   * @param {{ encryptedKey: string, iv: string, authTag: string, ciphertext: string }} envelope 
   * @returns {Promise<string>} Decrypted UTF-8 string
   */
  async decryptPayload(envelope) {
    const { encryptedKey, iv, authTag, ciphertext } = envelope;

    // 1. Unwrap the 32-byte DEK using private key
    const dek = crypto.privateDecrypt(
      {
        key: this._isolatedPrivateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(encryptedKey, 'base64')
    );

    // 2. Decrypt payload using AES-256-GCM
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      dek,
      Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));

    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}
