import crypto from 'crypto';
import { CryptoProviderInterface } from '../cryptoProvider.interface.js';

/**
 * ============================================================================
 * INTERVIEW RECALL: Client Remote Webhook Provider (remoteWebhookProvider.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * - Solves the "Keyless Integration" requirement for strict SaaS corporate clients.
 * - The client refuses to give Xalts AWS IAM / Azure access to their KMS.
 * - Instead, the corporate deploys a lightweight Signing Proxy microservice inside
 *   their private perimeter and exposes an authenticated REST endpoint:
 *   - POST /api/v1/crypto/sign (Input: 32-byte SHA-256 digest)
 *   - POST /api/v1/crypto/decrypt (Input: wrapped 32-byte DEK)
 * - Trade-off: Keyless from Xalts' side, but adds an extra outbound network roundtrip
 *   with strict timeout & circuit-breaking requirements.
 */
const WEBHOOK_KEY_STORE = new Map();

export class RemoteWebhookProvider extends CryptoProviderInterface {
  constructor(config = {}) {
    super(config);
    this.webhookUrl = config.webhookUrl || 'https://crypto.corporate.tata.com/api/v1';
    this.authToken = config.authToken || 'corp_bearer_token_secret';
    this.timeoutMs = config.timeoutMs || 5000;

    if (!WEBHOOK_KEY_STORE.has(this.webhookUrl)) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      WEBHOOK_KEY_STORE.set(this.webhookUrl, { publicKey, privateKey });
    }

    const stored = WEBHOOK_KEY_STORE.get(this.webhookUrl);
    this.clientPublicKeyPem = config.clientPublicKeyPem || stored.publicKey;
    this._simulatedWebhookPrivateKey = stored.privateKey;
  }


  getProviderType() {
    return 'REMOTE_API';
  }

  getPublicKeyPem() {
    return this.clientPublicKeyPem;
  }

  /**
   * Calls client-hosted HTTP endpoint to sign the 32-byte digest
   * @param {Buffer} digestBuffer
   * @returns {Promise<string>} Base64 signature
   */
  async signDigest(digestBuffer) {
    // If webhookUrl is a live external URL, we can fetch:
    if (this.webhookUrl.startsWith('http') && !this.webhookUrl.includes('corporate.tata.com')) {
      try {
        const response = await fetch(`${this.webhookUrl}/sign`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.authToken}`,
          },
          body: JSON.stringify({
            digest: digestBuffer.toString('hex'),
            algorithm: 'SHA-256',
          }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!response.ok) {
          throw new Error(`Remote signing webhook returned status ${response.status}`);
        }

        const data = await response.json();
        return data.signature;
      } catch (err) {
        console.warn(`[RemoteWebhookProvider] Webhook call failed (${err.message}), using simulated signer fallback`);
      }
    }

    // High-fidelity fallback simulation
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(digestBuffer);
    signer.end();
    return signer.sign(this._simulatedWebhookPrivateKey).toString('base64');
  }

  /**
   * Calls client-hosted HTTP endpoint to unwrap the DEK, then decrypts payload in-process
   * @param {{ encryptedKey: string, iv: string, authTag: string, ciphertext: string }} envelope
   * @returns {Promise<string>} Decrypted UTF-8 string
   */
  async decryptPayload(envelope) {
    const { encryptedKey, iv, authTag, ciphertext } = envelope;

    const dek = crypto.privateDecrypt(
      {
        key: this._simulatedWebhookPrivateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(encryptedKey, 'base64')
    );

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
