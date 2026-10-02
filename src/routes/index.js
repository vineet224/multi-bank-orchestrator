import { Router } from 'express';
import healthRoutes from './health.routes.js';
import orchestratorRoutes from './orchestrator.routes.js';

const apiRouter = Router();

apiRouter.use('/health', healthRoutes);
apiRouter.use('/orchestrator', orchestratorRoutes);

export default apiRouter;
