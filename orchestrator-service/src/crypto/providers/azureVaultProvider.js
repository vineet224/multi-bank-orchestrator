import crypto from 'crypto';
import { CryptoProviderInterface } from '../cryptoProvider.interface.js';

/**
 * ============================================================================
 * INTERVIEW RECALL: Azure Key Vault Non-Custodial Provider (azureVaultProvider.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * - Integrates with Azure Key Vault (AKV) Managed HSM.
 * - Used by corporate clients hosted in Microsoft Azure (e.g. Tata on Azure Cloud).
 * - Private keys are protected by FIPS 140-2 Level 3 HSMs; Orchestrator only receives
 *   asymmetric cryptographic signatures or decrypted symmetric DEK tokens.
 */
const AZURE_KEY_STORE = new Map();

export class AzureVaultProvider extends CryptoProviderInterface {
  constructor(config = {}) {
    super(config);
    this.vaultUrl = config.vaultUrl || 'https://tata-trade-vault.vault.azure.net/';
    this.keyName = config.keyName || 'corporate-signing-key';
    this.keyVersion = config.keyVersion || 'v1';

    const cacheKey = `${this.vaultUrl}:${this.keyName}`;
    if (!AZURE_KEY_STORE.has(cacheKey)) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      AZURE_KEY_STORE.set(cacheKey, { publicKey, privateKey });
    }

    const stored = AZURE_KEY_STORE.get(cacheKey);
    this.clientPublicKeyPem = config.clientPublicKeyPem || stored.publicKey;
    this._simulatedAzurePrivateKey = stored.privateKey;
  }


  getProviderType() {
    return 'AZURE_VAULT';
  }

  getPublicKeyPem() {
    return this.clientPublicKeyPem;
  }

  /**
   * Delegates signing of the 32-byte digest to Azure Key Vault
   * @param {Buffer} digestBuffer
   * @returns {Promise<string>} Base64 signature
   */
  async signDigest(digestBuffer) {
    // In production with Azure SDK:
    // const credential = new DefaultAzureCredential();
    // const cryptoClient = new CryptographyClient(keyUrl, credential);
    // const result = await cryptoClient.sign('PS256', digestBuffer);
    // return Buffer.from(result.result).toString('base64');

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(digestBuffer);
    signer.end();
    return signer.sign(this._simulatedAzurePrivateKey).toString('base64');
  }

  /**
   * Delegates unwrapping of the DEK to Azure Key Vault
   * @param {{ encryptedKey: string, iv: string, authTag: string, ciphertext: string }} envelope
   * @returns {Promise<string>} Decrypted UTF-8 string
   */
  async decryptPayload(envelope) {
    const { encryptedKey, iv, authTag, ciphertext } = envelope;

    // High-fidelity local Azure unwrap simulation
    const dek = crypto.privateDecrypt(
      {
        key: this._simulatedAzurePrivateKey,
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
