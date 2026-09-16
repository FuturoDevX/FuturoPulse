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
  capacity      INTEGER DEFAULT 0,    -- SUM OF OWNA ROOM CAPACITIES, rewritten by every nightly snapshot.
                                      -- It is NOT the licensed count: rooms are configured in OWNA for how the
                                      -- centre is run, and the sum drifts from the service approval.
  approved_places INTEGER,            -- APPROVED PLACES on the service approval (ACECQA National Register) — the
                                      -- licensed count, and the only honest denominator for utilisation, unused
                                      -- places, seats and available child-days. Maintained by hand at
                                      -- /admin/places; the snapshot never writes it. NULL = not licensed yet
                                      -- (a pre-opening centre), which must render "—", never 0.
  enrolled      INTEGER DEFAULT 0,    -- OWNA "children" count
  closed        INTEGER DEFAULT 0,
  approval_no   TEXT,                 -- service approval number, e.g. SE-00017004
  last_updated  TEXT,
  ll_id         INTEGER,              -- linked LineLeader centre id (enrolment pipeline)
  opening       INTEGER DEFAULT 0,    -- 1 = pre-opening (LineLeader pipeline only, not yet in OWNA)
  opening_year  INTEGER,              -- expected opening year for pre-opening centres (e.g. 2028); NULL = not set
  opening_month INTEGER               -- 1-12 when the month is known (e.g. 11 = November); NULL = year only
);

-- One aggregated row per centre per calendar day.
CREATE TABLE IF NOT EXISTS daily_metrics (
  owna_id     TEXT NOT NULL,
  metric_date TEXT NOT NULL,          -- YYYY-MM-DD
  capacity    INTEGER DEFAULT 0,      -- the centre's OWNA ROOM SUM as it stood on that day. Stored history:
                                      -- never rewritten, and never a denominator — percentages divide by the
                                      -- centre's approved places (centres.approved_places).
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
-- RETENTION: 90 days (owner's decision, 14 September 2026), enforced by services/retention.js as the
-- last step of the nightly snapshot. The `note` below goes with the row. The single most recent run is
-- always kept whatever its age, so the status page can still say when the data was last refreshed.
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
-- De-identified (Australian Privacy Principle 11.2): this dashboard is a derived system, so it holds no
-- departed child's name or date of birth. OWNA and LineLeader remain the records of identity. child_key
-- only has to keep two children in a centre apart; it is a salted hash whose salt is never written to
-- disk (see services/snapshot.js), so no name can be recovered from a row here.
-- RETENTION: 2 years for this row-level detail (owner's decision, 14 September 2026), against 7 years for
-- the exits_monthly aggregate below. services/retention.js enforces both, after the nightly fold-up.
CREATE TABLE IF NOT EXISTS child_exits (
  owna_id      TEXT NOT NULL,
  child_key    TEXT NOT NULL,         -- salted hash of the normalised name|dob — opaque, not reversible
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

-- Monthly departure aggregate. child_exits above is rebuilt every night with a rolling look-back
-- (EXIT_LOOKBACK_DAYS, 365 by default), so departures older than that disappear from it. runExitReport
-- folds each rebuild into this table BEFORE the old rows go, which is what lets exits by year and tenure
-- history keep accumulating. Counts only, no per-child rows: room is '' when OWNA recorded none, because
-- SQLite would otherwise allow duplicate NULL keys.
-- RETENTION: 7 years (owner's decision, 14 September 2026) — counts only, so it outlives the row-level
-- child_exits detail above by five years. services/retention.js enforces both.
CREATE TABLE IF NOT EXISTS exits_monthly (
  owna_id         TEXT NOT NULL,
  month           TEXT NOT NULL,         -- YYYY-MM of the finish date
  room            TEXT NOT NULL DEFAULT '',
  upcoming        INTEGER NOT NULL DEFAULT 0,
  departures      INTEGER NOT NULL DEFAULT 0,
  tenure_days_sum INTEGER NOT NULL DEFAULT 0,  -- sum over departures with a positive tenure
  tenure_n        INTEGER NOT NULL DEFAULT 0,  -- how many those are (the divisor for an average)
  updated_at      TEXT,
  PRIMARY KEY (owna_id, month, room, upcoming)
);
CREATE INDEX IF NOT EXISTS idx_exitsmon_month ON exits_monthly(month);

-- ===== Enrolment projection: CRM pipeline families with expected start + weekly schedule =====
-- De-identified (Australian Privacy Principle 11.2), like child_exits above and for the same reason: this
-- dashboard is a DERIVED system and LineLeader remains the record of who each child and family is. The three
-- ll_pipeline_* / ll_tours tables below therefore hold no child name, family name or date of birth. What
-- identifies a row is LineLeader's own opaque id (enrollment_id / child_id / task_id) — a foreign key into
-- LineLeader, useless on its own — plus a centre, a status and dates. These tables are REBUILT every night
-- from LineLeader, so the names are not collected at all (see services/snapshot.js); deleting them here
-- alone would only have them written back the next morning.
CREATE TABLE IF NOT EXISTS ll_pipeline_starts (
  enrollment_id  INTEGER PRIMARY KEY,   -- LineLeader enrolment id (opaque)
  ll_id          INTEGER,
  owna_id        TEXT,               -- mapped OWNA centre (NULL for pre-open LineLeader-only centres)
  centre_name    TEXT,
  status_id      INTEGER,
  expected_start TEXT,               -- YYYY-MM-DD
  days_csv       TEXT,               -- e.g. "mo,tu,we"
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_pstarts_owna ON ll_pipeline_starts(owna_id);
CREATE INDEX IF NOT EXISTS idx_pstarts_start ON ll_pipeline_starts(expected_start);

-- ===== Centre pipeline drill-down: individual members + scheduled tours =====
CREATE TABLE IF NOT EXISTS ll_pipeline_members (
  child_id       INTEGER PRIMARY KEY,   -- LineLeader child id (opaque), deduped per child
  ll_id          INTEGER,
  owna_id        TEXT,
  centre_name    TEXT,
  family_key     TEXT,                  -- salted hash of the family name — opaque, not reversible; only
                                        -- has to line a tour up with its family inside one centre
  status_id      INTEGER,
  status_name    TEXT,
  wait_list_date TEXT,                  -- when they joined the waitlist (YYYY-MM-DD)
  expected_start TEXT,
  updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_members_owna ON ll_pipeline_members(owna_id);
CREATE INDEX IF NOT EXISTS idx_members_status ON ll_pipeline_members(status_id);

CREATE TABLE IF NOT EXISTS ll_tours (
  task_id      INTEGER PRIMARY KEY,     -- LineLeader task id (opaque)
  ll_id        INTEGER,
  owna_id      TEXT,
  centre_name  TEXT,
  family_key   TEXT,                    -- same salted hash as ll_pipeline_members.family_key, so a cohort's
                                        -- tours can still be COUNTED without either table holding a name
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

-- Monthly lead & tour targets per centre (incl. pre-opening centres). month = 'default' is the standing monthly target;
-- a YYYY-MM row overrides it for that month. Shown on the Enrolment Pipeline page against this month's activity.
CREATE TABLE IF NOT EXISTS pipeline_targets (
  owna_id  TEXT NOT NULL,
  month    TEXT NOT NULL DEFAULT 'default',
  leads    INTEGER,                  -- new families joining the wait list per month
  tours    INTEGER,                  -- tours held per month
  PRIMARY KEY (owna_id, month)
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

-- ===== Turnover as the OWNER enters it, per centre per month (his decision of 16 September 2026) =====
-- This is the turnover of record. Payroll can say that someone left; it cannot say whether the business
-- counts the departure as turnover, so the three numbers are typed in on /admin/pc rather than derived.
-- NULL means NOT ENTERED and is not the same as 0: a blank month is left out of the average headcount
-- and contributes no leavers, where a 0 is a measurement that counts. Counts only — no name, no
-- employee id, no date of birth, exactly as every other table here.
CREATE TABLE IF NOT EXISTS pc_turnover_entry (
  owna_id      TEXT NOT NULL,
  month        TEXT NOT NULL,             -- YYYY-MM
  resignations INTEGER,                   -- people who resigned that month
  terminations INTEGER,                   -- people the business terminated that month
  headcount    INTEGER,                   -- staff headcount that month (the denominator)
  updated_at   TEXT,
  PRIMARY KEY (owna_id, month)
);
CREATE INDEX IF NOT EXISTS idx_pcturnover_month ON pc_turnover_entry(month);

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
-- Hours only. No roster row names a staff member, and leave carries no leave type: a leave type implies
-- health (personal/parental leave) and is sensitive information under the Privacy Act, and it was only
-- ever used to arrive at hours. Employment Hero remains the record of who worked and who was away.
CREATE TABLE IF NOT EXISTS roster_weekly (
  owna_id       TEXT NOT NULL,
  week_starting TEXT NOT NULL,          -- Monday YYYY-MM-DD
  total_hours   REAL,                   -- rostered hours across the week (OWNA rosteredhours)
  days_json     TEXT,                   -- JSON: [{day, hours, hpb, shifts, staff}] Mon–Sun; staff is a COUNT
  leave_json    TEXT,                   -- JSON: [{day, staff, hours}] — staff is a COUNT of people on leave
                                        -- that day, hours their leave hours. No name, no leave type.
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
-- RETENTION: 12 months AFTER REVIEW (owner's decision, 14 September 2026), enforced by
-- services/retention.js. A row still marked 'new' is never deleted — it is waiting on a human. The
-- period runs from `reviewed_at`, not from `created_at`: the owner set it to run from the review, and
-- a row submitted long before it was triaged would otherwise be deleted the same night it was read.
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT,
  user_email  TEXT, user_name TEXT, user_role TEXT,
  area        TEXT,                 -- which part of the dashboard
  category    TEXT,                 -- missing | bug | ui | data | performance | idea | other
  rating      INTEGER,              -- optional overall 1-5
  message     TEXT NOT NULL,
  page        TEXT,                 -- path they came from
  status      TEXT DEFAULT 'new',   -- new | reviewed | dismissed
  reviewed_at TEXT                  -- when it left 'new'; NULL while new, and cleared if it goes back
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);

-- ===== AI: cached weekly operations briefing (generated via the Claude API) =====
-- RETENTION: 12 months (owner's decision, 14 September 2026), enforced by services/retention.js.
CREATE TABLE IF NOT EXISTS ai_briefings (
  period_key  TEXT PRIMARY KEY,        -- "<from>..<to>" — one cached briefing per selected date range
  period_from TEXT,                    -- range start (YYYY-MM-DD)
  period_to   TEXT,                    -- range end (YYYY-MM-DD)
  content     TEXT,                    -- Claude's markdown briefing
  model       TEXT,                    -- model id used
  created_at  TEXT
);

-- ===== Continuation of Enrolment: the MEASURED continuing count and booking mix =====
-- Counts only. The nightly step reads each centre's current children and their forward bookings from
-- OWNA and writes nothing but numbers: no name, no date of birth, and no child id — not even a hashed
-- one, because a per-child row is not needed to answer "how many are continuing". Child identity stays
-- in OWNA, where the record belongs. Re-running a day overwrites that day's rows (the primary keys
-- carry snapshot_date), so the step is safe to run by hand as well as at 2:15am.

-- Per centre, per campaign month: the split of the children enrolled NOW into continuing (they hold
-- bookings in that month), not yet confirmed (no bookings there, no finish date) and leaving (a finish
-- date before the month), with the child-days each group represents.
CREATE TABLE IF NOT EXISTS coe_continuing (
  snapshot_date      TEXT NOT NULL,       -- Sydney date of the run
  owna_id            TEXT NOT NULL,
  month              TEXT NOT NULL,       -- YYYY-MM of the campaign window
  enrolled           INTEGER NOT NULL DEFAULT 0,  -- children counted at this centre on the snapshot date
  continuing         INTEGER NOT NULL DEFAULT 0,
  not_confirmed      INTEGER NOT NULL DEFAULT 0,
  leaving            INTEGER NOT NULL DEFAULT 0,
  continuing_days    REAL NOT NULL DEFAULT 0,     -- booked child-days in the month (operating days only)
  not_confirmed_days REAL NOT NULL DEFAULT 0,     -- what those children would be worth at their own pattern
  leaving_days       REAL NOT NULL DEFAULT 0,     -- what the leavers take with them, at their own pattern
  operating_days     INTEGER NOT NULL DEFAULT 0,  -- NSW operating days in the month, for the reader
  beyond_horizon     INTEGER NOT NULL DEFAULT 0,  -- 1 = the centre's bookings do not reach this month at all
  updated_at         TEXT,
  PRIMARY KEY (snapshot_date, owna_id, month)
);
CREATE INDEX IF NOT EXISTS idx_coecont_month ON coe_continuing(month);

-- Per centre, per snapshot date: how many children are booked 1, 2, 3, 4 or 5 days a week, and the
-- child-days a week each band represents. This is what separates places filled from days filled.
CREATE TABLE IF NOT EXISTS coe_booking_mix (
  snapshot_date TEXT NOT NULL,
  owna_id       TEXT NOT NULL,
  days_per_week INTEGER NOT NULL,             -- 1..5
  children      INTEGER NOT NULL DEFAULT 0,
  child_days    REAL NOT NULL DEFAULT 0,      -- children × days_per_week, i.e. child-days a week
  updated_at    TEXT,
  PRIMARY KEY (snapshot_date, owna_id, days_per_week)
);

-- Per centre, per snapshot date: how far OWNA's recurring bookings actually run forward. OWNA rolls
-- them indefinitely for most centres, but a centre that ends them on a fixed date (Heath Rd appears to
-- stop at 31 December — outstanding.md item 7) would otherwise read as "every family is leaving" in
-- every month after it. last_booking_date is where the roll stops; horizon_children is how many of the
-- centre's children have their last booking on exactly that day.
CREATE TABLE IF NOT EXISTS coe_forward_horizon (
  snapshot_date     TEXT NOT NULL,
  owna_id           TEXT NOT NULL,
  enrolled          INTEGER NOT NULL DEFAULT 0,
  week_from         TEXT,                     -- the reference week the booking mix was measured over
  week_to           TEXT,
  window_to         TEXT,                     -- last date the forward pull asked for
  last_booking_date TEXT,                     -- latest forward booking found, or NULL if there are none
  horizon_children  INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT,
  PRIMARY KEY (snapshot_date, owna_id)
);

-- ===== Talent pipeline: Employment Hero people, as COUNTS ONLY (services/eh-talent.js) =====
-- PRIVACY: Employment Hero's /employee record carries names, date of birth, tax file number, bank
-- accounts and addresses. NONE of it is stored. These three tables hold counts, a centre id, a month
-- and an ATO cessation code — nothing that identifies a person, exactly as the rest of this database.
--
-- THE OWNER'S RULES (decided 14 September 2026) are enforced in the aggregation, not in the reader:
--   * CASUALS ARE NOT TURNOVER. employmentType 'Casual' is excluded from both sides — not in the
--     headcount denominator here, and a casual who leaves is not a leaver.
--   * CASUALS ARE GROUP-LEVEL ONLY. A casual works across all centres, so the centre recorded against
--     them in payroll is an administrative home, not where the hours were worked. There is therefore
--     no casual column in talent_monthly at all; the one casual headcount lives in the group table.
--     (Casual HOURS per centre on the Wages page come from payroll earnings lines — real hours paid
--     against that location — and are unaffected. This is about counting casual PEOPLE.)
--   * SOMEONE WHO NEVER STARTED IS NOT A LEAVER. Payroll has no code for it, so it is inferred from
--     endDate on or before startDate: they never worked a day. Excluded on both sides like a casual.
--     Deliberately NOT a tenure threshold — someone who worked a fortnight and left IS turnover.
CREATE TABLE IF NOT EXISTS talent_monthly (
  owna_id       TEXT NOT NULL,        -- centre owna_id, or '(support office)' for payroll locations that
                                      -- are not a centre (Futuro HQ and the like). Never a casual figure.
  month         TEXT NOT NULL,        -- YYYY-MM
  headcount     INTEGER NOT NULL DEFAULT 0,  -- permanent people employed on the LAST DAY of the month
  starters      INTEGER NOT NULL DEFAULT 0,  -- permanent starts dated in the month (never-started excluded)
  leavers       INTEGER NOT NULL DEFAULT 0,  -- turnover leavers: permanent, and they actually started
  never_started INTEGER NOT NULL DEFAULT 0,  -- endDate <= startDate: excluded from leavers, shown separately
  -- The REPORTED role mix: the owner's rule of 16 September 2026 is that a person's role is their PAY
  -- CLASSIFICATION (payRateTemplate), not their job title. services/classification.js holds the mapping
  -- and /admin/pay-scales shows it. These seven sum to headcount — one category each — and they are
  -- what People & Culture and the centre pages show.
  cls_ect          INTEGER NOT NULL DEFAULT 0,
  cls_dip          INTEGER NOT NULL DEFAULT 0,
  cls_cert3        INTEGER NOT NULL DEFAULT 0,
  cls_trainee      INTEGER NOT NULL DEFAULT 0,
  cls_management   INTEGER NOT NULL DEFAULT 0,  -- CSE Level 7 (Assistant Director) and 8 (Director)
  cls_support      INTEGER NOT NULL DEFAULT 0,  -- Support Worker scales: kitchen and cleaning
  cls_unclassified INTEGER NOT NULL DEFAULT 0,  -- no pay scale, or one no rule maps — counted, never hidden
  -- The older JOB-TITLE mix, superseded on 16 September and no longer shown on any page. Still written,
  -- because it costs one pass over the same records and is the only other signal about someone whose
  -- pay scale is missing; talentReport() still returns it for anything that asks.
  ect           INTEGER NOT NULL DEFAULT 0,
  edu_leader    INTEGER NOT NULL DEFAULT 0,
  room_leader   INTEGER NOT NULL DEFAULT 0,
  educator      INTEGER NOT NULL DEFAULT 0,
  management    INTEGER NOT NULL DEFAULT 0,
  support       INTEGER NOT NULL DEFAULT 0,  -- kitchen, cleaning, maintenance
  other         INTEGER NOT NULL DEFAULT 0,  -- a job title no rule recognised — carried, never dropped
  updated_at    TEXT,
  PRIMARY KEY (owna_id, month)
);
CREATE INDEX IF NOT EXISTS idx_talent_month ON talent_monthly(month);

-- One row per month for the whole group. This is the ONLY place a casual is counted, and it is where
-- the turnover basis reconciles: raw_terminations - casual_leavers - never_started = leavers, by
-- construction, so the number on the page can be traced rather than doubted.
CREATE TABLE IF NOT EXISTS talent_group_monthly (
  month            TEXT PRIMARY KEY,            -- YYYY-MM
  headcount        INTEGER NOT NULL DEFAULT 0,  -- permanent, group-wide (the turnover denominator)
  casual_headcount INTEGER NOT NULL DEFAULT 0,  -- casuals employed at month end — group only, never per centre
  starters         INTEGER NOT NULL DEFAULT 0,  -- permanent starts
  casual_starters  INTEGER NOT NULL DEFAULT 0,
  raw_terminations INTEGER NOT NULL DEFAULT 0,  -- EVERY termination dated in the month, casuals included
  casual_leavers   INTEGER NOT NULL DEFAULT 0,  -- of those, the casuals (not turnover)
  never_started    INTEGER NOT NULL DEFAULT 0,  -- of the rest, those who never worked a day (not turnover)
  leavers          INTEGER NOT NULL DEFAULT 0,  -- = raw_terminations - casual_leavers - never_started
  -- The casual headcount broken down by pay classification. Group level, like every other casual figure
  -- here, and for the same reason: a casual works across every centre, so the centre payroll files them
  -- under is an administrative home rather than where the hours were worked. These sum to
  -- casual_headcount, and there is deliberately no per-centre equivalent in talent_monthly.
  cas_ect          INTEGER NOT NULL DEFAULT 0,
  cas_dip          INTEGER NOT NULL DEFAULT 0,
  cas_cert3        INTEGER NOT NULL DEFAULT 0,
  cas_trainee      INTEGER NOT NULL DEFAULT 0,
  cas_management   INTEGER NOT NULL DEFAULT 0,
  cas_support      INTEGER NOT NULL DEFAULT 0,
  cas_unclassified INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT
);

-- Leavers by ATO Single Touch Payroll cessation code, on the TURNOVER basis (casuals and never-started
-- already removed). There is no separate "Resignation" code in payroll: a resignation is recorded as
-- 'Voluntary cessation', which is why voluntary is reported as its own figure. The full STP set also
-- includes 'Transfer' and 'Deceased', which this tenant has not used yet; a code that has never been
-- seen — including one added later — is carried through with its own label rather than dropped.
CREATE TABLE IF NOT EXISTS talent_reasons_monthly (
  owna_id      TEXT NOT NULL,
  month        TEXT NOT NULL,        -- YYYY-MM of the end date
  reason_key   TEXT NOT NULL,        -- voluntary | contract | dismissal | redundancy | ill_health |
                                     -- transfer | deceased | not_recorded | other:<slug>
  reason_label TEXT NOT NULL,        -- the code as payroll words it (an ATO code, not free text)
  leavers      INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT,
  PRIMARY KEY (owna_id, month, reason_key)
);
CREATE INDEX IF NOT EXISTS idx_talentreason_month ON talent_reasons_monthly(month);

-- Every distinct pay classification seen in payroll, with how many people are on it. This exists so the
-- MAPPING is auditable: /admin/pay-scales lists each scale beside the category services/classification.js
-- puts it in, and a scale no rule matches is on that page under its own name with its headcount, instead
-- of disappearing into "Unclassified" with no way to find out what it was.
-- PRIVACY: a payRateTemplate is a PAY SCALE, not personal data — it names a rate, not a person, and it is
-- stored only because the mapping cannot be reviewed without it. Everything else here is a count. No name,
-- no employee id, no date of birth, exactly as the three tables above.
CREATE TABLE IF NOT EXISTS talent_pay_scales (
  scale      TEXT PRIMARY KEY,           -- payRateTemplate as payroll words it; '' = none recorded
  category   TEXT NOT NULL,              -- ect | dip | cert3 | trainee | management | support | unclassified
  people     INTEGER NOT NULL DEFAULT 0, -- people on it and employed as at the snapshot date
  permanent  INTEGER NOT NULL DEFAULT 0, -- of those, the ones who are not employmentType 'Casual'
  casual     INTEGER NOT NULL DEFAULT 0,
  matched    INTEGER NOT NULL DEFAULT 0, -- 1 when a rule matched it, 0 when nothing did
  updated_at TEXT
);

-- ===== Per-source sync health: what the nightly snapshot last did for each upstream =====
CREATE TABLE IF NOT EXISTS source_sync (
  source       TEXT PRIMARY KEY,    -- owna | lineleader | eh_labour | exits | incidents | roster | coe | talent | retention
  last_attempt TEXT,
  last_success TEXT,
  status       TEXT,                -- ok | error | skipped
  detail       TEXT,                -- one-line summary (error name + message); never an upstream response body
  rows         INTEGER,             -- rows written by the last SUCCESSFUL run
  meta_json    TEXT                 -- small JSON kept from the last SUCCESSFUL run, e.g. {"weeks":16,"latest_period":"2026-09-06"}
);

-- ===== Logged-in sessions (express-session, see middleware/session.js) =====
-- Kept here so the app survives a restart without signing everyone out. The store
-- (better-sqlite3-session-store) creates this table itself with exactly this definition; it is written
-- out here as well so the schema file stays the full picture of what this database holds.
-- PRIVACY: a row is personal information under APP 11 — `sess` is the session JSON, which carries the
-- signed-in user's id, email, name and role (never a password, and never a child or family). Rows expire
-- eight hours after the last request and the store sweeps expired rows every fifteen minutes, so this
-- table does not accumulate and needs no separate purge: the retention job (services/retention.js)
-- deliberately leaves it alone rather than sweep it a second time, and records the eight hours as
-- SESSION_HOURS so the documented period and the enforced one cannot drift apart. The sweep only
-- removes rows already past their expiry, so it does not cover a restore: `scripts/restore-db.js`
-- clears this table on the restored file,
-- or a backup younger than eight hours would reinstate every login that was live when it was taken.
CREATE TABLE IF NOT EXISTS sessions (
  sid    TEXT NOT NULL PRIMARY KEY,
  sess   JSON NOT NULL,             -- the serialised session; see the privacy note above
  expire TEXT NOT NULL              -- ISO-8601 UTC instant; compared with datetime('now'), i.e. in UTC
);

-- ===== eNPS survey trial (owner's spec, 16 September 2026) =====
-- Three tables, and the severing between two of them is the whole design. Read the block comment at
-- the top of services/survey.js before changing anything here.
--
-- A round of the survey: all centres at once, opens and closes on a date (Sydney dates, YYYY-MM-DD).
CREATE TABLE IF NOT EXISTS survey_rounds (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL DEFAULT 'enps',
  name       TEXT NOT NULL,          -- what a reader calls it, e.g. "eNPS trial — September 2026"
  opens_on   TEXT NOT NULL,          -- YYYY-MM-DD, inclusive
  closes_on  TEXT NOT NULL,          -- YYYY-MM-DD, inclusive: after this the link says the survey has closed
  created_at TEXT
);

-- ONE: the invitations. A token, the round, the centre it was issued for, whether it has been used.
-- PRIVACY: no name, no employee id, no email address. The address is needed at SEND TIME only — the
-- export reads it from payroll, writes it into the file the admin mail-merges from, and drops it. It
-- is never written to this database. `used` is a FLAG, not a date, for the reason set out in the
-- comment on survey_responses below.
--
-- And no employee id by the back door either. A row's POSITION within its centre is a column that is
-- not written down: pair a centre's rows in rowid order against the payroll list in payroll-id order
-- and, if the export assigned them that way, every token has a name on it — from this file plus a
-- payroll call, with nothing kept. So the export does NOT assign them that way. Which of a centre's
-- tokens a person is sent is a keyed shuffle (exportRows in services/survey.js) under a key held in
-- the environment and never in this file, so the ordinal of a row is not an employee number and this
-- file on its own pairs nobody. Anything that makes the assignment reproducible from stored data —
-- ordering these rows by who they were issued for, or storing the slot — puts the identifier back.
CREATE TABLE IF NOT EXISTS survey_invitations (
  token        TEXT PRIMARY KEY,     -- 32 random bytes, base64url; single-use
  round_id     INTEGER NOT NULL,
  owna_id      TEXT,                 -- the centre; NULL = a payroll location that is not a centre (support office)
  centre_label TEXT NOT NULL,        -- what question 1 says: "…recommend Futuro <centre_label>?"
  issued_on    TEXT,                 -- YYYY-MM-DD the token was created (same day for the whole round)
  sent_on      TEXT,                 -- YYYY-MM-DD it was last handed to an export / mail sender
  used         INTEGER NOT NULL DEFAULT 0  -- 1 = spent. WHEN it was spent is deliberately not recorded
);
CREATE INDEX IF NOT EXISTS idx_survey_inv_round ON survey_invitations(round_id, owna_id);

-- TWO: the answers. Deliberately severed from the table above — no foreign key, no token, no invitation
-- id, nothing that identifies which invitation this came from. The only columns the two tables share are
-- the round and the centre, which are group attributes rather than a joining value, and a centre is only
-- ever reported once at least SURVEY_MIN_RESPONSES answers stand behind it.
--
-- submitted_on is a DAY, not an instant, and it is the ONLY side that carries a time at all. The
-- invitation side records that a token was spent and not when: a shared day is a joining value, because
-- on any day one person at a centre answers, (round, centre, day) matches a single invitation. So the
-- invitation table has no date of use to line this column up against, and its rowid is assigned when
-- the round is generated rather than when a token is spent, so it carries no ordering either.
CREATE TABLE IF NOT EXISTS survey_responses (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id      INTEGER NOT NULL,
  owna_id       TEXT,                -- the centre, as above; NULL = not a centre
  centre_label  TEXT NOT NULL,
  score         INTEGER NOT NULL,    -- 0..10, question 1, the only required answer
  reason        TEXT,                -- question 2, free text
  other         TEXT,                -- question 3, free text
  submitted_on  TEXT NOT NULL        -- YYYY-MM-DD. NEVER a time of day — see above
);
CREATE INDEX IF NOT EXISTS idx_survey_resp_round ON survey_responses(round_id, owna_id);

-- THREE: the delivery log. Which invitations have actually left the building, so a retry after a
-- failed or interrupted run sends only to the people who never got one and nobody is sent two links.
--
-- KEYED ON THE TOKEN, and that is the whole reason this table can exist at all. exportRows() is
-- deterministic — the same key and the same staff list hand the same person the same token — so
-- "already delivered" can be answered from the token alone and the address never has to be written
-- down. No address, no name, no employee id: the columns below are the columns, and the address the
-- message went to is read from payroll inside the sending run and dropped with it.
--
-- updated_on is a DAY, like everywhere else here, and it is the day a message was SENT, not the day a
-- token was spent — survey_invitations.sent_on already records exactly that event at exactly that
-- granularity, so this adds no new kind of fact. The day a token is USED is still recorded nowhere:
-- that is the value that would join these rows to survey_responses, and it does not exist.
--
-- AND NO ORDER EITHER — the same rule as survey_invitations above, which this table has one more way to
-- break. A row is written as its message is sent, so ROW ORDER IS SEND ORDER: send in payroll order and
-- `ORDER BY rowid` hands back the round in payroll order, which pairs every token to a name from this
-- file plus a payroll call, with no key and nothing kept. So the sender sorts its queue by token
-- (graphSendRound), and WITHOUT ROWID makes the file itself agree: rows are stored physically in the
-- token's B-tree order, so the bytes on the page carry no arrival order to read even if a future caller
-- hands them over in some other one. There is no rowid here to order by, by construction.
CREATE TABLE IF NOT EXISTS survey_deliveries (
  token      TEXT PRIMARY KEY,          -- the invitation's token; the only identifier in this table
  round_id   INTEGER NOT NULL,
  status     TEXT NOT NULL,             -- 'sent' (Graph returned 202) | 'failed'
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,                      -- an error CLASS ('throttled', 'forbidden', …) — never a
                                        -- message, a body or an address
  updated_on TEXT                       -- YYYY-MM-DD. NEVER a time of day — see above
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_survey_deliveries_round ON survey_deliveries(round_id, status);
