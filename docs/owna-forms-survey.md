# What we can get from OWNA forms

Measured against the live tenant on 2026-09-14. Supersedes any earlier reading of the Swagger spec alone.

## The answer, short

**Nothing, today.** Both of OWNA's form systems are the *only* endpoints our API key is refused on.
Every other endpoint in the API answers normally.

## The forms endpoints, and what they return

| Endpoint | Result |
|---|---|
| `/api/customform/{centreId}/List` | **415** — You do not have authority to make this API Call |
| `/api/customform/{centreId}/{startDate}/{endDate}/List` | **415** — You do not have authority to make this API Call |
| `/api/customform/{startDate}/{endDate}/List` | **415** — You do not have authority to make this API Call |
| `/api/formsubmission/{centreId}/List` | **415** — You do not have authority to make this API Call |
| `/api/formsubmission/{startDate}/{endDate}/List` | **415** — You do not have authority to make this API Call |

OWNA reports a permissions failure as **HTTP 415 Unsupported Media Type**, not 403. The body is explicit:

> `{"type":"ValidationError","title":"Owna Validation Exception","status":415,`
> `"detail":"You do not have authority to make this API Call"}`

This matters because 415 normally means "your request was malformed". It is not. Sending a
`Content-Type: application/json` header makes it a 400 instead, which looks like a body-format
problem and sends you chasing the wrong thing. The permission message is present in both.

## What the key CAN read

48 endpoints answered. Counts are live, from a 30-day window where the endpoint takes dates.

| Endpoint | Rows | In the dashboard? |
|---|---|---|
| `/api/attendance/{centreId}/list` | 23986 | **not used** |
| `/api/attendance/{centreId}/{startDate}/{endDate}` | 2218 | yes |
| `/api/attendance/{startDate}/{endDate}/list` | 10018 | **not used** |
| `/api/basic/attendance/{centreId}/list` | 23986 | **not used** |
| `/api/basic/attendance/{centreId}/{startDate}/{endDate}` | 2218 | **not used** |
| `/api/basic/attendance/{startDate}/{endDate}/list` | 10018 | **not used** |
| `/api/basic/casualbooking/waitlist/{centreId}/{startDate}/{endDate}/list` | 2 | **not used** |
| `/api/basic/casualbooking/waitlist/{startDate}/{endDate}/list` | 35 | **not used** |
| `/api/basic/casualbooking/{centreId}/{startDate}/{endDate}/list` | 0 | **not used** |
| `/api/basic/casualbooking/{startDate}/{endDate}/list` | 46 | **not used** |
| `/api/basic/enrolment/submissions/list` | 1465 | **not used** |
| `/api/basic/enrolment/submissions/{centreId}/list` | 254 | **not used** |
| `/api/casualbookings/waitlist/{centreId}/{startDate}/{endDate}/list` | 2 | **not used** |
| `/api/casualbookings/waitlist/{startDate}/{endDate}/list` | 35 | **not used** |
| `/api/casualbookings/{centreId}/{startDate}/{endDate}/list` | 0 | **not used** |
| `/api/casualbookings/{startDate}/{endDate}/list` | 46 | **not used** |
| `/api/ccs/payments/{centreId}/{startDate}/{endDate}/list` | 700 | yes |
| `/api/ccs/payments/{startDate}/{endDate}/list` | 3003 | **not used** |
| `/api/centre/list` | 4 | yes |
| `/api/centre/{centreId}` | 1 | **not used** |
| `/api/children/illnesslog/{centreId}/{fromDate}/{toDate}` | 0 | **not used** |
| `/api/children/incident/{centreId}/{fromDate}/{toDate}` | 0 | yes |
| `/api/children/list` | 1622 | **not used** |
| `/api/children/medicationlog/{centreId}/{fromDate}/{toDate}` | 0 | **not used** |
| `/api/children/{centreId}/list` | 249 | yes |
| `/api/enquiries/list` | 0 | **not used** |
| `/api/enquiries/{centreId}/list` | 0 | **not used** |
| `/api/enquiries/{centreId}/{startDate}/{endDate}/list` | 0 | **not used** |
| `/api/enquiries/{startDate}/{endDate}/list` | 0 | **not used** |
| `/api/enrolment/submissions/list` | 1465 | **not used** |
| `/api/enrolment/submissions/{centreId}/list` | 254 | **not used** |
| `/api/family/List` | 1322 | **not used** |
| `/api/family/bond/{centreId}/{startDate}/{endDate}/list` | 0 | **not used** |
| `/api/family/bond/{startDate}/{endDate}/list` | 0 | **not used** |
| `/api/family/invoice/{centreId}/{fromDate}/{toDate}` | 0 | **not used** |
| `/api/family/transaction/{centreId}/{fromDate}/{toDate}` | 0 | **not used** |
| `/api/family/{centreId}/list` | 216 | **not used** |
| `/api/lookup/days` | 7 | **not used** |
| `/api/lookup/gender` | 3 | **not used** |
| `/api/lookup/hearabout` | 7 | **not used** |
| `/api/parent/List` | 5810 | **not used** |
| `/api/parent/{centreId}/list` | 870 | **not used** |
| `/api/room/{centreId}/fees/list` | 51 | **not used** |
| `/api/room/{centreId}/list` | 8 | yes |
| `/api/roster/{centreId}/{weekStarting}` | 1 | yes |
| `/api/staff/incidentreport/list` | 14 | **not used** |
| `/api/staff/log/{centreId}/{date}` | 213 | yes |
| `/api/staff/onduty/{centreId}/{date}` | 7 | **not used** |

## Unverified

Four endpoints could not be confirmed — the DNSFilter allowlist was propagating inconsistently and
these requests hit the block page rather than OWNA. None are form endpoints. Two of them
(`/api/staff/{centreId}/list`, and staff logs) are called successfully by the dashboard in production,
so the staff scope is known good. Re-run `npm run discover-forms` once DNS is stable to close these off.

- `/api/staff/rp/{centreId}`
- `/api/staff/{centreId}/list`
- `/api/waitlist/{centreId}/list`
- `/api/waitlist/{centreId}/tourbooking/list`

## What to do about it

Ask OWNA support to add **forms scope** to the API key — specifically the `FormSubmission` and
`FormResponse` endpoint groups. Until that happens no amount of client work helps: the data is
not reachable, and we still do not know whether Futuro's centres use OWNA form templates at all.

Once scope is granted, `npm run discover-forms` answers the remaining question in one run: how many
distinct forms exist, how many submissions each holds, and which fields are filled often enough to
build dashboard columns from. It prints field names and fill rates only, never answers.
