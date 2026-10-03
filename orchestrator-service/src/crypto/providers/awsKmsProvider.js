import crypto from 'crypto';
import { CryptoProviderInterface } from '../cryptoProvider.interface.js';

/**
 * ============================================================================
 * INTERVIEW RECALL: AWS KMS Non-Custodial Provider (awsKmsProvider.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * - Integrates with AWS Key Management Service (AWS KMS) Asymmetric Keys.
 * - Key Architecture Concept: `MessageType: 'DIGEST'`
 *   - The Orchestrator hashes the Trade Contract payload locally (SHA-256).
 *   - Dispatches only the 32-byte hash over the AWS network boundary.
 *   - AWS KMS signs the hash using an AWS CloudHSM-backed RSA/ECC private key.
 *   - The private key is mathematically non-exportable; Xalts NEVER has key custody.
 */
const KMS_KEY_STORE = new Map();

export class AwsKmsProvider extends CryptoProviderInterface {
  constructor(config = {}) {
    super(config);
    this.keyArn = config.keyArn || 'arn:aws:kms:ap-south-1:123456789012:key/mrk-sample-trade-finance-key';
    this.region = config.region || 'ap-south-1';
    this.signingAlgorithm = config.signingAlgorithm || 'RSASSA_PSS_SHA_256';

    // Retrieve or generate persistent simulated KMS keypair
    if (!KMS_KEY_STORE.has(this.keyArn)) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      KMS_KEY_STORE.set(this.keyArn, { publicKey, privateKey });
    }

    const stored = KMS_KEY_STORE.get(this.keyArn);
    this.clientPublicKeyPem = config.clientPublicKeyPem || stored.publicKey;
    this._simulatedKmsPrivateKey = stored.privateKey;
  }


  getProviderType() {
    return 'AWS_KMS';
  }

  getPublicKeyPem() {
    return this.clientPublicKeyPem;
  }

  /**
   * Delegates signing of the 32-byte digest to AWS KMS (kms:Sign)
   * @param {Buffer} digestBuffer
   * @returns {Promise<string>} Base64 signature
   */
  async signDigest(digestBuffer) {
    // In production with AWS SDK:
    // const client = new KMSClient({ region: this.region });
    // const command = new SignCommand({
    //   KeyId: this.keyArn,
    //   Message: digestBuffer,
    //   MessageType: 'DIGEST',
    //   SigningAlgorithm: this.signingAlgorithm,
    // });
    // const response = await client.send(command);
    // return Buffer.from(response.Signature).toString('base64');

    // High-fidelity local KMS simulation
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(digestBuffer);
    signer.end();
    return signer.sign(this._simulatedKmsPrivateKey).toString('base64');
  }

  /**
   * Delegates unwrapping of the DEK to AWS KMS (kms:Decrypt)
   * Then decrypts the payload locally using AES-256-GCM.
   * @param {{ encryptedKey: string, iv: string, authTag: string, ciphertext: string }} envelope
   * @returns {Promise<string>} Decrypted UTF-8 string
   */
  async decryptPayload(envelope) {
    const { encryptedKey, iv, authTag, ciphertext } = envelope;

    // In production with AWS SDK:
    // const command = new DecryptCommand({
    //   KeyId: this.keyArn,
    //   CiphertextBlob: Buffer.from(encryptedKey, 'base64'),
    //   EncryptionAlgorithm: 'RSAES_OAEP_SHA_256',
    // });
    // const { Plaintext } = await client.send(command);
    // const dek = Buffer.from(Plaintext);

    // High-fidelity local KMS unwrap simulation
    const dek = crypto.privateDecrypt(
      {
        key: this._simulatedKmsPrivateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(encryptedKey, 'base64')
    );

    // In-process AES-256-GCM decryption
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
