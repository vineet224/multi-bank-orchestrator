import { orchestratorStore } from '../storage/inMemoryOrchestratorStore.js';
import { unsealToken } from '../crypto/sealedToken.js';

/**
 * ============================================================================
 * INTERVIEW RECALL: Dual-Perimeter Auth Middleware (middleware/auth.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * 1. LOCAL DRAFT PERIMETER (Zero Network Hop):
 *    - For draft routes (/letter_of_credit/draft/*), the middleware decrypts and
 *      verifies the sealed AEAD opaque token locally using unsealToken().
 *    - Zero network calls to Auth Service. Zero capacity licensing consumed.
 *    - Client can save form drafts even if the WAN link or Auth Service is down.
 * 
 * 2. AUTHORITATIVE DISPATCH PERIMETER (Central Hop + Batch Billing Sync):
 *    - For bank dispatches and sync calls, delegates authoritative session and
 *      active concurrent capacity enforcement to the central Auth Service.
 *    - Concurrently flushes all PENDING milestone receipts in batch, updating
 *      local syncStatus to 'ACKNOWLEDGED' without any background flusher workers.
 */

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:4000';
const NODE_ID = process.env.NODE_ID || 'node-orchestrator-01';

export const authenticateRequest = async (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';

  // 1. Verify Bearer token presence
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Missing or malformed Authorization header. Expected Bearer token.',
    });
  }

  const token = authHeader.slice(7).trim();

  // 2. CHECK ROUTE TYPE: Is this a local draft operation?
  const isDraftRoute = req.path.includes('/draft');

  if (isDraftRoute) {
    // ------------------------------------------------------------------------
    // PERIMETER A: LOCAL OFFLINE VERIFICATION (0 NETWORK HOPS)
    // ------------------------------------------------------------------------
    const unsealed = unsealToken(token);
    if (!unsealed.valid) {
      if (unsealed.error === 'EXPIRED') {
        return res.status(401).json({
          error: 'token_expired',
          message: 'Your session has expired. Please re-authenticate.',
        });
      }
      return res.status(401).json({
        error: 'invalid_token',
        message: 'Invalid or tampered opaque token.',
      });
    }

    // Bind local authentication context (no central hop, no capacity increment)
    req.authContext = {
      clientId: unsealed.clientId,
      userId: unsealed.userId,
      expiresAt: unsealed.expiresAt,
      isLocalDraftAuth: true,
      orchestratorNodeId: NODE_ID,
    };

    return next();
  }

  // --------------------------------------------------------------------------
  // PERIMETER B: AUTHORITATIVE NETWORK HOP (PORT 4000)
  // --------------------------------------------------------------------------

  // 3. Collect all pending milestone billing receipts for batch synchronization
  const pendingReceipts = orchestratorStore.getPendingMilestoneReceipts();

  // 4. Determine workflow action for Active Concurrent Capacity licensing
  let workflowAction = 'INSPECT';
  if (req.method === 'POST' && req.path.includes('/issuance/')) {
    workflowAction = 'INITIATE_WORKFLOW';
  } else if (req.method === 'POST' && req.path.includes('/presentation/')) {
    workflowAction = 'TERMINATE_WORKFLOW';
  }

  try {
    const authResponse = await fetch(`${AUTH_SERVICE_URL}/api/v1/auth/validate-opaque-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Orchestrator-Node-Id': NODE_ID,
      },
      body: JSON.stringify({
        workflow_action: workflowAction,
        piggybacked_billing_receipts: pendingReceipts,
      }),
    });

    if (!authResponse.ok) {
      return res.status(authResponse.status).json({
        error: 'auth_verification_failed',
        message: 'Auth service rejected the verification request',
      });
    }

    const authData = await authResponse.json();

    // 5. Inspect token_status returned by RFC 7662 introspection
    if (authData.token_status !== 'VALID') {
      if (authData.token_status === 'SUSPENDED') {
        return res.status(403).json({
          error: 'forbidden',
          message: 'Client subscription is SUSPENDED or EXPIRED',
        });
      }

      return res.status(401).json({
        error: 'unauthorized',
        message: `Token is ${authData.token_status}`,
      });
    }

    // 6. Verify subscription context is active
    if (authData.subscription_context?.status !== 'ACTIVE') {
      return res.status(403).json({
        error: 'forbidden',
        message: `Enterprise client subscription status is ${authData.subscription_context?.status || 'UNKNOWN'}`,
      });
    }

    // 7. Active Concurrent Capacity Licensing Guard
    if (authData.capacity_status === 'CAPACITY_LIMIT_EXCEEDED') {
      return res.status(429).json({
        error: 'capacity_limit_exceeded',
        message: `Active concurrent capacity limit (${authData.subscription_context?.max_concurrent_workflows}) reached for ${authData.client_id}. Please wait for active LCs to reach settlement.`,
        subscription: authData.subscription_context,
      });
    }

    // 8. Update local milestone ledger with acknowledged receipts
    if (Array.isArray(authData.acknowledged_receipt_ids) && authData.acknowledged_receipt_ids.length > 0) {
      orchestratorStore.acknowledgeMilestoneReceipts(authData.acknowledged_receipt_ids);
    }

    // 9. Bind authoritative context to request object
    req.authContext = {
      clientId: authData.client_id,
      subscription: authData.subscription_context,
      capacityStatus: authData.capacity_status,
      acknowledgedReceiptIds: authData.acknowledged_receipt_ids || [],
      orchestratorNodeId: NODE_ID,
    };

    return next();
  } catch (err) {
    return res.status(503).json({
      error: 'auth_service_unavailable',
      message: `Failed to connect to central Auth Service: ${err.message}`,
    });
  }
};
