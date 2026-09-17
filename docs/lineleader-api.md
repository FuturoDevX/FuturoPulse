# LineLeader Enroll API — what is available, and what we use

Surveyed 18 September 2026 from the published Postman collection at
<https://apidocs.childcarecrm.com/> (collection `8336132-11ca823a-fdf9-42b7-9cd2-4250721b0fbe`;
the machine-readable source is `/api/collections/8336132/2sBYAsyC2q?segregateAuth=true&versionTag=latest`).

Base URL `https://live.childcarecrm.com.au`, API under `/api/v3`, bearer token from
`POST /api/v3/login` with refresh at `/login/refresh`. Client: `services/lineleader.js`.

**253 endpoints are documented. We call six.**

## What we call today

| Endpoint | Used for |
|---|---|
| `GET /centers?include_inactive=true` | centre list → `ll_centres` |
| `GET /statuses` | stage id → name map |
| `GET /families` (count only) | per-status family counts → `ll_pipeline` |
| `GET /enrollments` | starts, withdrawals, by-status → `ll_enrolments`, `ll_pipeline_starts`, `ll_pipeline_members` |
| `GET /tasks?type=` | tours (type 89) → `ll_tours` |
| `GET /types/reasons/withdrawn` | withdrawal reason lookup |

## Not used, and it costs us

These answer questions this dashboard currently tells people it cannot answer. Listed worst-first.

### 1. `GET /families/{id}/status-histories` — the pipeline over time

> *"Returns the status timeline for the family itself plus one timeline per relevant child."*
> `include_archived=true` also returns children now in Withdrawn or Lost.

`ll_pipeline` only holds stage counts for the nights the snapshot ran — as at this survey, two dates
(1 and 10 September 2026). Every page therefore has to say a funnel trend is impossible. It is not:
this endpoint carries each child's full stage history, so the funnel can be reconstructed backwards
for as long as LineLeader has records. **This is the single highest-value unused call.**

### 2. `GET /updates?since=&filter_type=&filter_value=` — a change feed

The docs give the exact recipe: *"to find all families that changed to status 5, GET
/updates?since=0&filter_value=5&filter_type=3"*. A conversion-events feed, which gives
stage-to-stage conversion and time-in-stage — both currently reported as unanswerable.

### 3. `GET /centers/{id}/classrooms` — room capacity AND per-day availability

The classroom object carries `capacity`, `begin_age`/`end_age` (whole months), `current_free`,
`next_free_date`, and **per-weekday, per-session free places**: `mon_am_free`, `mon_pm_free`,
`tue_am_free` … `fri_pm_free`.

This matters well beyond reporting. The v2 centre-manager screen cannot draw a room-level seat map
because OWNA's room records are unusable — capacities apportioned to sum to the licence, ratios set
on one room in twenty-four. **LineLeader may hold the room data OWNA does not.** Whether Futuro
maintains it is unverified; the Availability tab on each centre's Action Dashboard is where to look.

### 4. Lead source and attribution

`GET /types/family/source`, `/types/family/origins`, `/types/family/inquiry`,
`/types/marketing-campaigns`, and `GET /families?origin_id=`.

"Where do enquiries come from" is a board question, and item 11 of the outstanding register asks
Marketing to fill in "lead source" in LineLeader. The API exposes the whole taxonomy and lets the
family list be filtered by it.

### 5. `GET /types/reasons/enrolled` · `/types/reasons/withdrawn`

We fetch the withdrawn lookup but never store a reason against a departure, so the pack cannot say
*why* families leave — only how many.

## Worth knowing

- `GET /search`, `GET /families/search`, `/families/manage/dupe-check` — record lookup, no use here.
- `GET /events`, `/emails`, `/texts` — communications history. Personal content; would need a
  counts-only treatment to fit this app's privacy posture (`db/schema.sql`, APP 11.2).
- `GET /staff`, `/permissions`, `/organizations` — administrative.
- `GET /centers/{id}/tour-availability` and the `pst-settings` pair — parent-scheduled tours.
- `PUT`/`POST`/`DELETE` exist across most resources. **This dashboard is read-only against
  LineLeader and should stay that way** — it is not the system of record for any of it.

## How to re-run this survey

```bash
curl -s 'https://apidocs.childcarecrm.com/api/collections/8336132/2sBYAsyC2q?segregateAuth=true&versionTag=latest' -o ll-api.json
```

Then walk `item[]` recursively; each leaf has `request.method` and `request.url.path`.
