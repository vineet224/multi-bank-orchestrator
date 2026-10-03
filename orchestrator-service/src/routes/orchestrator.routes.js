import { Router } from 'express';
import {
  validateBankId,
  uploadBankCredentials,
  getBankCredentials,
  getLetterOfCredit,
  initiateIssuance,
  requestAmendment,
  presentDocuments,
} from '../controllers/orchestratorController.js';
import { authenticateRequest } from '../middleware/auth.js';

const router = Router();

// Protect all orchestrator endpoints with the intentional Auth network hop
router.use(authenticateRequest);

// Bank Credential Binding (Upload client/bank public keys & cryptoMode)
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


// Letter of Credit Lifecycle Endpoints
router.get(
  '/letter_of_credit/:bankId',
  validateBankId,
  getLetterOfCredit
);

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

export default router;
