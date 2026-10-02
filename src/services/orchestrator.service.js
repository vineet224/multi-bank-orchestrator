import { v4 as uuidv4 } from 'uuid';
import { storeRegistry } from '../storage/inMemoryStore.js';
import { ApiError } from '../middleware/errorHandler.js';

export class OrchestratorService {
  constructor() {
    this.transactionStore = storeRegistry.getStore('transactions');
    this.bankStore = storeRegistry.getStore('banks');

    // Initialize mock banks if not present
    this._initializeDefaultBanks();
  }

  /**
   * Populate default banks in the in-memory store
   * @private
   */
  _initializeDefaultBanks() {
    if (this.bankStore.size === 0) {
      const defaultBanks = [
        { id: 'BANK_ALPHA', name: 'Alpha National Bank', code: 'ANB01', status: 'ACTIVE', priority: 1, supportedCurrencies: ['USD', 'EUR', 'INR'] },
        { id: 'BANK_BETA', name: 'Beta Global Bank', code: 'BGB02', status: 'ACTIVE', priority: 2, supportedCurrencies: ['USD', 'GBP'] },
        { id: 'BANK_GAMMA', name: 'Gamma Union Bank', code: 'GUB03', status: 'ACTIVE', priority: 3, supportedCurrencies: ['INR', 'EUR'] },
      ];
      for (const bank of defaultBanks) {
        this.bankStore.set(bank.id, bank);
      }
    }
  }

  /**
   * Route and process a transaction across banks
   * @param {Object} paymentData
   * @returns {Object} Created transaction
   */
  async processPayment(paymentData) {
    const { amount, currency = 'USD', sourceAccount, destinationAccount, preferredBankId } = paymentData;

    if (!amount || amount <= 0) {
      throw ApiError.badRequest('Amount must be a positive number');
    }
    if (!sourceAccount || !destinationAccount) {
      throw ApiError.badRequest('Both sourceAccount and destinationAccount are required');
    }

    // Determine target bank (either preferred or best matching bank by currency and priority)
    let selectedBank = null;

    if (preferredBankId) {
      selectedBank = this.bankStore.get(preferredBankId);
      if (!selectedBank) {
        throw ApiError.badRequest(`Bank with ID '${preferredBankId}' not found`);
      }
      if (selectedBank.status !== 'ACTIVE') {
        throw ApiError.badRequest(`Bank '${selectedBank.name}' is currently unavailable`);
      }
    } else {
      // Automatic routing based on currency & priority
      const candidateBanks = this.bankStore
        .filter((b) => b.status === 'ACTIVE' && b.supportedCurrencies.includes(currency))
        .sort((a, b) => a.priority - b.priority);

      if (candidateBanks.length === 0) {
        throw ApiError.badRequest(`No active bank found supporting currency '${currency}'`);
      }
      selectedBank = candidateBanks[0];
    }

    // Generate transaction ID
    const transactionId = `txn_${uuidv4().replace(/-/g, '').slice(0, 16)}`;

    // Create transaction entity to save in the in-memory hashtable
    const transaction = {
      id: transactionId,
      amount: Number(amount),
      currency: currency.toUpperCase(),
      sourceAccount,
      destinationAccount,
      routedBank: {
        id: selectedBank.id,
        name: selectedBank.name,
        code: selectedBank.code,
      },
      status: 'SUCCESS', // Simulated instant execution
      referenceNumber: `REF-${Date.now()}`,
    };

    // Save to in-memory store
    return this.transactionStore.set(transactionId, transaction);
  }

  /**
   * Get transaction details by ID
   * @param {string} id
   * @returns {Object}
   */
  getTransactionById(id) {
    const transaction = this.transactionStore.get(id);
    if (!transaction) {
      throw ApiError.notFound(`Transaction with ID '${id}' not found`);
    }
    return transaction;
  }

  /**
   * List all stored transactions with optional filters
   * @param {Object} filters
   * @returns {Array<Object>}
   */
  getAllTransactions(filters = {}) {
    const { status, bankId, currency } = filters;
    return this.transactionStore.filter((tx) => {
      if (status && tx.status.toLowerCase() !== status.toLowerCase()) return false;
      if (bankId && tx.routedBank?.id !== bankId) return false;
      if (currency && tx.currency !== currency.toUpperCase()) return false;
      return true;
    });
  }

  /**
   * List all available banks
   * @returns {Array<Object>}
   */
  getAllBanks() {
    return this.bankStore.getAll();
  }

  /**
   * Register or update a bank entity in-memory
   * @param {Object} bankData
   * @returns {Object}
   */
  registerBank(bankData) {
    const { name, code, supportedCurrencies = ['USD'], priority = 10, status = 'ACTIVE' } = bankData;

    if (!name || !code) {
      throw ApiError.badRequest('Bank name and code are required');
    }

    const bankId = bankData.id || `BANK_${code.toUpperCase()}`;
    const newBank = {
      id: bankId,
      name,
      code: code.toUpperCase(),
      status,
      priority: Number(priority),
      supportedCurrencies,
    };

    return this.bankStore.set(bankId, newBank);
  }

  /**
   * Get in-memory storage statistics
   */
  getStorageStats() {
    return {
      stores: storeRegistry.listStores(),
      transactionsCount: this.transactionStore.size,
      banksCount: this.bankStore.size,
    };
  }
}

export const orchestratorService = new OrchestratorService();
