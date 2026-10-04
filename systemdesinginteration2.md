# Multi-Bank Trade Finance Orchestrator — Combined System Design & Low-Level Architecture (Iteration 2)

> **Architectural Level**: Staff / Principal Software Engineer (SDE-4)  
> **Systems Covered**: `Auth-Subscription-Service` (Port 4000) & `Bank-Orchestrator-Service` (Port 3000)  
> **Domain**: Enterprise B2B Trade Finance (Letter of Credit Lifecycle across Global Banks)  
> **Deployment Topology**: Hybrid Multi-Perimeter (SaaS at Xalts Cloud vs. Self-Hosted On-Prem inside Corporate VPC)

---

## Table of Contents
1. [Executive Summary & High-Level System Architecture](#1-executive-summary--high-level-system-architecture)
2. [Detailed Low-Level Design (LLD)](#2-detailed-low-level-design-lld)
   - 2.1 [Component Topology & Trust Boundaries](#21-component-topology--trust-boundaries)
   - 2.2 [Data Models & In-Memory Entity Schemas](#22-data-models--in-memory-entity-schemas)
   - 2.3 [Class Diagrams & Interface Contracts](#23-class-diagrams--interface-contracts)
   - 2.4 [End-to-End Sequence Diagrams](#24-end-to-end-sequence-diagrams)
   - 2.5 [Finite State Machines (Letter of Credit Lifecycle)](#25-finite-state-machines-letter-of-credit-lifecycle)
3. [Major Engineering Decisions & Technical Rationales](#3-major-engineering-decisions--technical-rationales)
4. [Production Engineering Challenges & War Stories](#4-production-engineering-challenges--war-stories)
5. [In-Depth Trade-Off Analysis Matrix](#5-in-depth-trade-off-analysis-matrix)
6. [Staff / SDE-4 Interview Strategy: How to Present & Defend](#6-staff--sde-4-interview-strategy-how-to-present--defend)
7. [Future Production-Grade Evolution (Staff+ Roadmap)](#7-future-production-grade-evolution-staff-roadmap)

---

## 1. Executive Summary & High-Level System Architecture

The platform serves as an enterprise trade finance aggregation layer that allows multinational corporate clients (e.g., Tata Steel) to manage multi-million dollar **Letter of Credit (LC)** lifecycles across heterogeneous global banking networks (e.g., **HSBC** and **SBI**) without integrating with each bank's proprietary protocol individually.

### Core Architectural Reality: The Dual-Perimeter Challenge
Enterprise clients operate under strict legal data sovereignty and financial compliance mandates:
- **SaaS Deployment**: All services run inside Xalts cloud infrastructure.
- **Self-Hosted / On-Prem Deployment**: The UI and `Bank-Orchestrator-Service` run inside the corporate client's own VPC/datacenter (e.g., Tata's private cloud). Sensitive trade documents, commercial contracts, and bills of lading **never cross the corporate perimeter**.
- **Centralized Anchor**: The `Subscription-Auth-Service` **always** runs centralized inside Xalts cloud. It acts as the single authoritative source of truth for corporate tenancy, session validity, and active concurrent capacity licensing.

```mermaid
flowchart TB
    subgraph Corporate_Perimeter ["🏢 Corporate Perimeter (Tata Steel On-Prem / VPC)"]
        UI["Corporate Web UI / ERP"] -->|1. Bearer Opaque Token| ORCH["Bank-Orchestrator-Service (:3000)"]
        
        subgraph Crypto_Engine ["Non-Custodial Cryptography Engine"]
            CFG["CryptoProviderFactory"] --> KMS["AWS KMS / Azure Vault / Remote Webhook\n(Private Key never leaves client perimeter)"]
        end
        
        ORCH -->|Digest: SHA-256 (32 bytes)| CFG
        CFG -->|Base64 Client Signature| ORCH
    end

    subgraph Xalts_Cloud ["☁️ Xalts Central Cloud (Authoritative SaaS)"]
        AUTH["Subscription-Auth-Service (:4000)"]
        LEDGER[("Capacity Quota & Deduplicated Billing Ledger")]
        AUTH <--> LEDGER
    end

    subgraph Banking_Networks ["🏦 Global Banking Infrastructure"]
        HSBC["HSBC Gateway\n(ISO 20022 tsmt.019)"]
        SBI["SBI Gateway\n(REST JSON v2)"]
    end

    ORCH -->|"2. Intentional Network Hop (Introspect Token + Piggyback Usage)"| AUTH
    AUTH -->|"3. Authorized + Capacity OK"| ORCH
    ORCH -->|"4. Encrypted (Bank PubKey) + Signed (Client PrivKey)"| HSBC
    ORCH -->|"4. Encrypted + Signed"| SBI
    ORCH -.->|"5. Stale Queue Flush (M2M Channel)"| AUTH
```

---

## 2. Detailed Low-Level Design (LLD)

### 2.1 Component Topology & Trust Boundaries

The system is partitioned into two autonomous microservices communicating over strictly defined cryptographic boundaries:

```mermaid
graph TD
    subgraph Service1 ["🔐 Auth-Subscription-Service (Port 4000)"]
        AuthController["controllers/authController.js"]
        AuthStore["storage/inMemoryAuthStore.js"]
        
        ClientsTable[("Map: clients<br/>[clientId, ClientRecord]")]
        TokensTable[("Map: opaqueTokens<br/>[token, TokenRecord]")]
        LedgerTable[("Map: billingLedger<br/>[dedupeKey, BillingReceipt]")]
        
        AuthController --> AuthStore
        AuthStore --> ClientsTable
        AuthStore --> TokensTable
        AuthStore --> LedgerTable
    end

    subgraph Service2 ["🏦 Bank-Orchestrator-Service (Port 3000)"]
        OrchRouter["routes/orchestrator.routes.js"]
        AuthMiddleware["middleware/auth.js"]
        OrchController["controllers/orchestratorController.js"]
        OrchStore["storage/inMemoryOrchestratorStore.js"]
        
        subgraph CryptoModule ["crypto/"]
            ProviderFactory["cryptoProviderFactory.js"]
            ProviderInterface["cryptoProvider.interface.js"]
            AwsKms["providers/awsKmsProvider.js"]
            AzureVault["providers/azureVaultProvider.js"]
            RemoteApi["providers/remoteWebhookProvider.js"]
            LocalMock["providers/localMockProvider.js"]
            
            ProviderFactory --> ProviderInterface
            ProviderInterface <|-- AwsKms
            ProviderInterface <|-- AzureVault
            ProviderInterface <|-- RemoteApi
            ProviderInterface <|-- LocalMock
        end

        subgraph BankModule ["services/"]
            ConnectorService["bankConnector.service.js"]
            HsbcAdapter["bankAdapters/hsbcAdapter.js"]
            SbiAdapter["bankAdapters/sbiAdapter.js"]
            
            ConnectorService --> HsbcAdapter
            ConnectorService --> SbiAdapter
        end

        Worker["workers/idleReceiptFlusher.js"]

        OrchRouter --> AuthMiddleware
        AuthMiddleware --> OrchController
        OrchController --> ProviderFactory
        OrchController --> ConnectorService
        OrchController --> OrchStore
        Worker --> OrchStore
    end

    AuthMiddleware -->|POST /validate-opaque-token| AuthController
    Worker -->|POST /m2m-flush-receipts| AuthController
```

---

### 2.2 Data Models & In-Memory Entity Schemas

#### 1. Auth Service Storage Entities (`auth-service/src/storage/inMemoryAuthStore.js`)

```typescript
interface ClientRecord {
  clientId: string;               // PK: e.g., 'tata_steel'
  clientSecret: string;           // Hash/Secret for login authentication
  subscription: {
    status: 'ACTIVE' | 'SUSPENDED' | 'EXPIRED';
    billingModel: 'ACTIVE_CAPACITY_LICENSING';
    maxConcurrentWorkflows: number; // e.g., 100 concurrent active LCs
    activeWorkflows: number;        // Real-time counter of in-flight LCs
  };
}

interface TokenRecord {
  token: string;                  // PK: 'xlt_opq_' + 48-char hex (24 bytes entropy)
  clientId: string;               // FK to ClientRecord
  issuedAt: string;               // ISO 8601 timestamp
  expiresAt: number;              // Epoch milliseconds (TTL: 3600s)
  status: 'ACTIVE' | 'REVOKED';
}

interface BillingReceipt {
  workflow_id: string;            // e.g., 'LC-1727889600000-a1b2c3'
  terminal_state_achieved: string;// e.g., 'DOCUMENTS_PRESENTED'
  cryptographic_signature: string;// RSA-PSS signature generated at milestone
  timestamp: string;              // Milestone ISO 8601
  ledgeredAt?: string;            // Timestamp persisted in central ledger
  orchestratorNodeId?: string;    // Ingesting node identifier
  dedupeKey?: string;             // PK: `${workflow_id}_${terminal_state_achieved}`
}
```

#### 2. Orchestrator Service Storage Entities (`orchestrator-service/src/storage/inMemoryOrchestratorStore.js`)

```typescript
interface BankCredentialRecord {
  clientId: string;               // Compound PK part 1
  bankId: 'HSBC' | 'SBI';         // Compound PK part 2
  clientPublicKey: string;        // PEM format (used to verify client responses)
  bankPublicKey: string;          // PEM format (used to encrypt for bank)
  cryptoMode: 'LOCAL_MOCK' | 'AWS_KMS' | 'AZURE_VAULT' | 'REMOTE_API';
  cryptoConfig: {
    keyArn?: string;              // AWS KMS Key ARN
    region?: string;              // AWS Region
    vaultUrl?: string;            // Azure Key Vault URL
    keyName?: string;             // Azure Key Name
    webhookUrl?: string;          // Client Remote Signing URL
    authToken?: string;           // Webhook Bearer Token
  };
  updatedAt: string;
}

interface WorkflowInstanceRecord {
  workflowId: string;             // PK: `LC-${timestamp}-${hex}`
  clientId: string;
  bankId: 'HSBC' | 'SBI';
  type: 'ISSUANCE' | 'AMENDMENT' | 'PRESENTATION';
  currentStage: 
    | 'LC_INITIATED' 
    | 'DISPATCHED_PENDING_ACK' 
    | 'ISSUANCE_CONFIRMED' 
    | 'AMENDMENT_CONFIRMED' 
    | 'DOCUMENTS_PRESENTED' 
    | 'DISPATCH_FAILED';
  genericContract: {
    lcNumber: string;
    amount: number;
    currency: string;
    applicant: string;
    beneficiary: string;
    expiryDate: string;
    version: number;              // Monotonically increasing for amendments
  };
  history: Array<{
    stage: string;
    timestamp: string;
    trigger: string;
    metadata: Record<string, any>;
  }>;
}
```

---

### 2.3 Class Diagrams & Interface Contracts

```mermaid
classDiagram
    class CryptoProviderInterface {
        <<interface>>
        +getProviderType() string
        +getPublicKeyPem() string
        +signDigest(digestBuffer: Buffer) Promise~string~
        +decryptPayload(envelope: Object) Promise~string~
        +encryptForBank(payload: Object, bankPublicKeyPem: string) Object
        +verifyBankSignature(payload: Object, sigBase64: string, bankPublicKeyPem: string) boolean
    }

    class LocalMockProvider {
        -string publicKeyPem
        -string _isolatedPrivateKeyPem
        +signDigest(digestBuffer) Promise~string~
        +decryptPayload(envelope) Promise~string~
    }

    class AwsKmsProvider {
        -string keyArn
        -string region
        -string signingAlgorithm
        +signDigest(digestBuffer) Promise~string~
        +decryptPayload(envelope) Promise~string~
    }

    class AzureVaultProvider {
        -string vaultUrl
        -string keyName
        +signDigest(digestBuffer) Promise~string~
        +decryptPayload(envelope) Promise~string~
    }

    class RemoteWebhookProvider {
        -string webhookUrl
        -string authToken
        -number timeoutMs
        +signDigest(digestBuffer) Promise~string~
        +decryptPayload(envelope) Promise~string~
    }

    class CryptoProviderFactory {
        <<static>>
        +create(credentialRecord: Object) CryptoProviderInterface
    }

    class BankConnectorService {
        -Map adapters
        +getAdapter(bankId: string) BankAdapterInterface
        +generateIdempotencyKey(clientId, lcNumber, version) string
        +dispatchToBank(params: Object) Promise~Object~
    }

    class HsbcBankAdapter {
        -string bankPublicKeyPem
        -string _bankPrivateKeyPem
        -Set processedIdempotencyKeys
        +formatOutboundContract(canonicalContract) Object
        +processBankRequest(request: Object) Promise~Object~
    }

    class SbiBankAdapter {
        -string bankPublicKeyPem
        -string _bankPrivateKeyPem
        -Set processedIdempotencyKeys
        +formatOutboundContract(canonicalContract) Object
        +processBankRequest(request: Object) Promise~Object~
    }

    CryptoProviderInterface <|-- LocalMockProvider
    CryptoProviderInterface <|-- AwsKmsProvider
    CryptoProviderInterface <|-- AzureVaultProvider
    CryptoProviderInterface <|-- RemoteWebhookProvider
    CryptoProviderFactory ..> CryptoProviderInterface : instantiates
    BankConnectorService --> HsbcBankAdapter
    BankConnectorService --> SbiBankAdapter
    BankConnectorService ..> CryptoProviderInterface : invokes
```

---

### 2.4 End-to-End Sequence Diagrams

#### Sequence 1: End-to-End LC Issuance with Non-Custodial Cryptographic Pipeline
This represents the primary business execution flow: handling an LC Issuance while upholding non-custodial boundaries, performing in-process envelope encryption, and validating bank signatures.

```mermaid
sequenceDiagram
    autonumber
    actor ClientUI as Corporate UI (Tata)
    participant Middleware as middleware/auth.js
    participant Auth as Auth-Service (:4000)
    participant Controller as orchestratorController.js
    participant Factory as CryptoProviderFactory
    participant Provider as AwsKmsProvider (Client KMS)
    participant Connector as bankConnector.service.js
    participant Bank as HsbcBankAdapter (HSBC Gateway)
    participant Store as inMemoryOrchestratorStore

    ClientUI->>Middleware: POST /letter_of_credit/issuance/HSBC<br/>Header: Authorization: Bearer xlt_opq_...<br/>Body: { lcNumber, amount, applicant, beneficiary }
    
    Note over Middleware: Tag workflow_action = 'INITIATE_WORKFLOW'<br/>Dequeue pending billing receipt if available
    Middleware->>Auth: POST /validate-opaque-token<br/>{ workflow_action: 'INITIATE_WORKFLOW', piggybacked_billing_receipt }
    
    Note over Auth: 1. Validate Opaque Token & TTL<br/>2. Atomically check: activeWorkflows < maxConcurrentWorkflows<br/>3. Increment activeWorkflows++<br/>4. Ledger piggybacked receipt (if attached)
    Auth-->>Middleware: 200 OK { token_status: "VALID", capacity_status: "CAPACITY_OK", acknowledged_receipt_id }
    
    Middleware->>Controller: Forward Request (req.authContext bound)
    
    Controller->>Store: getBankCredentials('tata_steel', 'HSBC')
    Store-->>Controller: BankCredentialRecord (AWS_KMS mode)
    
    Controller->>Store: saveWorkflow(stage: 'LC_INITIATED')
    Controller->>Store: transitionStage('DISPATCHED_PENDING_ACK')
    Note over Controller,Store: 2-Step Financial State Guard active
    
    Controller->>Factory: create(credentials)
    Factory-->>Controller: AwsKmsProvider instance
    
    Controller->>Connector: dispatchToBank(HSBC, canonicalContract, cryptoProvider)
    
    Note over Connector: Generate IdempotencyKey = hash(clientId + lcNumber + version)<br/>Format Canonical -> HSBC ISO 20022 format<br/>Calculate SHA-256 Digest of ISO payload
    
    Connector->>Provider: signDigest(32-byte SHA-256 Digest)
    Note over Provider: Dispatches only 32 bytes to AWS KMS (kms:Sign)<br/>MessageType: 'DIGEST'<br/>Zero private key custody
    Provider-->>Connector: Base64 RSA-PSS Client Signature
    
    Note over Connector: IN-PROCESS PUBLIC KEY ENVELOPE:<br/>1. Generate Ephemeral AES-256 DEK + IV<br/>2. Encrypt payload with AES-256-GCM<br/>3. Encrypt 32-byte DEK with HSBC Public Key (RSA-OAEP)
    
    Connector->>Bank: processBankRequest(encryptedEnvelope, clientSignature, idempotencyKey)
    
    Note over Bank: 1. Idempotency Check<br/>2. Decrypt DEK with HSBC Private Key<br/>3. Decrypt AES-GCM payload<br/>4. Verify Client Signature with Tata Public Key<br/>5. Generate BankReference: HSBC-TXN-...<br/>6. Sign Response with HSBC Private Key<br/>7. Encrypt Response for Tata Public Key
    Bank-->>Connector: { encryptedResponseEnvelope, bankSignature, bankReference }
    
    Note over Connector: IN-PROCESS VERIFICATION & DECRYPTION:<br/>1. Decrypt Response DEK via Provider<br/>2. In-Process AES-256-GCM Decrypt<br/>3. In-Process Verify Bank Signature with HSBC Public Key
    
    Connector-->>Controller: { success: true, bankReference, idempotencyKey, bankResponse }
    
    Controller->>Store: transitionStage('ISSUANCE_CONFIRMED', historyMetadata)
    Controller-->>ClientUI: 201 Created { status: "CONFIRMED", bank_reference, idempotency_key, crypto_execution }
```

---

#### Sequence 2: Document Presentation, Terminal State, and Piggybacked Billing Ledgering
Demonstrates how reaching a terminal milestone queues a billing receipt and amortizes network hops on subsequent user activity.

```mermaid
sequenceDiagram
    autonumber
    actor ClientUI as Corporate UI
    participant Middleware as middleware/auth.js
    participant Controller as orchestratorController.js
    participant Store as inMemoryOrchestratorStore
    participant Auth as Auth-Service (:4000)

    ClientUI->>Middleware: POST /letter_of_credit/presentation/HSBC<br/>{ workflowId, documentManifest }
    Middleware->>Auth: POST /validate-opaque-token (Tag: TERMINATE_WORKFLOW)
    Auth-->>Middleware: 200 OK (Capacity decremented: activeWorkflows--)
    Middleware->>Controller: Forward Request
    
    Controller->>Store: transitionStage('DOCUMENTS_PRESENTED')
    Note over Controller: Terminal state reached.<br/>Construct signed BillingReceipt
    Controller->>Store: enqueueBillingReceipt({ workflow_id, terminal_state: 'DOCUMENTS_PRESENTED', sig })
    Controller-->>ClientUI: 200 OK { status: "ACCEPTED", billing_notice: "Receipt enqueued" }

    Note over ClientUI,Auth: Subsequent organic UI request arrives 10 seconds later
    ClientUI->>Middleware: GET /letter_of_credit/HSBC?workflowId=LC-001
    
    Note over Middleware: Intercepts request.<br/>Pops pending receipt from queue.
    Middleware->>Auth: POST /validate-opaque-token<br/>Header: Bearer xlt_opq_...<br/>Body: { piggybacked_billing_receipt: receipt }
    
    Note over Auth: Atomically ledger receipt:<br/>Key: `${workflow_id}_${terminal_state}`<br/>Deduplicate & Record
    Auth-->>Middleware: 200 OK { token_status: "VALID", billing_receipt_status: "ACKNOWLEDGED_AND_LEDGERED", acknowledged_receipt_id: "LC-001" }
    
    Note over Middleware: Receipt successfully confirmed.<br/>Zero separate billing network hops!
    Middleware->>Controller: Process GET request
    Controller-->>ClientUI: 200 OK { workflowData }
```

---

#### Sequence 3: Stale Queue Recovery via Machine-to-Machine (M2M) Idle Worker
Demonstrates resilience when corporate users close their browsers and no subsequent organic UI requests occur.

```mermaid
sequenceDiagram
    autonumber
    participant Worker as idleReceiptFlusher.js (Background Timer)
    participant Store as inMemoryOrchestratorStore
    participant Auth as Auth-Service (:4000)

    Note over Worker: Timer ticks (every 30 seconds)
    Worker->>Store: getPendingReceiptsCount()
    
    alt Queue is Empty (count == 0)
        Note over Worker: No-op. Sleep until next tick.
    else Queue has Lingering Receipts (count > 0)
        Worker->>Store: drainPendingReceipts()
        Store-->>Worker: [receipt_1, receipt_2]
        
        Note over Worker: No user Bearer token available!<br/>Use Platform Channel Trust (Problem B)
        Worker->>Auth: POST /api/v1/auth/m2m-flush-receipts<br/>Header: X-Platform-Node-Id: node-orchestrator-01<br/>Header: X-Platform-Secret: xalts_platform_secret_...<br/>Body: { receipts: [receipt_1, receipt_2] }
        
        Note over Auth: Verify M2M node credentials.<br/>Persist all receipts atomically into ledger.
        Auth-->>Worker: 200 OK { flushed_count: 2, acknowledged_receipt_ids: [...] }
        Note over Worker: Receipts successfully purged. Zero lost billing data.
    end
```

---

### 2.5 Finite State Machines (Letter of Credit Lifecycle)

Trade finance workflows follow an asynchronous, multi-stage state machine designed to prevent financial double-commitment:

```mermaid
stateDiagram-v2
    [*] --> LC_INITIATED: POST /letter_of_credit/issuance/:bankId
    
    LC_INITIATED --> DISPATCHED_PENDING_ACK: Asymmetric Cryptographic Pipeline Dispatched
    note right of DISPATCHED_PENDING_ACK
      Critical 2-Step Financial Guard:
      If network timeouts occur, subsequent calls
      must NOT re-issue; they query status
      using the Deterministic Idempotency Key.
    end note
    
    DISPATCHED_PENDING_ACK --> ISSUANCE_CONFIRMED: Bank Responds with Signed Receipt
    DISPATCHED_PENDING_ACK --> DISPATCH_FAILED: Bank Security or Network Rejection
    
    ISSUANCE_CONFIRMED --> AMENDMENT_REQUESTED: POST /letter_of_credit/amendment/:bankId
    AMENDMENT_REQUESTED --> AMENDMENT_CONFIRMED: Bank Dispatches Signed Version Update
    
    AMENDMENT_CONFIRMED --> DOCUMENTS_PRESENTED: POST /letter_of_credit/presentation/:bankId
    ISSUANCE_CONFIRMED --> DOCUMENTS_PRESENTED: Direct Presentation (No Amendments)
    
    DOCUMENTS_PRESENTED --> EnqueueBilling: Generate Terminal BillingReceipt
    EnqueueBilling --> PiggybackedOrFlushed: Drained via Auth Hop or M2M Worker
    PiggybackedOrFlushed --> [*]
```

---

## 3. Major Engineering Decisions & Technical Rationales

### Decision 1: Hybrid Perimeter Topology (Data Sovereignty vs. Centralized Tenancy)
- **Context**: Tier-1 corporate clients (Tata, Reliance) refuse to upload trade contracts, bills of lading, and financial counterparty data into a shared multi-tenant SaaS cloud due to compliance, GDPR, and data residency laws.
- **Decision**: Decouple the stack into two perimeters:
  1. The **UI and Orchestrator Service** can be deployed directly inside the client's private infrastructure (Kubernetes cluster / on-prem datacenter).
  2. The **Subscription-Auth-Service** remains centralized inside Xalts cloud infrastructure.
- **Why It Matters**: Sensitive trade contracts never leave the customer's cloud. The only data crossing the corporate boundary to Xalts are random opaque tokens and anonymized capacity receipts.

---

### Decision 2: Opaque Bearer Tokens over Stateless JWTs
- **Context**: We need to authenticate client users while licensing active concurrent workflows.
- **Decision**: Issue high-entropy 48-character random hex strings (`xlt_opq_...`) stored centrally in the Auth Service with a 1-hour TTL, verified via RFC 7662 style introspection.
- **Why Rejected JWT**:
  1. **Instant Revocation Kill Switch**: In trade finance, if an employee is compromised or a corporate subscription is suspended, access must cease within zero milliseconds. Revoking a JWT requires maintaining distributed blocklists (Redis), which negates the stateless benefit of JWTs.
  2. **Zero Claim Leakage**: JWTs stored in client browser storage or on-prem proxies expose tenant scopes, licensing tiers, and internal account IDs to anyone inspecting base64 strings.// Important : so this benefit is because that jwt is passed in browser so it is not private , as response where opaque is returned to the orchestrator backend in the client infra , can't that client read from there the clientId and other supbscription tier of other thing only being token at the browser level is security risk
  3. **Capacity Licensing Synchronization**: Validating an opaque token centrally provides the perfect interception point to enforce real-time concurrent workflow concurrency (`activeWorkflows < maxConcurrentWorkflows`).

---

### Decision 3: Asymmetric Cryptographic Operation Partitioning
- **Context**: Communicating with global banks requires 4 cryptographic operations:
  1. Sign outbound payload with Client's private key.
  2. Encrypt outbound payload with Bank's public key.
  3. Decrypt inbound response with Client's private key.
  4. Verify inbound response with Bank's public key.
- **Decision**: Split the 4 operations between **in-process compute** and **non-custodial delegation**:
  - **Public Key Ops (Encrypt for Bank, Verify Bank Signature)**: Executed **in-process** inside the Node.js Orchestrator using OpenSSL bindings via Hybrid Envelope Encryption (`AES-256-GCM` + Bank RSA-OAEP). Runs in < 0.5ms with zero network hops and zero cloud costs.
  - **Private Key Ops (Sign Payload, Decrypt Bank Response)**: Executed **non-custodially** by delegating to the client's cloud KMS, HSM, or Remote Webhook.
  - **Digest-Only Signing (`MessageType: DIGEST`)**: The Orchestrator hashes the document locally (`SHA-256`) and transmits only the 32-byte digest to AWS KMS or the corporate webhook.
- **Why It Matters**: Reduces KMS network payloads by 99% (sending 32 bytes instead of 5MB PDFs), bypasses AWS KMS 4KB payload limits, cuts KMS billing costs in half, and eliminates private key liability.

---

### Decision 4: Pluggable Strategy Factory for Non-Custodial Key Governance
- **Context**: Every corporate client stores private keys in different key management infrastructure:
  - Tata on AWS $\to$ AWS KMS Asymmetric Keys.
  - Client on Azure $\to$ Azure Key Vault Managed HSM.
  - Strict SaaS Client $\to$ Client-Hosted Keyless Signing Webhook.
  - Local Dev / Test $\to$ Local In-Memory RSA Mock Provider.
- **Decision**: Implement a dynamic Factory Pattern (`CryptoProviderFactory`) loading provider implementations on demand based on tenant configuration stored in the database.
- **Why It Matters**: A single unified container image runs identically across AWS, Azure, on-prem Kubernetes, and local test environments without code forks.

---

### Decision 5: Two-Step Financial State Machine & Deterministic Idempotency Keys
- **Context**: A network drop or TCP timeout after dispatching an LC to HSBC could cause a client operator to hit "Retry", potentially executing duplicate $10M Letter of Credit obligations.
- **Decision**:
  1. Generate a **Deterministic Idempotency Key**: `SHA-256(clientId + lcNumber + version)`.
  2. Implement an intermediate state: transition from `LC_INITIATED` $\to$ `DISPATCHED_PENDING_ACK` **before** opening the network socket to the bank.
  3. If a network timeout occurs, any retry checks the bank status endpoint using the deterministic idempotency key rather than creating a duplicate financial contract.
  //IMPORTANT:  so i think here the client only creates the lcnumber the main idempotency key we don't generate that , does the lcnumber have to be unique accorss all the system or each client can have their own lcnumber range or how we are managing that if the client has the owner ship of the lc number that clientId+lcnumber is unique right

---

### Decision 6: Amortized Network Optimization with Dual-Channel Billing Flush
- **Context**: The opaque token validation incurs cross-cloud WAN latency (~50-100ms between Tata on-prem and Xalts AWS). Adding an independent billing microservice call would double WAN latency and double network overhead.
- **Decision**: Implement a **Dual-Channel Piggybacking & Flushing Architecture**:
  1. **Primary Channel (Piggybacked Hop)**: When a workflow reaches a terminal milestone (`DOCUMENTS_PRESENTED`), it enqueues a billing receipt. The very next UI $\to$ Orchestrator call dequeues the receipt and piggybacks it onto the authentication network hop in the same HTTP roundtrip.
  2. **Secondary Channel (M2M Idle Worker)**: If the client operator presents documents and closes their laptop at 5 PM, a background worker (`idleReceiptFlusher.js`) awakens every 30 seconds, uses platform-level Machine-to-Machine (M2M) credentials, and flushes lingering receipts directly to `/api/v1/auth/m2m-flush-receipts`.
  // Important: really i dont want this extra channel and one more things that our normal api's like save draft should not be calling the network hop there might be some way to authenticate some requests locally and to authenticate some request through central auth service with extra hop
- **Why It Matters**: Zero lost billing receipts, zero extra network roundtrips during normal usage, and 100% resilient queue drainage during idle hours.

---

## 4. Production Engineering Challenges & War Stories

### War Story 1: The AWS KMS 4KB Payload Limit & Latency Blowup
- **The Problem**: During initial testing with large trade contracts (including multi-page packing lists and commercial invoices), calls to AWS KMS `kms:Sign` began failing with `ValidationException: 1 validation error detected: Value at 'Message' failed to satisfy constraint: Member must have length less than or equal to 4096`. Furthermore, sending 2MB contracts to KMS over AWS network boundaries added 350ms of network overhead per signature.
- **The Engineering Fix**: We migrated the crypto pipeline to **Asymmetric Operation Partitioning with Digest-Only Signing**: // IMPORTANT: I don't konw that , like then how the big requests are signed?? and how big responses are beign decrypted or encrypted through KMS
  1. Compute `digest = crypto.createHash('sha256').update(contractString).digest()` locally inside Node.js OpenSSL in 0.8ms.// IMPORTANT also hashing the data does we lost it, are we encoding it that can be decoded because hash is not reversible
  2. Dispatch the exact 32-byte buffer to AWS KMS with parameter `MessageType: 'DIGEST'`.
  3. KMS executes raw RSA-PSS signature over the 32-byte hash.
- **The Result**: Payload reduced from 2MB to 32 bytes. Latency dropped from 350ms to 24ms. Zero payload limit exceptions regardless of trade document size. // Important why we say that payload reduced from 2MB to 32 bytes if the kms doesn't even support more then 4Kb then it is the mandatory thing not optional

---

### War Story 2: The Stale Piggyback Queue & Revenue Recognition Delay
- **The Problem**: In Iteration 1, billing receipts relied 100% on subsequent UI requests to piggyback onto Auth Service calls. When enterprise clients executed document presentations on Friday evening and shut down their computers, high-value billing receipts lingered in the Orchestrator's in-memory queue until Monday morning. This delayed real-time revenue recognition and billing ledger synchronization by over 60 hours. // Important: istead of queue why the orchestrator and auth keeps track of last updated or last Auth done and billable events after that can be transfered directly from db instead of having an extra queue, also we don't need to mark each billable transaction as billed we just have to mark till what the data has been sent and till what has been acknowledged by the auth service.
- **The Engineering Fix**: We engineered the **Secondary M2M Channel**:
  1. Created an autonomous worker (`idleReceiptFlusher.js`) with an interval timer.
  2. Introduced platform-level Machine-to-Machine authentication (`X-Platform-Node-Id` and `X-Platform-Secret`), distinct from human user session tokens (Problem B: Platform Channel Trust). // Also if using this X_PAltform secret and x-platform-node-id a client employ can misuse them, apart from the client credential we don't want this extra secrets also there is complexity to store them seperately, Also we must have some way when the client is making auth calls to auth-service are there over https 
  3. Added an atomic bulk ledgering endpoint: `POST /api/v1/auth/m2m-flush-receipts`.
- **The Result**: Lingering receipts are automatically purged within 30 seconds of user inactivity while preserving the zero-overhead piggybacking benefit during active hours.

---

### War Story 3: Financial Double-Commitment on Bank Gateway Timeouts
- **The Problem**: During a simulated WAN partition, an HTTP POST to HSBC timed out at 30,000ms. The Orchestrator marked the request as failed. However, HSBC had actually committed the LC before the network socket broke. The client UI clicked "Retry", attempting to issue an identical LC, risking duplicate multi-million dollar credit exposure.
- **The Engineering Fix**: We implemented **SWIFT/Stripe-style Financial Idempotency**:
  1. Implemented deterministic idempotency hashing: `SHA-256(clientId + lcNumber + version)`.
  2. Introduced the intermediate `DISPATCHED_PENDING_ACK` stage in the local state machine before socket write.
  3. Both the Bank Connector and the remote HSBC gateway simulator verify this idempotency key. When a retry arrives with an identical key, the bank gateway recognizes the replay and returns the existing transaction reference rather than re-committing financial liability.

---

### War Story 4: Corporate Forward Proxy Breaking mTLS
- **The Problem**: When testing on-prem deployment inside a corporate datacenter, the corporate network team routed all outbound internet traffic through an enterprise forward proxy (BlueCoat/Zscaler) that performed deep SSL Inspection (MITM TLS decryption). Because the proxy could not present the private key of the client's internal node certificate, mTLS handshakes between the on-prem Orchestrator and Xalts Cloud failed immediately at Layer 4.
- **The Engineering Fix**: We designed a **Dual-Layer Channel Trust Architecture**:
  1. **Transport Layer (Default)**: Mutual TLS (mTLS) for environments supporting direct WAN / VPN peering.
  2. **Application Layer (Fallback)**: When corporate proxies break mTLS, the Orchestrator falls back to standard TLS 1.3 with **Layer-7 Asymmetric Request Signing (JWS/HMAC)** using the node's private platform key (`X-Platform-Signature: <base64>`). The proxy inspects the cleartext HTTP headers without breaking cryptographic authentication.

---

## 5. In-Depth Trade-Off Analysis Matrix

| Architectural Dimension | Chosen Approach | Alternative Considered | Trade-Off Rationale & Mathematical Justification |
| :--- | :--- | :--- | :--- |
| **Token Verification** | **Centralized Intentional Network Hop** | Local Stateless JWT verification | **Trades ~40ms WAN latency for instantaneous revocation and zero-leakage capacity licensing**. In $10M trade finance, a 60-second revocation window on a compromised token is a catastrophic compliance violation. |
| **Key Custody** | **Non-Custodial Digest Delegation** | Custodial Key Storage (Storing private keys in Xalts DB) | **Trades an extra KMS network call for complete immunity from SOC-2/ISO-27001 key custody liability**. Xalts cannot be subpoenaed or breached for client private keys because it never holds them. |
| **Payload Encryption** | **Hybrid Envelope (In-Process AES-GCM + Asymmetric RSA-OAEP)** | Direct Asymmetric RSA Encryption | **Mathematical necessity**: 2048-bit RSA keys can only encrypt a maximum of 214 bytes under OAEP padding. Hybrid envelope encryption supports multi-gigabyte trade contracts with sub-millisecond symmetric AES speed. |
| **Crypto Extensibility** | **Dynamic Factory Pattern with In-Memory Caching** | Hardcoded AWS KMS SDK | Enables running the identical codebase across AWS, Azure, on-prem Kubernetes, and local test runners without code forks or cloud lock-in. |
| **Billing Synchronization** | **Piggybacked Roundtrip + M2M Idle Flusher** | Dedicated Kafka / RabbitMQ broker | Eliminates the operational cost and infrastructure maintenance of a distributed message broker in self-hosted on-prem mode, while guaranteeing at-least-once delivery with zero extra network hops during active sessions. |
| **Financial Concurrency** | **Active Concurrent Capacity Licensing** | Monthly Aggregate Usage Metering | Prevents enterprise clients from overwhelming banking APIs with bursts of 500 concurrent LCs, protecting bank SLA limits and enforcing fair usage at the gateway. |

---

## 6. Staff / SDE-4 Interview Strategy: How to Present & Defend

### 6.1 The 60-Second Elevator Pitch
> *"At Xalts, I architected a multi-bank trade finance orchestrator that connects multinational corporate clients like Tata Steel to global banking networks like HSBC and SBI under a strict zero-trust, non-custodial security model.*
> 
> *The core challenge was a dual-perimeter problem: corporate compliance prohibited sensitive trade contracts and private keys from leaving the client's private infrastructure, while platform tenancy and subscription licensing had to remain centralized at Xalts.*
> 
> *I designed a hybrid architecture where the UI and Orchestrator run on-premise inside the customer's VPC, while our central Auth Service acts as the authoritative licensing anchor. To solve the cryptographic challenge, I pioneered an **Asymmetric Operation Partitioning** pattern: all public key encryption and signature verification execute in-process in sub-milliseconds, while private key operations dispatch only a 32-byte SHA-256 digest to the client's AWS KMS or remote webhook.*
> 
> *Finally, to counteract the WAN latency of cross-cloud opaque token introspection, I amortized network roundtrips by **piggybacking active capacity checks and terminal billing receipts onto the exact same HTTP authentication hop**, backed by an autonomous M2M worker to prevent stale queue accumulation."*

---

### 6.2 The Staff-Level Whiteboard Blueprint (Interview Opening)

When asked to whiteboard this system, draw these **4 distinct zones** immediately:
1. **Zone 1: The Client Perimeter (On-Prem / VPC)**: Draw the UI, the Orchestrator, and the Client KMS/HSM. Emphasize that raw contracts never cross this border.
2. **Zone 2: The Cryptographic Partition**: Draw the box splitting Public Key Ops (In-Process AES-GCM + Bank PubKey) and Private Key Ops (32-byte digest to KMS).
3. **Zone 3: The Centralized Xalts SaaS Anchor**: Draw the Auth Service with Opaque Token Introspection, Active Capacity counter (`activeWorkflows < maxConcurrent`), and Deduplicated Billing Ledger. // Important i can say i have designed the decoupled billing ledger that sounds good
4. **Zone 4: The Banking Gateway**: Draw HSBC (ISO 20022) and SBI (REST JSON) with deterministic idempotency keys and 2-step financial state guards.

---

### 6.3 Defending Against Aggressive Interviewer Pushback

#### Pushback 1: *"Why not just use Kafka or SQS for billing receipts instead of this piggybacking mechanism?"* // Important good question very good question
> **Candidate Defense**:
> *"In a pure SaaS environment, Kafka is great. But in our **hybrid on-premise deployment mode**, Tata Steel deploys our Orchestrator inside their own Kubernetes cluster. 
> If we introduce Kafka, Tata's infrastructure team must now provision, monitor, manage, and secure a Kafka cluster or open cross-cloud egress firewall rules to an AWS MSK cluster. 
> Piggybacking leverages an HTTP channel that **already exists and is already required** for session validation. It eliminates an entire distributed infrastructure dependency in on-prem deployments, and our secondary M2M idle worker ensures at-least-once delivery even when UI traffic pauses."*

#### Pushback 2: *"Why not issue short-lived JWTs (e.g. 5 minutes) and eliminate the network hop entirely?"*
> **Candidate Defense**:
> *"In consumer tech, a 5-minute revocation window is acceptable. In enterprise trade finance, where an operator can issue a $50M Letter of Credit with a single click, a 5-minute window on a compromised employee or suspended client is catastrophic.
> More importantly, our monetization is based on **Active Concurrent Capacity Licensing**—capping how many in-flight LCs a client can have open simultaneously across all cluster nodes. A stateless JWT cannot enforce cluster-wide real-time concurrency without calling a shared state store anyway. Since we must make a network call to verify capacity, validating the opaque token and piggybacking the billing receipt in that exact same call is the most efficient design."* // Important i can specify this reason for the Active Concurrent Capacity Licensing for the opaque token oohh and jwt will let the consumer create extra concurrent workflows oohh, but if the interviwer has expereinced with this jwt + aync workflow + cuoncurrent workflow limit he might say it is possible have you reasearched 

#### Pushback 3: *"What happens if the Orchestrator receives a 200 OK from Auth Service, but crashes before dispatching to HSBC?"*
> **Candidate Defense**:
> *"We designed the state machine specifically for this failure domain. The workflow is initialized in `LC_INITIATED`, but before any bank network call is dispatched, it transitions to `DISPATCHED_PENDING_ACK`. 
> If the container crashes, the workflow remains in `DISPATCHED_PENDING_ACK`. When the container recovers, our reconciliation engine detects in-flight workflows and uses the **Deterministic Idempotency Key** (`hash(clientId + lcNumber + version)`) to query HSBC's query endpoint. If HSBC never received it, we safely re-dispatch; if HSBC already processed it, we transition directly to `ISSUANCE_CONFIRMED` without duplicate financial exposure."* // Important have to look at this

---

## 7. Future Production-Grade Evolution (Staff+ Roadmap)

If asked: *"How would you evolve this system to handle 100x scale or Tier-1 sovereign banking requirements?"*, pitch these 5 advanced architectural initiatives:

1. **Confidential Computing via AWS Nitro Enclaves / AMD SEV**:
   - For clients requiring extreme key isolation, run the cryptographic engine inside an isolated AWS Nitro Enclave (CPU/memory-isolated environment with no persistent storage, no interactive access, and cryptographic attestation).
2. **Distributed Saga Orchestration with Temporal / Zeebe**:
   - Letter of Credit lifecycles involve multi-day human workflows (advising banks, confirming banks, customs inspection). Replacing in-memory state tracking with an event-driven Temporal Saga provides durable execution, automatic compensations, and crash-resilient multi-day timers.
3. **Cluster-Wide Token Bucket Rate Limiting with Redis & Lua**:
   - Implement hierarchical rate limiting: globally per corporate tenant, per bank routing channel, and per employee to protect downstream bank partner rate limits.
4. **Zero-Knowledge Proofs (ZK-SNARKs) for Trade Document Privacy**:
   - Enable corporate clients to cryptographically prove that trade documents (invoices, bills of lading) satisfy bank loan requirements (e.g., invoice value > $1M, origin country in whitelist) without revealing the underlying proprietary commercial terms or supplier identities to the orchestrator.
5. **eBPF Kernel-Level Network Tracing**:
   - Deploy eBPF probes inside the on-prem container cluster to trace TCP handshake latencies, DNS resolution delays, and egress packet drops across the cross-cloud WAN link without adding application-level latency.
