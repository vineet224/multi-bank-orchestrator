import { Router } from 'express';
import { handleRequest, getStatus } from '../controllers/orchestrator.controller.js';
import { authenticate } from '../middleware/auth.js';

const router = Router();

// Routes with auth middleware placeholder
router.post('/process', authenticate, handleRequest);
router.get('/status', authenticate, getStatus);

export default router;
