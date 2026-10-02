import { Router } from 'express';
import {
  processPayment,
  getTransactionById,
  listTransactions,
  listBanks,
  registerBank,
  getStorageStats,
} from '../controllers/orchestrator.controller.js';

const router = Router();

// Transactions
router.post('/transactions', processPayment);
router.get('/transactions', listTransactions);
router.get('/transactions/:id', getTransactionById);

// Banks
router.get('/banks', listBanks);
router.post('/banks', registerBank);

// Storage metadata / stats
router.get('/storage-stats', getStorageStats);

export default router;
