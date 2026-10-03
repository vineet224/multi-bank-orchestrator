import crypto from 'crypto';

/**
 * ============================================================================
 * INTERVIEW RECALL: HSBC Bank Adapter & Simulator (hsbcAdapter.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * - Adapts canonical Letter of Credit schemas into HSBC ISO 20022 banking formats.
 * - Simulates the remote HSBC Trade Finance gateway with a real RSA-2048 keypair.
 * - Receives encrypted/signed client requests, verifies corporate identity,
 *   and responds with an encrypted & HSBC-signed confirmation receipt.
 */
export class HsbcBankAdapter {
  constructor() {
    // Generate HSBC Bank RSA-2048 keypair for simulated remote gateway
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
    return 'HSBC';
  }

  getBankPublicKeyPem() {
    return this.bankPublicKeyPem;
  }

  /**
   * Translates canonical LC contract to HSBC ISO 20022 format
   * @param {Object} canonicalContract
   * @returns {Object} HSBC ISO 20022 XML/JSON schema
   */
  formatOutboundContract(canonicalContract) {
    return {
      messageDefinition: 'tsmt.019.001.03',
      hsbcFormatVersion: '2026.1',
      document: {
        letterOfCreditDetails: {
          lcNumber: canonicalContract.lcNumber,
          amount: canonicalContract.amount,
          currency: canonicalContract.currency || 'USD',
          applicantName: canonicalContract.applicant,
          beneficiaryName: canonicalContract.beneficiary,
          expiryDate: canonicalContract.expiryDate,
        },
        routing: {
          swiftBic: 'HSBCINBBXXX',
          clearingSystem: 'SWIFT_FIN',
        },
      },
    };
  }

  /**
   * Simulates remote HSBC bank gateway receiving encrypted/signed payload
   * @param {Object} request
   * @param {Object} request.encryptedPayload - Envelope with encrypted DEK & ciphertext
   * @param {string} request.clientSignature - Base64 RSA-SHA256 signature
   * @param {string} request.clientPublicKeyPem
   * @param {string} request.idempotencyKey
   * @returns {Promise<{ encryptedResponse: Object, bankSignature: string, bankReference: string }>}
   */
  async processBankRequest({ encryptedPayload, clientSignature, clientPublicKeyPem, idempotencyKey }) {
    // 1. Financial Idempotency Check at Bank Gateway
    const isDuplicate = this.processedIdempotencyKeys.has(idempotencyKey);
    this.processedIdempotencyKeys.add(idempotencyKey);

    // 2. Decrypt envelope using HSBC's private key (RSA-OAEP + AES-256-GCM)
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

    // 3. Verify Client Signature using Client's Public Key
    const payloadHash = crypto.createHash('sha256').update(decryptedRaw).digest();
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(payloadHash);
    const isValidSignature = verifier.verify(clientPublicKeyPem, Buffer.from(clientSignature, 'base64'));

    if (!isValidSignature) {
      throw new Error('HSBC Security Rejection: Client cryptographic signature verification failed');
    }

    // 4. Construct Bank Response
    const bankReference = `HSBC-TXN-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const bankResponsePayload = {
      bank: 'HSBC',
      status: 'CONFIRMED_BY_HSBC',
      bankReference,
      lcNumber: receivedPayload.document?.letterOfCreditDetails?.lcNumber,
      idempotencyKey,
      isReplay: isDuplicate,
      settlementNetwork: 'SWIFT_FIN',
      timestamp: new Date().toISOString(),
    };

    const responseRaw = JSON.stringify(bankResponsePayload);

    // 5. Sign response using HSBC's Private Key
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(Buffer.from(responseRaw));
    signer.end();
    const bankSignature = signer.sign(this._bankPrivateKeyPem).toString('base64');

    // 6. Encrypt response for client using Client's Public Key
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

export const hsbcAdapter = new HsbcBankAdapter();
