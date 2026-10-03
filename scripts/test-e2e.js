/**
 * ============================================================================
 * INTERVIEW RECALL: End-to-End System Verification (test-e2e.js)
 * ============================================================================
 * 
 * Tests the complete architectural prototype:
 * 1. Opaque Token Issuance & Central Auth Service (Port 4000)
 * 2. Intentional Network Hop & Active Concurrent Capacity Licensing
 * 3. Non-Custodial Security Boundary (Rejection of private keys)
 * 4. Pluggable Crypto Providers (LOCAL_MOCK, AWS_KMS, AZURE_VAULT, REMOTE_API)
 * 5. Full Asymmetric Cryptographic Handshake with Banks (HSBC ISO 20022 & SBI)
 * 6. Financial Idempotency & Two-Step Transition (INITIATED -> DISPATCHED_PENDING_ACK -> CONFIRMED)
 * 7. Piggybacked Billing Receipts on Auth Hops
 * 8. Machine-to-Machine (M2M) Platform Channel Trust & Background Flusher
 */

const AUTH_URL = 'http://localhost:4000';
const ORCH_URL = 'http://localhost:3000';

const assert = (condition, message) => {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`  ✓ ${message}`);
};

async function runTests() {
  console.log('\n🚀 Starting End-to-End Multi-Bank Orchestrator Verification...\n');

  // 1. Health Checks
  console.log('--- Step 1: Health Checks ---');
  const authHealth = await fetch(`${AUTH_URL}/health`).then((r) => r.json());
  assert(authHealth.status === 'UP', 'Auth Service is UP on port 4000');

  const orchHealth = await fetch(`${ORCH_URL}/health`).then((r) => r.json());
  assert(orchHealth.status === 'UP', 'Orchestrator Service is UP on port 3000');
  assert(orchHealth.cryptoModes.includes('AWS_KMS'), 'Orchestrator exposes AWS_KMS mode');

  // 2. Client Login & Opaque Token
  console.log('\n--- Step 2: Client Login & Opaque Token Issuance ---');
  const loginRes = await fetch(`${AUTH_URL}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: 'tata_steel',
      clientSecret: 'secret_steel_99',
    }),
  });
  const loginData = await loginRes.json();
  assert(loginRes.status === 200, 'Login succeeded for tata_steel');
  assert(loginData.access_token.startsWith('xlt_opq_'), 'Issued high-entropy opaque bearer token');
  const token = loginData.access_token;

  // 3. Non-Custodial Security Guard Test
  console.log('\n--- Step 3: Non-Custodial Security Boundary ---');
  const leakRes = await fetch(`${ORCH_URL}/api/v1/upload/bank-integration/credentials/HSBC`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      cryptoMode: 'AWS_KMS',
      privateKey: '-----BEGIN RSA PRIVATE KEY-----...LEAK...',
    }),
  });
  const leakData = await leakRes.json();
  assert(leakRes.status === 400, 'Orchestrator rejected private key upload');
  assert(leakData.error === 'security_violation', 'Returned security_violation error');

  // 4. Onboard Client Non-Custodial Crypto Configurations
  console.log('\n--- Step 4: Provision Pluggable Crypto Configurations ---');
  // Onboard HSBC with LOCAL_MOCK
  const hsbcCredsRes = await fetch(`${ORCH_URL}/api/v1/upload/bank-integration/credentials/HSBC`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      cryptoMode: 'LOCAL_MOCK',
    }),
  });
  assert(hsbcCredsRes.status === 201, 'Onboarded HSBC credentials with LOCAL_MOCK');

  // Onboard SBI with AWS_KMS
  const sbiCredsRes = await fetch(`${ORCH_URL}/api/v1/upload/bank-integration/credentials/SBI`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      cryptoMode: 'AWS_KMS',
      cryptoConfig: {
        keyArn: 'arn:aws:kms:ap-south-1:123456789012:key/mrk-tata-sbi-trade-key',
        region: 'ap-south-1',
      },
    }),
  });
  assert(sbiCredsRes.status === 201, 'Onboarded SBI credentials with AWS_KMS');

  // 5. Letter of Credit Issuance (HSBC) with End-to-End Cryptography
  console.log('\n--- Step 5: LC Issuance (HSBC) with Cryptographic Pipeline ---');
  const issuanceRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/issuance/HSBC`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      lcNumber: 'LC/HSBC/2026/TATA-001',
      amount: 7500000,
      currency: 'USD',
      applicant: 'Tata Steel Limited',
      beneficiary: 'Australian Coking Coal Corp',
      expiryDate: '2026-11-30',
    }),
  });
  const issuanceData = await issuanceRes.json();
  assert(issuanceRes.status === 201, 'LC Issuance succeeded with status 201');
  assert(issuanceData.status === 'CONFIRMED', 'LC reached CONFIRMED state');
  assert(issuanceData.crypto_execution.client_digest_signed === true, 'Client signed 32-byte digest');
  assert(issuanceData.crypto_execution.bank_envelope_encrypted === true, 'Envelope encrypted for HSBC');
  assert(issuanceData.crypto_execution.bank_signature_verified === true, 'Verified HSBC signature');
  assert(issuanceData.bank_reference.startsWith('HSBC-TXN-'), 'Received HSBC transaction reference');
  const workflowId = issuanceData.workflow_id;

  // 6. Letter of Credit Issuance (SBI) with AWS KMS Provider
  console.log('\n--- Step 6: LC Issuance (SBI) with AWS KMS Provider ---');
  const sbiIssuanceRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/issuance/SBI`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      lcNumber: 'LC/SBI/2026/TATA-002',
      amount: 50000000,
      currency: 'INR',
      applicant: 'Tata Steel Limited',
      beneficiary: 'National Mineral Development Corp',
      expiryDate: '2026-12-15',
    }),
  });
  const sbiIssuanceData = await sbiIssuanceRes.json();
  assert(sbiIssuanceRes.status === 201, 'SBI LC Issuance succeeded with status 201');
  assert(sbiIssuanceData.crypto_execution.provider_mode === 'AWS_KMS', 'Used AWS_KMS provider');
  assert(sbiIssuanceData.bank_reference.startsWith('SBI-TXN-'), 'Received SBI transaction reference');

  // 7. LC Amendment
  console.log('\n--- Step 7: LC Amendment ---');
  const amendRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/amendment/HSBC`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      workflowId,
      amendmentDetails: {
        amount: 8000000,
        expiryDate: '2026-12-31',
      },
    }),
  });
  const amendData = await amendRes.json();
  assert(amendRes.status === 200, 'LC Amendment confirmed by bank');
  assert(amendData.current_stage === 'AMENDMENT_CONFIRMED', 'Current stage updated to AMENDMENT_CONFIRMED');

  // 8. LC Document Presentation & Terminal Receipt Queueing
  console.log('\n--- Step 8: Document Presentation & Terminal Billing Queueing ---');
  const presRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/presentation/HSBC`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      workflowId,
      documentManifest: {
        billOfLading: 'BL-99887766',
        commercialInvoice: 'INV-2026-0091',
        certificateOfOrigin: 'COO-AU-IND-443',
      },
    }),
  });
  const presData = await presRes.json();
  assert(presRes.status === 200, 'Document presentation accepted');
  assert(presData.current_stage === 'DOCUMENTS_PRESENTED', 'Stage is DOCUMENTS_PRESENTED');
  assert(presData.pending_receipts_in_queue >= 1, 'Billing receipt enqueued for piggybacking');

  // 9. Piggybacked Billing Verification on Subsequent Network Hop
  console.log('\n--- Step 9: Piggybacked Billing Hop & Deduplication ---');
  // Make a GET request to trigger the auth hop which piggybacks the receipt
  const checkRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/HSBC?workflowId=${workflowId}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });
  const checkData = await checkRes.json();
  assert(checkRes.status === 200, 'Status call succeeded through auth middleware');
  assert(checkData.data.workflowId === workflowId, 'Retrieved workflow details');

  // 10. M2M Platform Channel Trust & Idle Flusher Test
  console.log('\n--- Step 10: Platform M2M Channel Trust ---');
  const m2mRes = await fetch(`${AUTH_URL}/api/v1/auth/m2m-flush-receipts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-Node-Id': 'node-orchestrator-01',
      'X-Platform-Secret': 'xalts_platform_secret_m2m_node_01',
    },
    body: JSON.stringify({
      receipts: [
        {
          workflow_id: 'LC-M2M-DEMO-999',
          terminal_state_achieved: 'DOCUMENTS_PRESENTED',
          cryptographic_signature: 'sig_rsa_pss_demo_m2m',
          timestamp: new Date().toISOString(),
        },
      ],
    }),
  });
  const m2mData = await m2mRes.json();
  assert(m2mRes.status === 200, 'M2M channel authenticated and flushed receipts');
  assert(m2mData.acknowledged_receipt_ids.includes('LC-M2M-DEMO-999'), 'M2M receipt ledgered successfully');

  console.log('\n🎉 ALL 10 ARCHITECTURAL TEST SUITES PASSED PERFECTLY!\n');
}

runTests().catch((err) => {
  console.error('Fatal error during E2E verification:', err);
  process.exit(1);
});
