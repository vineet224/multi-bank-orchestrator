import crypto from 'crypto';
import { orchestratorStore } from '../storage/inMemoryOrchestratorStore.js';

/**
 * ============================================================================
 * INTERVIEW RECALL: Orchestrator Controller (orchestratorController.js)
 * ============================================================================
 * 
 * ITERATION 1: Baseline Prototype
 * 
 * Architectural Purpose:
 * - Serves as the multi-bank gateway for Trade Finance / Letter of Credit (LC).
 * - Enforces supported bank integrations strictly: ['HSBC', 'SBI'].
 * - Receives canonical client requests, initializes multi-stage LC state machines,
 *   and prepares execution context for bank-specific DAG adapters (Iteration 2).
 * - Non-custodial security: Rejects any attempt to upload corporate private keys.
 */

const SUPPORTED_BANKS = ['HSBC', 'SBI'];

/**
 * Middleware validation guard for :bankId route parameter
 */
export const validateBankId = (req, res, next) => {
  const bankId = req.params.bankId?.toUpperCase();
  if (!SUPPORTED_BANKS.includes(bankId)) {
    return res.status(400).json({
      error: 'unsupported_bank',
      message: `Bank '${req.params.bankId}' is not supported. Supported bank integrations: ${SUPPORTED_BANKS.join(', ')}`,
    });
  }
  req.params.bankId = bankId; // Normalize to uppercase
  next();
};

/**
 * POST /api/v1/upload/bank-integration/credentials/:bankId
 * Binds corporate client public key & bank public key for asymmetric exchange.
 * Security Guard: Rejects any request containing private key attributes.
 */
export const uploadBankCredentials = (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;
  const { clientPublicKey, bankPublicKey, cryptoMode = 'AWS_KMS' } = req.body;

  // 1. Non-custodial security check: Forbid corporate private keys
  if (req.body.privateKey || req.body.secretKey || req.body.clientPrivateKey) {
    return res.status(400).json({
      error: 'security_violation',
      message: 'Private keys are strictly forbidden. The orchestrator only stores public keys; private key operations must remain in the client KMS/HSM.',
    });
  }

  if (!clientPublicKey || !bankPublicKey) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Both clientPublicKey and bankPublicKey (in PEM format) are required',
    });
  }

  // 2. Validate crypto execution mode
  const validCryptoModes = ['AWS_KMS', 'AZURE_VAULT', 'REMOTE_API'];
  if (!validCryptoModes.includes(cryptoMode)) {
    return res.status(400).json({
      error: 'bad_request',
      message: `Invalid cryptoMode. Must be one of: ${validCryptoModes.join(', ')}`,
    });
  }

  // 3. Persist to in-memory store
  const credentialRecord = orchestratorStore.saveBankCredentials({
    clientId,
    bankId,
    clientPublicKey,
    bankPublicKey,
    cryptoMode,
  });

  return res.status(201).json({
    success: true,
    message: `Public key credentials mapped successfully for ${clientId} <-> ${bankId}`,
    data: credentialRecord,
  });
};

/**
 * GET /api/v1/letter_of_credit/:bankId?workflowId=<id>
 * Retrieves workflow instance, validating bank and client ownership.
 */
export const getLetterOfCredit = (req, res) => {
  const { bankId } = req.params;
  const { workflowId } = req.query;
  const { clientId } = req.authContext;

  if (!workflowId) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Query parameter ?workflowId=<id> is required',
    });
  }

  const workflow = orchestratorStore.getWorkflow(workflowId);
  if (!workflow) {
    return res.status(404).json({
      error: 'not_found',
      message: `Workflow '${workflowId}' not found`,
    });
  }

  // Tenant isolation & bank validation guard
  if (workflow.clientId !== clientId) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'You are not authorized to view this workflow',
    });
  }

  if (workflow.bankId !== bankId) {
    return res.status(400).json({
      error: 'bank_mismatch',
      message: `Workflow belongs to bank '${workflow.bankId}', not '${bankId}'`,
    });
  }

  return res.status(200).json({
    success: true,
    data: workflow,
  });
};

/**
 * POST /api/v1/letter_of_credit/issuance/:bankId
 * Generates workflowId, initializes canonical LC state (LC_INITIATED),
 * and prepares context for Iteration 2 bank DAG routing.
 */
export const initiateIssuance = (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;
  const genericContract = req.body;

  // 1. Verify client has onboarded credentials for this bank
  const credentials = orchestratorStore.getBankCredentials(clientId, bankId);
  if (!credentials) {
    return res.status(412).json({
      error: 'precondition_failed',
      message: `No public key credentials found for ${clientId} with ${bankId}. Upload credentials first.`,
    });
  }

  // 2. Generate unique workflow ID
  const workflowId = `LC-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  // 3. Initialize workflow instance
  const workflow = {
    workflowId,
    clientId,
    bankId,
    type: 'ISSUANCE',
    currentStage: 'LC_INITIATED',
    genericContract: {
      ...genericContract,
      lcNumber: genericContract.lcNumber || `LC/${bankId}/${new Date().getFullYear()}/${Date.now().toString().slice(-4)}`,
    },
    history: [
      {
        stage: 'LC_INITIATED',
        timestamp: new Date().toISOString(),
        trigger: 'CLIENT_ISSUANCE_REQUEST',
        metadata: {
          cryptoMode: credentials.cryptoMode,
          initiatedByNode: req.authContext.orchestratorNodeId,
        },
      },
    ],
  };

  orchestratorStore.saveWorkflow(workflow);

  // 4. Return 202 Accepted (asynchronous workflow pattern)
  return res.status(202).json({
    status: 'ACCEPTED',
    workflow_id: workflowId,
    bank_id: bankId,
    current_stage: 'LC_INITIATED',
    execution_context: {
      crypto_mode: credentials.cryptoMode,
      target_bank_adapter: `${bankId}_LC_DAG_ADAPTER_v1`,
      next_stage: 'PREPARE_BANK_TRANSLATION',
      iteration_note: 'Iteration 1 baseline: Workflow initialized. Bank-specific DAG execution queued for Iteration 2.',
    },
  });
};

/**
 * POST /api/v1/letter_of_credit/amendment/:bankId
 * Validates active LC existence and transitions to AMENDMENT_REQUESTED.
 */
export const requestAmendment = (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;
  const { workflowId, amendmentDetails } = req.body;

  if (!workflowId) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Body parameter workflowId is required for amendment',
    });
  }

  const workflow = orchestratorStore.getWorkflow(workflowId);
  if (!workflow) {
    return res.status(404).json({
      error: 'not_found',
      message: `Workflow '${workflowId}' not found`,
    });
  }

  if (workflow.clientId !== clientId || workflow.bankId !== bankId) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Unauthorized access or bank mismatch for this workflow',
    });
  }

  // Transition workflow state
  workflow.currentStage = 'AMENDMENT_REQUESTED';
  workflow.history.push({
    stage: 'AMENDMENT_REQUESTED',
    timestamp: new Date().toISOString(),
    trigger: 'CLIENT_AMENDMENT_REQUEST',
    metadata: { amendmentDetails },
  });

  orchestratorStore.saveWorkflow(workflow);

  return res.status(202).json({
    status: 'ACCEPTED',
    workflow_id: workflow.workflowId,
    current_stage: workflow.currentStage,
    message: 'Letter of credit amendment request recorded and queued for bank dispatch',
  });
};

/**
 * POST /api/v1/letter_of_credit/presentation/:bankId
 * Transitions workflow to DOCUMENTS_PRESENTED and enqueues completed billing receipt.
 */
export const presentDocuments = (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;
  const { workflowId, documentManifest } = req.body;

  if (!workflowId) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Body parameter workflowId is required for document presentation',
    });
  }

  const workflow = orchestratorStore.getWorkflow(workflowId);
  if (!workflow) {
    return res.status(404).json({
      error: 'not_found',
      message: `Workflow '${workflowId}' not found`,
    });
  }

  if (workflow.clientId !== clientId || workflow.bankId !== bankId) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'Unauthorized access or bank mismatch for this workflow',
    });
  }

  // Transition workflow state
  workflow.currentStage = 'DOCUMENTS_PRESENTED';
  workflow.history.push({
    stage: 'DOCUMENTS_PRESENTED',
    timestamp: new Date().toISOString(),
    trigger: 'CLIENT_DOCUMENT_PRESENTATION',
    metadata: { documentManifest },
  });

  orchestratorStore.saveWorkflow(workflow);

  // Enqueue a completed billing receipt to demonstrate piggybacked billing on next auth call
  orchestratorStore.enqueueBillingReceipt({
    workflow_id: workflow.workflowId,
    terminal_state_achieved: 'DOCUMENTS_PRESENTED',
    cryptographic_signature: `sig_rsa_${crypto.randomBytes(8).toString('hex')}`,
    timestamp: new Date().toISOString(),
  });

  return res.status(202).json({
    status: 'ACCEPTED',
    workflow_id: workflow.workflowId,
    current_stage: workflow.currentStage,
    billing_notice: 'Receipt enqueued to be piggybacked on next Auth Service network hop',
    message: 'Documents presented successfully',
  });
};
