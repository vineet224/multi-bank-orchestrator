import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import orchestratorRoutes from './routes/orchestrator.routes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check (unauthenticated)
app.get('/health', (req, res) => {
  res.json({
    service: 'orchestrator-service',
    status: 'UP',
    port: PORT,
    iteration: 'Iteration 3 (Production-Grade Dual-Perimeter Gateway)',
    supportedBanks: ['HSBC', 'SBI'],
    cryptoModes: ['LOCAL_MOCK', 'AWS_KMS', 'AZURE_VAULT', 'REMOTE_API'],
    features: [
      'Sealed AEAD Opaque Tokens',
      'Offline Local Draft Saving (0 Hops)',
      'Strict Two-Step Financial Dispatch',
      'Real-World Bank-Assigned LC Numbers',
      'Milestone Ledger Batch Billing Sync',
    ],
  });
});

// Mount orchestrator routes (standard /api/v1 and root)
app.use('/api/v1', orchestratorRoutes);
app.use('/', orchestratorRoutes);

app.listen(PORT, () => {
  console.log(`🏦 [Orchestrator Service] running on http://localhost:${PORT}`);
});

export default app;
