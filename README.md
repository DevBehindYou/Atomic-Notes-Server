# Atomic Notes Server

**Current readiness:** see [VERIFICATION.md](VERIFICATION.md) for the September
15 review, confirmed fixes, remaining release blockers and the new GitHub
Actions database/API suite. The historical migration notes below describe
implementation intent; they are not evidence of end-to-end verification.

Node.js + TypeScript + Hono backend for Atomic Notes, on MongoDB. Replaces
Supabase: Google Drive holds each user's actual note content (per the
migration brief's ownership principle), MongoDB holds everything else —
users, sessions, Google tokens, note/vault/folder metadata, the Energy
economy, and an audit log.

## Why MongoDB, and what changed from the first pass

The first pass of this backend used Postgres/Drizzle, following the original
brief. This version moves to MongoDB per direction to store sessions,
auth, logs, and user data there — which meant a real rewrite, not a
find-and-replace:

- **Sessions are now server-tracked, not a bare JWT.** `POST /auth/google` ->
  `/callback` issues an opaque token; only its SHA-256 hash is stored (see
  `src/lib/session.ts`). This is what makes `/auth/logout` real — a stateless
  JWT can't be revoked without a matching list anyway, so this *is* that list.
- **The Energy economy has a home.** See below — this is new in this pass.
- **Schema field names now mirror the live app's real tables**, not a guess.
  Read directly from the source (see "Where this came from").

## Where this came from

Two passes. First pass read the live app's `lib/` source via a code-search
tool (GitHits) scoped to individual files and grep results. Second pass got
the actual project archive (`Project-Atomic-Notes-main.zip`) — full source,
including `TESTING.md`, an internal audit doc with the exact migration
manifest (`001`–`009`, named) and an RLS column-by-column review. That
second pass corrected two real mistakes and confirmed the rest:

- **Fixed:** `atomicuser.last_standard_sync_at` — first pass invented a
  plausible-sounding name (`lastStandardSyncChargeAt`) for a column it knew
  had to exist but couldn't see. TESTING.md's RLS review states the real
  name directly. Corrected throughout `src/db/collections.ts` and
  `src/lib/energy.ts`.
- **Fixed:** new wallets now start with **5 coins**, not 0 — a one-time
  "welcome gift" documented in TESTING.md (item I-3) that the first pass had
  no way to know about and simply didn't include.
- **Added:** `atomicuser.note_limit` (default 20) and server-side enforcement
  on `POST /notes` — the live app's client-side cap is UX-only and
  bypassable by calling the API directly; TESTING.md confirms the real limit
  is a per-user Postgres column, and the client already parses the exact
  error string (`note_limit_reached`) this backend now returns on 409.
- **Confirmed, not guessed, on this pass:** `energy_convert` hard-rejects
  cap overflow rather than clipping; `energy_refund` is capped and ledgered;
  the full RPC name set; `note`/`atomicuser`/`energy_ledger` RLS is
  owner-scoped with all balance columns write-revoked for clients. All of
  this matches what this backend already did — good sign the first pass's
  inference from call sites alone was sound, just incomplete on the two
  points above.
- **Still not available, confirmed rather than assumed:** the actual SQL
  text. `TESTING.md` says so explicitly — the repo's own test file header
  states balance mutations are "verified against the live/test project, not
  here." There's a **separate private build repo** holding the real Supabase
  anon key and presumably the migrations themselves; this public repo
  intentionally ships without them. So the exact arithmetic in
  `src/lib/energy.ts` (rounding, isolation level, precise cap-boundary
  behavior) is still a careful reconstruction from documented behavior, not
  a copy — just a much better-informed one than the first pass.

One correction to something said **in chat**, not in this README: the
Atomic-Notes repo analysis two turns ago cited a public release page saying
"50-note free tier." The actual code's default is 20 (`NoteQuota.freeLimit`
in `note_quota.dart`) — the 50 figure was either stale marketing copy or a
number from a different context. Worth knowing if you'd cited that figure
anywhere else.

## Schema: Supabase table -> Mongo collection

| Supabase (live app) | Mongo collection | Notes |
|---|---|---|
| `note` | `notes` | title/body/items moved to Drive (`.atomic` files); this collection keeps kind/pinned/deleted/timestamps + Drive linkage (`driveFileId` etc., new) |
| `vault` | `vaults` | Direct carry-over. No salt column in either — it's computed (`SHA-256("atomic-notes-vault-v1|<user id>")`), never stored, by design |
| `atomicuser` | `atomic_users` | Direct carry-over, **including** the Energy wallet fields *and* `note_limit` living on the same document as `username` — that's how the live app does it too |
| `energy_ledger` | `energy_ledger` | Direct carry-over, including the `kind` enum's exact values |
| — | `users`, `google_accounts`, `sessions`, `logs` | New — Supabase's own `auth.users` covered identity + sessions before; there was nothing to carry over |

Full field-by-field mapping is in the comments above each schema in
`src/db/collections.ts`.

## The Energy economy

The app gates cloud sync behind a small in-app economy: instant sync costs
10 energy and is always open, automatic (standard) sync costs 5 and may start
once an hour, energy regenerates 20/day, and coins convert to energy at 40:1
— all enforced server-side so the client can't just edit its own balance.
Coins also buy note capacity: 10 coins per 10 notes, from 20 up to a ceiling
of 50 (`NOTE_LIMIT` in `src/lib/energy.ts`; `GET /api/energy` returns these numbers
as `limits` so the App shows what is enforced).

`src/lib/energy.ts` keeps the wallet operations (ensure, daily grant, convert,
note-limit purchase, refund) on MongoDB, using multi-document transactions
(wallet update + ledger insert, atomically) in place of what a single
Postgres function got for free. Exposed over HTTP at `/api/energy/*`
(`src/routes/energy.ts`).

**Sync is charged by the Server, not the client.** `POST /api/notes/push`
(`src/lib/syncOperation.ts`) charges the wallet when it accepts a request:
instant costs 10 and is always open; standard costs 5 and starts **at most once
per hour by the Server's clock**: inside the hour it answers
`429 sync_cooldown` with `retry_after_seconds` (and a `Retry-After` header), records
and charges nothing, and the App keeps the changes for the next window or for
instant sync. An empty batch is free. The request is recorded in
`sync_operations` under the client's `requestId`; if **no** note in the batch
was delivered the Server refunds it, once, and restores the previous standard
clock. A retry of a finished request returns the recorded outcome without
charging or writing again, even inside the hour. `POST /api/energy/refund`,
`/energy/spend` and `/energy/spend-standard` answer 410: a client can neither spend
nor refund. `POST`/`PATCH` on `/api/notes` answer 410 `use_push`: notes are written only
through `/push`, where sync is charged and rate limited.

**Note capacity.** `POST /api/energy/note-limit` with `{ from_limit }` buys the next
10 notes for 10 coins. `from_limit` is the limit the App showed, so a repeated
call after a lost response charges once. Errors: `insufficient_coins`,
`note_limit_ceiling` (at 50), `invalid_amount` (the caller is ahead of the Server).
`POST /notes/push` enforces the limit: a batch may delete a note and add one at
the limit, but only deletions that will really happen make room.

**Only edited notes reach Drive.** Each note stores a `contentHash` of what was last
written. A pushed row with the same fingerprint and deleted flag returns
`ok` with `unchanged: true` and the stored `version`, and no Drive call is made.
Rows that do need Drive are written 4 at a time (each write is about 1.7 s of
waiting) and committed to MongoDB in the order they were sent, so sequence
numbers stay consecutive.

**Housekeeping.** A deleted note's row (tombstone) expires after 30 days
(TTL index `tombstone_ttl`; run `npm run db:indexes` after deploying), matching
the Drive trash. Log rows expire after 30 days (TTL index `logs_ttl`, same
command); the energy ledger is kept. Each account keeps its newest 5 sessions;
older ones are revoked at sign-in.

MongoDB transactions **require a replica set** — Atlas gives you one by
default (including the free tier); a bare standalone `mongod` does not
support transactions at all and `withTransaction` will throw. Worth knowing
before you point this at a local single-node Mongo for testing.

## The Vault (client-side E2E encryption)

`src/routes/vault.ts` intentionally does very little: `GET /api/vault`
returns the verifier + KDF params (or 404 if none exist), `POST /api/vault`
creates one (insert-only — 409 if it already exists, same as the live app's
"never overwrite, that orphans other devices' notes" rule). There is
deliberately no unlock/verify endpoint — in the live design the recovery
phrase never leaves the device, the key is derived and checked locally, and
the server only ever sees a verifier blob. Don't add a server-side "check
this phrase" endpoint; that would defeat the design.

## Setup

```bash
npm install
cp .env.example .env   # fill in every variable; see the comments in the file
npm run db:indexes     # REQUIRED once per database: sessions/lock/OAuth-state TTL indexes and note indexes
npm run dev             # local server on http://localhost:3000
```

`db:indexes` changes the database named by `MONGODB_URI`/`MONGODB_DB_NAME`.
The application never creates indexes itself; without the TTL indexes,
expired locks, sessions and OAuth state are only ignored, not removed.

Deploy: push to GitHub, import into Vercel, add the same env vars in the
Vercel dashboard. `api/index.ts` + `vercel.json`'s rewrite route all `/api/*`
requests to the one Hono app. On a production Vercel cold start
(`VERCEL_ENV=production`), `src/lib/envGuard.ts` refuses to start if a required
variable is missing or malformed and names the variable (never its value) in
the function log; `GET /api/admin/health` reports the same list as
`configuration`. The step-by-step first deployment is in
`Project-Docs/10-deployment-guide.md` in the workspace.

**Verification status:** see [VERIFICATION.md](VERIFICATION.md) and
`Project-Docs/09-agent-handoff.md`. Local typecheck, build, unit tests and
audit pass on the working tree; the MongoDB integration suite runs only on
GitHub Actions; nothing has run against real Google or a deployed Server.

## What's real vs. stubbed

**Implemented; end-to-end verification still pending:** Google OAuth login issuing a
MongoDB-backed session (with a real `/auth/logout`), encrypted Google token
storage, automatic Drive folder setup, Notes CRUD (Drive + Mongo metadata)
with server-side note-limit enforcement, the full Energy primitive set with
transactional wallet+ledger writes, vault verifier storage, username
get/set, a `logs` collection wired into
login/logout/vault-creation/note-deletion/failed-spend events, and a
separate admin API (`/api/admin/*`, see below) for Atomic Community's
Controller panel.

**Deliberately stubbed, not silently faked:**
- `POST /api/folders` — same 501-with-a-pointer as the first pass.
- **Rate limiting** — needs a durable store (Upstash/Vercel KV), not a fake
  in-memory limiter that no-ops on serverless.
- **Realtime/push sync** — Supabase Realtime (websocket, row-level push) has
  no Drive equivalent; `changes.watch` webhooks are coarser. Still an open
  infra decision, not built. Other devices see changes on their next sync.
- **Drive files changed outside the app** are handled but not undone: a
  permanently deleted note file is skipped by pull (reported as `skipped`, with a
  `notes_unreadable` log event) and written again by the next push of that note
  (`drive_file_recreated`); a deleted app folder is recreated once
  (`drive_folder_recreated`); wiping tolerates files that are already gone.
  Devices that never held the note cannot recover its content.
- **Delivered-but-unacknowledged pushes after the App loses its saved
  request** — the Server then sees the retry as a version conflict and the App
  keeps the edit as a "(conflict copy)" note. Nothing is lost, but a duplicate
  can appear.
- The `notifications_feed`/`notification_mark_read`/etc. RPCs exist in the
  live app too but aren't touched here (per-user read/dismiss state).

## Sync protocol (App <-> Server)

Both sides must ship together.

- **Push:** `POST /api/notes/push` with `{ requestId (UUID), mode: "standard" | "instant", rows: [...] }`,
  at most 50 rows. Each row carries `base_version` (the version the App last
  saw, 0 for a new note). A row whose `base_version` is not the stored version
  fails with `note_conflict` (and the current `version`); nothing is
  overwritten. Any failed row makes the response HTTP 502 with per-row
  `results`; a batch where every row failed is refunded. Success rows carry the
  new `version` and `updated_at`.
- **Idempotency:** the same `requestId` with the same rows returns the recorded
  result; with different rows it is 409 `sync_request_mismatch`. A request
  that died midway is settled by the user's next write from stored results:
  a row counts as delivered only if its success was committed together with
  its note metadata.
- **Pull:** `GET /api/notes/pull?after=<cursor>` returns ten rows ordered by a
  per-user monotonic `syncSequence`, plus `nextCursor` and `hasMore`. Deleted
  notes stay as tombstones so other devices learn about them. A cloud wipe (`DELETE /api/notes`) is different: it removes the rows too and leaves no tombstones, so no device deletes its local notes.
- **Revoked or expired Google grant:** when Google refuses the stored refresh
  token (the user revoked the app, or seven days passed in *Testing*), the
  request answers 401 `google_reauth_required`. The App treats a 401 as an ended
  session and shows the sign-in screen. A push that was already accepted stays
  open; after signing in, retrying the same `requestId` resumes it without a
  second charge.
- **Deleted notes keep their content for the Recycle Bin.** A pull sends a tombstone's content read from its
  trashed Drive file; a deletion whose file is gone still arrives, without content.
- **Reads take no lock.** `GET /notes/pull` reads the per-user sequence counter first and only rows up to
  it. Writes are serialized per user and each sequence commits before the next is issued, so everything at or
  below the counter is visible and later writes arrive in the next pull. Each written row in a push result
  carries its `seq`; the App uses it to skip re-reading its own rows from Drive when they are the next
  sequences after its cursor.
- **Timing:** every `/api/notes` response has a `Server-Timing` header (`total`, `drive` with the call
  count), and each `notes_pushed` log event stores `ms`, `driveMs` and `driveCalls`
  (`npm run db:inspect -- <email>` prints them). An integration test caps the MongoDB commands per
  one-note operation, because every command is a network round trip. **Run the Vercel function in the same
  region as Atlas** (`vercel.json` sets `bom1` for a Mumbai cluster); a function in another continent pays
  about 200 ms per command.
- **Per-user lock:** every `/api/notes` request holds a Mongo lock for that
  user (lease 600 s, longer than the 300 s function limit). Requests wait up
  to 15 s for it, then fail with 409 `operation_in_progress`.
- **Drive vs MongoDB:** they cannot commit together. New Drive files are named
  `<noteId>.atomic` and a retry reuses an existing file of that name instead of
  creating a second one. A success is never reported before its metadata is
  committed.

## Admin API (`/api/admin/*`) — for Atomic Community's Controller panel

Separate from everything above: a second trust boundary for one caller only
— Atomic Community's server-side `/controller` admin routes, not end users
and not the Flutter app. Auth is a single static key
(`ADMIN_API_KEY`), sent as an `x-admin-api-key` header and checked in
`src/middleware/adminAuth.ts` — deliberately unrelated to any user's Google
session, so rotating one credential never touches the other.

Ported directly from the real SQL this time (`Project-Atomic-Notes-New`'s
`supabase/migrations/011_controller_stats.sql` and Atomic Community's actual
route handlers), not reconstructed from guesses:

- `GET /admin/health` — Mongo connectivity check
- `GET /admin/stats` — the Controller dashboard's aggregate numbers (users,
  active/new counts, coins/energy outstanding, notification/ledger counts) —
  `src/lib/adminStats.ts` is a direct port of `controller_stats()`
- `GET /admin/user?email=` — look up a user's account + wallet state before
  adjusting anything
- `POST /admin/energy` — adjust any user's coins/energy by delta (clamped,
  ledgered as `kind: 'admin_adjust'`), by email or user_id
- `GET/POST/PATCH/DELETE /admin/notifications` — full CRUD, same snake_case
  field shape as the live app's `notifications` table
- `GET /api/public/notifications/active` — separate, **unauthenticated** —
  the public read path for Community's homepage and `/updates` page, kept
  apart from the admin surface on purpose (lower trust, no key needed)

## Status: App and Community migrations

The Flutter app (`Project-Atomic-Notes`) and Atomic Community (the Next.js
site + Controller panel) have both since been migrated to call this server
instead of Supabase directly — see their own repos/READMEs for what changed
on each side. This server is the single backend all three now share.
