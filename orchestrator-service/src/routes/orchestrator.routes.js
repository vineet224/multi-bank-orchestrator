import { Router } from 'express';
import {
  validateBankId,
  uploadBankCredentials,
  getBankCredentials,
  saveIssuanceDraft,
  saveAmendmentDraft,
  savePresentationDraft,
  getDraft,
  initiateIssuance,
  requestAmendment,
  presentDocuments,
  getLetterOfCredit,
  syncBilling,
} from '../controllers/orchestratorController.js';
import { authenticateRequest } from '../middleware/auth.js';

const router = Router();

// Protect all orchestrator endpoints with the Dual-Perimeter Auth Middleware
// (Local verification for /draft/*, authoritative hop + batch sync for dispatches)
router.use(authenticateRequest);

// ============================================================================
// BANK CREDENTIAL MAPPINGS (Asymmetric Public Keys & KMS Binding)
// ============================================================================
router.post(
  '/upload/bank-integration/credentials/:bankId',
  validateBankId,
  uploadBankCredentials
);

router.get(
  '/bank-integration/credentials/:bankId',
  validateBankId,
  getBankCredentials
);

// ============================================================================
// DRAFT OPERATIONS (Local Perimeter: 0 Network Hops, Degraded Mode Safe)
// ============================================================================
router.post(
  '/letter_of_credit/draft/issuance/:bankId',
  validateBankId,
  saveIssuanceDraft
);

router.post(
  '/letter_of_credit/draft/amendment/:bankId',
  validateBankId,
  saveAmendmentDraft
);

router.post(
  '/letter_of_credit/draft/presentation/:bankId',
  validateBankId,
  savePresentationDraft
);

router.get(
  '/letter_of_credit/draft/:draftId',
  getDraft
);

// ============================================================================
// BANK DISPATCH OPERATIONS (Strict Two-Step Pipeline: Consumes draftId)
// ============================================================================
router.post(
  '/letter_of_credit/issuance/:bankId',
  validateBankId,
  initiateIssuance
);

router.post(
  '/letter_of_credit/amendment/:bankId',
  validateBankId,
  requestAmendment
);

router.post(
  '/letter_of_credit/presentation/:bankId',
  validateBankId,
  presentDocuments
);

router.get(
  '/letter_of_credit/:bankId',
  validateBankId,
  getLetterOfCredit
);

// ============================================================================
// ON-DEMAND BILLING SYNCHRONIZATION (Flushes Milestone Receipts)
// ============================================================================
router.post(
  '/sync-billing',
  syncBilling
);

export default router;
