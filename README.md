## Velocity Transfer

Velocity Transfer is a one‑page file sharing app built on Next.js.  
It lets a sender generate a short numeric key, share it with a receiver, and move a file with:

- **Storage‑backed transfers** (default): sender uploads directly to object storage (Cloudflare R2) using a presigned URL, receivers download from storage.
- **Live presence**: sender and receivers see how many people are currently joined on a transfer via a WebSocket channel.
- **Ephemeral sessions**: transfer sessions are short‑lived, keyed by a 6–8 digit code, and cleaned up automatically.

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

### Core concepts

- **Transfer code**: a 6–8 digit numeric key. All actions (start, join, upload, complete, download) are scoped to a transfer code.
- **Transfer session (Redis)**:
  - Stores `sessionId`, `transferCode`, `status` (`started | completed | failed`), `createdAt`, `expiresAt`, `fileSize`, `mimeType`, `storageKey`.
- **Transfer record (Postgres)**:
  - Table `transfers` tracks `transfer_code`, `file_size`, `status`, `receiver_count`, `created_at`, `completed_at`, `duration`.
  - Table `files` links `transfer_id` to a `storage_key` and file metadata.

---

### Features & flows

#### Sender: storage‑backed transfer (recommended)

1. **Choose file** in the “Send a file” panel.
2. Click **“Generate key & send”**.
3. The app:
   - Calls `POST /api/transfers/start` → creates a Redis session + Postgres transfer row.
   - Calls `POST /api/transfers/upload-url` → generates a presigned R2 upload URL.
   - Uploads the file **directly to R2** via `PUT` (no bytes go through the Next API).
   - Calls `POST /api/transfers/complete` → marks the transfer as completed and stores receiver count & file metadata.
4. A green card shows the **numeric key**. Share this key with receivers.

#### Receiver: download a file

1. In “Receive a file”, enter the key and click **“Join transfer”**.
2. The app:
   - Calls `POST /api/transfers/join` → validates the key and registers a receiver in Redis.
   - Opens `/api/transfers/live?code=...` (Edge WebSocket) to receive **live receiver count** updates.
3. When the sender has finished uploading:
   - Click **“Download file”**.
   - The app calls `POST /api/transfers/download-url` to fetch a presigned R2 download URL.
   - The browser navigates directly to that R2 URL to download the file.

#### Live presence

- Endpoint: `GET /api/transfers/live?code=<transferCode>` (WebSocket, Edge runtime).
- Periodically reads the receiver set for that transfer from Redis and broadcasts:
  - `{ type: 'receiver_count', transferCode, receiverCount }`
- Both sender and receivers show a **live “receivers joined” count** for the active transfer.

#### Experimental live streaming

There is an experimental WebSocket endpoint:

- `GET /api/transfers/stream?code=<transferCode>&role=sender|receiver`

It is intended to stream file chunks in real time from sender to receivers (SendAnywhere‑style), but:

- It depends on stable Edge WebSocket support in your deployment environment.
- In some local `next dev` setups (especially on Windows), binary WebSocket support via `WebSocketPair` can be unreliable, causing “Live streaming connection error” / “Live receive connection error”.

For production use today, rely on the **storage‑backed flow** described above.

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

### UX & constraints

- While a send is in progress:
  - The file chooser and send buttons are disabled to prevent conflicting actions.
  - Upload progress is shown as a percentage.
- On the receiver:
  - The “Download file” button is disabled until a transfer is in a valid state.
  - API errors are surfaced as short, clear messages.
- Sessions are ephemeral:
  - Transfer codes expire based on `transferConfig.sessionTtlSeconds`.
  - Late receivers may see “transfer not found or expired” once the session has been cleaned up.
