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
    iteration: 'Iteration 1 (Baseline Gateway)',
    supportedBanks: ['HSBC', 'SBI'],
  });
});

// Mount orchestrator routes (standard /api/v1 and root)
app.use('/api/v1', orchestratorRoutes);
app.use('/', orchestratorRoutes);

app.listen(PORT, () => {
  console.log(`🏦 [Orchestrator Service] running on http://localhost:${PORT}`);
});

export default app;
