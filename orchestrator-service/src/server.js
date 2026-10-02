import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import orchestratorRoutes from './routes/orchestrator.routes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ service: 'orchestrator-service', status: 'UP', port: PORT });
});

// Mount routes
app.use('/orchestrator', orchestratorRoutes);

app.listen(PORT, () => {
  console.log(`🏦 [Orchestrator Service] running on http://localhost:${PORT}`);
});

export default app;
