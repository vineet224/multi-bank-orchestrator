import crypto from 'crypto';

/**
 * ============================================================================
 * INTERVIEW RECALL: HSBC Bank Adapter & Simulator (hsbcAdapter.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * - Adapts canonical Letter of Credit schemas into HSBC ISO 20022 banking formats.
 * - Simulates the remote HSBC Trade Finance gateway with a real RSA-2048 keypair.
 * - Real-World Banking Identifier Realism:
 *   Neither the client nor the orchestrator generates the lcNumber!
 *   The client sends an ERP corporateReference (SWIFT Field 20: Sender's Reference).
 *   HSBC generates the authoritative lcNumber (SWIFT Field 27) upon issuance,
 *   amendmentNumber upon amendment, and presentationNumber upon presentation.
 */
export class HsbcBankAdapter {
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
      operationType: canonicalContract.operationType || 'ISSUANCE',
      document: {
        letterOfCreditDetails: {
          corporateReference: canonicalContract.corporateReference, // SWIFT Field 20
          lcNumber: canonicalContract.lcNumber || null,             // SWIFT Field 27 (Bank generated on issuance)
          amount: canonicalContract.amount,
          currency: canonicalContract.currency || 'USD',
          applicantName: canonicalContract.applicant,
          beneficiaryName: canonicalContract.beneficiary,
          expiryDate: canonicalContract.expiryDate,
          version: canonicalContract.version || 1,
          amendmentDetails: canonicalContract.amendmentDetails || null,
          documentManifest: canonicalContract.documentManifest || null,
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
   * @returns {Promise<{ encryptedResponse: Object, bankSignature: string, bankReference: string, bankResponse: Object }>}
   */
  async processBankRequest({ encryptedPayload, clientSignature, clientPublicKeyPem, idempotencyKey }) {
    const isDuplicate = this.processedIdempotencyKeys.has(idempotencyKey);
    this.processedIdempotencyKeys.add(idempotencyKey);

    // 1. Decrypt envelope using HSBC's private key (RSA-OAEP + AES-256-GCM)
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

    // 2. Verify Client Signature using Client's Public Key
    const payloadHash = crypto.createHash('sha256').update(decryptedRaw).digest();
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(payloadHash);
    const isValidSignature = verifier.verify(clientPublicKeyPem, Buffer.from(clientSignature, 'base64'));

    if (!isValidSignature) {
      throw new Error('HSBC Security Rejection: Client cryptographic signature verification failed');
    }

    const lcDetails = receivedPayload.document?.letterOfCreditDetails || {};
    const operationType = receivedPayload.operationType || 'ISSUANCE';

    // 3. Bank-Assigned Banking Identifiers
    const bankReference = `HSBC-TXN-${Date.now()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    let lcNumber = lcDetails.lcNumber;
    let amendmentNumber = null;
    let presentationNumber = null;

    if (operationType === 'ISSUANCE' || !lcNumber) {
      // In real-world banking: Bank assigns the official LC number
      lcNumber = `HSBC-LC-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    } else if (operationType === 'AMENDMENT') {
      amendmentNumber = `HSBC-AMD-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    } else if (operationType === 'PRESENTATION') {
      presentationNumber = `HSBC-PRES-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    }

    // 4. Construct Bank Response Payload
    const bankResponsePayload = {
      bank: 'HSBC',
      status: 'CONFIRMED_BY_HSBC',
      bankReference,
      corporateReference: lcDetails.corporateReference,
      lcNumber,
      amendmentNumber,
      presentationNumber,
      operationType,
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
      lcNumber,
      amendmentNumber,
      presentationNumber,
      bankResponse: bankResponsePayload,
    };
  }
}

export const hsbcAdapter = new HsbcBankAdapter();
