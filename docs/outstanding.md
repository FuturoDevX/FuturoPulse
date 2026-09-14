# Outstanding work — Futuro Pulse

Everything not yet done, and who it waits on. Updated 12 September 2026.
The full sequence and reasoning live in the work plan: https://claude.ai/code/artifact/ec2a6dab-fcc9-41a1-be33-9ad741b73836

## Waiting on a decision or access (nobody can start these)

| # | Needed | From | Blocks | Wanted by |
|---|---|---|---|---|
| 1 | Australian host: Fly.io Sydney or Azure Australia East | Owner + dev | Hosting move, encryption at rest | Week 2 |
| 2 | Which database is the source of truth — the laptop copy or the Render disk. They have diverged | Owner + dev | What the hosting move restores | Week 2 |
| 3 | Render dashboard and shell access | Owner | Backup schedule, verified restore, env-var inventory | Week 2 |
| 4 | Reporting year: financial or calendar | CEO | Year-to-date figures everywhere (financial year is the current default) | Week 2 |
| 5 | COE targets per centre: continuation % and backfill count | CEO + owner | Replaces the single 95% placeholder on /coe | Week 2 |
| 6 | Licensed places for Cobbitty and Oran Park | Owner | Percentages for the two opening centres on /coe | Week 2 |
| 7 | How each centre sets recurring bookings in OWNA: rolling, or ending 31 December | Centre directors | COE accuracy. Heath Rd appears to end them, which distorts every forward view for that centre. The measured count now **detects** a centre whose forward bookings stop dead on one date and says so instead of reporting a collapse, but only the directors can say which centres are set which way | Week 2 |
| 8 | Lead and tour targets per centre per month | Owner | The targets table on /pipeline exists and is empty | Week 2 |
| 9 | Which Employment Hero termination reasons count as a managed exit | P&C | Talent pipeline build | Week 3 |
| 10 | Retention period per data set | Owner | The retention purge job | Week 3 |
| 11 | Social page admin access, or agreement to monthly entry; and "lead source" filled in LineLeader | Marketing + enrolments | Social performance against leads | Week 4 |
| 12 | Which tool holds recruitment applications, and access to it | P&C | Recruitment stats and talent pool depth | Week 4 |
| 13 | Where training and qualification records live | P&C | Training and development dates | Week 4 |
| 14 | A "Staff family" tag in LineLeader, applied to current staff families | Enrolments | Staff-discount waitlist count | Week 4 |
| 15 | Monthly fixed costs per centre: rent, outgoings, insurance, admin | Finance | Break-even occupancy line on Wages | Week 4 |
| 16 | Owner of the breaches and notifications register, and its category list | Compliance | The register, feeding Q&C | Week 4 |
| 17 | A named privacy officer | CEO | Privacy policy and breach response plan | Week 5 |

## Build work still to do

### Week 2
- [x] COE nightly snapshot: per-child continuing count and booking-mix distribution, counts only — **done**. `runCoeSnapshot` in `services/snapshot.js` reads each operating centre's current children and forward bookings from OWNA and writes counts only to `coe_continuing`, `coe_booking_mix` and `coe_forward_horizon` (no name, no date of birth, no child id). It runs as a sub-step of the nightly snapshot, reports to the Wages-style status as source `coe`, and a re-run of the same day overwrites that day's rows. **On demand: `npm run coe-snapshot`** (`scripts/coe-snapshot.js`) — use it so the first measurement does not have to wait for 2:15am. `/coe` shows the measured continuing count beside the run-rate projection and the booking mix as its own section; before the first run the page is unchanged and says the count starts accumulating from it
- [x] Sydney-aware "today" throughout the app; time zone pinned in host config — **done**. `services/calendar.js` `today()` is the single source; the nightly cron pins `Australia/Sydney` in `server.js` as well as via `TZ` in `render.yaml`
- [x] Session store that survives a restart — **done**. Logins are now rows in the app's own SQLite file (`sessions`, defined in `db/schema.sql`), written through `better-sqlite3-session-store` 0.1.0 — pinned exactly, handed `db/db.js`'s existing connection, so there is no second service, no second file and nothing to fight WAL mode. It is all in `middleware/session.js`: an eight-hour cookie measured from the **last request** rather than from login, expired rows refused on read and swept every fifteen minutes as well as once at boot (so rows that expired while the process was down go immediately). A restore from backup is a separate matter and is handled separately: see the session note under the Week 3 retention job. The cookie keeps `httpOnly`, `sameSite=lax` and `secure` in production, and the placeholder-`SESSION_SECRET` refusal to start is unchanged. One hardening came with it: the per-request recheck in `middleware/auth.js` now stores a digest of the password hash instead of the hash itself, so moving sessions onto disk did not copy the password verifier into a second table — a password reset or a deleted account still invalidates a live session, now across a restart too
- [x] **The test hang is fixed** — the suite is 88 tests in ~8 seconds again (it was passing every assertion and then never exiting, for minutes). `freeze()` in `tests/week2.test.js` used to swap the **global** `Date`, which also stopped the timers Node's `fetch` uses to age out a keep-alive socket, so any test that awaited a request under the frozen clock left a connection that could never close, `server.close()` never called back and the file hung. `services/calendar.js` now has an injectable clock (`setNow`), so a test can put **the app** at any instant while the process keeps real time. A guard in `week2` fails if the global clock is ever frozen again
- [ ] Hosting move to an Australian region: container config, storage, restore, secrets, new address told to trial users, encryption at rest confirmed, backups re-pointed (2½ days) — blocked on #1, #2, #3

### Week 3
- [ ] COE page per-centre targets table: continuation % and backfill count per centre, replacing the single 95% placeholder (½ day) — blocked on #5. The continuing count and booking mix are already on the page
- [ ] Waitlist by age group; age band derived at import, date of birth never stored (1 day)
- [ ] Talent pipeline: ECTs, educational leaders, casuals per centre; managed vs non-managed exits (2 days) — blocked on #9
- [ ] Retention purge job for the tables that accumulate: roster leave detail, feedback, AI briefings, run notes, **and the names still held in `ll_pipeline_members`, `ll_pipeline_starts` and `ll_tours`** (1 day) — blocked on #10.
  **Sessions are the one table the job does not have to cover.** A row in `sessions` is personal information under APP 11 — it holds the signed-in user's id, email, name and role (never a password, never a child or family) — so it was never going to be allowed to sit there for ever. It does not: each row expires eight hours after that user's last request, expired rows are refused on read, and the store deletes them every fifteen minutes and again at boot. Encrypted backups therefore carry session rows, and those rows are live, not expired: `expire` is eight hours after the user's last request before the backup was taken, and the boot sweep deletes only rows already past it, so in a backup younger than eight hours every session survives. Restoring one would reinstate every login that was live at backup time, including ones revoked since — logging out deletes the row but not the browser's cookie, so a resurrected row signs that person straight back in. `scripts/restore-db.js` therefore clears `sessions` on the restored file before it is put into service: a restore signs everyone out. What item #10 still needs to settle is whether eight hours is the retention period the owner wants for a signed-in session, and it should say so explicitly rather than leave the table out of the decision

### Week 4 — each needs its input first
- [ ] Social media entry per platform, with leads by source alongside (½ day)
- [ ] Recruitment entry per centre (½ day)
- [ ] Training and development upload (1 day)
- [ ] Staff-discount waitlist count from the LineLeader tag (½ day)
- [ ] Fixed costs per centre and the break-even occupancy line (1 day)
- [ ] Breaches, investigations and lodged-notifications register on Q&C (½ day)

### Week 5
- [ ] Data inventory: every table and column, source system, derived or authoritative, retention, who sees it (2 hrs)
- [ ] Privacy policy and collection notice, breach response plan, vendor register (1½ days)

### Backlog, once access is granted
- [ ] Meta and Google Business insights replacing the social entry screen (2–3 days each)
- [ ] Employment Hero HR pull for qualifications and training (1–2 days)
- [ ] Xero or MYOB actuals replacing the fixed-cost entry (2–3 days)
- [ ] OWNA sign-in/sign-out into Employment Hero timesheets — read-only proof of concept already done, scoped separately

## Ask OWNA support

- [ ] **Request forms scope on the OWNA API key** — the `FormSubmission` and `FormResponse` endpoint groups. A survey of the live tenant on 14 September found these are the only endpoints the key is refused on: every other endpoint answers normally, while both form endpoints return the permission error. OWNA reports a permission failure as HTTP 415, which reads like a malformed request and sends you chasing the wrong thing, so this cost real time to establish. Until the scope is granted no client-side work helps and we still do not know whether the centres use OWNA form templates at all. Once granted, `npm run discover-forms` answers it in one run (field names and fill rates only, never answers). Full detail: `docs/owna-forms-survey.md`

## Housekeeping, not code

- [ ] Walk the CEO through the COE page and the mock
- [ ] Rotate the Anthropic API key that was pasted into a chat, and update `.env`
- [ ] Delete the two stale OneDrive copies of this app (copy `services/eh-timesheet.js` out of the archived worktree first if it is wanted). A server was found running from one of them on port 3003 on 12 September, serving 1 September data
- [ ] Push the outstanding commits to GitHub

## Fixed in production, recorded so it is not rediscovered

- **Every write on the deployed site was refused** (14 September, `/admin/places`, `/ai/briefing`, every form). The browser was sending `Origin: null`, so the cross-origin guard treated the app's own forms as cross-site. The cause was this app's own `Referrer-Policy: no-referrer` header: Chrome ties the Origin header on a form submission to the page's referrer policy, and under `no-referrer` it strips it to an opaque origin. Reproduced in a real browser against a local copy, fixed by setting `Referrer-Policy: same-origin` — which still stops a dashboard URL (it can name a centre) reaching another site — and verified by submitting the form again. The guard itself was also made proxy-tolerant (hostname comparison against `req.hostname`, `Host`, `X-Forwarded-Host` and an optional `PUBLIC_HOSTNAME`), it now logs the values that disagreed, and a refusal renders an explanation with those values shown to admin and ops instead of the single word "Forbidden"

## Known data problems at source — not calculation faults

These limit what the dashboard can honestly show. Each page says so where it applies.

1. **Operating days compute to 253 in FY2026-27, not the CEO's 251.** Likely a Christmas closure that is not a public holiday. One line in `services/calendar.js` once confirmed.
2. **Four centres book above their licensed places**, so utilisation reads over 100% and unused places go negative. Either `centres.capacity` is not the licensed figure or the definition differs.
3. **Only 4 of 92 enrolled LineLeader records carry a start date**, so "started" counts in the funnel are a floor, not a total.
4. **No tour is ever marked complete or cancelled** in LineLeader, so "tours held" rests on the date having passed. A no-show nobody cancelled counts as held.
5. **LineLeader does not date offer acceptance**, so every current Offer Accepted member counts as an offer in the last 12 months. Bardia reads 94.7% offer rate because of a long-standing backlog.
6. **OWNA keeps booking rows on public holidays.** Seats, utilisation and average occupancy now exclude them; some older figures do not.
7. **Tours are matched to families by name within a centre**, as LineLeader gives no family id on the tour row. Two families with the same name at one centre would be conflated.

## Not possible, by design

- **An accurate 12-month enrolment projection.** Departures are not in any system beyond about a term. Ninety days is shown as trustworthy, twelve months as a ceiling.
- **People metrics by name.** Turnover, tenure, exits and the talent pipeline stay aggregate per centre. This app is a derived system; the records of people stay in OWNA, Employment Hero and LineLeader.
