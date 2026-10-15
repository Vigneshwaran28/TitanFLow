# TaskFlow Server (Backend API)

The backend service for TaskFlow: a multi-tenant business platform featuring operational workflows, tasks, billing, logistics, clinic management, and real-time WebSockets.

---

## Features

- **Multi-Tenant Architecture**: Supports shared or dedicated tenant databases with automated schema synchronization.
- **Database Support**: Built on Knex.js with native support for **Neon Serverless PostgreSQL** and SQLite.
- **Neon Cloud Services**:
  - **Neon Postgres**: Auto-connecting via `DATABASE_URL` with SSL.
  - **Neon Auth**: Identity and JWKS endpoint verification (`/api/neon/auth/config`).
  - **Neon Object Storage**: S3-compatible asset management for uploads and attachments (`/api/neon/storage/*`).
- **Real-Time Engine**: WebSocket live synchronization at `/ws`.
- **Scheduled Workers**: Deadlines, broadcasts, and automated notifications.

---

## Requirements

- **Node.js**: 22.13 or newer
- **PostgreSQL**: Neon DB connection string or local PostgreSQL (or zero-config SQLite)

---

## Getting Started

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Variables
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Key environment variables:
```env
# Neon / PostgreSQL Connection String
DATABASE_URL=postgresql://user:password@ep-something.neon.tech/neondb?sslmode=require

# Neon Auth (Optional)
NEON_AUTH_BASE_URL=https://...
NEON_AUTH_JWKS_URL=https://.../.well-known/jwks.json

# Neon S3 Object Storage
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_ENDPOINT_URL_S3=https://...storage...neon.tech
AWS_REGION=ap-southeast-1
NEON_STORAGE_BUCKET=assets

# Port
PORT=4000
```

### 3. Run Development Server
```bash
npm run dev
```
The server will start on `http://localhost:4000` with live reload.

### 4. Verify Services
Run the end-to-end verification script:
```bash
node --env-file-if-exists=.env test/neon-verify.mjs
```

---

## Scripts

| Command | Action |
| :--- | :--- |
| `npm run dev` | Starts server with live auto-restart |
| `npm start` | Starts server in production mode |
| `npm run setup:reset` | Resets configuration to reopen the setup wizard |
