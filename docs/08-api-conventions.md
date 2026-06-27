# 08 — API Conventions

> The contract every Aegis service speaks. One error envelope, one list shape, one
> header set, one auth wrapper, one validation library. Read this before adding a
> route; a new endpoint that diverges from these rules is a bug.
>
> Related: [`03-access-control-model.md`](03-access-control-model.md) ·
> [`05-authn-authz-flow.md`](05-authn-authz-flow.md) ·
> [`06-service-to-service.md`](06-service-to-service.md) ·
> [`07-data-models.md`](07-data-models.md) ·
> [`09-deployment-and-ops.md`](09-deployment-and-ops.md) ·
> per-service contracts under [`services/`](services/).

---

## 1. Principles

1. **Uniform over clever.** Every service uses the same envelope, the same pagination
   shape, the same headers, the same `authenticate → authorize → handler` chain. A
   client that integrates one service can integrate all of them.
2. **Fail-closed.** Missing/malformed required headers, an unresolved principal, or a
   PDP `deny` all short-circuit to a typed error *before* the handler runs. Nothing is
   defaulted to `"UNKNOWN"` (see [`06-service-to-service.md`](06-service-to-service.md)).
3. **Tenant comes from context, never from the body.** `tenantId` and `userId` are
   derived from the validated request context (JWT at the edge → `X-Tenant-Id`/token
   downstream), pushed into Postgres via `SET LOCAL app.current_tenant`. A request body
   that carries a `tenantId` is ignored; a path/body that disagrees with context is a
   `403`.
4. **Explicit DTOs.** Responses are hand-built serializers, never raw Sequelize rows.
   Money is integer **minor units** (cents); IDs are UUID v4; timestamps are ISO-8601.
5. **Idempotent money/state writes.** Any endpoint that moves money or advances a state
   machine requires an `Idempotency-Key` (§6).

---

## 2. REST naming & versioned paths

### 2.1 Path grammar

```
/<service>/v1/<collection>[/<id>[/<sub-collection>[/<id>]]][:<action>]
```

- **Service prefix** — the owning service (`/user-management`, `/expense`, `/payroll`,
  `/invoice`, `/workflow`, `/reporting`, `/notification`, `/access-control`). The
  **gateway** strips/routes this prefix; internally each service also mounts under it so
  it is reachable directly in dev.
- **Version** — `/v1` is the first segment after the service. Versions are **additive**:
  a breaking change ships `/v2` alongside `/v1`; `/v1` is never silently mutated.
- **Collections are plural nouns** — `expense-reports`, `pay-runs`, `invoices`,
  `report-runs`, `roles`, `permissions`. Lower-case, hyphenated.
- **No tenant in the path.** Tenant is ambient (context/RLS), not `/{tenantId}/...`.

### 2.2 Verbs vs. action sub-resources

CRUD uses HTTP verbs on the collection/item. **State transitions are POST action
sub-resources**, not a `PATCH {status}` free-for-all — this keeps each transition
guard-able, auditable, and idempotent:

| Intent | Method + path |
|---|---|
| Create | `POST /expense/v1/expense-reports` |
| Read one | `GET /expense/v1/expense-reports/:id` |
| List | `GET /expense/v1/expense-reports` |
| Partial update (editable fields) | `PATCH /expense/v1/expense-reports/:id` |
| **Transition** (submit/approve/…) | `POST /expense/v1/expense-reports/:id/submit` |

> Why action sub-resources, not `PATCH status`: a transition is a distinct *operation*
> with its own permission (`expense.report.submit` vs `expense.report.approve`), its own
> ABAC conditions (amount/threshold/maker-checker), its own idempotency, and its own
> audit event. Modelling it as a verb route lets the PEP guard exactly that operation.

### 2.3 List operations that take a filter body

Read-heavy services (expense, invoice, reporting) also expose `POST
.../search` for rich filters that don't fit a query string (nested operators, long
`in` lists). `POST .../search` is **read-only** (no side effects), returns the standard
list envelope (§5), and is still guarded by the collection's `*.read` permission.

---

## 3. Required headers (`HttpHeaderKey`)

All header names are centralized in the `HttpHeaderKey` enum in `@aegis/shared-enums`
(never hand-typed string literals). The context middleware in `@aegis/service-core`
asserts the required set and **rejects fail-closed** on missing/malformed values.

```ts
// libs/shared/enums/src/http-header-key.enum.ts
export enum HttpHeaderKey {
  Authorization   = 'authorization',        // Bearer <user|internal JWT>
  TenantId        = 'x-tenant-id',           // tenant uuid (downstream hops)
  CorrelationId   = 'x-correlation-id',      // business-request id (edge-minted, propagated)
  TraceId         = 'x-trace-id',            // OpenTelemetry trace/span id
  Caller          = 'x-caller',              // logical caller (user agent / service)
  SourceService   = 'x-source-service',      // typed enum, internal hops only
  InternalOrigin  = 'x-internal-origin',     // origin gate for internal JWT lane
  IdempotencyKey  = 'idempotency-key',       // money/state writes (§6)
  ContentType     = 'content-type',
}
```

| Header | Edge (client→gateway) | Internal hop (service→service) | Validation |
|---|---|---|---|
| `Authorization` | **required** (user JWT) | **required** (internal JWT) | Bearer present; verified in §7 |
| `X-Tenant-Id` | derived from JWT at edge | **required**, must equal token `tenant_id` | uuid; mismatch → `403` |
| `X-Correlation-Id` | optional (minted if absent) | **required**, propagated unchanged | non-empty string |
| `X-Trace-Id` | injected by OTel | propagated | — |
| `X-Caller` | optional | propagated | — |
| `X-Source-Service` | n/a | **required** internal | member of `SourceService` enum |
| `X-Internal-Origin` | n/a | **required** internal | gates the internal-JWT lane |
| `Idempotency-Key` | required on money/state writes | required on connector pushes | see §6 |

> **`X-Correlation-Id` is the business-request id** — one id minted at the gateway per
> inbound logical operation and carried unchanged through every hop and every async
> message, so all logs/traces/audit rows for one operation stitch together. It is
> distinct from `X-Trace-Id` (the OTel span id). `X-Correlation-Id` is the only
> business-request correlation header — Aegis defines no alternate ad-hoc tracking header.

---

## 4. Error envelope & status mapping

A single Express error middleware in `@aegis/service-core` converts every typed error
(raised via `ErrorUtils`) into **one** shape. There is exactly one error envelope across
all services:

```jsonc
{
  "errors": [
    {
      "code": "EXPENSE_REPORT_NOT_FOUND",   // stable machine code (SCREAMING_SNAKE)
      "type": "NOT_FOUND",                   // ErrorType enum (status class)
      "message": "Expense report not found", // human-readable, safe to surface
      "details": { "reportId": "8f1c…" },    // optional structured context (omitted when none)
      "traceId": "b3a7c2e9-…"                 // == X-Correlation-Id for this request
    }
  ]
}
```

- `errors` is **always an array** — validation failures (§8) return one entry per
  invalid field; everything else returns a single entry.
- `traceId` echoes the request's `X-Correlation-Id`, so a client/support engineer can
  grep one id across every service's logs.
- `details` never contains secrets, raw SQL, stack traces, or masked field values.

### 4.1 `ErrorType` → HTTP status

```ts
// raised in services; mapped centrally by the error middleware
export enum ErrorType {
  VALIDATION    = 'VALIDATION',     // 400  malformed/invalid input
  UNAUTHORIZED  = 'UNAUTHORIZED',   // 401  no/invalid credentials
  FORBIDDEN     = 'FORBIDDEN',      // 403  authenticated but PDP denied
  NOT_FOUND     = 'NOT_FOUND',      // 404  resource absent (or hidden by scope)
  CONFLICT      = 'CONFLICT',       // 409  state-machine / uniqueness / idempotency clash
  UNPROCESSABLE = 'UNPROCESSABLE',  // 422  well-formed but semantically rejected
  RATE_LIMITED  = 'RATE_LIMITED',   // 429  throttled
  INTERNAL      = 'INTERNAL',       // 500  unexpected (message is generic; details suppressed)
  DEPENDENCY    = 'DEPENDENCY',     // 502/503  downstream (ERP connector, bus) failure
}
```

| Type | Status | Typical trigger |
|---|---|---|
| `VALIDATION` | 400 | Joi rejected the body/query/params |
| `UNAUTHORIZED` | 401 | missing/expired/invalid JWT, revoked session |
| `FORBIDDEN` | 403 | PDP `deny`, tenant mismatch, maker-checker violation |
| `NOT_FOUND` | 404 | unknown id, or a row outside the caller's row-scope (we 404 rather than 403 to avoid leaking existence) |
| `CONFLICT` | 409 | illegal state transition, duplicate, idempotency-key replay with a different body |
| `UNPROCESSABLE` | 422 | semantically invalid (e.g. negative net pay, threshold breach surfaced as a hard stop) |
| `RATE_LIMITED` | 429 | gateway/service rate limit |
| `INTERNAL` | 500 | uncaught — message generic, `details` suppressed, full cause logged with `traceId` |
| `DEPENDENCY` | 502/503 | ERP connector or event bus unavailable |

> **Authorization denials never 404 silently for *known-to-the-caller* resources.** A
> PDP `deny` on a resource the caller can otherwise see (wrong action) is `403`. A
> resource **outside the caller's row-scope** is `404` (existence is itself privileged).
> The PEP decides which, based on the obligation returned by the PDP.

---

## 5. List pagination & filtering

Every list endpoint returns the **same** envelope:

```jsonc
{
  "data": [ /* DTOs */ ],
  "meta": { "total": 137, "page": 1, "pageSize": 25 }
}
```

- `page` is **1-based**; `pageSize` defaults to `25`, max `100` (reporting data pulls
  may allow more, documented per-endpoint).
- `total` is the unfiltered-by-page count **after** tenant + row-scope + filters are
  applied — it reflects what *this caller* may see, not the raw table count.
- Query params: `?page=2&pageSize=50&sort=-createdAt` (`-` prefix = descending).

### 5.1 Filter operators

Simple filters go on the query string; complex ones go in a `POST .../search` body. The
operator set is fixed (`FilterOperator` enum), so every service filters the same way:

```jsonc
// POST /expense/v1/expense-reports/search
{
  "filters": [
    { "field": "status",     "op": "in",       "value": ["submitted", "in_approval"] },
    { "field": "totalAmount", "op": "gte",      "value": 50000 },
    { "field": "createdAt",  "op": "between",   "value": ["2026-06-01", "2026-06-30"] },
    { "field": "name",       "op": "contains",  "value": "travel" }
  ],
  "sort": [{ "field": "createdAt", "dir": "desc" }],
  "page": 1,
  "pageSize": 25
}
```

| `op` | Meaning | Value shape |
|---|---|---|
| `eq` / `ne` | equals / not-equals | scalar |
| `lt` / `lte` / `gt` / `gte` | comparisons | scalar |
| `in` / `nin` | set membership | array |
| `between` | inclusive range | `[min, max]` |
| `contains` / `startsWith` | substring (case-insensitive) | string |
| `isNull` | null check | boolean |

The repository layer compiles `filters` into parameterized Sequelize predicates — fields
are validated against an allow-list per resource (no arbitrary column access), and the
tenant predicate + RLS apply underneath regardless of what the caller sends.

---

## 6. Idempotency on money & state writes

Any request that **moves money** or **advances a state machine** must carry
`Idempotency-Key: <uuid>`. Applies to: pay-run `calculate`/`approve`/`disburse`,
expense/invoice `submit`/`approve`, connector `push-transaction`, and
`payroll-inputs`.

Contract:

1. The key + the request fingerprint (method, path, tenant, hashed body) are stored in
   an `idempotency_keys` row (or the domain's own `idempotency_key UNIQUE` column, e.g.
   `payments.idempotency_key`).
2. **Same key + same body** → the original response is replayed (`200`/`201`/`202` as
   first time), no side effect repeats.
3. **Same key + different body** → `409 CONFLICT` (`IDEMPOTENCY_KEY_REUSE`).
4. Keys are tenant-scoped and retained per the domain's window (payments: indefinitely).

```bash
curl -X POST https://api.aegis.internal/payroll/v1/pay-runs/$RUN/disburse \
  -H "Authorization: Bearer $JWT" \
  -H "X-Correlation-Id: $CID" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" -d '{}'
```

---

## 7. `authenticate → authorize → handler` & Joi validation

### 7.1 The wrapper

Every route is composed `authenticate → validate → authorize(permission) → handler`.
Only `/health` and the docs are unauthenticated.

```ts
// controllers use the PEP guard from @aegis/access-control
@controller('/expense/v1/expense-reports')
export class ExpenseReportController {
  constructor(@inject(ExpenseReportService) private svc: ExpenseReportService) {}

  @httpPost(
    '/:id/approve',
    authenticate(),                                   // PEP step 1: identity (JWT)
    validate(ExpenseReportValidators.approve),        // Joi: params + body
    authorize(Permission.ExpenseReportApprove, {      // PEP step 2: PDP decision
      resourceLoader: (req) => ExpenseReportService.loadForPolicy(req.params.id),
    }),
  )
  async approve(@requestParam('id') id: string, @requestBody() body: ApproveDto) {
    return this.svc.approve(id, body);                // handler: pure business logic
  }
}
```

- **`authenticate()`** — verifies the JWT (local symmetric secret; production adapters use JWKS),
  checks `aud`, and populates the `RequestContext` (`tenantId`, `userId`, `roles`). The reference IdP
  now writes/revokes `sessions` rows; per-request session introspection is a production hardening hook.
  Fail → `401`.
- **`authorize(permission, { resourceLoader })`** — the PEP. Loads resource attributes,
  calls the PDP `decide(principal, action, resource, context)`, enforces the verdict,
  and applies **obligations** (e.g. column masking on payroll reads). Fail → `403`
  (or `404` if the obligation hides existence). See
  [`05-authn-authz-flow.md`](05-authn-authz-flow.md).
- **`handler`** — never re-checks authority. By the time it runs, identity, validation,
  and authorization have all passed.

### 7.2 Joi validation

Request shapes live in `validators/` per service (`<area>.validators.ts`). One
`validate(schema)` middleware runs body/query/params through Joi; failures become a
`VALIDATION` error (one envelope entry per invalid field):

```ts
// apps/expense/src/validators/expense-report.validators.ts
import Joi from 'joi';

export const ExpenseReportValidators = {
  create: {
    body: Joi.object({
      name: Joi.string().trim().min(1).max(160).required(),
      reportStartDate: Joi.string().isoDate().required(),
      reportEndDate: Joi.string().isoDate().required(),
      expenses: Joi.array().items(Joi.object({
        amount: Joi.number().integer().min(0).required(),   // minor units
        currency: Joi.string().length(3).uppercase().default('USD'),
        merchant: Joi.string().max(160).required(),
        date: Joi.string().isoDate().required(),
        description: Joi.string().max(500).allow(''),
        categoryId: Joi.string().uuid(),                    // NO GL code — category only
      })).default([]),
    }),
  },
  approve: {
    params: Joi.object({ id: Joi.string().uuid().required() }),
    body: Joi.object({ comment: Joi.string().max(500).allow('') }),
  },
};
```

A validation error envelope:

```jsonc
{
  "errors": [
    { "code": "VALIDATION_ERROR", "type": "VALIDATION",
      "message": "\"reportEndDate\" must be a valid ISO date",
      "details": { "field": "reportEndDate" }, "traceId": "b3a7c2e9-…" }
  ]
}
```

---

## 8. Worked examples

> All examples assume the gateway has already validated the user JWT and minted/forwarded
> `X-Correlation-Id`. `$JWT` is the bearer token, `$CID` a correlation id, `$T` the
> tenant id. Money is in minor units. **No GL codes, no document-extracted line items**
> anywhere; invoice is **header-level**.

### 8.1 user-management — PAP (create role, assign role, list permissions)

**Create a custom role** (`role.create`):

```bash
curl -X POST https://api.aegis.internal/user-management/v1/roles \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "Expense Approver (EU)",
        "description": "Approves expense reports for EU cost centers",
        "permissions": ["expense.report.read", "expense.report.approve"]
      }'
```
```jsonc
// 201 Created
{
  "data": {
    "id": "c1d2e3f4-…", "tenantId": "…", "name": "Expense Approver (EU)",
    "system": false, "permissions": ["expense.report.read", "expense.report.approve"],
    "createdAt": "2026-06-26T10:00:00Z"
  }
}
```

**Assign a role to a user** (`role.assign`) — note the row-level `scope`:

```bash
curl -X POST https://api.aegis.internal/user-management/v1/users/$USER/roles \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Content-Type: application/json" \
  -d '{ "roleId": "c1d2e3f4-…", "scope": "OwnAndTeam" }'
```
```jsonc
// 201 Created
{ "data": { "userId": "…", "roleId": "c1d2e3f4-…", "scope": "OwnAndTeam", "tenantId": "…" } }
```

**List the permission catalog** (`permission.view`, paginated):

```bash
curl "https://api.aegis.internal/user-management/v1/permissions?page=1&pageSize=25" \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID"
```
```jsonc
// 200 OK
{
  "data": [
    { "name": "expense.report.approve", "domain": "expense", "action": "report.approve" },
    { "name": "payroll.payrun.approve",  "domain": "payroll", "action": "payrun.approve" },
    { "name": "role.assign",             "domain": "role",    "action": "assign" }
  ],
  "meta": { "total": 142, "page": 1, "pageSize": 25 }
}
```

### 8.2 access-control — a PDP decision

The PDP is callable directly (used by the gateway, by internal tooling, and to debug a
guard). It returns the verdict + reason + obligations:

```bash
curl -X POST https://api.aegis.internal/access-control/v1/decisions \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Content-Type: application/json" \
  -d '{
        "principal": { "userId": "…", "roles": ["expense-approver-eu"] },
        "action":    "expense.report.approve",
        "resource":  { "type": "expense_report", "id": "8f1c…",
                       "ownerId": "u-77", "amount": 240000, "status": "in_approval" },
        "context":   { "tenantId": "…" }
      }'
```
```jsonc
// 200 OK — allow with an obligation
{
  "data": {
    "allow": true,
    "reason": "RBAC: role grants expense.report.approve; ABAC: amount 240000 <= approvalLimit 500000",
    "obligations": [ { "type": "audit", "intent": "expense.report.approve" } ]
  }
}
```
A `deny` returns `{ "allow": false, "reason": "ABAC: amount exceeds approver limit", "obligations": [] }`;
the calling PEP turns that into a `403`.

### 8.3 expense — create report → submit → approve (no GL codes)

**Create** (`expense.report.create`):

```bash
curl -X POST https://api.aegis.internal/expense/v1/expense-reports \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "Berlin offsite — June",
        "reportStartDate": "2026-06-10", "reportEndDate": "2026-06-12",
        "expenses": [
          { "amount": 18500, "currency": "EUR", "merchant": "Hotel Mitte",
            "date": "2026-06-10", "description": "2 nights", "categoryId": "cat-lodging" }
        ]
      }'
```
```jsonc
// 201 Created
{ "data": { "id": "8f1c…", "status": "open", "totalAmount": 18500, "currency": "EUR",
            "reportNumber": "EXP-2026-0044", "createdAt": "2026-06-26T10:05:00Z" } }
```

**Submit** (`expense.report.submit`, state `open → in_approval`, idempotent):

```bash
curl -X POST https://api.aegis.internal/expense/v1/expense-reports/8f1c…/submit \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" -d '{}'
```
```jsonc
// 200 OK
{ "data": { "id": "8f1c…", "status": "in_approval", "submittedAt": "2026-06-26T10:06:00Z" } }
```

**Approve** (`expense.report.approve`, ABAC threshold applies):

```bash
curl -X POST https://api.aegis.internal/expense/v1/expense-reports/8f1c…/approve \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{ "comment": "Within policy" }'
```
```jsonc
// 200 OK
{ "data": { "id": "8f1c…", "status": "approved", "approvedAt": "2026-06-26T10:07:00Z",
            "approverId": "u-approver" } }
```
A non-approver, or an amount over the approver's limit, returns `403`/`422` with the
standard envelope; re-approving returns `409 CONFLICT` (`INVALID_STATE_TRANSITION`).

### 8.4 payroll — create pay-run → calculate → approve (maker-checker) → disburse

**Create draft pay-run** (`payroll.payrun.create`):

```bash
curl -X POST https://api.aegis.internal/payroll/v1/pay-runs \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{ "payCalendarId": "cal-monthly", "periodStart": "2026-06-01",
        "periodEnd": "2026-06-30", "payDate": "2026-07-01", "type": "regular" }'
```
```jsonc
// 201 Created
{ "data": { "id": "run-9", "status": "draft", "type": "regular", "createdBy": "u-processor" } }
```

**Calculate** (`payroll.payrun.calculate`, `draft → calculated`):

```bash
curl -X POST https://api.aegis.internal/payroll/v1/pay-runs/run-9/calculate \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" -d '{}'
```
```jsonc
// 202 Accepted — heavy calc runs async; poll the run
{ "data": { "id": "run-9", "status": "calculating" } }
```

**Approve** (`payroll.payrun.approve`, `calculated → approved`) — **maker-checker is
enforced in the PDP**: the approver must differ from the run's creator/editor.

```bash
curl -X POST https://api.aegis.internal/payroll/v1/pay-runs/run-9/approve \
  -H "Authorization: Bearer $APPROVER_JWT" -H "X-Correlation-Id: $CID" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" -d '{}'
```
```jsonc
// 200 OK — calculation snapshotted, run locked
{ "data": { "id": "run-9", "status": "approved", "approvedBy": "u-approver", "approvedAt": "…" } }
```
If `approvedBy == createdBy`, the PDP denies and the PEP returns:
```jsonc
// 403 Forbidden
{ "errors": [ { "code": "SEGREGATION_OF_DUTIES", "type": "FORBIDDEN",
  "message": "The pay-run approver must differ from its editor", "traceId": "…" } ] }
```

**Disburse** (`payroll.payrun.disburse`, `approved → funding`, idempotent, append-only
ledger):

```bash
curl -X POST https://api.aegis.internal/payroll/v1/pay-runs/run-9/disburse \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" -d '{}'
```
```jsonc
// 202 Accepted — payment batch + ledger entries created; net is masked unless caller may read it
{ "data": { "id": "run-9", "status": "funding", "paymentBatchId": "batch-3", "payslipCount": 214 } }
```

### 8.5 invoice — create → detect-duplicate → approve (header-level only)

Invoice is **header-level**: no line items, no GL codes. "Matching" = duplicate detection
(vendor + invoice number + amount) + threshold/variance vs an optional PO reference.

**Create** (`invoice.create`):

```bash
curl -X POST https://api.aegis.internal/invoice/v1/invoices \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{
        "vendorName": "Northwind Supplies",
        "invoiceNumber": "NW-5582",
        "amount": 1240000, "currency": "USD",
        "invoiceDate": "2026-06-20", "dueDate": "2026-07-20",
        "poReference": "PO-3391"
      }'
```
```jsonc
// 201 Created
{ "data": { "id": "inv-12", "status": "received", "vendorName": "Northwind Supplies",
            "invoiceNumber": "NW-5582", "amount": 1240000, "currency": "USD" } }
```

**Detect duplicates** (`invoice.duplicate.detect`) — header-level reconciliation:

```bash
curl -X POST https://api.aegis.internal/invoice/v1/invoices/inv-12/detect-duplicate \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Content-Type: application/json" -d '{}'
```
```jsonc
// 200 OK — a likely duplicate + a PO variance flag
{
  "data": {
    "invoiceId": "inv-12",
    "duplicates": [
      { "invoiceId": "inv-04", "score": 0.97,
        "matchedOn": ["vendorName", "invoiceNumber", "amount"] }
    ],
    "poVariance": { "poReference": "PO-3391", "poAmount": 1200000,
                    "invoiceAmount": 1240000, "variance": 40000,
                    "withinThreshold": false }
  }
}
```

**Approve** (`invoice.approve`, threshold-routed):

```bash
curl -X POST https://api.aegis.internal/invoice/v1/invoices/inv-12/approve \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" \
  -d '{ "comment": "Variance accepted — freight surcharge" }'
```
```jsonc
// 200 OK
{ "data": { "id": "inv-12", "status": "approved", "approvedAt": "…", "approverId": "u-ap" } }
```
A confirmed duplicate, or a variance over the per-tenant threshold without override
authority, returns `409`/`422` with the standard envelope.

### 8.6 workflow — create a rule

Rules are data: ordered conditions (`{field, operator, value, conjunction}`) + actions,
triggered by domain events (`workflow.rule.create`).

```bash
curl -X POST https://api.aegis.internal/workflow/v1/rules \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "Escalate large expense approvals",
        "trigger": "expense.report.submitted",
        "steps": [
          { "field": "totalAmount", "operator": "gte", "value": 500000, "conjunction": "AND" },
          { "field": "currency",    "operator": "eq",  "value": "USD" }
        ],
        "actions": [
          { "type": "route_approval", "params": { "approverGroup": "finance-directors" } },
          { "type": "notify", "params": { "template": "large_expense_submitted" } }
        ],
        "enabled": true
      }'
```
```jsonc
// 201 Created
{ "data": { "id": "rule-7", "trigger": "expense.report.submitted", "enabled": true,
            "stepCount": 2, "actionCount": 2 } }
```

### 8.7 reporting — create a report-run (async) → list/poll → export

Generation is async: `POST` returns `202 + runId`; the client lists/polls run status, then
fetches the artifact URL once the run succeeds. Access-scope is part of the run, so masked
columns never appear for callers who lack them (`report.run` to create, `report.view` to read).

```bash
curl -X POST https://api.aegis.internal/reporting/v1/report-runs \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Content-Type: application/json" \
  -d '{ "definitionId": "def-expense-by-dept",
        "params": { "period": "2026-06", "department": "engineering" } }'
```
```jsonc
// 202 Accepted
{ "data": { "runId": "rr-31", "status": "queued" } }
```

**List runs / poll** (`report.view`):

```bash
curl "https://api.aegis.internal/reporting/v1/report-runs?page=1&pageSize=20&status=succeeded" \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID"

curl https://api.aegis.internal/reporting/v1/report-runs/rr-31 \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID"
```
```jsonc
// 200 OK
{ "data": { "runId": "rr-31", "status": "succeeded",
            "finishedAt": "2026-06-26T10:12:00Z",
            "artifactUrl": "https://artifacts.aegis.local/reporting/exports/rr-31.csv" } }
```

**Fetch export URL**:

```bash
curl "https://api.aegis.internal/reporting/v1/report-runs/rr-31/export" \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID"
```
```jsonc
// 200 OK
{ "data": { "runId": "rr-31", "status": "succeeded",
            "artifactUrl": "https://artifacts.aegis.local/reporting/exports/rr-31.csv" } }
```
If the run is still queued/running, the export lookup returns `409` with the standard error
envelope. Streamed data pages and multi-format renderers are production-worker upgrade seams.

### 8.8 connectors — configure ERP connector bindings & inspect sync state

ERP integration is the pluggable `@aegis/connectors` framework with **mock** connectors
(`LedgerOne`, `Finovo`, `AcctBridge`). Outbound auth is per-connector; pushes are
idempotent. See [`services/connectors.md`](services/connectors.md).

**Configure a connector** (`connector.manage`):

```bash
curl -X PUT https://api.aegis.internal/workflow/v1/connectors/ledger_one \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Content-Type: application/json" \
  -d '{
        "active": true,
        "baseUrl": "https://mock-connectors.aegis.local/ledger_one",
        "credentialsRef": "/aegis/prod/connectors/ledger_one",
        "settings": { "environment": "sandbox" }
      }'
```
```jsonc
// 200 OK — secret is referenced, never echoed
{ "id": "cfg-2", "kind": "ledger_one", "active": true,
  "baseUrl": "https://mock-connectors.aegis.local/ledger_one",
  "credentialsRef": "/aegis/prod/connectors/ledger_one",
  "settings": { "environment": "sandbox" } }
```

**Inspect sync state** (`connector.push`):

```bash
curl https://api.aegis.internal/workflow/v1/connectors/sync-state?kind=ledger_one \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID"
```
```jsonc
// 200 OK
{ "data": [
    { "kind": "ledger_one", "entity": "invoice", "recordId": "inv-12",
      "idempotencyKey": "inv-12", "status": "synced", "externalId": "ledger_one-inv-12" }
  ],
  "meta": { "total": 1, "page": 1, "pageSize": 50 } }
```
There is intentionally no public "push arbitrary transaction" endpoint. Expense, invoice, and
payroll stage `connector.push.requested` events inside the same transaction as the approved/paid
business write. The workflow worker performs the push, and durable sync-state makes a replay of the
same idempotency key a no-op.

**Reconcile queued/in-progress sync state** (`connector.push`):

```bash
curl -X POST https://api.aegis.internal/workflow/v1/connectors/reconcile \
  -H "Authorization: Bearer $JWT" -H "X-Correlation-Id: $CID" \
  -H "Content-Type: application/json" \
  -d '{ "limit": 100 }'
```
```jsonc
// 202 Accepted
{ "data": { "limit": 100, "advanced": 3 } }
```

This operator endpoint is tenant-scoped. The future automated scheduler will drive the same
reconcile path for each tenant context.

---

## 9. Checklist for a new endpoint

- [ ] Path follows `/<service>/v1/<collection>` (state changes are `POST .../<action>`).
- [ ] Wrapped `authenticate → validate → authorize(permission) → handler`; permission is
      a dotted `domain.action` from the catalog.
- [ ] Joi schema in `validators/`; tenant/userId come from context, not the body.
- [ ] Response is an explicit DTO; lists return `{ data, meta: { total, page, pageSize } }`.
- [ ] Money writes / state transitions require `Idempotency-Key`.
- [ ] Errors raised via `ErrorUtils` (typed) → the one envelope; correct `ErrorType`.
- [ ] Headers referenced via `HttpHeaderKey`; `X-Correlation-Id` propagated on any
      outbound hop.
- [ ] Audit emitted on writes; no GL codes / line items; invoice stays header-level.
