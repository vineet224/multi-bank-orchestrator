import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../src/storage/inMemoryStore.js';
import { orchestratorService } from '../src/services/orchestrator.service.js';

describe('InMemoryStore (Hashtable)', () => {
  test('should insert and retrieve entities with O(1) key lookup', () => {
    const store = new InMemoryStore('test_store');
    const item = store.set('key1', { name: 'Test Item', value: 100 });

    assert.equal(store.size, 1);
    assert.equal(item.name, 'Test Item');
    assert.ok(item.createdAt);
    assert.ok(item.updatedAt);

    const retrieved = store.get('key1');
    assert.deepEqual(retrieved.name, 'Test Item');
  });

  test('should filter items using predicate', () => {
    const store = new InMemoryStore('filter_store');
    store.set('1', { status: 'ACTIVE', score: 10 });
    store.set('2', { status: 'INACTIVE', score: 20 });
    store.set('3', { status: 'ACTIVE', score: 30 });

    const active = store.filter((item) => item.status === 'ACTIVE');
    assert.equal(active.length, 2);
  });

  test('should delete items', () => {
    const store = new InMemoryStore('del_store');
    store.set('del1', { data: 'test' });
    assert.equal(store.has('del1'), true);

    const deleted = store.delete('del1');
    assert.equal(deleted, true);
    assert.equal(store.has('del1'), false);
    assert.equal(store.get('del1'), null);
  });
});

describe('OrchestratorService with In-Memory Store', () => {
  test('should initialize default banks', () => {
    const banks = orchestratorService.getAllBanks();
    assert.ok(banks.length >= 3);
  });

  test('should route payment to a bank and save transaction in in-memory hashtable', async () => {
    const payment = await orchestratorService.processPayment({
      amount: 250,
      currency: 'USD',
      sourceAccount: 'ACC_SRC_101',
      destinationAccount: 'ACC_DST_202',
    });

    assert.ok(payment.id.startsWith('txn_'));
    assert.equal(payment.amount, 250);
    assert.equal(payment.currency, 'USD');
    assert.ok(payment.routedBank);
    assert.equal(payment.status, 'SUCCESS');

    // Retrieve from store by key
    const retrieved = orchestratorService.getTransactionById(payment.id);
    assert.equal(retrieved.id, payment.id);
    assert.equal(retrieved.amount, 250);
  });
});
