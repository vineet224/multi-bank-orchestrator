import crypto from 'crypto';

/**
 * ============================================================================
 * INTERVIEW RECALL: In-Memory Orchestrator Storage (inMemoryOrchestratorStore.js)
 * ============================================================================
 * 
 * ITERATION 3: Production-Grade Dual-Perimeter Architecture
 * 
 * Architectural Purpose:
 * 1. Bank Credential Mappings: Asymmetric public keys and KMS configs. Zero private keys.
 * 2. Draft Storage: Multi-step offline/local draft saving for issuance, amendment, and presentation.
 * 3. Workflow Instances: Two-step lifecycle tracking (DRAFT -> INITIATED -> DISPATCHED -> CONFIRMED).
 * 4. Milestone Ledger: Replaces separate queue & background idle flusher!
 *    Terminal state receipts are recorded with syncStatus: 'PENDING' | 'ACKNOWLEDGED'
 *    and batch-synchronized during authoritative Auth hops or via on-demand /sync-billing.
 */

/**
 * @typedef {'HSBC' | 'SBI'} SupportedBankId
 */

/**
 * @typedef {Object} BankCredentialRecord
 * @property {string} clientId
 * @property {SupportedBankId} bankId
 * @property {string} clientPublicKey - PEM format
 * @property {string} bankPublicKey - PEM format
 * @property {'LOCAL_MOCK' | 'AWS_KMS' | 'AZURE_VAULT' | 'REMOTE_API'} cryptoMode
 * @property {Object} [cryptoConfig]
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
 * @typedef {Object} DraftRecord
 * @property {string} draftId - e.g. 'DRAFT-LC-1727889600000-a1b2c3'
 * @property {string} clientId - e.g. 'tata_steel'
 * @property {SupportedBankId} bankId
 * @property {'ISSUANCE' | 'AMENDMENT' | 'PRESENTATION'} type
 * @property {string} corporateReference - ERP trade/PO reference
 * @property {string} [lcNumber] - Assigned once issued by bank (required for amendment/presentation)
 * @property {string} stage - Always 'DRAFT'
 * @property {Object} payload - Canonical contract data, amendment details, or document manifest
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} WorkflowInstanceRecord
 * @property {string} workflowId - Internal workflow ID
 * @property {string} clientId
 * @property {SupportedBankId} bankId
 * @property {'ISSUANCE' | 'AMENDMENT' | 'PRESENTATION'} type
 * @property {string} corporateReference - Client's ERP reference (SWIFT Field 20)
 * @property {string} [lcNumber] - Bank-issued LC number (SWIFT Field 27)
 * @property {string} [amendmentNumber] - Bank-issued amendment number
 * @property {string} [presentationNumber] - Bank-issued presentation number
 * @property {string} currentStage
 * @property {Object} genericContract - Canonical LC schema
 * @property {Array<WorkflowStageHistory>} history
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} MilestoneReceiptRecord
 * @property {string} receiptId
 * @property {string} workflowId
 * @property {string} corporateReference
 * @property {string} terminalState
 * @property {string} cryptographicSignature
 * @property {string} timestamp
 * @property {'PENDING' | 'ACKNOWLEDGED'} syncStatus
 * @property {string} [acknowledgedAt]
 */

export class InMemoryOrchestratorStore {
  constructor() {
    /** @type {Map<string, BankCredentialRecord>} Key: `${clientId}:${bankId}` */
    this.bankCredentials = new Map();

    /** @type {Map<string, DraftRecord>} Key: `draftId` */
    this.drafts = new Map();

    /** @type {Map<string, WorkflowInstanceRecord>} Key: `workflowId` */
    this.workflows = new Map();

    /** @type {Map<string, MilestoneReceiptRecord>} Key: `receiptId` */
    this.milestoneReceipts = new Map();

    /** @type {number} Epoch ms of last successful sync with Auth Service */
    this.lastSyncedAtEpoch = 0;

    // Pre-seed baseline data for Tata Steel with HSBC and SBI
    this._seedInitialData();
  }

  /**
   * Pre-seed baseline data for 'tata_steel'
   * @private
   */
  _seedInitialData() {
    // 1. HSBC Credentials for tata_steel
    this.saveBankCredentials({
      clientId: 'tata_steel',
      bankId: 'HSBC',
      clientPublicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0...\n-----END PUBLIC KEY-----',
      bankPublicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1...\n-----END PUBLIC KEY-----',
      cryptoMode: 'AWS_KMS',
    });

    // 2. SBI Credentials for tata_steel
    this.saveBankCredentials({
      clientId: 'tata_steel',
      bankId: 'SBI',
      clientPublicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0...\n-----END PUBLIC KEY-----',
      bankPublicKey: '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2...\n-----END PUBLIC KEY-----',
      cryptoMode: 'AZURE_VAULT',
    });

    // 3. Pre-seed a baseline active workflow that has been confirmed by Bank
    const sampleWorkflowId = 'LC-SAMPLE-001';
    const sampleLcNumber = 'HSBC-LC-2026-TATA-SAMPLE-01';
    this.saveWorkflow({
      workflowId: sampleWorkflowId,
      clientId: 'tata_steel',
      bankId: 'HSBC',
      type: 'ISSUANCE',
      corporateReference: 'ERP-PO-2026-0001',
      lcNumber: sampleLcNumber,
      currentStage: 'ISSUANCE_CONFIRMED',
      genericContract: {
        corporateReference: 'ERP-PO-2026-0001',
        lcNumber: sampleLcNumber,
        amount: 5000000,
        currency: 'USD',
        applicant: 'Tata Steel Limited',
        beneficiary: 'Global Iron Ore Supplier Ltd',
        expiryDate: '2026-12-31',
        version: 1,
      },
      history: [
        {
          stage: 'LC_INITIATED',
          timestamp: new Date().toISOString(),
          trigger: 'SEED_INITIALIZER',
          metadata: { note: 'Pre-seeded sample for interview testing' },
        },
        {
          stage: 'ISSUANCE_CONFIRMED',
          timestamp: new Date().toISOString(),
          trigger: 'BANK_CONFIRMATION',
          metadata: { lcNumber: sampleLcNumber },
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // 4. Pre-seed one milestone receipt in PENDING state to demonstrate initial batch sync
    this.recordMilestoneReceipt({
      receiptId: 'RCPT-PREV-COMPLETED-999',
      workflow_id: 'LC-PREV-COMPLETED-999',
      corporate_reference: 'ERP-PO-2025-HISTORIC',
      terminal_state_achieved: 'DOCUMENTS_PRESENTED',
      cryptographic_signature: 'sig_rsa_pss_mock_receipt_7788',
      timestamp: new Date().toISOString(),
    });
  }

  // ==========================================================================
  // BANK CREDENTIALS OPERATIONS
  // ==========================================================================

  saveBankCredentials(record) {
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

  getBankCredentials(clientId, bankId) {
    return this.bankCredentials.get(`${clientId}:${bankId}`);
  }

  // ==========================================================================
  // DRAFT OPERATIONS (Local, 0 Network Hops, Degraded Mode Safe)
  // ==========================================================================

  /**
   * Saves or updates a draft record
   * @param {Object} draftData
   * @returns {DraftRecord}
   */
  saveDraft(draftData) {
    const draftId = draftData.draftId || `DRAFT-LC-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const existing = this.drafts.get(draftId);
    const now = new Date().toISOString();

    const record = {
      ...draftData,
      draftId,
      stage: 'DRAFT',
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    this.drafts.set(draftId, record);
    return { ...record };
  }

  /**
   * Retrieves a draft by draftId
   * @param {string} draftId
   * @returns {DraftRecord | undefined}
   */
  getDraft(draftId) {
    return this.drafts.get(draftId);
  }

  /**
   * Deletes a draft (e.g. once promoted to active dispatch)
   * @param {string} draftId
   * @returns {boolean}
   */
  deleteDraft(draftId) {
    return this.drafts.delete(draftId);
  }

  // ==========================================================================
  // WORKFLOW INSTANCE OPERATIONS
  // ==========================================================================

  saveWorkflow(workflowRecord) {
    const now = new Date().toISOString();
    const record = {
      ...workflowRecord,
      createdAt: workflowRecord.createdAt || now,
      updatedAt: now,
    };
    this.workflows.set(record.workflowId, record);
    return { ...record };
  }

  getWorkflow(workflowId) {
    return this.workflows.get(workflowId);
  }

  findWorkflowByCorporateReference(clientId, corporateReference) {
    for (const wf of this.workflows.values()) {
      if (wf.clientId === clientId && wf.corporateReference === corporateReference) {
        return wf;
      }
    }
    return undefined;
  }

  findWorkflowByLcNumber(clientId, lcNumber) {
    for (const wf of this.workflows.values()) {
      if (wf.clientId === clientId && wf.lcNumber === lcNumber) {
        return wf;
      }
    }
    return undefined;
  }

  // ==========================================================================
  // MILESTONE BILLING LEDGER (Replaces queue and flusher worker)
  // ==========================================================================

  /**
   * Records a terminal milestone receipt in the ledger with syncStatus: 'PENDING'
   * @param {Object} receiptParams
   * @returns {MilestoneReceiptRecord}
   */
  recordMilestoneReceipt(receiptParams) {
    const receiptId = receiptParams.receiptId || `RCPT-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const record = {
      receiptId,
      workflow_id: receiptParams.workflow_id || receiptParams.workflowId,
      corporate_reference: receiptParams.corporate_reference || receiptParams.corporateReference,
      terminal_state_achieved: receiptParams.terminal_state_achieved || receiptParams.terminalState || 'DOCUMENTS_PRESENTED',
      cryptographic_signature: receiptParams.cryptographic_signature || receiptParams.cryptographicSignature,
      timestamp: receiptParams.timestamp || new Date().toISOString(),
      syncStatus: 'PENDING',
    };

    this.milestoneReceipts.set(receiptId, record);
    return { ...record };
  }

  /**
   * Retrieves all milestone receipts pending synchronization
   * @returns {Array<MilestoneReceiptRecord>}
   */
  getPendingMilestoneReceipts() {
    const pending = [];
    for (const r of this.milestoneReceipts.values()) {
      if (r.syncStatus === 'PENDING') {
        pending.push({ ...r });
      }
    }
    return pending;
  }

  /**
   * Acknowledges synchronized milestone receipts
   * @param {Array<string>} acknowledgedIds - Workflow IDs or Receipt IDs
   */
  acknowledgeMilestoneReceipts(acknowledgedIds = []) {
    if (!Array.isArray(acknowledgedIds) || acknowledgedIds.length === 0) return;

    const idSet = new Set(acknowledgedIds);
    const now = new Date().toISOString();

    for (const receipt of this.milestoneReceipts.values()) {
      if (idSet.has(receipt.receiptId) || idSet.has(receipt.workflow_id)) {
        receipt.syncStatus = 'ACKNOWLEDGED';
        receipt.acknowledgedAt = now;
      }
    }
    this.lastSyncedAtEpoch = Date.now();
  }

  /**
   * Returns summary counts of milestone receipts
   * @returns {{ total: number, pending: number, acknowledged: number }}
   */
  getMilestoneReceiptsCount() {
    let pending = 0;
    let acknowledged = 0;
    for (const r of this.milestoneReceipts.values()) {
      if (r.syncStatus === 'PENDING') pending++;
      else if (r.syncStatus === 'ACKNOWLEDGED') acknowledged++;
    }
    return {
      total: this.milestoneReceipts.size,
      pending,
      acknowledged,
    };
  }
}

export const orchestratorStore = new InMemoryOrchestratorStore();
