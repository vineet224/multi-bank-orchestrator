/**
 * ============================================================================
 * INTERVIEW RECALL REFERENCE: In-Memory Storage Interface (inMemoryAuthStore.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * - Replaces an external database (Redis / PostgreSQL / DynamoDB) with native JS Maps.
 * - Simulates 3 collections:
 *    1. clients       -> Enterprise corporate tenants & their subscription limits
 *    2. opaqueTokens  -> High-entropy opaque bearer tokens with TTL (RFC 6749 / RFC 7662)
 *    3. billingLedger -> Piggybacked execution receipts from the orchestrator
 * 
 * Time Complexities:
 * - O(1) Token Lookup, Client Lookup, and Billing Append
 */

/**
 * @typedef {Object} ClientRecord
 * @property {string} clientId - Primary Key (e.g., 'tata_steel')
 * @property {string} clientSecret - Verification secret
 * @property {Object} subscription
 * @property {'ACTIVE' | 'SUSPENDED' | 'EXPIRED'} subscription.status
 * @property {'ACTIVE_CAPACITY_LICENSING'} subscription.billingModel
 * @property {number} subscription.maxConcurrentWorkflows
 * @property {number} subscription.activeWorkflows
 */

/**
 * @typedef {Object} TokenRecord
 * @property {string} token - 'xlt_opq_' + 48-char hex
 * @property {string} clientId - Foreign Key to clients Map
 * @property {string} issuedAt - ISO 8601 Timestamp
 * @property {number} expiresAt - Epoch Milliseconds (TTL: 3600s)
 * @property {'ACTIVE' | 'REVOKED'} status
 */

/**
 * @typedef {Object} BillingReceipt
 * @property {string} workflow_id
 * @property {string} terminal_state_achieved
 * @property {string} cryptographic_signature
 * @property {string} timestamp
 * @property {string} ledgeredAt
 */

export class InMemoryAuthStore {
  constructor() {
    /** @type {Map<string, ClientRecord>} */
    this.clients = new Map();

    /** @type {Map<string, TokenRecord>} */
    this.opaqueTokens = new Map();

    /** @type {Map<string, BillingReceipt>} */
    this.billingLedger = new Map();

    // Pre-seed sample enterprise client for interview walkthrough
    this._seedInitialData();
  }

  /**
   * Pre-seeds baseline client for immediate interview demonstration
   * @private
   */
  _seedInitialData() {
    this.saveClient({
      clientId: 'tata_steel',
      clientSecret: 'secret_steel_99',
      subscription: {
        status: 'ACTIVE',
        billingModel: 'ACTIVE_CAPACITY_LICENSING',
        maxConcurrentWorkflows: 100,
        activeWorkflows: 42,
      },
    });
  }

  /**
   * Find client by primary key
   * @param {string} clientId
   * @returns {ClientRecord | undefined}
   */
  findClient(clientId) {
    return this.clients.get(clientId);
  }

  /**
   * Upsert a client record
   * @param {ClientRecord} clientRecord
   * @returns {ClientRecord}
   */
  saveClient(clientRecord) {
    this.clients.set(clientRecord.clientId, { ...clientRecord });
    return this.clients.get(clientRecord.clientId);
  }

  /**
   * Store a newly issued active opaque token
   * @param {string} token - 'xlt_opq_...'
   * @param {{ clientId: string, ttlSeconds?: number }} metadata
   * @returns {TokenRecord}
   */
  storeToken(token, { clientId, ttlSeconds = 3600 }) {
    const now = Date.now();
    /** @type {TokenRecord} */
    const record = {
      token,
      clientId,
      issuedAt: new Date(now).toISOString(),
      expiresAt: now + ttlSeconds * 1000,
      status: 'ACTIVE',
    };

    this.opaqueTokens.set(token, record);
    return record;
  }

  /**
   * Retrieve and validate token presence and TTL
   * @param {string} token
   * @returns {{ tokenRecord?: TokenRecord, isExpired: boolean, exists: boolean }}
   */
  getToken(token) {
    const record = this.opaqueTokens.get(token);
    if (!record) {
      return { exists: false, isExpired: false, tokenRecord: undefined };
    }

    const isExpired = Date.now() > record.expiresAt;
    return {
      exists: true,
      isExpired,
      tokenRecord: record,
    };
  }

  /**
   * Revoke an active token (Kill switch)
   * @param {string} token
   * @returns {boolean} true if revoked, false if token not found
   */
  revokeToken(token) {
    const record = this.opaqueTokens.get(token);
    if (!record) return false;

    record.status = 'REVOKED';
    return true;
  }

  /**
   * Validates and atomically appends a piggybacked billing receipt to the ledger
   * @param {BillingReceipt} receipt
   * @returns {BillingReceipt}
   */
  recordBilling(receipt) {
    if (!receipt || !receipt.workflow_id) {
      throw new Error('Invalid billing receipt: workflow_id is required');
    }

    const ledgeredReceipt = {
      ...receipt,
      ledgeredAt: new Date().toISOString(),
    };

    this.billingLedger.set(receipt.workflow_id, ledgeredReceipt);
    return ledgeredReceipt;
  }
}

// Singleton storage export for interview reference
export const authStore = new InMemoryAuthStore();
