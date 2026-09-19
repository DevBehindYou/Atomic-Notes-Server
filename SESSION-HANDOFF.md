# Server session checkpoint - September 19, 2026

This repository has **uncommitted** readiness changes. Nothing was committed,
pushed or deployed. No Server deployment exists; Atlas and Google Cloud are not
configured. Intended origin: `https://atomic-notes-server-gde2e.vercel.app`.
Resume only on a new user request.

## Verified where

- Last hosted pass: commit `726539d1f94cc3c4e20c36e11635c090f20891e5`
  (`logs_94679360100.zip`): eight unit tests and six replica-set scenarios
  using a fake Drive. It does not cover the current working tree.
- Working tree, run locally on September 18-19: `npm run typecheck` (including
  tests), `npm run build`, `npm test` (11 unit tests) and `npm audit` (zero
  vulnerabilities) all pass.
- `npm run test:integration` has **not run**: it needs a MongoDB replica set,
  which this device does not have (do not install MongoDB, Docker or Flutter;
  storage is limited). The new scenarios exist and type-check; they run on
  GitHub Actions after the user pushes.
- Nothing has run against real Google (OAuth, Drive) or a deployed Vercel
  function.

## What changed since the September 15 checkpoint

- Sync results are authoritative: a success is stored in the same transaction
  as the note metadata; refunds derive from stored results and happen once.
- A finished `requestId` is replayed from its record before quota/token checks.
- Operations abandoned by a dead request are settled by the user's next write
  (rows with no stored result count as not delivered); the recovery deadlock is
  gone. Closed operations refuse later metadata commits.
- Per-user lock waits up to 15 s. Drive create reuses an existing
  `<noteId>.atomic` file. `PATCH` needs `base_version`, refuses deleted notes,
  and shares content bounds with push. Production env validation and the
  `configuration` field on `/api/admin/health`. README corrected.

## Added after the first deployment (September 19, uncommitted)

- Pull skips notes whose Drive file is missing or corrupt (`skipped` count, log event) instead of failing
  the whole pull; push recreates a missing file or app folder; wipe tolerates missing files.
- A revoked or expired Google grant answers 401 `google_reauth_required` (push, pull, wipe); an accepted
  push stays open and resumes on retry. The error handler no longer logs whole error objects (they can
  carry bearer tokens).
- Sign-in falls back to the Google profile endpoint if the token response has no ID token.
- `sync_operations` expire after 30 days (**run `npm run db:indexes` again**).
- `npm run db:inspect -- <email>`: read-only account state for device tests.
- Local: typecheck, build, compiled-entrypoint load, 15 unit tests, audit 0. The new integration
  scenarios (Drive deletions, revoked grant, profile fallback, TTL index) have not run on GitHub yet.

## Still open

Rate limiting; unpaginated `GET /notes` and admin lists; real Google verification
(sign-in, Drive writes) and multi-device checks on a phone; load testing. A
delivered push whose App-side request record was lost surfaces as a
"(conflict copy)" in the App. A note whose Drive file was deleted cannot be
recovered by a device that never held it.

App and Server must ship the new push/pull protocol together. Run
`npm run db:indexes` against the intended Atlas database during setup only, and
follow `Project-Docs/10-deployment-guide.md`. Full context:
`Project-Docs/09-agent-handoff.md` in the workspace. Never ask for production
secrets in chat.
