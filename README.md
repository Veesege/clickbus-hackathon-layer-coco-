# Clickbus Agent

> **TLDR:** An autonomous agent that listens for Zendesk webhooks from Clickbus ticket submissions, parses the PDF attachment using Claude AI, looks up the matching booking in Bookaway's admin API, and automatically approves it — then closes the Zendesk ticket. A human-in-the-loop dashboard lets agents review and manually approve anything the bot couldn't handle automatically.

---

## User Flows

### Flow 1 — Fully Automatic Approval

```
Clickbus customer submits ticket PDF
        │
        ▼
Zendesk receives ticket → triggers webhook → POST /api/clickbus/trigger
        │
        ▼
Agent downloads PDF attachment from Zendesk
        │
        ▼
Claude Haiku extracts: name, seats, date, origin city, destination city
        │
        ▼
Bookaway Admin API searched by passenger name → candidates scored by date+cities
        │
        ▼
Best match found (score ≥ 1)
        │
        ▼
PDF uploaded to Bookaway → booking approved via API
        │
        ▼
Zendesk ticket closed with internal comment ✅
```

### Flow 2 — Manual Review (Human-in-the-Loop)

```
Agent fails to find/match booking
        │
        ▼
Log entry created with status = "pending" + error message
        │
        ▼
Dashboard agent sees pending entry at /
        │
        ▼
Agent clicks "Approve" button → POST /api/clickbus/approve/:id
        │
        ▼
Server re-downloads PDF, calls Bookaway API, closes Zendesk ticket
        │
        ▼
Log marked "reviewed" ✅
```

### Flow 3 — Round Trip Tickets

```
First leg PDF arrives → stored as pending (waiting for companion)
        │
        ▼
Second leg PDF arrives → detected as same bwRef
        │
        ▼
Both PDFs merged → single approval call with departure + return data
        │
        ▼
Both Zendesk tickets closed simultaneously
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 18 |
| Web server | Express 4 |
| PDF parsing | `pdf-parse` (text extraction) |
| AI extraction | Anthropic Claude Haiku (`claude-haiku-4-5-20251001`) |
| Database | SQLite via `better-sqlite3` |
| Auth | Custom HMAC-SHA256 signed session cookie |
| Environment | `dotenv` |
| Deployment | Fly.io (via `fly.toml` + GitHub Actions) |
| CI/CD | GitHub Actions → `fly deploy` on push to `master` |

---

## Software Architecture

```
┌─────────────────────────────────────────────────────┐
│                      server.js                      │
│                                                     │
│  ┌─────────────┐   ┌──────────────────────────────┐ │
│  │  Auth layer │   │         Express routes        │ │
│  │  (HMAC      │   │  POST /api/clickbus/trigger   │ │
│  │   session   │   │  POST /api/clickbus/approve   │ │
│  │   cookie)   │   │  GET  /api/logs               │ │
│  └─────────────┘   │  POST /api/logs/:id/review    │ │
│                    │  POST /api/logs/:id/dismiss    │ │
│                    │  GET  /login  POST /login      │ │
│                    └──────────────────────────────┘ │
└────────────────────┬────────────────────────────────┘
                     │
          ┌──────────┴──────────┐
          │                     │
   ┌──────▼──────┐       ┌──────▼──────┐
   │ clickbus.js │       │    db.js    │
   │             │       │             │
   │ parseWith   │       │  SQLite     │
   │ Claude()    │       │  logs table │
   │             │       │             │
   │ findClickbus│       │  log()      │
   │ Booking()   │       │  updateLog()│
   │             │       │  claimFor   │
   │ approveClick│       │  Approval() │
   │ busBooking()│       └─────────────┘
   └──────┬──────┘
          │
   ┌──────┴──────────────┐
   │   External APIs     │
   │                     │
   │  Anthropic API      │
   │  (Claude Haiku)     │
   │                     │
   │  Zendesk REST API   │
   │  (tickets/comments) │
   │                     │
   │  Bookaway Admin API │
   │  (auth/bookings/    │
   │   approve/upload)   │
   └─────────────────────┘
```

### Key Design Decisions

- **Async fire-and-forget webhook**: `POST /api/clickbus/trigger` responds `200 OK` immediately and processes in the background — Zendesk doesn't wait for the full pipeline.
- **Atomic claim (`claimForApproval`)**: prevents double-approval race conditions by using a `status='approving'` SQLite UPDATE that only one request can win.
- **Scoring system**: bookings are ranked by `isoDate` match (+3), `fromCity`/`toCity` keyword matches (+1 each), and `pending+approved` status (+1) before a final threshold gate (`score ≥ 1`).
- **DRY_RUN mode**: setting `DRY_RUN=true` runs the full pipeline (PDF parse, name match, scoring) but skips the actual Bookaway approval and PDF upload calls.

---

## DB / Data

### Database

SQLite file at:
- **Development:** `./logs.db` (project root)
- **Production (Fly.io):** `/data/logs.db` (persistent volume)

### Schema

```sql
CREATE TABLE logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT    NOT NULL,          -- ISO 8601 UTC
  type      TEXT    NOT NULL,          -- e.g. "clickbus"
  status    TEXT    NOT NULL DEFAULT 'pending',
  summary   TEXT    NOT NULL,          -- human-readable one-liner
  data      TEXT,                      -- JSON blob of parsed ticket + booking info
  error     TEXT,                      -- error message if failed
  tags      TEXT,                      -- JSON array e.g. ["clickbus"]
  notes     TEXT                       -- reserved for future use
);
```

### `status` lifecycle

```
pending → approving → reviewed
                   ↘ pending  (on error — reset)
pending → dismissed
```

### `data` JSON fields (when booking is found)

| Field | Type | Description |
|---|---|---|
| `bwRef` | string | Bookaway booking reference |
| `bookingId` | string | Bookaway internal `_id` |
| `passengerName` | string | Full name from PDF |
| `route` | string | Resolved origin → destination |
| `date` | string | Departure date |
| `seats` | string[] | Seat numbers from ticket |
| `passengers` | number | Passenger count |
| `ticketId` | string | Zendesk ticket ID |
| `pdfUrl` | string | Zendesk attachment URL |
| `roundTrip` | boolean | Whether booking has 2 legs |
| `dry` | boolean | Whether DRY_RUN was active |

---

## Security

### Dashboard Authentication

- Protected by a **username + password** set via env vars (`DASHBOARD_USER`, `DASHBOARD_PASS`).
- On login, the server issues a **signed session cookie** (`coco_session`):
  - Payload: `username:timestamp`
  - Signature: `HMAC-SHA256(payload, SESSION_SECRET)`
  - Cookie flags: `HttpOnly`, `SameSite=Strict`, `Path=/`
- On each request, `verifySession()` re-validates the HMAC — no external session store needed.
- If `DASHBOARD_USER`/`DASHBOARD_PASS` are not set, auth is **disabled** (dev mode).

### Webhook (`/api/clickbus/trigger`)

- Intentionally **excluded from auth middleware** — Zendesk triggers it server-to-server.
- Validates that `ticket_id` is a non-empty string of digits only (`/^\d+$/`) before processing.

### API Credentials

- All secrets (Zendesk token, Bookaway credentials, Anthropic key) are loaded from environment variables — never hardcoded.
- Bookaway admin token is cached in memory with a 23-hour TTL; `invalidateToken()` is called immediately on any `401`/`403` response.

### Double-Approval Prevention

- `claimForApproval(id)` performs an atomic SQL `UPDATE ... WHERE status = 'pending'` — only the first concurrent request succeeds; subsequent ones receive `409 Conflict`.

---

## Setup

### Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
ANTHROPIC_API_KEY=       # Anthropic API key for Claude Haiku PDF parsing
ZENDESK_SUBDOMAIN=       # e.g. "bookaway"
ZENDESK_EMAIL=           # Zendesk agent email
ZENDESK_TOKEN=           # Zendesk API token
ZENDESK_REFERENCE_FIELD_ID=  # Optional: custom field ID for BW reference
ADMIN_EMAIL=             # Bookaway admin login email
ADMIN_PASSWORD=          # Bookaway admin password
DRY_RUN=true             # Set to "false" to enable real approvals
PORT=3000
DASHBOARD_USER=          # Dashboard login username
DASHBOARD_PASS=          # Dashboard login password
SESSION_SECRET=          # Long random string for cookie signing
```

### Run locally

```bash
npm install
npm start
```

### Deploy to Fly.io

```bash
fly deploy
```

CI/CD automatically deploys on push to `master` via `.github/workflows/fly-deploy.yml`.

---

## Zendesk Trigger Setup

Create a Zendesk trigger with:
- **Condition:** Tag contains `clickbus` (or desired condition)
- **Action:** Webhook → `POST https://<your-app>.fly.dev/api/clickbus/trigger`
- **Body:** `{"ticket_id": "{{ticket.id}}"}`
