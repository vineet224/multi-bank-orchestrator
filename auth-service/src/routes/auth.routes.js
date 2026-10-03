import { Router } from 'express';
import {
  registerClient,
  login,
  validateOpaqueToken,
  m2mFlushReceipts,
  revoke,
} from '../controllers/authController.js';

const router = Router();

// Onboard enterprise client
router.post('/clients', registerClient);

// Issue high-entropy opaque bearer token
router.post('/login', login);

// Authoritative inspection endpoint with optional piggybacked billing
router.post('/validate-opaque-token', validateOpaqueToken);

// Dedicated M2M platform channel for background flusher (Problem B: Channel trust)
router.post('/m2m-flush-receipts', m2mFlushReceipts);

// Administrative session kill switch
router.post('/revoke', revoke);

export default router;

