## Velocity Transfer

A focused, production‑ready file handoff experience built on Next.js.

![Velocity Transfer hero](public/hero.png)

Velocity lets you move a file from one browser to another using a short numeric code.  
No accounts, no inbox clutter, and files are scoped to a single, short‑lived transfer.

---

### Highlights

- **One‑time numeric keys**: 6–8 digit codes that are safe to share over chat or call.
- **Direct‑to‑storage uploads**: the browser uploads straight to Cloudflare R2 via presigned URLs.
- **Ephemeral sessions**: transfers are short‑lived and cleaned up automatically.
- **Live receiver count**: both sides see how many people have joined a transfer.

> Note: experimental WebSocket live streaming is wired up in the backend but **currently hidden in the UI** while it’s being iterated on.

---

### Tech stack

- **Framework**: Next.js App Router (TypeScript, `app/` directory)
- **Runtime**:
  - Node runtime for REST API routes under `app/api/transfers/*`
  - Edge runtime for WebSocket presence under `app/api/transfers/live` and experimental streaming under `app/api/transfers/stream`
- **Database**: Postgres (Neon) for durable transfer records and file metadata
- **Cache / sessions**: Upstash Redis for transfer sessions and receiver presence
- **Object storage**: Cloudflare R2, accessed via presigned upload/download URLs

---

### How it works

#### Sender flow (recommended path)

1. Open the **Sender** panel and pick a file.
2. Click **Generate key & send**.
3. The app:
   - Calls `POST /api/transfers/start` → creates a Redis session + Postgres transfer row.
   - Calls `POST /api/transfers/upload-url` → generates a presigned R2 upload URL.
   - Uploads the file **directly to R2** via `PUT` (no bytes go through the Next API).
   - Calls `POST /api/transfers/complete` → marks the transfer as completed and stores receiver count & file metadata.
4. A highlighted card shows the **numeric key** to share with receivers.

#### Receiver flow

1. In the **Receiver** panel, paste the numeric key and click **Join transfer**.
2. The app:
   - Calls `POST /api/transfers/join` → validates the key and registers the receiver in Redis.
   - Opens `/api/transfers/live?code=...` (Edge WebSocket) to receive **live receiver count** updates.
3. When the sender finishes:
   - Click **Download file**.
   - The app calls `POST /api/transfers/download-url` to fetch a presigned R2 download URL.
   - The browser navigates directly to that R2 URL to download the file.

---

### Data model (high level)

- **Transfer code**: 6–8 digit numeric key. All actions (start, join, upload, complete, download) are keyed by this value.
- **Transfer session (Redis)**:
  - Stores `sessionId`, `transferCode`, `status` (`started | completed | failed`), `createdAt`, `expiresAt`, `fileSize`, `mimeType`, `storageKey`.
- **Transfer record (Postgres)**:
  - `transfers` tracks `transfer_code`, `file_size`, `status`, `receiver_count`, `created_at`, `completed_at`, `duration`.
  - `files` links `transfer_id` to a `storage_key` and file metadata.

---

### Environment configuration

Create a `.env` file (do **not** commit real credentials) with at least:

```bash
NODE_ENV=development

# Postgres (Neon)
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DB?sslmode=require

# Upstash Redis
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...

# Cloudflare R2
R2_ENDPOINT=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=velocity

# App base URL
APP_URL=http://localhost:3000
```

Rotate any credentials that were ever checked into version control and replace them with secure values in your own environment.

---

### Running the app

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

Then open `http://localhost:3000` in your browser.

Build and run in production mode:

```bash
npm run build
npm start
```

---

### UX & behaviour

- While a send is in progress:
  - The file chooser and send buttons are disabled to prevent conflicting actions.
  - Upload progress is surfaced as a percentage and progress bar.
- On the receiver:
  - The **Download file** button is disabled until the transfer is in a valid state.
  - API errors are surfaced as short, clear messages.
- Sessions are ephemeral:
  - Transfer codes expire based on `transferConfig.sessionTtlSeconds`.
  - Late receivers may see “transfer not found or expired” once the session is cleaned up.

If you want to adapt Velocity for your own product, you can:

- Swap R2 for any S3‑compatible object storage.
- Replace Redis with your own session/cache layer.
- Customize the UI copy and theming without touching the transfer protocol.
