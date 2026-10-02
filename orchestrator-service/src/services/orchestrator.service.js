import { bankStore, transactionStore } from '../storage/inMemoryStore.js';

export class OrchestratorService {
  /**
   * Boilerplate service method placeholder
   */
  async processRequest(payload) {
    // Add routing / orchestration logic later
    return {
      status: 'RECEIVED',
      payload,
    };
  }
}

export const orchestratorService = new OrchestratorService();
