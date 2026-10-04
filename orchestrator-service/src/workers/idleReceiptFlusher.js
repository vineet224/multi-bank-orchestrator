/**
 * ============================================================================
 * RETIRED IN ITERATION 3: Background Idle Receipt Flusher (idleReceiptFlusher.js)
 * ============================================================================
 * 
 * Architectural Evolution Note:
 * - In Iteration 2, this background worker ran an interval timer to flush receipts.
 * - In Iteration 3, this has been completely RETIRED & REPLACED by:
 *   1. The Milestone Ledger (syncStatus: 'PENDING' | 'ACKNOWLEDGED').
 *   2. Zero-worker Piggybacked Batch Synchronization on regular auth calls.
 *   3. Dedicated On-Demand /sync-billing endpoint for ops/billing-cycle sync.
 * - Why Removed:
 *   a) Eliminates background timer leaks and node event-loop locks.
 *   b) Eliminates storing platform-level M2M secrets inside client-side infrastructure.
 *   c) Guarantees deterministic ledger synchronization without timer races.
 */

export class IdleReceiptFlusher {
  constructor() {
    this.intervalId = null;
    this.isFlushing = false;
  }

  start() {
    // No-op in Iteration 3 (Replaced by Milestone Ledger Batch Sync)
    console.log('ℹ️ [Idle Flusher Worker] Retired in Iteration 3. Batch synchronization handled via Milestone Ledger.');
  }

  stop() {
    // No-op
  }

  async flushNow() {
    return { flushed: 0, acknowledgedIds: [], retired: true };
  }
}

export const idleReceiptFlusher = new IdleReceiptFlusher();
