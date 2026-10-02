import { orchestratorService } from '../services/orchestrator.service.js';

export const processPayment = async (req, res, next) => {
  try {
    const result = await orchestratorService.processPayment(req.body);
    return res.status(201).json({
      success: true,
      message: 'Transaction routed and processed successfully',
      data: result,
    });
  } catch (error) {
    next(error);
  }
};

export const getTransactionById = (req, res, next) => {
  try {
    const { id } = req.params;
    const transaction = orchestratorService.getTransactionById(id);
    return res.status(200).json({
      success: true,
      data: transaction,
    });
  } catch (error) {
    next(error);
  }
};

export const listTransactions = (req, res, next) => {
  try {
    const { status, bankId, currency } = req.query;
    const transactions = orchestratorService.getAllTransactions({ status, bankId, currency });
    return res.status(200).json({
      success: true,
      count: transactions.length,
      data: transactions,
    });
  } catch (error) {
    next(error);
  }
};

export const listBanks = (req, res, next) => {
  try {
    const banks = orchestratorService.getAllBanks();
    return res.status(200).json({
      success: true,
      count: banks.length,
      data: banks,
    });
  } catch (error) {
    next(error);
  }
};

export const registerBank = (req, res, next) => {
  try {
    const bank = orchestratorService.registerBank(req.body);
    return res.status(201).json({
      success: true,
      message: 'Bank registered successfully in in-memory store',
      data: bank,
    });
  } catch (error) {
    next(error);
  }
};

export const getStorageStats = (req, res, next) => {
  try {
    const stats = orchestratorService.getStorageStats();
    return res.status(200).json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
};
