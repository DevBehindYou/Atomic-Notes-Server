# Server readiness review — September 14, 2026

## Verdict

The App and Community are wired to Server routes, but full integration and
production readiness are **not yet verified**. The Server is not deployed.
The user selected GitHub Actions for database verification because local
storage is limited. No local MongoDB, Docker or Flutter installation was made.

## Confirmed fixes in this change

| Problem | Change |
|---|---|
| App omits `updated_at`, while Server required it for every pushed row | Accept omitted client timestamps and retain Server-owned update timestamps |
| Batch note upsert filtered only by ID, allowing a different authenticated account to replace ownership | Reject foreign-ID collisions before Drive calls and scope all note writes by authenticated user ID |
| App ignored per-row failures in a successful HTTP push response and cleared dirty flags | Failed batches now return HTTP 502 with `note_sync_failed` and the per-row results; the existing App error path keeps notes dirty |
| PATCH containing only `pinned` replaced title/body/items/payload with empty values | Read existing Drive content and merge only supplied fields, preserving explicit payload null |
| Revived tombstones bypassed the sequential quota check; duplicate IDs caused repeated writes | Count revived active notes and reject duplicate IDs before Drive writes |
| Drive delete errors were swallowed during batch deletion and remote wipe | Return failure and retain Mongo metadata needed for retry |
| Public notification endpoint returned user-targeted content | Require `targetAudience: all` and no target user in addition to active/unexpired status |
| Admin email lookup interpreted regex metacharacters | Escape literal email text while preserving case-insensitive matching |
| Invalid request data returned 500; unexpected errors exposed raw messages | Validation and malformed JSON return 400; unexpected errors use a generic 500 response |
| Unicode admin-key input could make timing-safe comparison throw | Compare byte lengths before comparing buffers |
| Profile creation could grant welcome coins without a ledger row | Reuse the transactional wallet initializer; successful login also initializes the wallet before issuing a session |
| Unbounded Drive reads/deletes and missing incremental query index | Limit concurrent requests to four; add `(userId, updatedAt)` note and `(userId, createdAt)` session indexes |
| Setup instructed users to create `.env`, but scripts never loaded it | Node 22 development/index scripts explicitly load `.env` if present |

Pull responses now include a request-start cursor even for empty results,
include the timestamp boundary on subsequent pulls, and batch metadata is
timestamped after each Drive operation. These reduce gaps but do **not** solve
the App cursor/concurrency issues below.

## Verification and CI

- Local: TypeScript checks cover production code and test code. Unit tests
  exercise request validation, literal email patterns, admin auth, token
  encryption, bounded Drive scheduling and actual entrypoint auth guards.
  All eight local unit tests passed. `npm run typecheck` and
  `npm run build` both completed successfully.
- Dependency audit: zero high/critical findings; four moderate package entries
  (`googleapis`, `googleapis-common`, `gaxios`, `uuid`) trace to
  [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
  No forced Google SDK major update was made without OAuth/Drive verification.
- `.github/workflows/typecheck.yml` now builds and tests, audits at high
  severity, then starts an isolated MongoDB 7 replica set in Docker on the
  GitHub runner. No repository secrets are required for this suite.
- `npm run test:integration` requires a disposable localhost replica set.
  It generates a unique database and drops only that database afterward.
  It checks actual MongoDB writes, transaction rollback/concurrent daily
  grants, sessions/logout, vault creation, notes, and Community API contracts.
- Google Drive uses an injected in-memory adapter in that suite. This tests
  Server behavior around successful/failing Drive operations; it does not
  test the real Google SDK, OAuth exchange, scopes, token refresh or Drive.
- The suite tests Hono requests in process, not the deployed Vercel adapter
  or a running Community browser UI. The standalone Server workflow cannot
  independently prove execution of the other two repositories.

The hosted database suite is **pending push/run**, not claimed as passed.
Apply `npm run db:indexes` to the intended deployment database during setup;
the application does not automatically create indexes.

## Remaining release blockers and limits

1. **OAuth:** browser state is generated but neither persisted nor verified
   at callback. Returning login requires a fresh refresh token even if a
   stored token exists; failed initial Drive-folder setup is not retried on
   returning login. Identity linking and concurrent onboarding need real
   provider tests. Do not expose the unfinished browser flow as production-ready.
2. **Energy authorization:** authenticated clients can request arbitrary
   refunds with no recorded-spend reference or single-use refund check.
   Notes writes do not enforce a paid sync operation. Transactions protect
   wallet/ledger atomicity, not authorization or refund idempotency.
3. **App sync:** `notes_repository.dart` sets `lastSyncedAt` from the device
   clock, while `atomic_notes_api.dart` discards the Server cursor. Clock skew
   and concurrent edits can lose updates. A local edit arriving during push
   can also have its dirty flag cleared by the older request. Server changes
   here do not solve those client races.
4. **Cross-service consistency:** Drive and MongoDB cannot commit in one
   transaction. Partial batches and orphan files remain possible; retries
   and reconciliation need a defined protocol. Concurrent creates can race
   the count-based quota check. Reviving a trashed note does not yet untrash
   its Drive file. Conflict/version checks remain absent.
5. **Scale:** note/admin lists remain unpaginated. Four concurrent Drive
   calls is a resource bound, not a measured latency or throughput result.
   Durable rate limiting and realtime notifications remain unimplemented.
6. **Other missing coverage:** concurrent vault insertion can still return
   a duplicate-key 500 instead of 409. Folder creation and notification
   read/dismiss state remain incomplete. Google SDK moderate advisories
   require a tested dependency upgrade.

MongoDB's [transaction guidance](https://www.mongodb.com/docs/drivers/node/v6.x/crud/transactions/)
requires replica-set support and prohibits parallel operations within a single
transaction. The new concurrency helper is used only for independent Drive
operations, not wallet transaction statements.

## Next verification step

Commit all Server changes, including the previously untracked `.github/`
directory, `tests/`, `src/lib/concurrency.ts`, `src/lib/validation.ts`, `src/types/noteWire.ts`, and
`tsconfig.test.json`. Push to main and run **Server verification**.
Review that log before claiming MongoDB/API integration passes. Real Google
onboarding, a deployed Server, Community UI actions and multi-device App
sync remain subsequent end-to-end checks.
