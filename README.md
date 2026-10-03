# Multi-Bank Trade Finance Orchestrator Architecture

An enterprise-grade prototype monorepo modeling a zero-trust, non-custodial multi-bank Trade Finance (Letter of Credit) orchestrator. Built for Staff / Principal Engineer (SDE-4) system design interviews and architectural reference.

---

## 🏛️ Architectural Highlights

```mermaid
flowchart TB
    subgraph Corporate_Perimeter ["🏢 Corporate Client Perimeter (Tata Steel On-Prem / VPC)"]
        UI["Corporate UI"] -->|Bearer Opaque Token| ORCH["Bank-Orchestrator-Service\n(:3000)"]
        ORCH -->|Digest: SHA-256 (32 bytes)| KMS["Corporate KMS / HSM / Remote API\n(Non-Custodial: Private Key never leaves)"]
        KMS -->|Signature| ORCH
    end

    subgraph Xalts_Cloud ["☁️ Xalts Central Infra (SaaS)"]
        AUTH["Subscription-Auth-Service\n(:4000)"]
        LEDGER[("Capacity Quota & Billing Ledger")]
        AUTH <--> LEDGER
    end

    subgraph Global_Banks ["🏦 Bank Networks"]
        HSBC["HSBC Gateway\n(ISO 20022: tsmt.019)"]
        SBI["SBI Gateway\n(REST JSON: v2)"]
    end

    ORCH -->|"1. Intentional Network Hop (Introspect Token + Piggyback Usage)"| AUTH
    AUTH -->|"2. Authorize Session + Capacity OK"| ORCH
    ORCH -->|"3. Encrypted (Bank PubKey) + Signed (Client PrivKey)"| HSBC
    ORCH -->|"3. Encrypted + Signed"| SBI
```

1. **Non-Custodial Cryptography Engine (Asymmetric Operation Partitioning)**:
   - **Public Key Ops (In-Process)**: Hybrid envelope encryption (AES-256-GCM + Bank RSA-OAEP) and Bank signature verification execute in-process using Node.js `crypto` at sub-millisecond speeds with zero cloud API costs.
   - **Private Key Ops (Non-Custodial)**: Only the 32-byte `SHA-256` payload digest is dispatched to the client's key provider. The corporate private key never touches the orchestrator.
   - **Pluggable Strategy Pattern**: Seamlessly supports `AWS_KMS` (`MessageType: DIGEST`), `AZURE_VAULT`, `REMOTE_API` (Keyless Webhook), and `LOCAL_MOCK`.

2. **Hybrid Perimeter & Data Sovereignty**:
   - For enterprise clients with strict data residency requirements (e.g., Tata), the UI and `orchestrator-service` run inside the client's own VPC/datacenter. Sensitive trade documents never leave the corporate boundary.
   - Only high-entropy opaque session tokens and anonymized capacity/billing receipts cross the WAN to Xalts.

3. **Amortized Network Hop with Piggybacked Capacity Licensing**:
   - The UI-to-Orchestrator opaque token validation incurs an intentional network hop to `auth-service`.
   - We turn this latency into an architectural asset by **piggybacking active concurrent capacity checks (`activeWorkflows < maxConcurrentWorkflows`) and terminal-state billing receipts (`DOCUMENTS_PRESENTED`)** onto the exact same HTTP roundtrip.

4. **Financial Idempotency & Two-Step Bank Transitions**:
   - Deterministic Idempotency Key: `hash(clientId + lcNumber + contractVersion)`.
   - Two-step state machine: `LC_INITIATED` $\to$ `DISPATCHED_PENDING_ACK` $\to$ `ISSUANCE_CONFIRMED`.
   - Network drops or retries query bank status rather than generating duplicate multi-million dollar credit obligations.

5. **Machine-to-Machine (M2M) Platform Channel Trust & Idle Flusher**:
   - Background worker drains un-piggybacked receipts if UI traffic goes idle for > 30 seconds using platform M2M credentials (`X-Platform-Node-Id` and `X-Platform-Secret`).

---

## 📁 Project Structure

```text
multi-bank-orchestrator/
├── auth-service/                          # Port 4000 (Centralized Xalts Tenancy & Auth)
│   ├── src/
│   │   ├── controllers/authController.js  # Token introspection, capacity licensing & ledger sink
│   │   ├── routes/auth.routes.js          # Auth & M2M routes
│   │   ├── server.js                      # Express entrypoint
│   │   └── storage/inMemoryAuthStore.js   # In-memory tenant, token & deduplicated billing store
│   └── package.json
│
├── orchestrator-service/                  # Port 3000 (Multi-Bank Gateway)
│   ├── src/
│   │   ├── crypto/
│   │   │   ├── cryptoProvider.interface.js # Envelope encryption & digest signing contract
│   │   │   ├── cryptoProviderFactory.js   # Dynamic provider factory
│   │   │   └── providers/
│   │   │       ├── awsKmsProvider.js      # AWS KMS adapter (MessageType: DIGEST)
│   │   │       ├── azureVaultProvider.js  # Azure Key Vault adapter
│   │   │       ├── remoteWebhookProvider.js # Client Keyless Signing Webhook adapter
│   │   │       └── localMockProvider.js   # In-memory RSA-2048 keypair for testing
│   │   ├── services/
│   │   │   ├── bankConnector.service.js   # Cryptographic dispatch & verification pipeline
│   │   │   └── bankAdapters/
│   │   │       ├── hsbcAdapter.js         # HSBC ISO 20022 formatting & gateway simulator
│   │   │       └── sbiAdapter.js          # SBI REST format & gateway simulator
│   │   ├── controllers/
│   │   │   └── orchestratorController.js  # LC issuance, amendment & presentation handlers
│   │   ├── middleware/auth.js             # Intentional network hop & capacity quota check
│   │   ├── workers/idleReceiptFlusher.js  # Background M2M queue drain worker
│   │   └── storage/
│   │       └── inMemoryOrchestratorStore.js # Non-custodial credential & workflow store
│   └── package.json
│
├── scripts/
│   ├── dev.js                             # Concurrently starts both services
│   ├── test-e2e.js                        # Complete 10-suite architectural test runner
│   └── run-and-test.js                    # Automated spawn -> verify -> teardown harness
└── package.json
```

---

## 🚀 Running the System

### 1. Run Automated Verification Test Suite (10 Architecture Tests)
Executes health checks, login, non-custodial security rejection, HSBC issuance, SBI AWS KMS issuance, amendment, document presentation, piggybacked billing, and M2M platform flushing:
```bash
node scripts/run-and-test.js
```

### 2. Start Both Microservices for Manual API Testing
```bash
npm run dev
```
- **Auth Service**: `http://localhost:4000`
- **Orchestrator Service**: `http://localhost:3000`

---

## 📡 API Reference

### 🔐 Central Auth Service (Port 4000)
- `POST /api/v1/auth/clients` — Onboard enterprise tenant with capacity limits
- `POST /api/v1/auth/login` — Exchange client credentials for high-entropy opaque bearer token
- `POST /api/v1/auth/validate-opaque-token` — Authoritative RFC 7662 token inspection + capacity licensing + piggybacked billing sink
- `POST /api/v1/auth/m2m-flush-receipts` — M2M platform channel for background flusher
- `POST /api/v1/auth/revoke` — Session revocation kill switch

### 🏦 Orchestrator Service (Port 3000)
- `POST /api/v1/upload/bank-integration/credentials/:bankId` — Non-custodial credential onboarding (`LOCAL_MOCK`, `AWS_KMS`, `AZURE_VAULT`, `REMOTE_API`)
- `GET  /api/v1/bank-integration/credentials/:bankId` — View configured provider and bank public keys
- `POST /api/v1/letter_of_credit/issuance/:bankId` — 2-step financial transition + signing & envelope encryption
- `POST /api/v1/letter_of_credit/amendment/:bankId` — Contract version increment & bank dispatch
- `POST /api/v1/letter_of_credit/presentation/:bankId` — Document presentation + enqueues terminal billing receipt
- `GET  /api/v1/letter_of_credit/:bankId?workflowId=<id>` — Query workflow details & cryptographic audit trail
