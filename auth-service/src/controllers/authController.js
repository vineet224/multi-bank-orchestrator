import crypto from 'crypto';
import { authStore } from '../storage/inMemoryAuthStore.js';

/**
 * ============================================================================
 * INTERVIEW RECALL REFERENCE: Auth Controller & DTO Mapping (authController.js)
 * ============================================================================
 * 
 * Execution Flow & Design Concepts:
 * 1. Opaque Token Pattern (RFC 6749):
 *    - Instead of stateless JWTs, we issue high-entropy 48-char random hex strings.
 *    - Allows instantaneous revocation (kill switch) without waiting for token expiry.
 * 2. Authoritative Inspection (RFC 7662 Token Introspection):
 *    - Orchestrator sends Bearer token + optional piggybacked billing receipt.
 *    - Auth service validates token + subscription status and records billing atomically.
 * 3. Compact DTO Mapping:
 *    - Inline DTO transforms decouple storage representations from external API contracts.
 */

// ============================================================================
// INLINE DTO FACTORIES / SERIALIZERS
// ============================================================================

/**
 * DTO: Baseline client response
 */
const toClientResponseDTO = (client) => ({
  client_id: client.clientId,
  subscription_status: client.subscription.status,
  billing_model: client.subscription.billingModel,
  max_concurrent_workflows: client.subscription.maxConcurrentWorkflows,
  active_workflows: client.subscription.activeWorkflows,
});

/**
 * DTO: Token issue response
 */
const toLoginResponseDTO = (token, ttlSeconds) => ({
  token_type: 'Opaque',
  access_token: token,
  expires_in_seconds: ttlSeconds,
});

/**
 * DTO: Authoritative token inspection response
 */
const toIntrospectionResponseDTO = ({
  status,
  clientId = null,
  subscription = null,
  billingStatus = 'NOT_ATTACHED',
  issuedAt = null,
  expiresInSeconds = 0,
}) => ({
  token_status: status,
  client_id: clientId,
  ...(subscription && {
    subscription_context: {
      status: subscription.status,
      billing_model: subscription.billingModel,
      concurrent_workflows_active: subscription.activeWorkflows,
      max_concurrent_workflows: subscription.maxConcurrentWorkflows,
    },
  }),
  billing_receipt_status: billingStatus,
  ...(issuedAt && {
    session_metadata: {
      issued_at: issuedAt,
      expires_in_seconds: Math.max(0, expiresInSeconds),
    },
  }),
});

// ============================================================================
// CONTROLLER HANDLERS
// ============================================================================

/**
 * POST /api/v1/auth/clients
 * Onboard a new enterprise tenant
 */
export const registerClient = (req, res) => {
  const { clientId, clientSecret, maxConcurrentWorkflows = 50 } = req.body;

  if (!clientId || !clientSecret) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Both clientId and clientSecret are required',
    });
  }

  // Create ClientRecord entity
  const clientRecord = {
    clientId,
    clientSecret,
    subscription: {
      status: 'ACTIVE',
      billingModel: 'ACTIVE_CAPACITY_LICENSING',
      maxConcurrentWorkflows: Number(maxConcurrentWorkflows),
      activeWorkflows: 0,
    },
  };

  const saved = authStore.saveClient(clientRecord);
  return res.status(201).json(toClientResponseDTO(saved));
};

/**
 * POST /api/v1/auth/login
 * Authenticate client credentials and issue high-entropy opaque token
 */
export const login = (req, res) => {
  const { clientId, clientSecret } = req.body;

  if (!clientId || !clientSecret) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'clientId and clientSecret are required',
    });
  }

  const client = authStore.findClient(clientId);
  if (!client || client.clientSecret !== clientSecret) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Invalid client credentials',
    });
  }

  if (client.subscription.status !== 'ACTIVE') {
    return res.status(403).json({
      error: 'forbidden',
      message: `Client subscription is ${client.subscription.status}`,
    });
  }

  // Generate high-entropy opaque token (prefix + 48-char random hex = 24 bytes)
  const token = `xlt_opq_${crypto.randomBytes(24).toString('hex')}`;
  const TTL_SECONDS = 3600;

  authStore.storeToken(token, { clientId, ttlSeconds: TTL_SECONDS });

  return res.status(200).json(toLoginResponseDTO(token, TTL_SECONDS));
};

/**
 * POST /api/v1/auth/validate-opaque-token
 * Authoritative inspection endpoint (OAuth2 RFC 7662 style)
 * Headers: Authorization: Bearer <token>, X-Orchestrator-Node-Id: <nodeId>
 * Body: Optional { piggybacked_billing_receipt?: BillingReceipt }
 */
export const validateOpaqueToken = (req, res) => {
  const authHeader = req.headers['authorization'] || '';
  const orchestratorNodeId = req.headers['x-orchestrator-node-id'] || 'unknown-node';
  const { piggybacked_billing_receipt } = req.body || {};

  // 1. Extract Bearer token
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
  if (!token) {
    return res.status(200).json(
      toIntrospectionResponseDTO({ status: 'INVALID' })
    );
  }

  // 2. Validate token existence and TTL
  const { exists, isExpired, tokenRecord } = authStore.getToken(token);
  if (!exists) {
    return res.status(200).json(
      toIntrospectionResponseDTO({ status: 'INVALID' })
    );
  }

  if (isExpired) {
    return res.status(200).json(
      toIntrospectionResponseDTO({ status: 'EXPIRED' })
    );
  }

  if (tokenRecord.status === 'REVOKED') {
    return res.status(200).json(
      toIntrospectionResponseDTO({ status: 'REVOKED' })
    );
  }

  // 3. Verify client subscription status
  const client = authStore.findClient(tokenRecord.clientId);
  if (!client || client.subscription.status !== 'ACTIVE') {
    return res.status(200).json(
      toIntrospectionResponseDTO({ status: 'SUSPENDED', clientId: tokenRecord.clientId })
    );
  }

  // 4. Atomically persist piggybacked billing receipt if attached
  let billingStatus = 'NOT_ATTACHED';
  if (piggybacked_billing_receipt && piggybacked_billing_receipt.workflow_id) {
    authStore.recordBilling({
      ...piggybacked_billing_receipt,
      orchestratorNodeId,
    });
    billingStatus = 'ACKNOWLEDGED_AND_LEDGERED';
  }

  // 5. Calculate remaining TTL in seconds
  const remainingSeconds = Math.round((tokenRecord.expiresAt - Date.now()) / 1000);

  return res.status(200).json(
    toIntrospectionResponseDTO({
      status: 'VALID',
      clientId: client.clientId,
      subscription: client.subscription,
      billingStatus,
      issuedAt: tokenRecord.issuedAt,
      expiresInSeconds: remainingSeconds,
    })
  );
};

/**
 * POST /api/v1/auth/revoke
 * Administrative session kill switch
 */
export const revoke = (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Token is required for revocation',
    });
  }

  const revoked = authStore.revokeToken(token);
  return res.status(200).json({ revoked });
};
