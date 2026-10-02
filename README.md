# Multi-Bank Prototype Architecture

A clean prototype monorepo containing two decoupled microservices designed for interview preparation and study:

- 🔐 **`auth-service`**: Runs on **Port 4000** (handles authentication, user state in an in-memory hashtable).
- 🏦 **`orchestrator-service`**: Runs on **Port 3000** (handles request orchestration, in-memory hashtables for banks & transactions).

Both services use JavaScript `Map`-backed in-memory hashtables — **zero external databases required**.

---

## 📁 Project Structure

```text
multi-bank-orchestrator/
├── auth-service/                   # Runs on Port 4000
│   ├── .env                        # PORT=4000
│   ├── package.json
│   └── src/
│       ├── server.js               # Express server entrypoint
│       ├── controllers/
│       │   └── auth.controller.js  # Register / login / verify handlers (boilerplate)
│       ├── routes/
│       │   └── auth.routes.js      # Express router
│       └── storage/
│           └── inMemoryStore.js    # In-memory user hashtable (Map)
│
├── orchestrator-service/           # Runs on Port 3000
│   ├── .env                        # PORT=3000, AUTH_SERVICE_URL=http://localhost:4000
│   ├── package.json
│   └── src/
│       ├── server.js               # Express server entrypoint
│       ├── controllers/
│       │   └── orchestrator.controller.js # Request handlers (boilerplate)
│       ├── middleware/
│       │   └── auth.js             # Auth middleware placeholder
│       ├── routes/
│       │   └── orchestrator.routes.js     # Express router
│       ├── services/
│       │   └── orchestrator.service.js    # Service layer (boilerplate)
│       └── storage/
│           └── inMemoryStore.js    # In-memory bank & transaction hashtable (Map)
│
├── scripts/
│   └── dev.js                      # Concurrently runs both services in watch mode
├── package.json                    # Monorepo root (npm workspaces)
├── .gitignore
└── README.md
```

---

## 🚀 Getting Started

### 1. Install Dependencies
Run from the root directory (installs dependencies for all workspaces):
```bash
npm install
```

### 2. Run Both Services Concurrently
```bash
npm run dev
```
- Auth Service starts at: `http://localhost:4000`
- Orchestrator Service starts at: `http://localhost:3000`

### 3. Or Run Services Individually
```bash
# Run Auth Service only (port 4000)
npm run dev:auth

# Run Orchestrator Service only (port 3000)
npm run dev:orchestrator
```

---

## 📡 Boilerplate Endpoints

### 🔐 Auth Service (Port 4000)
- `GET  http://localhost:4000/health` — Health check
- `POST http://localhost:4000/auth/register` — Register user placeholder
- `POST http://localhost:4000/auth/login` — Login placeholder
- `GET  http://localhost:4000/auth/verify` — Token verification placeholder

### 🏦 Orchestrator Service (Port 3000)
- `GET  http://localhost:3000/health` — Health check
- `GET  http://localhost:3000/orchestrator/status` — Status check (uses auth middleware)
- `POST http://localhost:3000/orchestrator/process` — Process request (uses auth middleware)
