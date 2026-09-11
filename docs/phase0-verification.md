# Phase 0 implementation and verification — 8 September 2026

## Local result

Implemented and tested locally; not pushed or deployed. The local server was restarted after an encrypted backup and corrected wage refresh. This is an engineering verification record, not a finding of legal compliance.

- Centre accounts without a valid assigned centre return 403. Unknown roles fail closed. Every authenticated request rechecks the account, role and centre assignment. Deleted accounts and password changes invalidate sessions. New logins regenerate session IDs.
- Viewer/demo access blocks identified pipeline, exits, action-plan and audit pages. Centre pages withhold individual exit/leave rows and action-plan/audit content from viewers; aggregate views remain available. This does not guarantee that small groups cannot be re-identified.
- Centre overview excludes group P&C, group trends and group AI briefings. AI lookups reject invalid centre scope.
- Admin/operations writes are restricted; exec is read-only. New users default to viewer. New/reset passwords require 12 characters; production cannot seed the published default password.
- API response bodies and AI provider messages are withheld from errors and logs. Snapshot sub-step failures log and store a one-line summary (error name + message, never an upstream body) per source in `source_sync`; a run with a failed sub-step is marked `partial` with the reasons in its note, and the Wages and wage-budget pages show the payroll import status (last success, pay periods covered, or the failure reason). Authenticated responses use no-store, no-referrer, nosniff and frame-denial headers. Cross-origin writes with an Origin header are rejected.
- AI request limits are 20/user/hour and 300/team/day by default. They are in-memory and reset on restart; they are not a durable billing cap. AI prompts still go to the external provider. No automatic personal-information redaction has been added.
- Privacy notices no longer claim Australian hosting or automatic 12-month feedback deletion. Trial briefing updated.

## Wages

The importer pages through all payruns and employees, selects the latest configured pay-period endings, and imports every finalised run in those periods. The default history window remains 16 periods. Earnings are retrieved by run ID, never allocated by payment date. All finalised runs sharing a period are summed. Room, kitchen and cleaning sublocations roll up to their parent centre/cost centre. Kitchen and cleaning worked amounts remain separate buckets.

Every employee gross total is reconciled to the run's earnings lines before any database changes. EH returns earnings at greater precision than its employee gross totals. Only an employee's half-cent-or-smaller rounding residual is applied to their largest earnings line. Other discrepancies stop the refresh before the existing wages are replaced. Each selected period is replaced inside one transaction.

Real-source verification: 26 finalised runs across 16 pay-period endings reconciled. The local refresh wrote 99 centre-period rows. Combined gross wages across those runs: $3,927,131.11 (all centres/cost centres and wage categories; not educator-only wages). This establishes gross-pay reconciliation, not correctness of every historical job-role classification or allowance unit. Historical job classification still uses current employee metadata plus earnings location. Period-end allocation is not a daily accrual allocation for multi-week runs.

API references:
- https://api.keypay.com.au/australia/reference/pay-run/au-pay-run--get-pay-runs.html
- https://api.keypay.com.au/australia/reference/pay-run/au-pay-run-earnings-line--get.html

## Workbook verification

Read the actual GWH Futuro Action Plan workbook (12 monthly sheets) and Final Term2 2026 GWH Compliance Audit workbook. The compliance parser produced seven Quality Areas, 30 actions and a 79% overall result; due dates and progress notes were present.

The monthly editor already represented context, status assessments and urgent/BAU/support/keep-in-mind action groups. Added start/logged date, goal completion date, progress/monthly update, intended outcome, priority and support job reference. These fields save and render, and the plan plus items now save atomically. The editor preserves more than six existing items rather than silently losing later rows.

This was structure/parser validation, not an import of the monthly workbook. Its separate insights/initials/suggestions and red/amber summary blocks are not replicated as separate sections. Audit actions remain in Q&C; automatic conversion into monthly actions is not implemented. Historical plans can still show current auto-suggestions where no saved assessment exists.

## Tests

`npm test` (tested using Node 18.20.4 matching the existing native SQLite module) passes 12 regression cases plus their parent test:

1. Missing/invalid centre assignments and unknown roles denied.
2. Centre scope enforced for overview, direct URLs, writes and AI tools.
3. Viewer identified-page restrictions and opening-centre bypass closed.
4. Password reset and account deletion revoke existing sessions.
5. Action-plan tracking fields round-trip and injected HTML is escaped.
6. Encrypted backup restores, rejects wrong key/tampering and never overwrites an existing destination.
7. Payroll pagination exceeds 30 runs and rejects repeated pages.
8. Runs with the same payment date land in their own periods; multiple runs in one period sum; failed reconciliation preserves old wages.
9. AI usage limit and cross-origin write/header protection.
10. Employee rounding tolerance rejects larger discrepancies.
11. Production default-password seed rejected; schema and data survive reopening the database.
12. All EJS templates compile.

Authenticated local smoke check: HTTP 200 for overview, wages, P&C, Q&C, action plans, action-plan editor, safety, rostering, pipeline, ask, user admin, feedback and an operating centre page.

A backup of the actual local database was encrypted and restored to a temporary file. SQLite integrity_check returned ok, 25 tables were present and the centre count matched. The restored test file was deleted; the encrypted rollback backup remains under the gitignored backups directory.

## Backup operation

`npm run backup` requires BACKUP_PASSPHRASE (at least 20 characters), DB_PATH and optional BACKUP_DIR. New backups use authenticated AES-256-GCM with scrypt and random salt/nonce. There is no plaintext fallback. Keep the passphrase separately in the organisation's password manager.

`npm run restore -- /path/to/backup.db.enc /path/to/NEW-restored.db` validates authentication and SQLite integrity before writing a new destination. It refuses to overwrite an existing database. Legacy OpenSSL CBC backups are not accepted by this new restore command; retain their original OpenSSL restoration instructions if needed.

Off-host delivery, scheduling and automatic pruning are not configured. No off-host backup or disaster-recovery claim is made.

## Deployment limits / remaining work

Render's public login returned HTTP 200. render.yaml specifies a /data persistent disk and /data/owna.db with runtime schema initialization. Actual mounted disk, current deployed commit, live database integrity, host region and at-rest encryption were not verified: Render dashboard access was unavailable. Australian hosting has not been established.

After deployment, `node scripts/verify-deployment.js` in the service shell reports the actual DB path, mount evidence, commit where provided, quick_check and aggregate freshness information without emitting records or credentials. A controlled restart/redeploy check is still needed to prove live persistence.

Node 18 remains configured and needs a separately tested runtime/dependency upgrade. Session storage is still MemoryStore. Durable AI budgeting, provider agreements/privacy governance, retention configuration, off-host backups and live hosting verification remain outside the completed local controls. Do not describe Phase 0 or Australian privacy compliance as fully complete until the outstanding operational controls are verified.
