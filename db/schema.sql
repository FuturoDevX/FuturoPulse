-- OWNA Operations Dashboard schema
-- One SQLite file; the nightly snapshot upserts aggregated per-centre-per-day rows.

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer',  -- viewer | centre | exec | ops_manager | admin (least privilege by default)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Mirror of OWNA centres (source of truth stays OWNA; refreshed on each snapshot).
CREATE TABLE IF NOT EXISTS centres (
  owna_id       TEXT PRIMARY KEY,     -- OWNA centre id
  name          TEXT NOT NULL,
  alias         TEXT,
  suburb        TEXT,
  state         TEXT,
  capacity      INTEGER DEFAULT 0,    -- sum of room capacities (licensed places)
  enrolled      INTEGER DEFAULT 0,    -- OWNA "children" count
  closed        INTEGER DEFAULT 0,
  approval_no   TEXT,
  last_updated  TEXT,
  ll_id         INTEGER,              -- linked LineLeader centre id (enrolment pipeline)
  opening       INTEGER DEFAULT 0,    -- 1 = pre-opening (LineLeader pipeline only, not yet in OWNA)
  opening_year  INTEGER               -- expected opening year for pre-opening centres (e.g. 2028); NULL = not set
);

-- One aggregated row per centre per calendar day.
CREATE TABLE IF NOT EXISTS daily_metrics (
  owna_id     TEXT NOT NULL,
  metric_date TEXT NOT NULL,          -- YYYY-MM-DD
  capacity    INTEGER DEFAULT 0,      -- capacity snapshot for that day (from centre)
  booked      INTEGER DEFAULT 0,      -- booked child-days (attendance rows)
  attended    INTEGER DEFAULT 0,      -- of those, physically present
  absent      INTEGER DEFAULT 0,      -- booked but not attending
  casual      INTEGER DEFAULT 0,      -- bookings flagged casualBooking
  fee_total   REAL DEFAULT 0,         -- sum of session fees (gross fees billed)
  PRIMARY KEY (owna_id, metric_date),
  FOREIGN KEY (owna_id) REFERENCES centres(owna_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_date ON daily_metrics(metric_date);

-- CCS subsidy payments, keyed by the week they clear on (kept separate from fee billings).
CREATE TABLE IF NOT EXISTS ccs_payments (
  owna_id       TEXT NOT NULL,
  week_starting TEXT NOT NULL,        -- YYYY-MM-DD
  amount        REAL DEFAULT 0,
  PRIMARY KEY (owna_id, week_starting),
  FOREIGN KEY (owna_id) REFERENCES centres(owna_id)
);

-- Audit log of snapshot runs.
CREATE TABLE IF NOT EXISTS snapshot_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT,                   -- ok | error
  window_from TEXT,
  window_to   TEXT,
  rows_written INTEGER DEFAULT 0,
  note        TEXT
);

-- ===== LineLeader (ChildcareCRM) enrollment/waitlist pipeline =====

CREATE TABLE IF NOT EXISTS ll_centres (
  ll_id      INTEGER PRIMARY KEY,   -- LineLeader center id
  name       TEXT NOT NULL,
  active     INTEGER DEFAULT 1
);

-- Daily snapshot of family counts by pipeline stage, per centre.
CREATE TABLE IF NOT EXISTS ll_pipeline (
  snapshot_date TEXT NOT NULL,      -- YYYY-MM-DD
  ll_id         INTEGER NOT NULL,
  centre_name   TEXT,
  status_id     INTEGER NOT NULL,
  status_name   TEXT,
  count         INTEGER DEFAULT 0,
  PRIMARY KEY (snapshot_date, ll_id, status_id)
);
CREATE INDEX IF NOT EXISTS idx_llpipe_date ON ll_pipeline(snapshot_date);

-- Individual enrolment records (for starts vs withdrawals / net growth over time).
CREATE TABLE IF NOT EXISTS ll_enrolments (
  enrollment_id  INTEGER PRIMARY KEY,
  ll_id          INTEGER,
  centre_name    TEXT,
  child_id       INTEGER,
  status_id      INTEGER,
  start_date     TEXT,
  withdrawn_date TEXT,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_llenrol_centre ON ll_enrolments(ll_id);

-- ===== Exit report: OWNA departures (finishDate) enriched with LineLeader withdrawal reason =====
CREATE TABLE IF NOT EXISTS child_exits (
  owna_id      TEXT NOT NULL,
  child_key    TEXT NOT NULL,         -- normalised name|dob (stable id for the child within a centre)
  child_name   TEXT,
  dob          TEXT,
  room         TEXT,
  start_date   TEXT,                  -- officialstartdate / activeFrom
  finish_date  TEXT NOT NULL,         -- OWNA finishDate (YYYY-MM-DD)
  tenure_days  INTEGER,
  upcoming     INTEGER DEFAULT 0,     -- 1 if finish_date is in the future (scheduled)
  reason       TEXT,                  -- from LineLeader where matched, else NULL
  reason_source TEXT,                 -- 'lineleader' | NULL
  updated_at   TEXT,
  PRIMARY KEY (owna_id, child_key, finish_date)
);
CREATE INDEX IF NOT EXISTS idx_exits_centre ON child_exits(owna_id);
CREATE INDEX IF NOT EXISTS idx_exits_finish ON child_exits(finish_date);

-- ===== Enrolment projection: CRM pipeline families with expected start + weekly schedule =====
CREATE TABLE IF NOT EXISTS ll_pipeline_starts (
  enrollment_id  INTEGER PRIMARY KEY,
  ll_id          INTEGER,
  owna_id        TEXT,               -- mapped OWNA centre (NULL for pre-open LineLeader-only centres)
  centre_name    TEXT,
  child_name     TEXT,
  status_id      INTEGER,
  expected_start TEXT,               -- YYYY-MM-DD
  days_csv       TEXT,               -- e.g. "mo,tu,we"
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_pstarts_owna ON ll_pipeline_starts(owna_id);
CREATE INDEX IF NOT EXISTS idx_pstarts_start ON ll_pipeline_starts(expected_start);

-- ===== Centre pipeline drill-down: individual members + scheduled tours =====
CREATE TABLE IF NOT EXISTS ll_pipeline_members (
  child_id       INTEGER PRIMARY KEY,   -- deduped per child
  ll_id          INTEGER,
  owna_id        TEXT,
  centre_name    TEXT,
  child_name     TEXT,
  family_name    TEXT,
  status_id      INTEGER,
  status_name    TEXT,
  wait_list_date TEXT,                  -- when they joined the waitlist (YYYY-MM-DD)
  expected_start TEXT,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_owna ON ll_pipeline_members(owna_id);
CREATE INDEX IF NOT EXISTS idx_members_status ON ll_pipeline_members(status_id);

CREATE TABLE IF NOT EXISTS ll_tours (
  task_id      INTEGER PRIMARY KEY,
  ll_id        INTEGER,
  owna_id      TEXT,
  centre_name  TEXT,
  family_name  TEXT,
  type_name    TEXT,
  tour_date    TEXT,                    -- scheduled date/time (ISO)
  is_completed INTEGER DEFAULT 0,
  is_cancelled INTEGER DEFAULT 0,
  result       TEXT,
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_tours_owna ON ll_tours(owna_id);
CREATE INDEX IF NOT EXISTS idx_tours_date ON ll_tours(tour_date);

-- ===== Employment Hero labour (weekly, per centre) =====
CREATE TABLE IF NOT EXISTS labour_weekly (
  eh_centre    TEXT NOT NULL,        -- EH location name (e.g. "Futuro Bardia")
  week_ending  TEXT NOT NULL,        -- pay-period ending (YYYY-MM-DD)
  owna_id      TEXT,                 -- mapped OWNA centre (NULL for HQ/pre-open)
  employees    INTEGER DEFAULT 0,
  worked_h     REAL DEFAULT 0,
  worked_amt   REAL DEFAULT 0,
  kitchen_h    REAL DEFAULT 0,
  kitchen_amt  REAL DEFAULT 0,
  leave_h      REAL DEFAULT 0,
  leave_amt    REAL DEFAULT 0,
  matwc_amt    REAL DEFAULT 0,       -- workers comp / maternity / parental leave ($)
  casual_h     REAL DEFAULT 0,       -- casual worked hours (subset of worked)
  total_hours  REAL DEFAULT 0,
  total_wages  REAL DEFAULT 0,
  super_amt    REAL DEFAULT 0,
  updated_at   TEXT,
  PRIMARY KEY (eh_centre, week_ending)
);
CREATE INDEX IF NOT EXISTS idx_labour_week ON labour_weekly(week_ending);

-- Weekly budget targets per centre (admin-entered; enables the "vs budget" columns).
CREATE TABLE IF NOT EXISTS labour_budget (
  eh_centre    TEXT NOT NULL,
  week_ending  TEXT NOT NULL,        -- or 'default' for a standing weekly target
  budget_wages REAL,
  budget_hours REAL,
  budget_occ   REAL,
  PRIMARY KEY (eh_centre, week_ending)
);

-- ===== People & Culture (manual entry, per centre per month) =====
CREATE TABLE IF NOT EXISTS pc_metrics (
  owna_id           TEXT NOT NULL,
  month             TEXT NOT NULL,        -- YYYY-MM
  enps              REAL,                 -- employee NPS, -100..100
  family_nps        REAL,                 -- family/parent NPS, -100..100
  turnover          REAL,                 -- rolling annual (YoY) turnover %
  turnover_mom      REAL,                 -- single-month turnover %
  headcount         INTEGER,              -- staff headcount that month
  leavers           INTEGER,              -- leavers that month
  checkin_due       INTEGER,
  checkin_completed INTEGER,
  psych_safety      REAL,
  updated_at        TEXT,
  PRIMARY KEY (owna_id, month)
);
CREATE TABLE IF NOT EXISTS pc_targets (
  metric  TEXT PRIMARY KEY,               -- enps | turnover | checkin_pct | psych_safety
  target  REAL
);

-- ===== Quality & Compliance (uploaded audit) =====
CREATE TABLE IF NOT EXISTS qc_audits (
  owna_id     TEXT NOT NULL,
  term        TEXT NOT NULL,           -- audit period, e.g. "Term 2 2026" (one row per centre per audit)
  centre_name TEXT, auditor TEXT, audit_date TEXT,
  overall_pct REAL,
  qa_json     TEXT,                    -- JSON: [{code,name,items,y,n,pct}]
  uploaded_at TEXT,
  PRIMARY KEY (owna_id, term)
);
CREATE TABLE IF NOT EXISTS qc_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owna_id TEXT, term TEXT, quality_area TEXT, issue TEXT, action TEXT, progress TEXT,
  priority TEXT, owner TEXT, due_date TEXT, completed TEXT
);
CREATE INDEX IF NOT EXISTS idx_qcact_owna ON qc_actions(owna_id);

-- ===== Monthly action plans (per centre) =====
CREATE TABLE IF NOT EXISTS action_plans (
  owna_id     TEXT NOT NULL,
  month       TEXT NOT NULL,          -- YYYY-MM
  overall     TEXT,                   -- green|amber|red
  context     TEXT,
  areas_json  TEXT,                   -- {key:{rating,reason}}
  updated_at  TEXT,
  PRIMARY KEY (owna_id, month)
);
CREATE TABLE IF NOT EXISTS action_plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owna_id TEXT, month TEXT, category TEXT,   -- urgent|bau|support|keep
  focus_area TEXT, actions TEXT, owner TEXT, status TEXT, sort INTEGER DEFAULT 0,
  start_date TEXT, due_date TEXT, progress TEXT, outcome TEXT, priority TEXT, job_reference TEXT
);
CREATE INDEX IF NOT EXISTS idx_apitems ON action_plan_items(owna_id, month);

-- ===== Rostering: OWNA weekly staff roster aggregated per centre per week =====
CREATE TABLE IF NOT EXISTS roster_weekly (
  owna_id       TEXT NOT NULL,
  week_starting TEXT NOT NULL,          -- Monday YYYY-MM-DD
  total_hours   REAL,                   -- rostered hours across the week (OWNA rosteredhours)
  days_json     TEXT,                   -- JSON: [{day, hours, hpb, shifts, staff}] Mon–Sun
  leave_json    TEXT,                   -- JSON: [{staff, leavetype, day, hours}]
  updated_at    TEXT,
  PRIMARY KEY (owna_id, week_starting)
);

-- ===== Safety: OWNA child incidents aggregated per centre per month =====
CREATE TABLE IF NOT EXISTS incidents_monthly (
  owna_id     TEXT NOT NULL,
  month       TEXT NOT NULL,          -- YYYY-MM
  total       INTEGER DEFAULT 0,      -- all incident reports
  injuries    INTEGER DEFAULT 0,      -- physical-injury incidents (affected type: cut, bruise, bite, head bump, etc.)
  illness     INTEGER DEFAULT 0,      -- illness incidents (temperature, rash, vomiting, infectious, respiratory)
  serious     INTEGER DEFAULT 0,      -- higher-severity injuries (head/concussion, bite, anaphylaxis, fracture, crush, eye, burn)
  reportable  INTEGER DEFAULT 0,      -- notifiable: regulatoryAuthority field completed by the centre
  updated_at  TEXT,
  PRIMARY KEY (owna_id, month)
);

-- ===== Feedback from users trialling the dashboard =====
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT,
  user_email  TEXT, user_name TEXT, user_role TEXT,
  area        TEXT,                 -- which part of the dashboard
  category    TEXT,                 -- missing | bug | ui | data | performance | idea | other
  rating      INTEGER,              -- optional overall 1-5
  message     TEXT NOT NULL,
  page        TEXT,                 -- path they came from
  status      TEXT DEFAULT 'new'    -- new | reviewed | dismissed
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);

-- ===== AI: cached weekly operations briefing (generated via the Claude API) =====
CREATE TABLE IF NOT EXISTS ai_briefings (
  period_key  TEXT PRIMARY KEY,        -- "<from>..<to>" — one cached briefing per selected date range
  period_from TEXT,                    -- range start (YYYY-MM-DD)
  period_to   TEXT,                    -- range end (YYYY-MM-DD)
  content     TEXT,                    -- Claude's markdown briefing
  model       TEXT,                    -- model id used
  created_at  TEXT
);
