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
| 7 | How each centre sets recurring bookings in OWNA: rolling, or ending 31 December | Centre directors | COE accuracy. Heath Rd appears to end them, which distorts every forward view for that centre | Week 2 |
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
- [ ] COE nightly snapshot: per-child continuing count and booking-mix distribution, counts only — **in progress**
- [x] Sydney-aware "today" throughout the app; time zone pinned in host config — **done**. `services/calendar.js` `today()` is the single source; the nightly cron pins `Australia/Sydney` in `server.js` as well as via `TZ` in `render.yaml`
- [ ] Session store that survives a restart — **in progress**
- [ ] Hosting move to an Australian region: container config, storage, restore, secrets, new address told to trial users, encryption at rest confirmed, backups re-pointed (2½ days) — blocked on #1, #2, #3

### Week 3
- [ ] COE page second half: continuing count and booking mix on screen, per-centre targets table (1 day)
- [ ] Waitlist by age group; age band derived at import, date of birth never stored (1 day)
- [ ] Talent pipeline: ECTs, educational leaders, casuals per centre; managed vs non-managed exits (2 days) — blocked on #9
- [ ] Retention purge job for the tables that accumulate: roster leave detail, feedback, AI briefings, run notes, **and the names still held in `ll_pipeline_members`, `ll_pipeline_starts` and `ll_tours`** (1 day) — blocked on #10

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

## Housekeeping, not code

- [ ] Walk the CEO through the COE page and the mock
- [ ] Rotate the Anthropic API key that was pasted into a chat, and update `.env`
- [ ] Delete the two stale OneDrive copies of this app (copy `services/eh-timesheet.js` out of the archived worktree first if it is wanted). A server was found running from one of them on port 3003 on 12 September, serving 1 September data
- [ ] Push the outstanding commits to GitHub

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
