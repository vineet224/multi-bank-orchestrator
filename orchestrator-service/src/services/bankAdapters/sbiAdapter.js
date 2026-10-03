import crypto from 'crypto';

/**
 * ============================================================================
 * INTERVIEW RECALL: State Bank of India (SBI) Adapter & Simulator (sbiAdapter.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * - Adapts canonical Letter of Credit schemas into SBI Trade Finance REST JSON format.
 * - Simulates the remote SBI Trade Finance gateway with a real RSA-2048 keypair.
 * - Demonstrates multi-bank heterogeneous protocol translation.
 */
export class SbiBankAdapter {
  constructor() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    this.bankPublicKeyPem = publicKey;
    this._bankPrivateKeyPem = privateKey;
    this.processedIdempotencyKeys = new Set();
  }

  getBankId() {
    return 'SBI';
  }

  getBankPublicKeyPem() {
    return this.bankPublicKeyPem;
  }

  /**
   * Translates canonical LC contract to SBI Trade Finance JSON format
   * @param {Object} canonicalContract
   * @returns {Object} SBI JSON schema
   */
  formatOutboundContract(canonicalContract) {
    return {
      protocol: 'SBI_TRADE_FINANCE_v2',
      sbiHeader: {
        channel: 'CORPORATE_DIRECT_CONNECT',
        timestamp: new Date().toISOString(),
      },
      lcApplication: {
        refNo: canonicalContract.lcNumber,
        sanctionedAmount: canonicalContract.amount,
        ccy: canonicalContract.currency || 'INR',
        corporateParty: canonicalContract.applicant,
        supplierParty: canonicalContract.beneficiary,
        validityDate: canonicalContract.expiryDate,
      },
    };
  }

  /**
   * Simulates remote SBI bank gateway receiving encrypted/signed payload
   * @param {Object} request
   * @returns {Promise<{ encryptedResponse: Object, bankSignature: string, bankReference: string }>}
   */
  async processBankRequest({ encryptedPayload, clientSignature, clientPublicKeyPem, idempotencyKey }) {
    const isDuplicate = this.processedIdempotencyKeys.has(idempotencyKey);
    this.processedIdempotencyKeys.add(idempotencyKey);

    // 1. Decrypt envelope using SBI private key
    const dek = crypto.privateDecrypt(
      {
        key: this._bankPrivateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(encryptedPayload.encryptedKey, 'base64')
    );

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      dek,
      Buffer.from(encryptedPayload.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(encryptedPayload.authTag, 'base64'));

    let decryptedRaw = decipher.update(encryptedPayload.ciphertext, 'base64', 'utf8');
    decryptedRaw += decipher.final('utf8');
    const receivedPayload = JSON.parse(decryptedRaw);

    // 2. Verify Client Signature
    const payloadHash = crypto.createHash('sha256').update(decryptedRaw).digest();
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(payloadHash);
    const isValidSignature = verifier.verify(clientPublicKeyPem, Buffer.from(clientSignature, 'base64'));

    if (!isValidSignature) {
      throw new Error('SBI Security Rejection: Client cryptographic signature verification failed');
    }

    // 3. Construct SBI Response
    const bankReference = `SBI-TXN-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const bankResponsePayload = {
      bank: 'SBI',
      status: 'CONFIRMED_BY_SBI',
      bankReference,
      lcNumber: receivedPayload.lcApplication?.refNo,
      idempotencyKey,
      isReplay: isDuplicate,
      clearingSystem: 'NEFT_RTGS_CORPORATE',
      timestamp: new Date().toISOString(),
    };

    const responseRaw = JSON.stringify(bankResponsePayload);

    // 4. Sign response using SBI Private Key
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(Buffer.from(responseRaw));
    signer.end();
    const bankSignature = signer.sign(this._bankPrivateKeyPem).toString('base64');

    // 5. Encrypt response for client using Client's Public Key
    const clientDek = crypto.randomBytes(32);
    const clientIv = crypto.randomBytes(12);

    const cipher = crypto.createCipheriv('aes-256-gcm', clientDek, clientIv);
    let ciphertext = cipher.update(responseRaw, 'utf8', 'base64');
    ciphertext += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');

    const encryptedKey = crypto.publicEncrypt(
      {
        key: clientPublicKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      clientDek
    ).toString('base64');

    return {
      encryptedResponse: {
        encryptedKey,
        iv: clientIv.toString('base64'),
        authTag,
        ciphertext,
      },
      bankSignature,
      bankReference,
    };
  }
}

export const sbiAdapter = new SbiBankAdapter();
