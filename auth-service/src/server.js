import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.routes.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ service: 'auth-service', status: 'UP', port: PORT });
});

// Mount routes
app.use('/auth', authRoutes);

app.listen(PORT, () => {
  console.log(`🔐 [Auth Service] running on http://localhost:${PORT}`);
});

export default app;
