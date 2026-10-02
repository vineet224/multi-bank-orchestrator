import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './config/index.js';
import apiRouter from './routes/index.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

const app = express();

// Middlewares
app.use(cors({ origin: config.corsOrigin }));
app.use(morgan(config.env === 'development' ? 'dev' : 'combined'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Root Information Endpoint
app.get('/', (req, res) => {
  res.json({
    service: config.appName,
    status: 'ONLINE',
    version: '1.0.0',
    storage: 'In-Memory Hashtable (Map)',
    documentation: {
      health: 'GET /health or GET /api/v1/health',
      stats: 'GET /api/v1/orchestrator/storage-stats',
      banks: 'GET /api/v1/orchestrator/banks',
      transactions: 'GET /api/v1/orchestrator/transactions',
      processPayment: 'POST /api/v1/orchestrator/transactions',
    },
  });
});

// Direct Health Route
app.use('/health', (req, res) => {
  res.json({ status: 'UP', timestamp: new Date().toISOString() });
});

// Mount Versioned API Routes
app.use('/api/v1', apiRouter);

// 404 & Error Handling
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
