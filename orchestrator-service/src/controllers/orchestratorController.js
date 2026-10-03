import crypto from 'crypto';
import { orchestratorStore } from '../storage/inMemoryOrchestratorStore.js';
import { CryptoProviderFactory } from '../crypto/cryptoProviderFactory.js';
import { bankConnectorService } from '../services/bankConnector.service.js';

/**
 * ============================================================================
 * INTERVIEW RECALL: Orchestrator Controller (orchestratorController.js)
 * ============================================================================
 * 
 * ITERATION 2: Non-Custodial Multi-Bank Enterprise Gateway
 * 
 * Architectural Purpose:
 * - Multi-bank gateway for Trade Finance (Letters of Credit).
 * - Enforces supported banks: ['HSBC', 'SBI'].
 * - Non-custodial security boundary: Rejects any attempt to upload corporate private keys.
 * - Coordinates Pluggable Crypto Providers (AWS KMS, Azure Key Vault, Remote Webhook, Local Mock).
 * - Implements 2-step financial state transitions (INITIATED -> DISPATCHED_PENDING_ACK -> CONFIRMED).
 * - Enqueues terminal billing receipts to be piggybacked on outbound Auth Service hops.
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
 * GET /api/v1/bank-integration/credentials/:bankId
 * Returns the onboarded cryptographic credentials and provider configuration for the client
 */
export const getBankCredentials = (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;

  const credentials = orchestratorStore.getBankCredentials(clientId, bankId);
  if (!credentials) {
    return res.status(404).json({
      error: 'credentials_not_found',
      message: `No credentials mapped for client '${clientId}' with bank '${bankId}'`,
    });
  }

  return res.status(200).json({
    success: true,
    data: credentials,
  });
};

/**
 * POST /api/v1/upload/bank-integration/credentials/:bankId
 * Binds corporate client public key & bank public key for asymmetric exchange.
 * Security Guard: Rejects any request containing private key attributes.
 */
export const uploadBankCredentials = (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;
  let { clientPublicKey, bankPublicKey, cryptoMode = 'LOCAL_MOCK', cryptoConfig = {} } = req.body;

  // 1. Non-custodial security check: Forbid corporate private keys
  if (req.body.privateKey || req.body.secretKey || req.body.clientPrivateKey) {
    return res.status(400).json({
      error: 'security_violation',
      message: 'Private keys are strictly forbidden. The orchestrator only stores public keys; private key operations must remain in the client KMS/HSM.',
    });
  }

  // 2. Validate crypto execution mode
  const validCryptoModes = ['LOCAL_MOCK', 'AWS_KMS', 'AZURE_VAULT', 'REMOTE_API'];
  if (!validCryptoModes.includes(cryptoMode)) {
    return res.status(400).json({
      error: 'bad_request',
      message: `Invalid cryptoMode. Must be one of: ${validCryptoModes.join(', ')}`,
    });
  }

  // 3. Fallback public key resolution if not explicitly passed
  if (!clientPublicKey || !bankPublicKey) {
    const provider = CryptoProviderFactory.create({ cryptoMode, cryptoConfig });
    clientPublicKey = clientPublicKey || provider.getPublicKeyPem();
    const adapter = bankConnectorService.getAdapter(bankId);
    bankPublicKey = bankPublicKey || adapter.getBankPublicKeyPem();
  }

  if (!clientPublicKey || !bankPublicKey) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Both clientPublicKey and bankPublicKey (in PEM format) are required',
    });
  }


  // 4. Persist to in-memory store
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
 * 1. Checks active concurrent capacity licensing.
 * 2. Instantiates non-custodial crypto provider.
 * 3. Sets state: LC_INITIATED -> DISPATCHED_PENDING_ACK.
 * 4. Dispatches signed (Client Private Key) & encrypted (Bank Public Key) payload to bank.
 * 5. Verifies Bank signature & decrypts bank confirmation.
 * 6. Transitions to ISSUANCE_CONFIRMED.
 */
export const initiateIssuance = async (req, res) => {
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

  // 2. Generate unique workflow ID & canonical LC Number
  const workflowId = `LC-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const canonicalContract = {
    ...genericContract,
    lcNumber: genericContract.lcNumber || `LC/${bankId}/${new Date().getFullYear()}/${Date.now().toString().slice(-4)}`,
    amount: genericContract.amount || 1000000,
    currency: genericContract.currency || (bankId === 'SBI' ? 'INR' : 'USD'),
    applicant: genericContract.applicant || clientId,
    beneficiary: genericContract.beneficiary || 'Global Trade Partner Inc',
    expiryDate: genericContract.expiryDate || '2026-12-31',
    version: 1,
  };

  // 3. Initialize workflow instance with 2-step financial transition
  const workflow = {
    workflowId,
    clientId,
    bankId,
    type: 'ISSUANCE',
    currentStage: 'LC_INITIATED',
    genericContract: canonicalContract,
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

  // 4. Transition to DISPATCHED_PENDING_ACK (protects against duplicate financial issuance)
  workflow.currentStage = 'DISPATCHED_PENDING_ACK';
  workflow.history.push({
    stage: 'DISPATCHED_PENDING_ACK',
    timestamp: new Date().toISOString(),
    trigger: 'DISPATCH_COMMENCED',
    metadata: { targetBank: bankId },
  });
  orchestratorStore.saveWorkflow(workflow);

  try {
    // 5. Instantiate non-custodial crypto provider on demand
    const cryptoProvider = CryptoProviderFactory.create(credentials);

    // 6. Execute cryptographic dispatch pipeline:
    //    - Deterministic Idempotency Key
    //    - Sign 32-byte digest via client KMS/HSM
    //    - Encrypt payload via Bank Public Key (AES-GCM envelope)
    //    - Verify Bank signature & decrypt response
    const bankResult = await bankConnectorService.dispatchToBank({
      bankId,
      clientId,
      genericContract: canonicalContract,
      cryptoProvider,
    });

    // 7. Transition to ISSUANCE_CONFIRMED
    workflow.currentStage = 'ISSUANCE_CONFIRMED';
    workflow.history.push({
      stage: 'ISSUANCE_CONFIRMED',
      timestamp: new Date().toISOString(),
      trigger: 'BANK_DISPATCH_SUCCESS',
      metadata: {
        bankReference: bankResult.bankReference,
        idempotencyKey: bankResult.idempotencyKey,
        clientSignature: bankResult.clientSignature.slice(0, 32) + '...',
        bankSignature: bankResult.bankSignature.slice(0, 32) + '...',
      },
    });

    orchestratorStore.saveWorkflow(workflow);

    return res.status(201).json({
      status: 'CONFIRMED',
      workflow_id: workflowId,
      bank_id: bankId,
      current_stage: workflow.currentStage,
      bank_reference: bankResult.bankReference,
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
 * Validates active LC existence and transitions to AMENDMENT_CONFIRMED via Bank Connector.
 */
export const requestAmendment = async (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;
  const { workflowId, amendmentDetails = {} } = req.body;

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

  const credentials = orchestratorStore.getBankCredentials(clientId, bankId);
  if (!credentials) {
    return res.status(412).json({
      error: 'precondition_failed',
      message: `No credentials mapped for ${clientId} with ${bankId}`,
    });
  }

  // Update contract version
  const newVersion = (workflow.genericContract.version || 1) + 1;
  const updatedContract = {
    ...workflow.genericContract,
    ...amendmentDetails,
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
    workflow.currentStage = 'AMENDMENT_CONFIRMED';
    workflow.history.push({
      stage: 'AMENDMENT_CONFIRMED',
      timestamp: new Date().toISOString(),
      trigger: 'CLIENT_AMENDMENT_REQUEST',
      metadata: {
        amendmentDetails,
        bankReference: bankResult.bankReference,
        idempotencyKey: bankResult.idempotencyKey,
      },
    });

    orchestratorStore.saveWorkflow(workflow);

    return res.status(200).json({
      status: 'CONFIRMED',
      workflow_id: workflow.workflowId,
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
 * Transitions workflow to DOCUMENTS_PRESENTED and enqueues completed billing receipt.
 * The receipt will be piggybacked on the next outbound Auth Service hop or drained by the idle flusher.
 */
export const presentDocuments = async (req, res) => {
  const { bankId } = req.params;
  const { clientId } = req.authContext;
  const { workflowId, documentManifest = {} } = req.body;

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

  // Enqueue a completed billing receipt to be piggybacked on next Auth Service network hop
  const receipt = {
    workflow_id: workflow.workflowId,
    terminal_state_achieved: 'DOCUMENTS_PRESENTED',
    cryptographic_signature: `sig_rsa_pss_${crypto.randomBytes(12).toString('hex')}`,
    timestamp: new Date().toISOString(),
  };

  orchestratorStore.enqueueBillingReceipt(receipt);

  return res.status(200).json({
    status: 'ACCEPTED',
    workflow_id: workflow.workflowId,
    current_stage: workflow.currentStage,
    billing_notice: 'Receipt enqueued: Will be piggybacked on next Auth hop or flushed by idle worker',
    pending_receipts_in_queue: orchestratorStore.getPendingReceiptsCount(),
    message: 'Documents presented successfully',
  });
};
