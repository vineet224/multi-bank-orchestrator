import { orchestratorStore } from '../storage/inMemoryOrchestratorStore.js';

/**
 * ============================================================================
 * INTERVIEW RECALL: Background Idle Receipt Flusher (idleReceiptFlusher.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * - Solves the "Stale Piggyback Queue" edge case in asynchronous trade finance.
 * - If a corporate user presents documents and closes their browser for the day,
 *   the billing receipt would normally wait indefinitely for the next UI click.
 * - This background worker triggers an automated flush if un-piggybacked receipts
 *   linger in memory.
 * - Authentication: Uses Machine-to-Machine (M2M) platform channel credentials
 *   (Problem B: Platform Channel Trust) since no human UI session token is present.
 */

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:4000';
const NODE_ID = process.env.NODE_ID || 'node-orchestrator-01';
const PLATFORM_SECRET = process.env.PLATFORM_SECRET || 'xalts_platform_secret_m2m_node_01';

export class IdleReceiptFlusher {
  constructor() {
    this.intervalId = null;
    this.isFlushing = false;
  }

  /**
   * Starts the background interval flusher
   * @param {number} [intervalMs=30000] 
   */
  start(intervalMs = 30000) {
    if (this.intervalId) return;

    this.intervalId = setInterval(async () => {
      await this.flushNow();
    }, intervalMs);

    // Unref timer so it doesn't block process exit if needed
    if (this.intervalId.unref) this.intervalId.unref();

    console.log(`⏱️ [Idle Flusher Worker] Started with interval: ${intervalMs}ms`);
  }

  /**
   * Stop the background flusher
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Executes a flush of pending receipts using M2M platform credentials
   * @returns {Promise<{ flushed: number, acknowledgedIds: string[] }>}
   */
  async flushNow() {
    if (this.isFlushing) return { flushed: 0, acknowledgedIds: [] };

    const count = orchestratorStore.getPendingReceiptsCount();
    if (count === 0) return { flushed: 0, acknowledgedIds: [] };

    this.isFlushing = true;
    const receiptsToFlush = orchestratorStore.drainPendingReceipts();

    try {
      const response = await fetch(`${AUTH_SERVICE_URL}/api/v1/auth/m2m-flush-receipts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Platform-Node-Id': NODE_ID,
          'X-Platform-Secret': PLATFORM_SECRET,
        },
        body: JSON.stringify({ receipts: receiptsToFlush }),
      });

      if (!response.ok) {
        throw new Error(`Auth service returned status ${response.status} on M2M flush`);
      }

      const data = await response.json();
      console.log(`✅ [Idle Flusher Worker] Flushed ${data.flushed_count} receipts via M2M channel.`);
      return {
        flushed: data.flushed_count,
        acknowledgedIds: data.acknowledged_receipt_ids || [],
      };
    } catch (err) {
      console.error(`⚠️ [Idle Flusher Worker] M2M flush failed: ${err.message}. Re-queueing receipts.`);
      // Re-queue receipts so they are never lost (At-Least-Once Delivery)
      for (const r of receiptsToFlush) {
        orchestratorStore.enqueueBillingReceipt(r);
      }
      return { flushed: 0, acknowledgedIds: [] };
    } finally {
      this.isFlushing = false;
    }
  }
}

export const idleReceiptFlusher = new IdleReceiptFlusher();
