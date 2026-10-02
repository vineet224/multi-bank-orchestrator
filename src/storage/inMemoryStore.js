/**
 * In-Memory Hashtable Store
 * Implements a generic in-memory key-value store using JavaScript Map (Hashtable).
 * Provides O(1) lookups, CRUD operations, and querying helpers without any external DB.
 */
export class InMemoryStore {
  /**
   * @param {string} name - Name of the store (e.g., 'transactions', 'banks')
   */
  constructor(name = 'default') {
    this.name = name;
    this.table = new Map();
  }

  /**
   * Save or update an item by key
   * @param {string} key
   * @param {Object} value
   * @returns {Object} Stored value
   */
  set(key, value) {
    const item = {
      ...value,
      id: key,
      updatedAt: new Date().toISOString(),
      createdAt: value?.createdAt || new Date().toISOString(),
    };
    this.table.set(key, item);
    return { ...item };
  }

  /**
   * Get an item by key
   * @param {string} key
   * @returns {Object|null}
   */
  get(key) {
    const item = this.table.get(key);
    return item ? { ...item } : null;
  }

  /**
   * Check if a key exists
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this.table.has(key);
  }

  /**
   * Delete an item by key
   * @param {string} key
   * @returns {boolean}
   */
  delete(key) {
    return this.table.delete(key);
  }

  /**
   * Get all items as an array
   * @returns {Array<Object>}
   */
  getAll() {
    return Array.from(this.table.values()).map((item) => ({ ...item }));
  }

  /**
   * Find items matching a predicate function
   * @param {Function} predicate
   * @returns {Array<Object>}
   */
  filter(predicate) {
    return this.getAll().filter(predicate);
  }

  /**
   * Find the first item matching a predicate function
   * @param {Function} predicate
   * @returns {Object|null}
   */
  find(predicate) {
    const all = this.getAll();
    return all.find(predicate) || null;
  }

  /**
   * Clear all items in the store
   */
  clear() {
    this.table.clear();
  }

  /**
   * Get total number of items
   * @returns {number}
   */
  get size() {
    return this.table.size;
  }
}

/**
 * Registry to manage multiple in-memory tables / collections
 */
class StoreRegistry {
  constructor() {
    this.stores = new Map();
  }

  /**
   * Get an existing store or initialize a new one by name
   * @param {string} name
   * @returns {InMemoryStore}
   */
  getStore(name) {
    if (!this.stores.has(name)) {
      this.stores.set(name, new InMemoryStore(name));
    }
    return this.stores.get(name);
  }

  /**
   * List all registered store names
   * @returns {string[]}
   */
  listStores() {
    return Array.from(this.stores.keys());
  }

  /**
   * Clear all registered stores
   */
  clearAll() {
    for (const store of this.stores.values()) {
      store.clear();
    }
  }
}

export const storeRegistry = new StoreRegistry();
