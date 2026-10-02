# Multi-Bank Orchestrator

A lightweight, modular Node.js + Express.js service boilerplate with an in-memory hashtable store (using JavaScript `Map`). Ready for request orchestration without requiring an external database connection.

---

## 🚀 Features

- **Runtime**: Modern Node.js (ES Modules, Node 18+ / 22+).
- **Web Framework**: Express.js 5 with JSON parsing, CORS, Morgan request logger, and centralized async error handling.
- **In-Memory Hashtable Store**: Reusable `InMemoryStore` backed by JavaScript `Map` providing $O(1)$ key lookups, CRUD operations, query filtering, and namespace registry.
- **Modular Architecture**: Clean separation of Controller, Service, Storage, Middleware, and Routes.
- **Graceful Shutdown**: Handles `SIGINT` and `SIGTERM` signals cleanly.
- **Built-in Testing**: Native Node.js test runner suite (`node:test`).

---

## 📁 Project Structure

```text
multi-bank-orchestrator/
├── src/
│   ├── app.js                          # Express application initialization & middleware
│   ├── server.js                       # HTTP server entrypoint & graceful shutdown
│   ├── config/
│   │   └── index.js                    # Environment configuration
│   ├── controllers/
│   │   └── orchestrator.controller.js  # HTTP request/response handlers
│   ├── middleware/
│   │   └── errorHandler.js             # ApiError class, 404 handler, global error handler
│   ├── routes/
│   │   ├── index.js                    # Versioned master router (/api/v1)
│   │   ├── health.routes.js            # Healthcheck route
│   │   └── orchestrator.routes.js      # Multi-bank orchestration routes
│   ├── services/
│   │   └── orchestrator.service.js     # Business logic & bank routing
│   └── storage/
│       └── inMemoryStore.js            # In-memory hashtable (Map) repository
├── test/
│   └── orchestrator.test.js            # Unit tests for store and service
├── .env.example                        # Template for environment variables
├── .env                                # Local environment config
├── .gitignore
├── package.json
└── README.md
```

---

## 🛠️ Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment
Copy `.env.example` to `.env` (already done for default local setup):
```env
PORT=3000
NODE_ENV=development
APP_NAME=multi-bank-orchestrator
CORS_ORIGIN=*
```

### 3. Run the Server

**Development Mode (auto-reloads on file changes):**
```bash
npm run dev
```

**Production Mode:**
```bash
npm start
```

### 4. Run Tests
```bash
npm test
```

---

## 💡 How the In-Memory Hashtable Store Works

The storage layer is implemented in [`src/storage/inMemoryStore.js`](src/storage/inMemoryStore.js) using native JavaScript `Map` objects:

```javascript
import { storeRegistry, InMemoryStore } from './storage/inMemoryStore.js';

// Get or create an in-memory table/store
const userStore = storeRegistry.getStore('users');

// O(1) set & get
userStore.set('usr_1', { name: 'John Doe', role: 'admin' });
const user = userStore.get('usr_1');

// Filtering / querying
const admins = userStore.filter(u => u.role === 'admin');

// Check & delete
if (userStore.has('usr_1')) {
  userStore.delete('usr_1');
}
```

Whenever you want to add a new entity later (e.g., `customers`, `accounts`, `audit_logs`), you simply call `storeRegistry.getStore('<entity_name>')` without configuring any database.

---

## 📡 API Endpoints

### Base / Discovery
- `GET /` - Service info and route catalog
- `GET /health` or `GET /api/v1/health` - Health check

### Orchestrator Endpoints
- `GET /api/v1/orchestrator/storage-stats` - View current in-memory hashtables and item counts
- `GET /api/v1/orchestrator/banks` - List available banks
- `POST /api/v1/orchestrator/banks` - Register a new bank
- `GET /api/v1/orchestrator/transactions` - List processed transactions (supports `?status=`, `?currency=`, `?bankId=`)
- `GET /api/v1/orchestrator/transactions/:id` - Fetch transaction by ID
- `POST /api/v1/orchestrator/transactions` - Route and process a transaction

---

## 🧪 Sample cURL Requests

### 1. Process a Payment Transaction
```bash
curl -X POST http://localhost:3000/api/v1/orchestrator/transactions \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 250,
    "currency": "USD",
    "sourceAccount": "ACC_1001",
    "destinationAccount": "ACC_9901"
  }'
```

### 2. View All Transactions
```bash
curl http://localhost:3000/api/v1/orchestrator/transactions
```

### 3. Check In-Memory Storage Stats
```bash
curl http://localhost:3000/api/v1/orchestrator/storage-stats
```
