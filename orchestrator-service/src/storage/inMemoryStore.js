/**
 * Generic In-Memory Hashtable Store Boilerplate
 * Uses JavaScript Map for O(1) operations without external database.
 */
export class InMemoryStore {
  constructor(name = 'default') {
    this.name = name;
    this.table = new Map();
  }

  set(key, value) {
    this.table.set(key, value);
    return value;
  }

  get(key) {
    return this.table.get(key) || null;
  }

  has(key) {
    return this.table.has(key);
  }

  delete(key) {
    return this.table.delete(key);
  }

  getAll() {
    return Array.from(this.table.values());
  }

  clear() {
    this.table.clear();
  }

  get size() {
    return this.table.size;
  }
}

// In-memory hashtable instances placeholder
export const bankStore = new InMemoryStore('banks');
export const transactionStore = new InMemoryStore('transactions');
