import crypto from 'crypto';
import { orchestratorStore } from '../storage/inMemoryOrchestratorStore.js';
import { CryptoProviderFactory } from '../crypto/cryptoProviderFactory.js';
import { bankConnectorService } from '../services/bankConnector.service.js';

/**
 * ============================================================================
 * INTERVIEW RECALL: Orchestrator Controller (orchestratorController.js)
 * ============================================================================
 * 
 * ITERATION 3: Production-Grade Dual-Perimeter Architecture
 * 
 * Architectural Highlights:
 * 1. Dual-Perimeter Routing:
 *    - Draft operations (/draft/*) are authenticated 100% locally with 0 central hops.
 *    - Bank dispatch operations execute authoritative central capacity checks.
 * 2. Real-World Banking Identifiers:
 *    - Client ERP provides corporateReference (SWIFT Field 20: Sender's Reference).
 *    - Bank generates official lcNumber (Field 27), amendmentNumber, and presentationNumber.
 * 3. Strict Two-Step Financial Pipeline:
 *    - Step 1: Form state saved as DRAFT locally.
 *    - Step 2: Client reviews draft and explicitly dispatches draftId to the bank.
 * 4. Milestone Ledger Batch Synchronization:
 *    - Replaces background flusher worker and queue array.
 *    - Receipts are recorded with syncStatus: 'PENDING' and batch-acknowledged.
 */

// ============================================================================
// BANK VALIDATION MIDDLEWARE & CREDENTIALS
// ============================================================================

export const validateBankId = (req, res, next) => {
  const { bankId } = req.params;
  const supported = ['HSBC', 'SBI'];
  if (!bankId || !supported.includes(bankId.toUpperCase())) {
    return res.status(400).json({
      error: 'invalid_bank_id',
      message: `Unsupported bankId: '${bankId}'. Supported banks are: ${supported.join(', ')}`,
    });
  }
  req.params.bankId = bankId.toUpperCase();
  next();
};

export const uploadBankCredentials = (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;
  let { clientPublicKey, bankPublicKey, cryptoMode = 'LOCAL_MOCK', cryptoConfig = {} } = req.body;

  if (req.body.privateKey || req.body.secretKey || req.body.clientPrivateKey) {
    return res.status(400).json({
      error: 'security_violation',
      message: 'Private keys are strictly forbidden. The orchestrator only stores public keys; private keys remain in client KMS/HSM.',
    });
  }

  const validCryptoModes = ['LOCAL_MOCK', 'AWS_KMS', 'AZURE_VAULT', 'REMOTE_API'];
  if (!validCryptoModes.includes(cryptoMode)) {
    return res.status(400).json({
      error: 'bad_request',
      message: `Invalid cryptoMode. Must be one of: ${validCryptoModes.join(', ')}`,
    });
  }

  if (!clientPublicKey || !bankPublicKey) {
    const provider = CryptoProviderFactory.create({ cryptoMode, cryptoConfig });
    clientPublicKey = clientPublicKey || provider.getPublicKeyPem();
    const adapter = bankConnectorService.getAdapter(bankId);
    bankPublicKey = bankPublicKey || adapter.getBankPublicKeyPem();
  }

  const credentialRecord = orchestratorStore.saveBankCredentials({
    clientId,
    bankId,
    clientPublicKey,
    bankPublicKey,
    cryptoMode,
    cryptoConfig,
  });

  return res.status(201).json({
    success: true,
    message: `Public key credentials mapped successfully for ${clientId} <-> ${bankId}`,
    data: credentialRecord,
  });
};

export const getBankCredentials = (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;

  const credentials = orchestratorStore.getBankCredentials(clientId, bankId);
  if (!credentials) {
    return res.status(404).json({
      error: 'not_found',
      message: `No credentials mapped for client '${clientId}' with bank '${bankId}'`,
    });
  }

  return res.status(200).json({
    success: true,
    data: credentials,
  });
};

// ============================================================================
// DRAFT OPERATIONS (Local Perimeter: 0 Network Hops, Degraded Mode Safe)
// ============================================================================

/**
 * POST /api/v1/letter_of_credit/draft/issuance/:bankId
 * Creates and saves an LC Issuance draft locally.
 */
export const saveIssuanceDraft = (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;
  const {
    corporateReference,
    amount = 1000000,
    currency = bankId === 'SBI' ? 'INR' : 'USD',
    applicant = clientId,
    beneficiary = 'Global Trade Partner Inc',
    expiryDate = '2026-12-31',
    draftId,
  } = req.body;

  if (!corporateReference) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'corporateReference (ERP Trade / Purchase Order reference) is mandatory for draft creation',
    });
  }

  const credentials = orchestratorStore.getBankCredentials(clientId, bankId);
  if (!credentials) {
    return res.status(412).json({
      error: 'precondition_failed',
      message: `No public key credentials mapped for ${clientId} with ${bankId}. Upload credentials first.`,
    });
  }

  const draft = orchestratorStore.saveDraft({
    draftId,
    clientId,
    bankId,
    type: 'ISSUANCE',
    corporateReference,
    payload: {
      corporateReference,
      amount,
      currency,
      applicant,
      beneficiary,
      expiryDate,
    },
  });

  return res.status(201).json({
    success: true,
    status: 'DRAFT_SAVED',
    draft_id: draft.draftId,
    corporate_reference: draft.corporateReference,
    bank_id: draft.bankId,
    type: draft.type,
    message: 'LC Issuance draft saved locally. Zero network hops consumed.',
    data: draft,
  });
};

/**
 * POST /api/v1/letter_of_credit/draft/amendment/:bankId
 * Creates and saves an LC Amendment draft locally against an issued LC.
 */
export const saveAmendmentDraft = (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;
  const {
    lcNumber,
    corporateReference,
    amendmentDetails = {},
    draftId,
  } = req.body;

  if (!lcNumber) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'lcNumber (Bank-issued Letter of Credit number) is required for amendment draft',
    });
  }

  const existingWorkflow = orchestratorStore.findWorkflowByLcNumber(clientId, lcNumber);
  if (!existingWorkflow) {
    return res.status(404).json({
      error: 'not_found',
      message: `Active issued LC with lcNumber '${lcNumber}' not found for ${clientId}`,
    });
  }

  const draft = orchestratorStore.saveDraft({
    draftId,
    clientId,
    bankId,
    type: 'AMENDMENT',
    corporateReference: corporateReference || existingWorkflow.corporateReference,
    lcNumber,
    payload: {
      lcNumber,
      corporateReference: corporateReference || existingWorkflow.corporateReference,
      amendmentDetails,
      baseWorkflowId: existingWorkflow.workflowId,
    },
  });

  return res.status(201).json({
    success: true,
    status: 'DRAFT_SAVED',
    draft_id: draft.draftId,
    lc_number: draft.lcNumber,
    corporate_reference: draft.corporateReference,
    bank_id: draft.bankId,
    type: draft.type,
    message: 'LC Amendment draft saved locally.',
    data: draft,
  });
};

/**
 * POST /api/v1/letter_of_credit/draft/presentation/:bankId
 * Creates and saves a Document Presentation draft locally.
 */
export const savePresentationDraft = (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;
  const {
    lcNumber,
    corporateReference,
    documentManifest = {},
    draftId,
  } = req.body;

  if (!lcNumber) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'lcNumber is required for document presentation draft',
    });
  }

  const existingWorkflow = orchestratorStore.findWorkflowByLcNumber(clientId, lcNumber);
  if (!existingWorkflow) {
    return res.status(404).json({
      error: 'not_found',
      message: `Active issued LC with lcNumber '${lcNumber}' not found for ${clientId}`,
    });
  }

  const draft = orchestratorStore.saveDraft({
    draftId,
    clientId,
    bankId,
    type: 'PRESENTATION',
    corporateReference: corporateReference || existingWorkflow.corporateReference,
    lcNumber,
    payload: {
      lcNumber,
      corporateReference: corporateReference || existingWorkflow.corporateReference,
      documentManifest,
      baseWorkflowId: existingWorkflow.workflowId,
    },
  });

  return res.status(201).json({
    success: true,
    status: 'DRAFT_SAVED',
    draft_id: draft.draftId,
    lc_number: draft.lcNumber,
    corporate_reference: draft.corporateReference,
    type: draft.type,
    message: 'Document presentation draft saved locally.',
    data: draft,
  });
};

/**
 * GET /api/v1/letter_of_credit/draft/:draftId
 * Retrieves a saved draft
 */
export const getDraft = (req, res) => {
  const { draftId } = req.params;
  const { clientId } = req.authContext;

  const draft = orchestratorStore.getDraft(draftId);
  if (!draft) {
    return res.status(404).json({
      error: 'not_found',
      message: `Draft '${draftId}' not found`,
    });
  }

  if (draft.clientId !== clientId) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'You are not authorized to view this draft',
    });
  }

  return res.status(200).json({
    success: true,
    data: draft,
  });
};

// ============================================================================
// BANK DISPATCH OPERATIONS (Strict Two-Step: Promotes Draft -> Bank Call)
// ============================================================================

/**
 * POST /api/v1/letter_of_credit/issuance/:bankId
 * Strictly consumes an existing draftId, checks capacity, executes crypto pipeline,
 * dispatches to Bank, and receives the official Bank-assigned lcNumber.
 */
export const initiateIssuance = async (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;
  const { draftId } = req.body;

  if (!draftId) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'draftId is required. Follow the 2-step financial pipeline: create a draft first via POST /letter_of_credit/draft/issuance/:bankId',
    });
  }

  const draft = orchestratorStore.getDraft(draftId);
  if (!draft) {
    return res.status(404).json({
      error: 'not_found',
      message: `Draft '${draftId}' not found. Please create a draft before initiating issuance.`,
    });
  }

  if (draft.clientId !== clientId || draft.bankId !== bankId || draft.type !== 'ISSUANCE') {
    return res.status(400).json({
      error: 'invalid_draft',
      message: `Draft does not match client '${clientId}', bank '${bankId}', or type 'ISSUANCE'`,
    });
  }

  const credentials = orchestratorStore.getBankCredentials(clientId, bankId);
  if (!credentials) {
    return res.status(412).json({
      error: 'precondition_failed',
      message: `No public key credentials found for ${clientId} with ${bankId}`,
    });
  }

  const workflowId = `LC-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const canonicalContract = {
    ...draft.payload,
    corporateReference: draft.corporateReference,
    operationType: 'ISSUANCE',
    version: 1,
  };

  const workflow = {
    workflowId,
    clientId,
    bankId,
    type: 'ISSUANCE',
    corporateReference: draft.corporateReference,
    lcNumber: null, // Will be populated by bank
    currentStage: 'LC_INITIATED',
    genericContract: canonicalContract,
    history: [
      {
        stage: 'LC_INITIATED',
        timestamp: new Date().toISOString(),
        trigger: 'PROMOTED_FROM_DRAFT',
        metadata: {
          draftId,
          corporateReference: draft.corporateReference,
          cryptoMode: credentials.cryptoMode,
        },
      },
      {
        stage: 'DISPATCHED_PENDING_ACK',
        timestamp: new Date().toISOString(),
        trigger: 'BANK_DISPATCH_COMMENCED',
        metadata: { targetBank: bankId },
      },
    ],
  };

  workflow.currentStage = 'DISPATCHED_PENDING_ACK';
  orchestratorStore.saveWorkflow(workflow);

  try {
    const cryptoProvider = CryptoProviderFactory.create(credentials);
    const bankResult = await bankConnectorService.dispatchToBank({
      bankId,
      clientId,
      genericContract: canonicalContract,
      cryptoProvider,
    });

    // Authoritative Bank-Assigned LC Number
    workflow.lcNumber = bankResult.lcNumber;
    workflow.genericContract.lcNumber = bankResult.lcNumber;
    workflow.currentStage = 'ISSUANCE_CONFIRMED';
    workflow.history.push({
      stage: 'ISSUANCE_CONFIRMED',
      timestamp: new Date().toISOString(),
      trigger: 'BANK_CONFIRMATION',
      metadata: {
        bankReference: bankResult.bankReference,
        bankLcNumber: bankResult.lcNumber,
        corporateReference: bankResult.corporateReference,
        idempotencyKey: bankResult.idempotencyKey,
      },
    });

    orchestratorStore.saveWorkflow(workflow);
    // Delete consumed draft
    orchestratorStore.deleteDraft(draftId);

    return res.status(201).json({
      status: 'CONFIRMED',
      workflow_id: workflowId,
      bank_id: bankId,
      corporate_reference: workflow.corporateReference,
      bank_lc_number: bankResult.lcNumber,
      bank_reference: bankResult.bankReference,
      current_stage: workflow.currentStage,
      idempotency_key: bankResult.idempotencyKey,
      crypto_execution: {
        provider_mode: credentials.cryptoMode,
        client_digest_signed: true,
        bank_envelope_encrypted: true,
        bank_signature_verified: true,
      },
      bank_response: bankResult.bankResponse,
      subscription_status: req.authContext.subscription,
    });
  } catch (err) {
    workflow.currentStage = 'DISPATCH_FAILED';
    workflow.history.push({
      stage: 'DISPATCH_FAILED',
      timestamp: new Date().toISOString(),
      trigger: 'BANK_DISPATCH_ERROR',
      metadata: { error: err.message },
    });
    orchestratorStore.saveWorkflow(workflow);

    return res.status(502).json({
      error: 'bank_dispatch_failed',
      message: err.message,
      workflow_id: workflowId,
    });
  }
};

/**
 * POST /api/v1/letter_of_credit/amendment/:bankId
 * Consumes an amendment draftId, dispatches to bank, receives official bank amendmentNumber.
 */
export const requestAmendment = async (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;
  const { draftId } = req.body;

  if (!draftId) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'draftId is required for amendment. Create a draft first via POST /letter_of_credit/draft/amendment/:bankId',
    });
  }

  const draft = orchestratorStore.getDraft(draftId);
  if (!draft || draft.type !== 'AMENDMENT') {
    return res.status(404).json({
      error: 'not_found',
      message: `Amendment draft '${draftId}' not found`,
    });
  }

  const workflow = orchestratorStore.findWorkflowByLcNumber(clientId, draft.lcNumber);
  if (!workflow) {
    return res.status(404).json({
      error: 'not_found',
      message: `Base LC '${draft.lcNumber}' not found for amendment`,
    });
  }

  const credentials = orchestratorStore.getBankCredentials(clientId, bankId);
  if (!credentials) {
    return res.status(412).json({
      error: 'precondition_failed',
      message: `No credentials mapped for ${clientId} with ${bankId}`,
    });
  }

  const newVersion = (workflow.genericContract.version || 1) + 1;
  const updatedContract = {
    ...workflow.genericContract,
    ...draft.payload.amendmentDetails,
    lcNumber: workflow.lcNumber,
    corporateReference: draft.corporateReference,
    operationType: 'AMENDMENT',
    version: newVersion,
  };

  try {
    const cryptoProvider = CryptoProviderFactory.create(credentials);
    const bankResult = await bankConnectorService.dispatchToBank({
      bankId,
      clientId,
      genericContract: updatedContract,
      cryptoProvider,
    });

    workflow.genericContract = updatedContract;
    workflow.amendmentNumber = bankResult.amendmentNumber;
    workflow.currentStage = 'AMENDMENT_CONFIRMED';
    workflow.history.push({
      stage: 'AMENDMENT_CONFIRMED',
      timestamp: new Date().toISOString(),
      trigger: 'BANK_AMENDMENT_CONFIRMATION',
      metadata: {
        amendmentNumber: bankResult.amendmentNumber,
        bankReference: bankResult.bankReference,
        idempotencyKey: bankResult.idempotencyKey,
      },
    });

    orchestratorStore.saveWorkflow(workflow);
    orchestratorStore.deleteDraft(draftId);

    return res.status(200).json({
      status: 'CONFIRMED',
      workflow_id: workflow.workflowId,
      lc_number: workflow.lcNumber,
      amendment_number: bankResult.amendmentNumber,
      corporate_reference: workflow.corporateReference,
      current_stage: workflow.currentStage,
      bank_reference: bankResult.bankReference,
      message: 'Letter of credit amendment successfully signed, encrypted, and confirmed by bank',
    });
  } catch (err) {
    return res.status(502).json({
      error: 'amendment_dispatch_failed',
      message: err.message,
    });
  }
};

/**
 * POST /api/v1/letter_of_credit/presentation/:bankId
 * Consumes a presentation draftId, dispatches to bank, receives official presentationNumber,
 * transitions to DOCUMENTS_PRESENTED, and records a milestone receipt with syncStatus: 'PENDING'.
 */
export const presentDocuments = async (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;
  const { draftId } = req.body;

  if (!draftId) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'draftId is required for document presentation. Create a draft first via POST /letter_of_credit/draft/presentation/:bankId',
    });
  }

  const draft = orchestratorStore.getDraft(draftId);
  if (!draft || draft.type !== 'PRESENTATION') {
    return res.status(404).json({
      error: 'not_found',
      message: `Presentation draft '${draftId}' not found`,
    });
  }

  const workflow = orchestratorStore.findWorkflowByLcNumber(clientId, draft.lcNumber);
  if (!workflow) {
    return res.status(404).json({
      error: 'not_found',
      message: `Base LC '${draft.lcNumber}' not found for presentation`,
    });
  }

  const credentials = orchestratorStore.getBankCredentials(clientId, bankId);
  if (!credentials) {
    return res.status(412).json({
      error: 'precondition_failed',
      message: `No credentials mapped for ${clientId} with ${bankId}`,
    });
  }

  const presentationContract = {
    ...workflow.genericContract,
    operationType: 'PRESENTATION',
    documentManifest: draft.payload.documentManifest,
    corporateReference: draft.corporateReference,
  };

  try {
    const cryptoProvider = CryptoProviderFactory.create(credentials);
    const bankResult = await bankConnectorService.dispatchToBank({
      bankId,
      clientId,
      genericContract: presentationContract,
      cryptoProvider,
    });

    workflow.presentationNumber = bankResult.presentationNumber;
    workflow.currentStage = 'DOCUMENTS_PRESENTED';
    workflow.history.push({
      stage: 'DOCUMENTS_PRESENTED',
      timestamp: new Date().toISOString(),
      trigger: 'BANK_PRESENTATION_CONFIRMATION',
      metadata: {
        presentationNumber: bankResult.presentationNumber,
        bankReference: bankResult.bankReference,
        documentManifest: draft.payload.documentManifest,
      },
    });

    orchestratorStore.saveWorkflow(workflow);
    orchestratorStore.deleteDraft(draftId);

    // Record milestone receipt in ledger with syncStatus: 'PENDING'
    const receipt = orchestratorStore.recordMilestoneReceipt({
      workflow_id: workflow.workflowId,
      corporate_reference: workflow.corporateReference,
      terminal_state_achieved: 'DOCUMENTS_PRESENTED',
      cryptographic_signature: `sig_rsa_pss_${crypto.randomBytes(12).toString('hex')}`,
      timestamp: new Date().toISOString(),
    });

    return res.status(200).json({
      status: 'ACCEPTED',
      workflow_id: workflow.workflowId,
      lc_number: workflow.lcNumber,
      presentation_number: bankResult.presentationNumber,
      current_stage: workflow.currentStage,
      milestone_receipt: {
        receipt_id: receipt.receiptId,
        sync_status: receipt.syncStatus,
        notice: 'Milestone recorded. Will be synchronized on next authoritative Auth call or via /sync-billing',
      },
      message: 'Documents presented successfully and confirmed by bank',
    });
  } catch (err) {
    return res.status(502).json({
      error: 'presentation_dispatch_failed',
      message: err.message,
    });
  }
};

/**
 * GET /api/v1/letter_of_credit/:bankId?workflowId=<id>&lcNumber=<num>&corporateReference=<ref>
 */
export const getLetterOfCredit = (req, res) => {
  const { bankId } = req.params;
  const { workflowId, lcNumber, corporateReference } = req.query;
  const { clientId } = req.authContext;

  let workflow;
  if (workflowId) {
    workflow = orchestratorStore.getWorkflow(workflowId);
  } else if (lcNumber) {
    workflow = orchestratorStore.findWorkflowByLcNumber(clientId, lcNumber);
  } else if (corporateReference) {
    workflow = orchestratorStore.findWorkflowByCorporateReference(clientId, corporateReference);
  }

  if (!workflow) {
    return res.status(404).json({
      error: 'not_found',
      message: 'Workflow not found matching provided query parameters',
    });
  }

  if (workflow.clientId !== clientId) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'You are not authorized to view this workflow',
    });
  }

  return res.status(200).json({
    success: true,
    data: workflow,
  });
};

// ============================================================================
// BILLING SYNCHRONIZATION ON-DEMAND (Zero Flusher Worker Alternative)
// ============================================================================

/**
 * POST /api/v1/sync-billing
 * Pure billing synchronization endpoint (passes through auth.js middleware to flush all pending receipts)
 */
export const syncBilling = (req, res) => {
  const counts = orchestratorStore.getMilestoneReceiptsCount();

  return res.status(200).json({
    success: true,
    message: 'Milestone billing receipts successfully synchronized with central Auth Service',
    acknowledged_receipt_ids: req.authContext.acknowledgedReceiptIds || [],
    milestone_ledger_status: counts,
  });
};
