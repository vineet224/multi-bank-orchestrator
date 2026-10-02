import { orchestratorStore } from '../storage/inMemoryOrchestratorStore.js';

/**
 * ============================================================================
 * INTERVIEW RECALL: Network Hop Middleware (middleware/auth.js)
 * ============================================================================
 * 
 * Architectural Purpose:
 * - Represents the INTENTIONAL NETWORK HOP from the Orchestrator to Auth Service.
 * - Even though a client has a valid session token, the orchestrator delegates
 *   authoritative session & capacity subscription validation to Auth Service.
 * - Concurrently drains and piggybacks completed workflow receipts to Auth Service
 *   in the same HTTP roundtrip, avoiding an extra billing network call.
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

  // 2. Dequeue pending billing receipt (if available) to piggyback onto auth hop
  const pendingReceipt = orchestratorStore.dequeueNextBillingReceipt();

  try {
    // 3. Intentional Network Hop to Auth Service (Port 4000)
    const authResponse = await fetch(`${AUTH_SERVICE_URL}/api/v1/auth/validate-opaque-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Orchestrator-Node-Id': NODE_ID,
      },
      body: JSON.stringify({
        ...(pendingReceipt && { piggybacked_billing_receipt: pendingReceipt }),
      }),
    });

    if (!authResponse.ok) {
      // Re-queue receipt if auth call failed unexpectedly
      if (pendingReceipt) orchestratorStore.enqueueBillingReceipt(pendingReceipt);
      return res.status(authResponse.status).json({
        error: 'auth_verification_failed',
        message: 'Auth service rejected the verification request',
      });
    }

    const authData = await authResponse.json();

    // 4. Inspect token_status returned by RFC 7662 introspection
    if (authData.token_status !== 'VALID') {
      // Re-queue receipt if token was invalid
      if (pendingReceipt) orchestratorStore.enqueueBillingReceipt(pendingReceipt);

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

    // 5. Verify subscription context is active
    if (authData.subscription_context?.status !== 'ACTIVE') {
      if (pendingReceipt) orchestratorStore.enqueueBillingReceipt(pendingReceipt);
      return res.status(403).json({
        error: 'forbidden',
        message: `Enterprise client subscription status is ${authData.subscription_context?.status || 'UNKNOWN'}`,
      });
    }

    // 6. Bind authoritative context to request object
    req.authContext = {
      clientId: authData.client_id,
      subscription: authData.subscription_context,
      billingReceiptStatus: authData.billing_receipt_status,
      sessionMetadata: authData.session_metadata,
      orchestratorNodeId: NODE_ID,
    };

    next();
  } catch (err) {
    // Re-queue receipt so it is not lost
    if (pendingReceipt) orchestratorStore.enqueueBillingReceipt(pendingReceipt);

    console.error('[Network Hop Error] Failed to reach Auth Service:', err.message);
    return res.status(503).json({
      error: 'service_unavailable',
      message: 'Auth service network hop failed. Ensure Auth Service is running on port 4000.',
    });
  }
};
