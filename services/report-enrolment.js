// The enrolment report: one model assembled from the three things that answer different halves of the
// same question, plus the markers that explain movement in it.
//
//   COE       — of the children enrolled today, how many hold a booking into each month (retention)
//   Occupancy — how many children are booked in each month at all, new starters included (the net)
//   Enquiries — what is coming in, weekly, and how far it gets (the front of the funnel)
//
// COE and occupancy MUST be read together. Austral's continuation into February 2027 is 78.8% and its
// booked occupancy that month is 101%: 42 children finish and their places are already re-booked. Either
// figure alone tells the wrong story — the first reads as a centre emptying, the second hides the churn.
const m = require("./metrics");
const cal = require("./calendar");
const enquiries = require("./enquiries");
const marketing = require("./marketing");
const db = require("../db/db");

const SHORT = (n) => String(n || "").replace(/Futuro Childcare\s*(and|&)\s*Education\s*-?\s*/i, "").trim();

// Booked occupancy per centre per month, with the coverage that produced it. placesByMonth divides by
// the operating days it actually HAS rows for, never by the days in the month — a missing day is missing
// snapshot coverage, not a day nobody attended. The report prints that coverage so a thin month is
// visible as thin rather than read as empty.
// `horizon` maps owna_id to that centre's last booked day. Occupancy needs it for exactly the reason COE
// does: past the day families have booked to, the booked count falls to nothing. Bardia's last booking is
// 19 March, so March reads 57.7% and April reads near zero — neither is a centre emptying, both are the
// edge of the data. A month that runs past the horizon is marked, and a month entirely past it is not
// shown at all. Without this the table paints a wall of red for something that has not happened.
function occupancyByMonth(months, horizon = new Map()) {
  const first = months[0], last = months[months.length - 1];
  return m.centres().filter((c) => !c.opening).map((c) => {
    const places = m.placesFor(c);
    const rows = m.placesByMonth(c.owna_id, places, first, last);
    const hz = horizon.get(c.owna_id) || null;
    const byMonth = {};
    for (const r of rows) {
      const start = r.month + "-01", end = monthEnd(r.month);
      const opDays = cal.operatingDays(start, end);
      const beyond = hz ? start > hz : false;             // the whole month is past the last booking
      const partial = hz ? !beyond && end > hz : false;   // the month straddles it
      byMonth[r.month] = {
        booked: r.booked,
        avg_booked: r.avg_booked,
        utilisation: r.utilisation,
        days_with_rows: r.days_with_rows,
        operating_days: opDays,
        // Below this the month is too thin to quote. Two thirds is a judgement, stated rather than hidden.
        thin: opDays > 0 && r.days_with_rows / opDays < 0.67,
        beyond_horizon: beyond,
        partial_horizon: partial,
        horizon: hz,
      };
    }
    return { owna_id: c.owna_id, name: SHORT(c.name), places, months: byMonth, horizon: hz };
  });
}

function monthEnd(ym) {
  const [y, mo] = ym.split("-").map(Number);
  return ym + "-" + String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0");
}

// Children currently waiting, per centre, from the LineLeader pipeline members — the table that matches
// LineLeader's own "Child Counts" bar. Validated against the live dashboards for Cobbitty and Bardia.
function waitlistByCentre() {
  return db.prepare(`
    SELECT COALESCE(c.name, p.centre_name) AS name, p.owna_id,
           COUNT(DISTINCT CASE WHEN p.status_id = 4 THEN p.child_id END) AS waiting,
           COUNT(DISTINCT CASE WHEN p.status_id IN (5,12) THEN p.child_id END) AS offered,
           COUNT(DISTINCT CASE WHEN p.status_id = 13 THEN p.child_id END) AS pre_open,
           COUNT(DISTINCT CASE WHEN p.status_id IN (1,2,3,11) THEN p.child_id END) AS early
    FROM ll_pipeline_members p LEFT JOIN centres c ON c.owna_id = p.owna_id
    WHERE p.centre_name NOT LIKE '%Z-Test%'
    GROUP BY COALESCE(c.name, p.centre_name)
    HAVING waiting + offered + early + pre_open > 0
    ORDER BY waiting DESC
  `).all().map((r) => ({ ...r, name: SHORT(r.name) }));
}

// The three sites that have not opened. Their story is entirely front-of-funnel — there is no occupancy
// and no continuation to measure — so it is told as the pipeline stages LineLeader holds today plus the
// weekly arrival of new families behind them.
const STAGES = [
  { key: "new",      label: "New / engaged", ids: [1, 2] },
  { key: "tour",     label: "Tour booked",   ids: [11] },
  { key: "toured",   label: "Toured",        ids: [3] },
  { key: "waitlist", label: "Waitlist",      ids: [4] },
  { key: "pre_open", label: "Pre open",      ids: [13] },
  { key: "offer",    label: "Offer accepted", ids: [5, 12] },
];
function openingCentres(from) {
  const counts = db.prepare(`
    SELECT owna_id, status_id, COUNT(DISTINCT child_id) AS n
    FROM ll_pipeline_members WHERE owna_id = ? GROUP BY status_id
  `);
  return m.centres().filter((c) => c.opening).map((c) => {
    const byStatus = new Map(counts.all(c.owna_id).map((r) => [r.status_id, r.n]));
    const stages = STAGES.map((st) => ({
      key: st.key, label: st.label,
      n: st.ids.reduce((a, id) => a + (byStatus.get(id) || 0), 0),
    }));
    // byWeek with an ownaId returns this centre's own initiatives AND the group-wide ones, because a
    // group-wide post reached this centre too.
    const own = marketing.byWeek({ from, ownaId: c.owna_id });
    const weeks = enquiries.weeks({ from, ownaId: c.owna_id })
      .map((w) => ({ ...w, initiatives: own.get(w.week_start) || [] }));
    return {
      owna_id: c.owna_id, name: SHORT(c.name), stages, weeks,
      opening_year: c.opening_year, opening_month: c.opening_month,
      pipeline: stages.reduce((a, st) => a + st.n, 0),
      leads: weeks.reduce((a, w) => a + w.leads, 0),
    };
  }).filter((c) => c.pipeline > 0 || c.leads > 0)
    // Soonest first: the centre opening in November is the one the board needs to look at hardest.
    .sort((a, b) => (a.opening_year - b.opening_year) || ((a.opening_month || 13) - (b.opening_month || 13)));
}

// LineLeader carries a "Staff Location" and test sites alongside the real ones. They are not centres and
// have no place on a board slide.
const NOT_A_CENTRE = /staff location|z-test/i;

// The last day any child is booked in, per centre. COE already derives it, and both measures must use the
// same one or the two tables will disagree about where the data stops.
function horizonMap(coe) {
  const out = new Map();
  for (const c of (coe ? coe.centres : [])) if (c.last_booking_date) out.set(c.owna_id, c.last_booking_date);
  return out;
}

function build({ weeks = 26 } = {}) {
  const today = m.todayStr();
  const coe = m.coeMeasured();                      // continuing_pct is computed in here already
  const months = coe ? coe.months.map((x) => x.month) : m.coeMonthKeys();
  const from = enquiries.mondayOf(cal.addDays(today, -7 * weeks)) || cal.addDays(today, -7 * weeks);

  const series = enquiries.weeks({ from });
  const initiatives = marketing.byWeek({ from });

  return {
    as_at: today,
    coe,                                            // null when no snapshot has run
    coe_months: months,
    occupancy: occupancyByMonth(months, horizonMap(coe)),
    waitlist: waitlistByCentre(),
    mix: coe ? coe.centres.map((c) => ({ name: SHORT(c.name), mix: c.mix, avg: c.avg_days_per_child })) : [],
    weeks: series.map((w) => ({ ...w, initiatives: initiatives.get(w.week_start) || [] })),
    opening: openingCentres(from),
    enquiries_by_centre: enquiries.byCentre({ from })
      .filter((r) => !NOT_A_CENTRE.test(r.ll_centre || ""))
      .map((r) => ({ ...r, name: SHORT(r.centre_name || r.ll_centre), unmapped: !r.owna_id })),
    enquiries_refreshed: enquiries.lastRefreshed(),
    // Every figure on the page is only as current as the pull behind it, and the two pulls are different.
    owna_as_at: m.lastActualDate(),
    owna_lag_days: m.actualsLagDays(),
    initiatives: marketing.list({ from }),
  };
}

// The CSV a board pack actually needs: one row per centre per month, both measures side by side, with the
// coverage that produced the occupancy figure so nobody quotes a thin month as a result.
function csv(model) {
  const head = ["centre", "month", "enrolled", "continuing", "not_confirmed", "leaving",
    "continuation_pct", "booked_avg_per_day", "approved_places", "occupancy_pct",
    "operating_days_held", "operating_days_in_month", "coverage_note"];
  const out = [head.join(",")];
  const occ = new Map(model.occupancy.map((o) => [o.owna_id, o]));
  for (const c of (model.coe ? model.coe.centres : [])) {
    const o = occ.get(c.owna_id);
    for (const mo of c.months) {
      const om = o && o.months[mo.month];
      out.push([
        q(SHORT(c.name)), mo.month,
        mo.beyond_horizon ? "" : mo.enrolled,
        mo.beyond_horizon ? "" : mo.continuing,
        mo.beyond_horizon ? "" : mo.not_confirmed,
        mo.beyond_horizon ? "" : mo.leaving,
        mo.beyond_horizon ? "" : (mo.continuing_pct ?? ""),
        om ? om.avg_booked : "", o ? o.places : "",
        om && om.utilisation != null ? om.utilisation : "",
        om ? om.days_with_rows : "", om ? om.operating_days : "",
        q(mo.beyond_horizon ? "beyond this centre's booking horizon"
          : om && om.beyond_horizon ? "occupancy beyond this centre's booking horizon — not a real figure"
          : om && om.partial_horizon ? "month runs past the last booked day (" + om.horizon + ") — occupancy understated"
          : om && om.thin ? "thin coverage — do not quote" : ""),
      ].join(","));
    }
  }
  return out.join("\n") + "\n";
}
const q = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;

module.exports = { build, csv, occupancyByMonth, waitlistByCentre, openingCentres, STAGES };
