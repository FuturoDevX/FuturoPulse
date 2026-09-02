# Futuro OWNA Operations Dashboard

An internal dashboard that pulls **occupancy, attendance, revenue (fees), casual days, and CCS** from the
OWNA Childcare Portal API and presents an all-centres **overview** with per-centre **drill-down**.

Stack: Express + EJS + SQLite (`better-sqlite3`) + node-cron — same house pattern as PMS-App / TrainingTracker-App.

## How it works

- A **nightly snapshot** (`services/snapshot.js`, cron `SNAPSHOT_CRON`) pulls a rolling window
  (`SNAPSHOT_WINDOW_DAYS`, default 120) from OWNA, aggregates it **per centre per day**, and upserts into SQLite.
- Pages read only from SQLite, so they're fast and survive brief OWNA outages.
- Admin/Ops can hit **↻ Refresh from OWNA** for an on-demand pull.

## Metric definitions

| Metric | Definition |
|---|---|
| **Occupancy** | booked child-days ÷ (licensed places × days). Places = sum of room capacities. Can exceed 100% when a centre overbooks against expected absences. |
| **Attendance rate** | children who actually signed in ÷ booked child-days. |
| **Fees billed** | sum of per-session `fee` (gross, before CCS subsidy). |
| **Casual days** | bookings flagged `casualBooking`. |
| **CCS paid** | subsidy payments clearing in the range (posted weekly). |

## OWNA API

- Base `https://api.owna.com.au`, auth header `x-api-key`. Docs: https://api.owna.com.au/swagger/index.html
- Key endpoints used: `/api/centre/list`, `/api/room/{centre}/list`, `/api/attendance/{centre}/{from}/{to}`
  (requires `sort=attendanceDate`), `/api/ccs/payments/{centre}/{from}/{to}/list`. List endpoints page via `take`/`skip`.

## Setup

```bash
cp .env.example .env      # fill in OWNA_API_KEY (already set locally)
npm install
npm run seed              # creates schema + default admin
npm run snapshot          # first data pull
npm start                 # http://localhost:3003
```

Default login is `ADMIN_EMAIL` / `ADMIN_DEFAULT_PASSWORD` from `.env` — **change the password after first login.**

## Notes / next steps

- Occupancy >100% is real (overbooking). If you'd rather cap it, switch the numerator to attended child-days.
- `.env` (with the API key) and `data/` are gitignored. Don't commit them.
- Room-level and week-on-week trend views are easy follow-ons off the same `daily_metrics` table.
