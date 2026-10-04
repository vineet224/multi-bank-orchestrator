import crypto from 'crypto';
import { hsbcAdapter } from './bankAdapters/hsbcAdapter.js';
import { sbiAdapter } from './bankAdapters/sbiAdapter.js';

/**
 * ============================================================================
 * INTERVIEW RECALL: Bank Connector Service (bankConnector.service.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * - Coordinates the complete end-to-end cryptographic and banking pipeline:
 *   1. Deterministic Idempotency Key: Uses corporateReference for issuance,
 *      or bank lcNumber for amendment/presentation.
 *   2. Digest calculation (`SHA-256`) and non-custodial delegated signing (`signDigest`).
 *   3. In-process hybrid envelope encryption for target bank (`encryptForBank`).
 *   4. Dispatch to bank adapter (`HSBC` or `SBI`).
 *   5. In-process verification of bank signature (`verifyBankSignature`).
 *   6. Delegated decryption of bank response (`decryptPayload`).
 *   7. Returns bank-assigned official lcNumber / amendmentNumber / presentationNumber.
 */
export class BankConnectorService {
  constructor() {
    this.adapters = {
      HSBC: hsbcAdapter,
      SBI: sbiAdapter,
    };
  }

  /**
   * Resolves the bank adapter for the requested bank
   * @param {string} bankId
   * @returns {import('./bankAdapters/hsbcAdapter.js').HsbcBankAdapter}
   */
  getAdapter(bankId) {
    const adapter = this.adapters[bankId?.toUpperCase()];
    if (!adapter) {
      throw new Error(`Unsupported bank adapter for bankId: '${bankId}'`);
    }
    return adapter;
  }

  /**
   * Generates a deterministic idempotency key for financial safety
   * @param {string} clientId
   * @param {string} referenceKey - corporateReference or lcNumber
   * @param {number|string} [version=1]
   * @returns {string}
   */
  generateIdempotencyKey(clientId, referenceKey, version = 1) {
    return crypto
      .createHash('sha256')
      .update(`${clientId}:${referenceKey}:${version}`)
      .digest('hex');
  }

  /**
   * Dispatches a canonical LC operation to the bank through the secure cryptographic pipeline
   * @param {Object} params
   * @param {string} params.bankId - 'HSBC' | 'SBI'
   * @param {string} params.clientId - e.g. 'tata_steel'
   * @param {Object} params.genericContract - Canonical LC schema
   * @param {import('../crypto/cryptoProvider.interface.js').CryptoProviderInterface} params.cryptoProvider
   * @returns {Promise<Object>}
   */
  async dispatchToBank({ bankId, clientId, genericContract, cryptoProvider }) {
    const adapter = this.getAdapter(bankId);

    // 1. Generate Deterministic Idempotency Key using corporateReference or lcNumber
    const referenceKey = genericContract.corporateReference || genericContract.lcNumber || 'UNKNOWN_REF';
    const idempotencyKey = this.generateIdempotencyKey(
      clientId,
      referenceKey,
      genericContract.version || 1
    );

    // 2. Format canonical contract to bank-specific schema
    const formattedBankPayload = adapter.formatOutboundContract(genericContract);
    const bankPayloadString = JSON.stringify(formattedBankPayload);

    // 3. Compute 32-byte SHA-256 digest of outbound payload
    const digest = crypto.createHash('sha256').update(bankPayloadString).digest();

    // 4. DELEGATED PRIVATE KEY OP: Sign 32-byte digest via client's KMS / Webhook / Mock
    const clientSignature = await cryptoProvider.signDigest(digest);

    // 5. IN-PROCESS PUBLIC KEY OP: Encrypt payload for bank using Bank's Public Key (Hybrid AES-GCM envelope)
    const encryptedPayload = cryptoProvider.encryptForBank(
      bankPayloadString,
      adapter.getBankPublicKeyPem()
    );

    // 6. Network Dispatch to Bank Gateway (Simulated Remote Gateway)
    const clientPublicKeyPem = cryptoProvider.getPublicKeyPem();
    const bankResult = await adapter.processBankRequest({
      encryptedPayload,
      clientSignature,
      clientPublicKeyPem,
      idempotencyKey,
    });

    const { encryptedResponse, bankSignature, bankReference } = bankResult;

    // 7. IN-PROCESS PUBLIC KEY OP: Decrypt & verify bank response
    const decryptedRawResponse = await cryptoProvider.decryptPayload(encryptedResponse);
    const parsedBankResponse = JSON.parse(decryptedRawResponse);

    // 8. IN-PROCESS PUBLIC KEY OP: Verify Bank Signature using Bank's Public Key
    const isValidBankSig = cryptoProvider.verifyBankSignature(
      decryptedRawResponse,
      bankSignature,
      adapter.getBankPublicKeyPem()
    );

    if (!isValidBankSig) {
      throw new Error(`Bank signature verification failed for response from ${bankId}`);
    }

    return {
      success: true,
      bankId,
      bankReference,
      lcNumber: parsedBankResponse.lcNumber,
      amendmentNumber: parsedBankResponse.amendmentNumber,
      presentationNumber: parsedBankResponse.presentationNumber,
      corporateReference: parsedBankResponse.corporateReference,
      idempotencyKey,
      clientSignature,
      bankSignature,
      bankResponse: parsedBankResponse,
      timestamp: new Date().toISOString(),
    };
  }
}

export const bankConnectorService = new BankConnectorService();
