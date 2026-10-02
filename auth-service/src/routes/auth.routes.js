import { Router } from 'express';
import {
  registerClient,
  login,
  validateOpaqueToken,
  revoke,
} from '../controllers/authController.js';

const router = Router();

// Onboard enterprise client
router.post('/clients', registerClient);

// Issue high-entropy opaque bearer token
router.post('/login', login);

// Authoritative inspection endpoint with optional piggybacked billing
router.post('/validate-opaque-token', validateOpaqueToken);

// Administrative session kill switch
router.post('/revoke', revoke);

export default router;
