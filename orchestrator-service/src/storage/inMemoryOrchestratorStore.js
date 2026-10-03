import crypto from 'crypto';

/**
 * ============================================================================
 * INTERVIEW RECALL: In-Memory Orchestrator Storage (inMemoryOrchestratorStore.js)
 * ============================================================================
 * 
 * ITERATION 1: Baseline Prototype
 * 
 * Architectural Purpose:
 * - Manages Bank Credential Mappings (asymmetric public key binding) and 
 *   Letter of Credit (LC) multi-stage workflow instances without any external DB.
 * - Enforces zero private key storage (non-custodial cryptographic boundary).
 * - Manages an in-memory queue of pending completed workflow receipts to be
 *   piggybacked onto outbound Auth Service token inspection calls.
 */

/**
 * @typedef {'HSBC' | 'SBI'} SupportedBankId
 */

/**
 * @typedef {Object} BankCredentialRecord
 * @property {string} clientId
 * @property {SupportedBankId} bankId
 * @property {string} clientPublicKey - PEM format (Corporate Public Key)
 * @property {string} bankPublicKey - PEM format (Bank Public Key)
 * @property {'AWS_KMS' | 'AZURE_VAULT' | 'REMOTE_API'} cryptoMode
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} WorkflowStageHistory
 * @property {string} stage
 * @property {string} timestamp
 * @property {string} trigger
 * @property {Object} [metadata]
 */

/**
 * @typedef {Object} WorkflowInstanceRecord
 * @property {string} workflowId - Primary key (e.g. 'LC-1727889600000-a1b2c3')
 * @property {string} clientId - Foreign reference to client
 * @property {SupportedBankId} bankId
 * @property {'ISSUANCE' | 'AMENDMENT' | 'PRESENTATION'} type
 * @property {string} currentStage
 * @property {Object} genericContract - Canonical LC schema
 * @property {Array<WorkflowStageHistory>} history
 */

/**
 * @typedef {Object} BillingReceipt
 * @property {string} workflow_id
 * @property {string} terminal_state_achieved
 * @property {string} cryptographic_signature
 * @property {string} timestamp
 */

export class InMemoryOrchestratorStore {
  constructor() {
    /** @type {Map<string, BankCredentialRecord>} Key: `${clientId}:${bankId}` */
    this.bankCredentials = new Map();

    /** @type {Map<string, WorkflowInstanceRecord>} Key: `workflowId` */
    this.workflows = new Map();

    /** @type {Array<BillingReceipt>} Queue of completed receipts to piggyback to Auth Service */
    this.pendingReceiptsQueue = [];

    // Pre-seed sample credentials & baseline LC for interview walkthrough
    this._seedInitialData();
  }

  /**
   * Pre-seed baseline data for 'tata_steel' with HSBC and SBI
   * @private
   */
  _seedInitialData() {
    // 1. Pre-seed HSBC Credentials for tata_steel
    this.saveBankCredentials({
      clientId: 'tata_steel',
      bankId: 'HSBC',
      clientPublicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0...\n-----END PUBLIC KEY-----',
      bankPublicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1...\n-----END PUBLIC KEY-----',
      cryptoMode: 'AWS_KMS',
    });

    // 2. Pre-seed SBI Credentials for tata_steel
    this.saveBankCredentials({
      clientId: 'tata_steel',
      bankId: 'SBI',
      clientPublicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0...\n-----END PUBLIC KEY-----',
      bankPublicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2...\n-----END PUBLIC KEY-----',
      cryptoMode: 'AZURE_VAULT',
    });

    // 3. Pre-seed Baseline Active LC for immediate testing
    const sampleWorkflowId = 'LC-SAMPLE-001';
    this.saveWorkflow({
      workflowId: sampleWorkflowId,
      clientId: 'tata_steel',
      bankId: 'HSBC',
      type: 'ISSUANCE',
      currentStage: 'LC_INITIATED',
      genericContract: {
        lcNumber: 'LC/HSBC/2026/001',
        amount: 5000000,
        currency: 'USD',
        applicant: 'Tata Steel Limited',
        beneficiary: 'Global Iron Ore Supplier Ltd',
        expiryDate: '2026-12-31',
      },
      history: [
        {
          stage: 'LC_INITIATED',
          timestamp: new Date().toISOString(),
          trigger: 'SEED_INITIALIZER',
          metadata: { note: 'Pre-seeded sample for interview testing' },
        },
      ],
    });

    // 4. Pre-seed one completed receipt to demonstrate the first piggybacked billing hop
    this.enqueueBillingReceipt({
      workflow_id: 'LC-PREV-COMPLETED-999',
      terminal_state_achieved: 'COMPLETED',
      cryptographic_signature: 'sig_rsa_sha256_mock_7788',
      timestamp: new Date().toISOString(),
    });
  }

  // ==========================================================================
  // BANK CREDENTIALS OPERATIONS
  // ==========================================================================

  /**
   * Save or update bank credential mapping
   * Security guard: Strictly forbids any private key fields.
   * @param {BankCredentialRecord} record
   * @returns {BankCredentialRecord}
   */
  saveBankCredentials(record) {
    // Non-custodial check: never store private keys
    if (record.privateKey || record.secretKey || record.clientPrivateKey) {
      throw new Error('SECURITY VIOLATION: Private keys must never be stored in the orchestrator.');
    }

    const key = `${record.clientId}:${record.bankId}`;
    const credential = {
      ...record,
      updatedAt: new Date().toISOString(),
    };

    this.bankCredentials.set(key, credential);
    return { ...credential };
  }

  /**
   * Retrieve bank credentials by client and bank
   * @param {string} clientId
   * @param {SupportedBankId} bankId
   * @returns {BankCredentialRecord | undefined}
   */
  getBankCredentials(clientId, bankId) {
    return this.bankCredentials.get(`${clientId}:${bankId}`);
  }

  // ==========================================================================
  // WORKFLOW INSTANCE OPERATIONS
  // ==========================================================================

  /**
   * Save or update workflow instance
   * @param {WorkflowInstanceRecord} workflowRecord
   * @returns {WorkflowInstanceRecord}
   */
  saveWorkflow(workflowRecord) {
    this.workflows.set(workflowRecord.workflowId, { ...workflowRecord });
    return this.workflows.get(workflowRecord.workflowId);
  }

  /**
   * Retrieve workflow instance by ID
   * @param {string} workflowId
   * @returns {WorkflowInstanceRecord | undefined}
   */
  getWorkflow(workflowId) {
    return this.workflows.get(workflowId);
  }

  // ==========================================================================
  // PIGGYBACKED BILLING QUEUE OPERATIONS
  // ==========================================================================

  /**
   * Enqueue a completed workflow receipt to be piggybacked on the next auth hop
   * @param {BillingReceipt} receipt
   */
  enqueueBillingReceipt(receipt) {
    this.pendingReceiptsQueue.push({ ...receipt });
  }

  /**
   * Dequeue the next pending receipt to piggyback onto auth validation
   * @returns {BillingReceipt | null}
   */
  dequeueNextBillingReceipt() {
    return this.pendingReceiptsQueue.shift() || null;
  }

  /**
   * Peek next pending receipt without removing
   * @returns {BillingReceipt | null}
   */
  peekNextBillingReceipt() {
    return this.pendingReceiptsQueue[0] || null;
  }

  /**
   * Removes an acknowledged receipt from the pending queue
   * @param {string} workflowId
   */
  acknowledgeReceipt(workflowId) {
    this.pendingReceiptsQueue = this.pendingReceiptsQueue.filter(
      (r) => r.workflow_id !== workflowId
    );
  }

  /**
   * Drains all pending receipts from the queue (used by background idle flusher)
   * @returns {Array<BillingReceipt>}
   */
  drainPendingReceipts() {
    const receipts = [...this.pendingReceiptsQueue];
    this.pendingReceiptsQueue = [];
    return receipts;
  }

  /**
   * Get queue length
   * @returns {number}
   */
  getPendingReceiptsCount() {
    return this.pendingReceiptsQueue.length;
  }
}

export const orchestratorStore = new InMemoryOrchestratorStore();

