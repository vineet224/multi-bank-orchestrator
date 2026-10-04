/**
 * ============================================================================
 * INTERVIEW RECALL: End-to-End System Verification (test-e2e.js)
 * ============================================================================
 * 
 * ITERATION 3 VERIFICATION SUITE:
 * 1. Health Checks (Ports 4000 & 3000)
 * 2. Client Login & Sealed AEAD Opaque Token Issuance (Zero Claim Leakage)
 * 3. Local Offline Draft Creation (0 Central Network Hops, Degraded Mode Safe)
 * 4. Non-Custodial Security Boundary (Rejection of private keys)
 * 5. Strict Two-Step Issuance Pipeline (Draft -> Authoritative Dispatch)
 * 6. Real-World Bank-Assigned LC Numbers (HSBC & SBI ISO 20022 / REST)
 * 7. Two-Step LC Amendment with Bank-Assigned Amendment Number
 * 8. Two-Step LC Document Presentation & Milestone Receipt Creation (syncStatus: PENDING)
 * 9. Milestone Ledger Batch Synchronization via On-Demand /sync-billing (Zero Flusher Worker)
 * 10. Multi-Bank Heterogeneous Crypto Routing (HSBC Local Mock & SBI AWS KMS)
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
  console.log('\n🚀 Starting Iteration 3 End-to-End Multi-Bank Orchestrator Verification...\n');

  // 1. Health Checks
  console.log('--- Step 1: Health Checks ---');
  const authHealth = await fetch(`${AUTH_URL}/health`).then((r) => r.json());
  assert(authHealth.status === 'UP', 'Auth Service is UP on port 4000');

  const orchHealth = await fetch(`${ORCH_URL}/health`).then((r) => r.json());
  assert(orchHealth.status === 'UP', 'Orchestrator Service is UP on port 3000');
  assert(orchHealth.features.includes('Sealed AEAD Opaque Tokens'), 'Orchestrator exposes Sealed AEAD Opaque Tokens');
  assert(orchHealth.features.includes('Offline Local Draft Saving (0 Hops)'), 'Orchestrator exposes Offline Local Drafts');

  // 2. Client Login & Sealed AEAD Token
  console.log('\n--- Step 2: Client Login & Sealed AEAD Opaque Token ---');
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
  assert(loginData.access_token.startsWith('xlt_opq_'), 'Issued sealed AEAD opaque token');
  
  // Verify token is truly opaque and cannot be inspected as plain base64 JSON
  const rawToken = loginData.access_token.replace('xlt_opq_', '');
  let leakedClaims = false;
  try {
    const decoded = Buffer.from(rawToken, 'base64url').toString('utf8');
    if (decoded.includes('tata_steel') || decoded.includes('ACTIVE_CAPACITY_LICENSING')) {
      leakedClaims = true;
    }
  } catch {
    // Expected: cipher string is not plain JSON
  }
  assert(!leakedClaims, 'Zero Claim Leakage: Token cannot be decoded to plaintext claims by browser');
  const token = loginData.access_token;

  // 3. Non-Custodial Security Boundary
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

  // 4. Provision Credentials
  console.log('\n--- Step 4: Provision Pluggable Crypto Configurations ---');
  const hsbcCredsRes = await fetch(`${ORCH_URL}/api/v1/upload/bank-integration/credentials/HSBC`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ cryptoMode: 'LOCAL_MOCK' }),
  });
  assert(hsbcCredsRes.status === 201, 'Onboarded HSBC credentials with LOCAL_MOCK');

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

  // 5. Local Offline Draft Creation (0 Central Network Hops)
  console.log('\n--- Step 5: Local Offline Draft Creation (Zero Central Network Hop) ---');
  const draftRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/draft/issuance/HSBC`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      corporateReference: 'ERP-PO-2026-TATA-001',
      amount: 7500000,
      currency: 'USD',
      applicant: 'Tata Steel Limited',
      beneficiary: 'Australian Coking Coal Corp',
      expiryDate: '2026-11-30',
    }),
  });
  const draftData = await draftRes.json();
  assert(draftRes.status === 201, 'Draft created successfully with status 201');
  assert(draftData.status === 'DRAFT_SAVED', 'Draft saved locally with status DRAFT_SAVED');
  assert(draftData.draft_id.startsWith('DRAFT-LC-'), 'Received unique draft_id');
  assert(draftData.corporate_reference === 'ERP-PO-2026-TATA-001', 'Preserved ERP corporateReference');
  const issuanceDraftId = draftData.draft_id;

  // Verify Draft Retrieval
  const getDraftRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/draft/${issuanceDraftId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const getDraftData = await getDraftRes.json();
  assert(getDraftRes.status === 200, 'Retrieved saved draft locally');
  assert(getDraftData.data.stage === 'DRAFT', 'Draft stage is verified as DRAFT');

  // 6. Strict Two-Step Issuance Pipeline (Consumes draftId -> Bank Generates lcNumber)
  console.log('\n--- Step 6: Strict Two-Step Issuance & Bank-Assigned LC Number ---');
  
  // Negative test: Direct call without draftId must be rejected
  const directRejectRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/issuance/HSBC`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ amount: 1000000 }),
  });
  assert(directRejectRes.status === 400, 'Direct issuance rejected without draftId');

  // Positive test: Dispatch with draftId
  const dispatchRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/issuance/HSBC`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ draftId: issuanceDraftId }),
  });
  const dispatchData = await dispatchRes.json();
  assert(dispatchRes.status === 201, 'Draft promoted and dispatched to HSBC with status 201');
  assert(dispatchData.status === 'CONFIRMED', 'Workflow stage reached CONFIRMED');
  assert(dispatchData.bank_lc_number.startsWith('HSBC-LC-'), 'Bank assigned authoritative lcNumber');
  assert(dispatchData.corporate_reference === 'ERP-PO-2026-TATA-001', 'Preserved ERP corporate reference in bank confirmation');
  assert(dispatchData.bank_reference.startsWith('HSBC-TXN-'), 'Received HSBC bank transaction reference');
  const bankLcNumber = dispatchData.bank_lc_number;
  const workflowId = dispatchData.workflow_id;

  // 7. Two-Step LC Amendment with Bank-Assigned Amendment Number
  console.log('\n--- Step 7: Two-Step LC Amendment & Bank-Assigned Amendment Number ---');
  // Step 7A: Create Amendment Draft
  const amendDraftRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/draft/amendment/HSBC`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      lcNumber: bankLcNumber,
      corporateReference: 'ERP-AMD-REQ-001',
      amendmentDetails: {
        amount: 8500000,
        expiryDate: '2026-12-31',
      },
    }),
  });
  const amendDraftData = await amendDraftRes.json();
  assert(amendDraftRes.status === 201, 'Amendment draft created locally');
  const amendDraftId = amendDraftData.draft_id;

  // Step 7B: Dispatch Amendment
  const amendDispatchRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/amendment/HSBC`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ draftId: amendDraftId }),
  });
  const amendDispatchData = await amendDispatchRes.json();
  assert(amendDispatchRes.status === 200, 'Amendment confirmed by bank');
  assert(amendDispatchData.amendment_number.startsWith('HSBC-AMD-'), 'Bank assigned official amendmentNumber');
  assert(amendDispatchData.lc_number === bankLcNumber, 'Amendment anchored to bankLcNumber');

  // 8. Two-Step Presentation & Milestone Receipt Ledgering
  console.log('\n--- Step 8: Document Presentation & Milestone Ledgering ---');
  // Step 8A: Create Presentation Draft
  const presDraftRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/draft/presentation/HSBC`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      lcNumber: bankLcNumber,
      corporateReference: 'ERP-PRES-REF-001',
      documentManifest: {
        billOfLading: 'BL-99887766',
        commercialInvoice: 'INV-2026-0091',
        certificateOfOrigin: 'COO-AU-IND-443',
      },
    }),
  });
  const presDraftData = await presDraftRes.json();
  assert(presDraftRes.status === 201, 'Presentation draft created locally');
  const presDraftId = presDraftData.draft_id;

  // Step 8B: Dispatch Presentation
  const presDispatchRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/presentation/HSBC`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ draftId: presDraftId }),
  });
  const presDispatchData = await presDispatchRes.json();
  assert(presDispatchRes.status === 200, 'Document presentation accepted and confirmed by bank');
  assert(presDispatchData.presentation_number.startsWith('HSBC-PRES-'), 'Bank assigned official presentationNumber');
  assert(presDispatchData.milestone_receipt.sync_status === 'PENDING', 'Milestone receipt recorded with syncStatus PENDING');

  // 9. Milestone Ledger Batch Synchronization (Zero Background Flusher Worker)
  console.log('\n--- Step 9: Milestone Ledger Batch Sync via On-Demand Endpoint ---');
  const syncRes = await fetch(`${ORCH_URL}/api/v1/sync-billing`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const syncData = await syncRes.json();
  assert(syncRes.status === 200, 'On-demand billing synchronization completed successfully');
  assert(syncData.milestone_ledger_status.pending === 0, 'All milestone receipts acknowledged and ledgered (0 pending)');
  assert(syncData.milestone_ledger_status.acknowledged >= 2, 'Acknowledged receipts count updated in milestone ledger');

  // 10. Multi-Bank Heterogeneous Execution (SBI with AWS KMS)
  console.log('\n--- Step 10: SBI Issuance with AWS KMS & Bank-Assigned SBI LC Number ---');
  const sbiDraftRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/draft/issuance/SBI`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      corporateReference: 'ERP-PO-2026-SBI-002',
      amount: 50000000,
      currency: 'INR',
      applicant: 'Tata Steel Limited',
      beneficiary: 'National Mineral Development Corp',
      expiryDate: '2026-12-15',
    }),
  });
  const sbiDraftData = await sbiDraftRes.json();
  assert(sbiDraftRes.status === 201, 'SBI draft created locally');

  const sbiDispatchRes = await fetch(`${ORCH_URL}/api/v1/letter_of_credit/issuance/SBI`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ draftId: sbiDraftData.draft_id }),
  });
  const sbiDispatchData = await sbiDispatchRes.json();
  assert(sbiDispatchRes.status === 201, 'SBI LC issued with status 201');
  assert(sbiDispatchData.bank_lc_number.startsWith('SBI-LC-'), 'Bank assigned authoritative SBI LC number');
  assert(sbiDispatchData.crypto_execution.provider_mode === 'AWS_KMS', 'Used AWS_KMS provider for non-custodial signing');

  console.log('\n🎉 ALL 10 ITERATION 3 ARCHITECTURAL TEST SUITES PASSED PERFECTLY!\n');
}

runTests().catch((err) => {
  console.error('Fatal error during E2E verification:', err);
  process.exit(1);
});
