# Atomic Notes Server

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

The live app gates cloud sync behind a small in-app economy: instant sync
costs 10 energy, standard (hourly/background) sync costs 5 (free once within
the same hour), energy regenerates 20/day, and coins convert to energy at
40:1 — all enforced server-side via Postgres `SECURITY DEFINER` RPCs so the
client can't just edit its own balance.

`src/lib/energy.ts` ports the five RPCs (`energy_ensure`, `energy_grant_daily`,
`energy_convert`, `energy_spend`, `energy_spend_standard`, `energy_refund`) to
MongoDB, using multi-document transactions (wallet update + ledger insert,
atomically) in place of what a single Postgres function got for free. Exposed
over HTTP at `/api/energy/*` (`src/routes/energy.ts`).

**This is a primitives layer, not automatic gating.** In the live app, the
*client* decides when to spend — `NotesRepository.syncNow()` calls
`EnergyService.spendInstant()`/`spendStandard()` **before** pushing to
Supabase, and refunds if the upload then fails. This backend's `/notes`
endpoints deliberately don't charge energy internally, for the same reason:
that decision belongs to whatever orchestrates sync (today, the Flutter
client's `NotesRepository`), not to a single note's create/update/delete
call. When the client side of this migration happens, point its sync
orchestration at `POST /api/energy/spend-standard` (or `/spend` with
`amount: 10, reason: "Instant sync"`) the same way it calls the Supabase RPC
today, then call the `/notes` endpoints, then `/energy/refund` on failure.

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
cp .env.example .env   # fill in MONGODB_URI, Google OAuth creds, TOKEN_ENCRYPTION_KEY
npm run db:indexes     # creates indexes, including the sessions TTL index
npm run dev             # local server on http://localhost:3000
```

Deploy: push to GitHub, import into Vercel, add the same env vars in the
Vercel dashboard. `api/index.ts` + `vercel.json`'s rewrite route all `/api/*`
requests to the one Hono app.

**Verification update (2026-09-14):** dependencies have been installed and
`tsc --noEmit` passes locally after fixing Hono context declarations and the
admin middleware's asynchronous return type. The dependency set is recorded
in `package-lock.json`; use `npm ci` to reproduce it. This establishes a
TypeScript compile pass, not runtime or deployment verification. MongoDB,
Google OAuth/Drive, and cross-project integration tests remain pending the
Flutter build gate. See `Project-Docs/07-test-verification-matrix.md` in the
workspace for the recorded results and the root GitHub Actions workflow for
hosted verification.

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
- **Conflict detection on note edits** — still last-write-wins; the fields
  needed for a real check (`driveRevisionId`, `localVersion`) are there, the
  check itself isn't wired in yet.
- **CSRF state on the OAuth flow** — noted inline in `routes/auth.ts`.
- **Rate limiting** — needs a durable store (Upstash/Vercel KV), not a fake
  in-memory limiter that no-ops on serverless.
- **Realtime/push sync** — Supabase Realtime (websocket, row-level push) has
  no Drive equivalent; `changes.watch` webhooks are coarser. Still an open
  infra decision, not built.
- The `notifications_feed`/`notification_mark_read`/etc. RPCs exist in the
  live app too (same shape as Energy) but aren't touched here — flagging so
  it isn't a surprise later, not because it's hard. (Second-pass addition:
  it's actually two tables — a global `notifications` table, admin/service-
  role write only, plus a per-user `user_notifications` read-state table —
  per TESTING.md's RLS review.)

**One architecture-level mismatch worth knowing about, not just a missing
endpoint:** the live app's actual sync isn't per-note REST calls — `_push`/
`_pull` in `notes_repository.dart` batch-upsert all locally-dirty notes in
one call and pull everything changed since a cursor, backstopped by a
Realtime subscription for anything the cursor's client-clock skew might
miss (a known, documented low-risk issue in TESTING.md, L-1). This backend's
`/notes` endpoints are per-note CRUD instead — simpler REST, but a real
design choice, not an oversight. If the Flutter client is ever pointed at
this API instead of Supabase, its sync engine talking to per-note endpoints
one at a time (instead of one batched push/pull) is a bigger behavioral
change than swapping which backend it calls, and worth deciding on
deliberately rather than discovering during that integration.

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
