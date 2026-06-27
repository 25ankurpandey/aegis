# invoice — Service Reference

> The **invoice** service owns the lifecycle of an accounts-payable invoice as a
> **header-level** business document: receipt, validation, duplicate detection,
> threshold/variance reconciliation against an optional purchase-order reference,
> multi-level approval routing, and push of approved invoices to an ERP of record
> through the [`@aegis/connectors`](../../libs/connectors) framework.
>
> This file is consistent with [`SPEC.md`](../../SPEC.md) — in particular
> [§5 (Data model)](../../SPEC.md#5-data-model-high-level--see-docs07-data-modelsmd-for-full)
> and **[§10 Amendments — 2026-06-26](../../SPEC.md#10-amendments--2026-06-26)**. Where this
> document and `SPEC.md` disagree, **`SPEC.md` wins**.
>
> Related: [`07-data-models.md`](../07-data-models.md) ·
> [`03-access-control-model.md`](../03-access-control-model.md) ·
> [`05-authn-authz-flow.md`](../05-authn-authz-flow.md) ·
> [`06-service-to-service.md`](../06-service-to-service.md) ·
> [`08-api-conventions.md`](../08-api-conventions.md) ·
> sibling services [`expense.md`](expense.md), [`workflow.md`](workflow.md),
> [`notification.md`](notification.md).

---

## 0. Scope — read this first

Invoice in Aegis is deliberately **header-level**. This is the single most important
thing to understand before reading the model.

**What invoice IS:**

- A status-driven document with a small set of **header** fields (vendor, invoice number,
  dates, total amount, currency, an optional PO reference, transaction type).
- **Duplicate detection** over the `(vendor, invoice_number, amount)` signature.
- **Threshold / variance reconciliation**: the header total vs an _optional_ PO-reference
  amount and per-tenant tolerance/auto-approval limits.
- **Approval routing** through the shared approval engine (multi-level, threshold-gated).
- **ERP push** of the approved header via pluggable connectors.

**What invoice is explicitly NOT (per [§10.1](../../SPEC.md#101-scope-removals)):**

- ❌ **No line items.** There is no `invoice_line_items` table and no per-line storage.
- ❌ **No line-item matching / no 3-way match.** We do **not** reconcile invoice lines to
  PO lines to receipt lines. There is no `invoice_match_groups`, no `match_items`.
- ❌ **No GL codes / no coding** of the document or any line.
- ❌ **No OCR / document-extraction pipeline.** Header fields are entered through the API
  (or imported via an upstream system), not extracted from a scanned document.

> **"Matching", reframed.** The reference accounts-payable platform this domain is
> distilled from performed **line-level 3-way matching** (invoice line ↔ PO line ↔ receipt
> line, with GL coding and discrepancy buckets). Aegis does **not** do that. In Aegis,
> "matching" means three header-level checks only — **(1) duplicate detection**,
> **(2) threshold/variance vs an optional PO-reference amount + per-tenant limits**, and
> **(3) approval routing**. Whenever you see "matching" in this service, read it as
> _header-level reconciliation_, never line matching. See [§4](#4-matching-reframed).

---

## 1. Responsibility

| Concern                                                             | invoice owns it?  | Notes                                                                                                          |
| ------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Invoice header lifecycle / state machine                            | ✅                | `invoices.status`, see [§3](#3-lifecycle--state-machine).                                                      |
| Header metadata (number, dates, PO ref, amount, currency, txn type) | ✅                | `invoice_metadata`, 1:1 with the invoice.                                                                      |
| Duplicate detection                                                 | ✅                | `invoice_duplicates`, signature `(vendor, invoice_number, amount)`.                                            |
| Threshold / variance reconciliation                                 | ✅                | header amount vs optional PO ref + per-tenant limits.                                                          |
| Auto-approval gating invariants                                     | ✅                | see [§5](#5-gating-invariants-that-block-auto-approval).                                                       |
| Approval **routing decision**                                       | ✅                | invoice asks the shared engine _who is next_.                                                                  |
| Approval **chain definition + vote storage**                        | shared            | `approval_*` tables live in the shared approval domain ([§6](#6-approval-shared-engine--multi-level-routing)). |
| ERP push of approved invoices                                       | ✅ (orchestrates) | via [`@aegis/connectors`](../../libs/connectors), see [§7](#7-erp-push-via-aegisconnectors).                   |
| Identity / roles / permissions                                      | ❌                | owned by **user-management** (PAP).                                                                            |
| Notifications (in-app/email)                                        | ❌                | **notification** consumes invoice events.                                                                      |
| Workflow rules (tag/route/auto-approve policy)                      | ❌                | **workflow** consumes invoice events and may call back.                                                        |
| Tenant isolation                                                    | shared substrate  | every table is `tenant_id NOT NULL` + RLS (see [`04-multi-tenancy.md`](../04-multi-tenancy.md)).               |

The service follows the standard per-service internal layout (`controllers/services/
repositories/models/interfaces/validators/constants/ioc`), is wired on Express +
InversifyJS, shares [`@aegis/service-core`](../../libs/service-core) and
[`@aegis/access-control`](../../libs/access-control), and emits hash-chained audit on
every write (see [`02-patterns.md`](../02-patterns.md)).

---

## Local Development

How to run, extend, and test **this** service on your machine. Invoice listens on
**HTTP port 4007** and is wired through the Nx `serve`/`build`/`test` targets in
[`apps/invoice/project.json`](../../apps/invoice/project.json).

### Prerequisites

- **Node 22 + npm**, **Docker** (for the Postgres/Redis/Kafka infra).
- Install the workspace once from the **repo root**: `npm ci`.

### 1. Bring up the infra (Postgres + Redis + Kafka)

Invoice needs Postgres (RLS-scoped data + the casbin policy store), Redis (cache +
policy-watcher), and Kafka (event bus / outbox relay). Two ways to get there:

**(a) Whole stack** — build every service image and start everything, then develop
against it:

```bash
bash scripts/setup.sh
```

**(b) Just the infra** — leave the app containers down and run only invoice from your
shell:

```bash
docker compose -f docker-compose.all.yml up -d postgres redis kafka
# run the schema/seed migrations once against the fresh DB:
docker compose -f docker-compose.all.yml run --rm migrate
```

### 2. Run this service with hot-reload

```bash
npx nx serve invoice
```

The `serve` target uses the `@nx/js:node` executor over `invoice:build`, so it rebuilds
and restarts on source changes.

> **CRITICAL GOTCHA — the committed `.env` uses Docker-network hostnames.**
> [`apps/invoice/.env`](../../apps/invoice/.env) points at compose **service names**
> (`postgres:5432`, `redis:6379`, `kafka:9092`, `user-management:4001`, `gateway:4000`,
> …). Those names only resolve **inside** the docker network. When you run `nx serve`
> from your host they will not resolve and the service fails to connect. For local runs,
> override them to the docker-**published host ports** on `127.0.0.1` (e.g. a local
> `.env.local` / shell exports / your run config):
>
> ```bash
> DATABASE_URL=postgres://aegis_app:aegis_app_pw@127.0.0.1:5432/aegis
> REDIS_URL=redis://127.0.0.1:6379
> KAFKA_BROKERS=127.0.0.1:9092
> GATEWAY_URL=http://127.0.0.1:4000
> USER_MANAGEMENT_URL=http://127.0.0.1:4001
> # …and any other inter-service URL you actually call, rewritten host:port:
> # EXPENSE_URL / PAYROLL_URL / REPORTING_URL / WORKFLOW_URL /
> # NOTIFICATION_URL / INVOICE_URL / JWKS_URL → http://127.0.0.1:<port>
> ```
>
> **Vars in this service's `.env` that need the localhost rewrite** (every value that is
> a docker hostname): `DATABASE_URL`, `REDIS_URL`, `KAFKA_BROKERS`, `JWKS_URL`,
> `GATEWAY_URL`, `USER_MANAGEMENT_URL`, `EXPENSE_URL`, `PAYROLL_URL`, `REPORTING_URL`,
> `WORKFLOW_URL`, `NOTIFICATION_URL`, `INVOICE_URL`. The non-URL vars (`PORT`,
> `AUTH_JWT_SECRET`, `INTERNAL_JWT_SECRET`, `FIELD_ENCRYPTION_KEY`, `*_ENV`,
> `PROCESS_TYPE`, etc.) work as committed.

### 3. Verify it's up

The service exposes a health endpoint on its own port:

```bash
curl localhost:4007/health
```

In normal use you don't hit `:4007` directly — traffic comes **through the gateway** at
`http://localhost:4000/invoice/v1/...`, and invoice still re-validates the caller via its
own PEP ([§9](#9-access-control)). The direct port is for local dev / health checks.

### 4. Runtime dependencies

What invoice talks to at runtime (drives what must be up locally):

- **Postgres** (`DATABASE_URL`, required) — domain tables + RLS, and the casbin policy
  store read by `@aegis/access-control`.
- **Redis** (`REDIS_URL`) — cache adapter + the access-control policy watcher.
- **Kafka** (`KAFKA_BROKERS`) — the `@aegis/events` bus. When `KAFKA_BROKERS` is **unset**
  the lib falls back to an **in-process bus** (single-process dev works with no broker);
  when set, the in-process outbox relay drains staged events to Kafka.
- **Token validation** — the PEP verifies the bearer JWT with the shared **HS256
  `AUTH_JWT_SECRET`** (`AUTH_JWT_SECRET` is `requireAll`'d at startup). `JWKS_URL` /
  user-management is the token issuer in the platform topology.
- **Inter-service HTTP** — via `@aegis/service-core`'s typed http-client, resolved from
  the `*_URL` env vars (gateway, user-management, expense, payroll, reporting, workflow,
  notification).
- **ERP connectors** — `registerBuiltinConnectors()` from
  [`@aegis/connectors`](../../libs/connectors) wires the **mock** ERP targets
  (`LedgerOne` / `Finovo` / `AcctBridge`); no real ERP is contacted locally ([§7](#7-erp-push-via-aegisconnectors)).

**Worker role.** `PROCESS_TYPE=worker` (vs the default `api`) starts the **consumer-only**
half (no HTTP server): it `requireAll(['DATABASE_URL','AUTH_JWT_SECRET','KAFKA_BROKERS'])`
and registers the `ApprovalCompleted` consumer (stranded-record recovery) and the
`RecordUpdated` consumer (`assign_team` / `add_tag`). A worker **must** have a real Kafka
broker. See [`bootstrap.ts`](../../apps/invoice/src/bootstrap.ts).

### 5. Test + build

```bash
npx nx test invoice    # Jest (apps/invoice/jest.config.ts)
npx nx build invoice   # @nx/webpack:webpack, target=node, compiler=tsc
```

The `build` target compiles with `tsc`, so it runs the **production type-check** — use it
to catch type errors the dev `serve` loop may tolerate.

---

## 2. Domain model

All money is stored as **integer minor units** (`amount_minor BIGINT`) plus an ISO-4217
`currency CHAR(3)` — never floats. All PKs are UUID v4; every table is tenant-scoped
(`tenant_id NOT NULL` + RLS). Physical table names come from the `TableName` enum in
[`@aegis/shared-enums`](../../libs/shared/enums); status strings mirror
`invoice.enum.ts`.

### 2.1 Tables (header-level only)

| Table (`TableName`)  | Cardinality         | Purpose                                                                      |
| -------------------- | ------------------- | ---------------------------------------------------------------------------- |
| `invoices`           | aggregate root      | Status state machine + denormalized vendor + financial summary.              |
| `invoice_metadata`   | 1:1 with `invoices` | Header attributes: number, dates, PO ref, txn type, amount, currency.        |
| `invoice_duplicates` | 0..N per invoice    | Detected duplicate links (this invoice ↔ a prior one) + signature + verdict. |
| `invoice_approvals`  | 0..N per invoice    | Per-level approval _votes_ recorded against this invoice.                    |
| `invoice_activities` | append-only         | Immutable activity timeline (audit/UX), no `updated_at`.                     |

> There is **no `invoice_line_items` and no `invoice_match_groups`** — by design
> ([§0](#0-scope--read-this-first)).

### 2.2 `invoices` (aggregate root)

```ts
// models/invoice.model.ts (shape)
interface InvoiceAttributes {
  id: string; // uuid v4
  tenant_id: string; // uuid — RLS key, NOT NULL
  vendor_id: string; // uuid — supplier (denormalized vendor_name for display)
  vendor_name: string;
  status: InvoiceStatus; // state machine, see §3
  amount_minor: bigint; // header TOTAL, integer minor units
  currency: string; // ISO-4217, CHAR(3)
  po_reference: string | null; // OPTIONAL purchase-order header ref (free text/id, NOT a line link)
  auto_approved: boolean; // true when AutoApproved by policy (vs human ForApproval→Approved)
  auto_approved_by: AutoApprovedBy | null; // WORKFLOW | SYSTEM
  approval_policy_id: string | null; // bound shared approval policy snapshot ref
  submitted_by: string | null; // user id who moved it ForApproval
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null; // soft delete
}
```

`amount_minor` is the **header total**; there is no per-line summation because there are
no lines. `po_reference` is an **optional header string** (e.g. a PO number/id) used only
by the variance check in [§4.2](#42-thresholdvariance-vs-an-optional-po-reference) — it is
_not_ a foreign key into PO lines and carries no line data.

### 2.3 `invoice_metadata` (1:1 header attributes)

```ts
interface InvoiceMetadataAttributes {
  id: string;
  tenant_id: string;
  invoice_id: string; // uuid, UNIQUE → 1:1 with invoices
  invoice_number: string; // vendor's invoice number (part of dup signature)
  invoice_date: Date; // date on the invoice
  due_date: Date | null; // payment due date
  po_reference: string | null; // mirror of the optional PO header ref (kept with metadata)
  transaction_type: InvoiceTransactionType; // 'debit' | 'credit'
  amount_minor: bigint; // header amount as stated on the document
  currency: string; // ISO-4217
  created_at: Date;
  updated_at: Date;
}
```

We keep the human-facing header attributes here, separate from the lifecycle/aggregate
row, so the state machine table stays lean. `(invoice_number, vendor_id, amount_minor)` is
the **duplicate signature** consumed by [§4.1](#41-duplicate-detection).

### 2.4 `invoice_duplicates`

```ts
interface InvoiceDuplicateAttributes {
  id: string;
  tenant_id: string;
  invoice_id: string; // the invoice under validation
  duplicate_of_invoice_id: string; // the earlier invoice it collides with
  signature: string; // hash of (vendor_id|invoice_number|amount_minor|currency)
  match_type: DuplicateMatchType; // 'exact' | 'probable'
  status: DuplicateStatus; // 'flagged' | 'confirmed' | 'dismissed'
  resolved_by: string | null; // user id who confirmed/dismissed
  created_at: Date;
  updated_at: Date;
}
```

### 2.5 `invoice_approvals`

Per-invoice approval **votes** recorded as the shared engine advances the chain. The chain
_definition_ (policies, hierarchy levels, approver groups, thresholds) lives in the shared
approval domain ([§6](#6-approval-shared-engine--multi-level-routing)); this table is the
invoice-local projection of each decision so the invoice aggregate is self-describing.

```ts
interface InvoiceApprovalAttributes {
  id: string;
  tenant_id: string;
  invoice_id: string;
  approver_user_id: string;
  approval_level: number; // which hierarchy level this vote satisfied
  decision: ApprovalDecision; // 'approved' | 'rejected'
  comment: string | null;
  active: boolean; // false when superseded by a re-route/reset
  created_at: Date;
  updated_at: Date;
}
```

### 2.6 `invoice_activities` (append-only)

Immutable timeline (`created_at` only, no `updated_at`) — the per-domain audit feed for
the invoice aggregate, complementing the platform `audit_log`.

```ts
interface InvoiceActivityAttributes {
  id: string;
  tenant_id: string;
  invoice_id: string;
  actor_user_id: string | null; // null = system/automation
  activity_type: InvoiceActivityType; // e.g. Received, MarkedDuplicate, MovedForApproval, Approved...
  details: Record<string, unknown>; // JSONB template payload
  correlation_id: string; // X-Correlation-Id of the originating request
  created_at: Date;
}
```

`activity_type` mirrors an `InvoiceActivityType` enum with a `*Display` template map (e.g.
`MarkedDuplicate = 'flagged as a possible duplicate of {duplicate_of}'`), following the
`@aegis/shared-enums` display idiom.

---

## 3. Lifecycle / state machine

The invoice header advances through an explicit status state machine
(`invoices.status`, mirrored by `InvoiceStatus` in `invoice.enum.ts`). Transitions are
guarded by the gating invariants in [§5](#5-gating-invariants-that-block-auto-approval) and
emit an `invoice_activities` row plus a domain event on every hop.

```mermaid
stateDiagram-v2
    [*] --> Received
    Received --> Validating : submit / import accepted

    Validating --> Duplicate : duplicate signature confirmed
    Validating --> PendingReview : variance over tolerance / missing PO ref / blocking issue
    Validating --> ForApproval : passes checks, human approval required
    Validating --> AutoApproved : passes checks AND auto-approval policy satisfied

    PendingReview --> ForApproval : reviewer clears the issue
    PendingReview --> Cancelled : reviewer abandons
    PendingReview --> Rejected : reviewer rejects

    ForApproval --> Approved : final approval level satisfied
    ForApproval --> Rejected : any approver rejects
    ForApproval --> Cancelled : withdrawn before completion

    Duplicate --> Cancelled : confirmed duplicate, discarded
    Duplicate --> Validating : duplicate dismissed (re-validate)

    AutoApproved --> Approved : recorded as approved (no human step)

    Approved --> [*]
    AutoApproved --> [*]
    Rejected --> [*]
    Cancelled --> [*]
```

| Status          | Meaning                                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `Received`      | Header captured (via API or import); nothing validated yet.                                                                       |
| `Validating`    | Running header-level checks: duplicate detection + threshold/variance.                                                            |
| `Duplicate`     | Flagged as a probable/exact duplicate; awaiting confirm/dismiss.                                                                  |
| `PendingReview` | A blocking issue (variance over tolerance, missing required PO ref, open status issue) needs human clearing before approval.      |
| `ForApproval`   | Passed validation; routed into the shared multi-level approval chain.                                                             |
| `Approved`      | All required approval levels satisfied (human path).                                                                              |
| `AutoApproved`  | Auto-approved by policy because every gating invariant passed and it sat under the auto-approval limit (no human level required). |
| `Rejected`      | An approver/reviewer rejected the invoice. Terminal.                                                                              |
| `Cancelled`     | Withdrawn / discarded (e.g. confirmed duplicate). Terminal.                                                                       |

> **Transitions are orchestrated explicitly** in the service layer (no FSM library): each
> mutator calls a `transition(invoice, to, reason)` helper that asserts the edge is legal
> against a `LEGAL_TRANSITIONS` map, writes the `invoice_activities` row, and publishes the
> matching event. Illegal edges raise a typed `InvalidTransitionError` →
> `{ errors: [{ code, type, message, details, traceId }] }`.

---

## 4. "Matching", reframed

This is the core reinterpretation. The donor platform did **line-level 3-way matching**;
Aegis replaces it with three **header-level** checks. There is no line data, no GL coding,
no receipt reconciliation.

### 4.1 Duplicate detection

When an invoice enters `Validating`, the service computes a **signature** over
`(vendor_id, invoice_number, amount_minor, currency)` and looks for a prior tenant-scoped
invoice with the same signature.

```ts
function duplicateSignature(m: InvoiceMetadataAttributes, vendorId: string): string {
  // normalize: trim/upper invoice_number, exact vendor + minor-unit amount + currency
  return sha256(`${vendorId}|${normalize(m.invoice_number)}|${m.amount_minor}|${m.currency}`);
}
```

- An **exact** signature collision → `match_type = 'exact'`, status → `Duplicate`, an
  `invoice_duplicates` row is written (`status = 'flagged'`), and an
  `invoice.duplicate.flagged` event is emitted.
- A **probable** collision (same vendor + invoice_number, amount within a small tolerance)
  → `match_type = 'probable'`, routed to `PendingReview`.
- A human **confirms** (→ `Cancelled`) or **dismisses** (→ back to `Validating`).

Detection runs inside the validation transaction and is itself a gating invariant
([§5](#5-gating-invariants-that-block-auto-approval)): an invoice with a `flagged` or
`confirmed` duplicate can never auto-approve.

### 4.2 Threshold / variance vs an optional PO reference

The invoice header carries an **optional** `po_reference` (a PO number/id string) plus the
header `amount_minor`. The variance check is **header-amount-to-header-amount**, never
line-to-line:

1. If a `po_reference` is present and resolvable to a PO **header amount** (via an
   upstream procurement source or an imported reference value), compute
   `variance = |invoice.amount_minor − po.amount_minor|`.
2. Compare against the **per-tenant limits** held in tenant configuration:

```ts
interface TenantInvoiceLimits {
  variance_tolerance_minor: bigint; // absolute tolerance on amount vs PO ref
  variance_tolerance_pct: number; // OR a percentage tolerance (whichever applies)
  auto_approve_under_minor: bigint; // amounts strictly under this may auto-approve
  require_po_over_minor: bigint; // amounts at/over this MUST carry a PO reference
}
```

- `variance` within tolerance **and** `amount_minor < auto_approve_under_minor` **and** all
  other invariants pass → eligible for `AutoApproved`.
- `variance` over tolerance, **or** `amount_minor ≥ require_po_over_minor` with no
  `po_reference`, **or** a missing/unresolved PO ref where one is required → `PendingReview`.
- Otherwise → `ForApproval` (human chain).

> If no `po_reference` is supplied and the amount is below `require_po_over_minor`, the PO
> variance step is simply **skipped** — a PO reference is optional, not mandatory. The
> auto-approval/threshold logic still applies on the header amount alone.

### 4.3 Approval routing

When checks resolve to `ForApproval`, the invoice asks the **shared approval engine**
([§6](#6-approval-shared-engine--multi-level-routing)) "_who is the next approver for this
header amount, currency, and tenant policy?_" and routes accordingly. Routing is purely a
function of the header `amount_minor` + `currency` + the bound approval policy thresholds —
there are no line-level approvers.

```mermaid
flowchart TD
    A[Received] --> B[Validating]
    B --> C{Duplicate signature?}
    C -- exact --> D[Duplicate -> confirm/dismiss]
    C -- none/dismissed --> E{Variance vs optional PO ref<br/>within per-tenant tolerance?}
    E -- over tolerance / missing required PO --> F[PendingReview]
    E -- within tolerance --> G{All gating invariants pass<br/>AND amount < auto-approve limit?}
    G -- yes --> H[AutoApproved -> Approved]
    G -- no --> I[ForApproval: route via shared engine]
    F --> I
    I --> J{Final level satisfied?}
    J -- yes --> K[Approved]
    J -- rejected --> L[Rejected]
    K --> M[ERP push via @aegis/connectors]
    H --> M
```

---

## 5. Gating invariants that block auto-approval

Auto-approval is the riskiest transition, so it is fail-closed: an invoice may move to
`AutoApproved` **only if every one of the following holds**. If any fails, it falls back to
`ForApproval` or `PendingReview` (never silently approved):

1. **No open duplicate.** No `invoice_duplicates` row in `flagged` or `confirmed` state for
   this invoice ([§4.1](#41-duplicate-detection)).
2. **Variance within tolerance.** Where a PO reference applies, the header amount is within
   the tenant's `variance_tolerance_*` ([§4.2](#42-thresholdvariance-vs-an-optional-po-reference)).
3. **PO reference present when required.** If `amount_minor ≥ require_po_over_minor`, a
   `po_reference` must be present and resolvable.
4. **Under the auto-approval limit.** `amount_minor < auto_approve_under_minor` for the
   tenant.
5. **No blocking review issue.** No unresolved `PendingReview` condition.
6. **Valid status edge.** The current status legally permits `→ AutoApproved`
   (`Validating` only).

```ts
function canAutoApprove(inv: Invoice, ctx: ValidationContext): boolean {
  return (
    !ctx.hasOpenDuplicate &&
    ctx.varianceWithinTolerance &&
    ctx.poReferencePresentIfRequired &&
    inv.amount_minor < ctx.limits.auto_approve_under_minor &&
    !ctx.hasBlockingReviewIssue &&
    isLegalTransition(inv.status, InvoiceStatus.AutoApproved)
  );
}
```

These invariants are evaluated by the PDP-backed service logic and re-asserted at the
transition boundary, so a bug in one path cannot smuggle an unverified invoice into
`AutoApproved`.

---

## 6. Approval (shared engine + multi-level routing)

Invoice does **not** implement its own approval chain. It uses the **shared approval
domain** described in [`SPEC.md` §5](../../SPEC.md#5-data-model-high-level--see-docs07-data-modelsmd-for-full)
and detailed in [`07-data-models.md`](../07-data-models.md), the same engine expense and
payroll use:

| Shared table                                 | Role                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `approval_policies`                          | Named, per-tenant, currency-aware policy; `is_default`; optionally bound per-record.                                  |
| `approval_hierarchy(level)`                  | The **ordered levels** of a policy.                                                                                   |
| `approver_groups` / `approver_group_members` | Approvers as a polymorphic union — **user / role / team / persona** (e.g. record owner, manager) resolved at runtime. |
| `record_approvers(threshold)`                | Threshold gating: `None` / `MoreThan` / `Between` over the (currency-converted) amount.                               |
| `approvals`                                  | The canonical vote rows (invoice mirrors active votes into `invoice_approvals`).                                      |
| `approval_progress_log`                      | Per-level `entered_at` / `exited_at` time-in-level tracking.                                                          |

The **next-approver resolver** walks the policy's hierarchy levels in order, skips levels
already satisfied, applies each approver's threshold against the header amount (with
multi-currency conversion), and returns the first unsatisfied level's approvers — excluding
anyone who already voted. The invoice binds the resolved policy id into
`invoices.approval_policy_id` (a snapshot reference) so re-routing is deterministic and
auditable.

```mermaid
sequenceDiagram
    participant C as Controller (PEP)
    participant S as InvoiceService
    participant AE as Approval engine (shared)
    participant EV as @aegis/events
    C->>S: approve(invoiceId, decision, comment)
    S->>AE: recordVote + resolveNextApprover(amount, currency, policy)
    AE-->>S: { complete?, nextApprovers[] }
    S->>S: write invoice_approvals + invoice_activities
    alt chain complete
        S->>S: transition ForApproval -> Approved
        S->>EV: publish invoice.approved
    else more levels
        S->>EV: publish invoice.for_next_approval
    end
```

`invoice.for_next_approval` and `invoice.approved` are consumed by **notification**
(email/in-app to the next approver / submitter) and may be consumed by **workflow** (e.g. a
rule that re-routes or tags on approval). Notification never re-derives authority — it
consumes already-authorized events ([§8](#8-events)).

---

## 7. ERP push via `@aegis/connectors`

When an invoice reaches `Approved` (or `AutoApproved`), invoice stages a
`connector.push.requested` event. The workflow connector worker then pushes to the tenant's ERP /
accounting **system of record** through the pluggable connector framework
([`@aegis/connectors`](../../libs/connectors), see
[`SPEC.md` §10.3](../../SPEC.md#103-erp-integration--pluggable-connector-framework-keep-productionize)).
There is **no ad-hoc "ERP sync"** — every push goes through a common connector interface
with an adapter/strategy per ERP and a registry, so adding an ERP is writing one adapter.

```ts
interface ErpConnector {
  readonly type: ErpConnectorType; // 'LedgerOne' | 'Finovo' | 'AcctBridge' (mock)
  authenticate(cfg: ConnectorConfig): Promise<ConnectorSession>;
  pushInvoice(session: ConnectorSession, payload: ErpInvoicePush): Promise<ErpPushResult>;
  fetchStatus(session: ConnectorSession, externalRef: string): Promise<ErpPushStatus>;
}
```

- The push payload is **header-level only** (vendor, invoice number, dates, total amount,
  currency, txn type, PO reference) — there are no lines or GL codes to send.
- The framework ships **MOCK connectors** with neutral names (`LedgerOne`, `Finovo`,
  `AcctBridge`) that emulate the auth handshake → push → status-poll cycle **without calling
  any real ERP**, proving the infra is production-ready.
- Every push carries an **idempotency key** (`invoice_id` + attempt) so a retried push
  cannot double-post. The connector call goes through the service-to-service auth + context
  propagation patterns ([`06-service-to-service.md`](../06-service-to-service.md)); the
  `X-Correlation-Id` of the approving request is propagated for end-to-end tracing.
- The result (external ref + status) is recorded on an `invoice_activities` row
  (`activity_type = ErpPushSucceeded | ErpPushFailed`); failures are retryable and do **not**
  revert the approval.

---

## 8. Events

Invoice publishes domain events through [`@aegis/events`](../../libs/events) (topic enum →
handler registry, transactional-outbox semantics — published only after the owning
transaction commits). Consumers never re-derive authority.

| Event topic                 | Emitted when                                  | Primary consumers                           |
| --------------------------- | --------------------------------------------- | ------------------------------------------- |
| `invoice.received`          | header captured (`→ Received`)                | workflow (tagging/routing rules), reporting |
| `invoice.duplicate.flagged` | duplicate signature hit (`→ Duplicate`)       | notification, reporting                     |
| `invoice.pending_review`    | blocking issue / variance (`→ PendingReview`) | notification                                |
| `invoice.for_approval`      | routed into the chain (`→ ForApproval`)       | notification, workflow                      |
| `invoice.for_next_approval` | a level satisfied, more remain                | notification (next approver)                |
| `invoice.approved`          | chain complete or auto-approved               | notification, reporting, **ERP push**       |
| `invoice.rejected`          | approver/reviewer rejected                    | notification                                |
| `invoice.cancelled`         | withdrawn / confirmed duplicate discarded     | notification, reporting                     |
| `invoice.erp_pushed`        | connector push result recorded                | reporting                                   |

Conversely, invoice **consumes** workflow callbacks (e.g. a rule that assigns/changes the
approval policy or re-routes an in-flight invoice). When a re-route changes the policy or
approver while a header is `ForApproval`, prior `invoice_approvals` rows are marked
`active = false` and the chain re-resolves — mirroring the gating discipline of [§5](#5-gating-invariants-that-block-auto-approval).

---

## 9. Access control

Invoice routes are wrapped `authenticate → authorize(permission, { resourceLoader }) →
handler`. The PDP ([`@aegis/access-control`](../../libs/access-control)) combines RBAC
(does the role grant the action?) + ABAC (conditions: own/team scope, amount ceiling,
tenant) + row-level scope (compiled predicates **and** Postgres RLS keyed on
`app.current_tenant`).

### 9.1 Permission vocabulary (dotted `domain.action`)

| Permission                  | Guards                                                                   |
| --------------------------- | ------------------------------------------------------------------------ |
| `invoice.read`              | list/get invoices (row-scoped: `AllRecords` / `OwnAndTeam` / `OwnOnly`). |
| `invoice.create`            | submit a new header.                                                     |
| `invoice.update`            | edit header metadata while `Received`/`Validating`/`PendingReview`.      |
| `invoice.validate`          | run/re-run duplicate + variance checks.                                  |
| `invoice.duplicate.resolve` | confirm/dismiss a flagged duplicate.                                     |
| `invoice.review`            | clear a `PendingReview` issue.                                           |
| `invoice.submit`            | move `Validating`/`PendingReview` → `ForApproval`.                       |
| `invoice.approve`           | record an approval vote (ABAC: amount ≤ approver's limit, own tenant).   |
| `invoice.reject`            | reject (any level).                                                      |
| `invoice.cancel`            | withdraw / discard.                                                      |
| `invoice.erp.push`          | trigger / retry an ERP push (service + ops).                             |

### 9.2 ABAC conditions enforced

- **Amount ceiling** — an approver may only `invoice.approve` headers whose `amount_minor`
  (currency-converted) is within their hierarchy threshold / approval limit. This is the
  same predicate the next-approver resolver uses, enforced again at the PEP.
- **Tenant + scope** — every read/write is bound to `app.current_tenant`; `OwnAndTeam` /
  `OwnOnly` scopes compile into query predicates and are backstopped by RLS. A body that
  carries a `tenantId` is ignored; context wins ([`08-api-conventions.md`](../08-api-conventions.md)).
- **Separation of duties** — the user who submitted an invoice (`submitted_by`) cannot also
  be its sole approver where the policy requires distinct approvers (ABAC rule), mirroring
  the maker-checker discipline used in payroll.

Every sensitive transition writes an `audit_log` entry (actor, tenant, intent, decision,
permissions-at-time-of-action) plus the `invoice_activities` timeline row.

---

## 10. Endpoints

All paths are tenant-scoped via context; lists return `{ data, meta: { total, page,
pageSize } }`; writes return explicit DTOs. State-advancing endpoints require an
`Idempotency-Key` and propagate `X-Correlation-Id`. Headers come from the `HttpHeaderKey`
enum.

| Method & path                                     | Permission                  | Effect                                                                                                      |
| ------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `POST /v1/invoices`                               | `invoice.create`            | Create a header → `Received`.                                                                               |
| `GET /v1/invoices`                                | `invoice.read`              | List (row-scoped, paginated; filters include `status`, `vendor_id`, `tag`, `team`, `assignee`, `tagMatch`). |
| `GET /v1/invoices/:id`                            | `invoice.read`              | Fetch one header + metadata + duplicates + approvals.                                                       |
| `PATCH /v1/invoices/:id`                          | `invoice.update`            | Edit metadata (only in pre-approval states).                                                                |
| `POST /v1/invoices/:id/validate`                  | `invoice.validate`          | Run duplicate + threshold/variance checks; transition accordingly.                                          |
| `GET /v1/invoices/:id/duplicates`                 | `invoice.read`              | List detected duplicate links.                                                                              |
| `POST /v1/invoices/:id/duplicates/:dupId/resolve` | `invoice.duplicate.resolve` | `{ action: 'confirm' \| 'dismiss' }`.                                                                       |
| `POST /v1/invoices/:id/review`                    | `invoice.review`            | Clear a `PendingReview` issue → `ForApproval`.                                                              |
| `POST /v1/invoices/:id/submit`                    | `invoice.submit`            | Route into the approval chain → `ForApproval`.                                                              |
| `POST /v1/invoices/:id/approve`                   | `invoice.approve`           | Record vote; advance or complete the chain.                                                                 |
| `POST /v1/invoices/:id/reject`                    | `invoice.reject`            | Reject → `Rejected`.                                                                                        |
| `POST /v1/invoices/:id/cancel`                    | `invoice.cancel`            | Withdraw/discard → `Cancelled`.                                                                             |
| `GET /v1/invoices/:id/activities`                 | `invoice.read`              | Append-only activity timeline.                                                                              |
| `POST /v1/invoices/:id/erp-push`                  | `invoice.erp.push`          | (Re)push the approved header to the ERP connector.                                                          |

### 10.1 Example — create

```http
POST /v1/invoices HTTP/1.1
X-Tenant-Id: 7c9e...        # context wins; body tenantId (if any) is ignored
X-Correlation-Id: 0f1a...   # business-request id, propagated downstream
Authorization: Bearer <jwt aud=invoice>
Idempotency-Key: 6b2c...

{
  "vendorId": "b1d2...",
  "invoiceNumber": "INV-2026-04417",
  "invoiceDate": "2026-06-20",
  "dueDate": "2026-07-20",
  "poReference": "PO-88231",
  "transactionType": "debit",
  "amountMinor": 1499900,
  "currency": "USD"
}
```

```json
{
  "data": {
    "id": "9a77...",
    "status": "Received",
    "vendorName": "Northwind Supplies",
    "amountMinor": 1499900,
    "currency": "USD",
    "poReference": "PO-88231",
    "createdAt": "2026-06-26T10:14:02Z"
  }
}
```

### 10.2 Example — validate (duplicate + variance), then auto-approve

```json
// POST /v1/invoices/9a77.../validate  →  200
{
  "data": {
    "id": "9a77...",
    "status": "AutoApproved",
    "autoApproved": true,
    "autoApprovedBy": "SYSTEM",
    "checks": {
      "duplicate": { "result": "none" },
      "variance": { "poReference": "PO-88231", "varianceMinor": 0, "withinTolerance": true },
      "underAutoApproveLimit": true
    }
  }
}
```

### 10.3 Example — typed error (illegal transition)

```json
// POST /v1/invoices/9a77.../approve on an already-Cancelled invoice  →  409
{
  "errors": [
    {
      "code": "INVOICE_INVALID_TRANSITION",
      "type": "ConflictError",
      "message": "Cannot approve an invoice in status 'Cancelled'.",
      "details": { "from": "Cancelled", "attempted": "Approved" },
      "traceId": "c0ffee..."
    }
  ]
}
```

---

## 11. ER diagram

```mermaid
erDiagram
    INVOICES ||--|| INVOICE_METADATA : "1:1 header attrs"
    INVOICES ||--o{ INVOICE_DUPLICATES : "detected dup links"
    INVOICES ||--o{ INVOICE_APPROVALS : "votes (mirror of shared engine)"
    INVOICES ||--o{ INVOICE_ACTIVITIES : "append-only timeline"
    INVOICES }o--|| VENDORS : "vendor_id"
    INVOICES }o--o| APPROVAL_POLICIES : "bound policy snapshot (shared)"
    INVOICE_DUPLICATES }o--|| INVOICES : "duplicate_of_invoice_id"

    INVOICES {
        uuid id PK
        uuid tenant_id "NOT NULL, RLS"
        uuid vendor_id FK
        string vendor_name
        string status "InvoiceStatus state machine"
        bigint amount_minor "header total, minor units"
        char currency "ISO-4217"
        string po_reference "OPTIONAL header PO ref (no line link)"
        boolean auto_approved
        string auto_approved_by "WORKFLOW | SYSTEM | null"
        uuid approval_policy_id FK "shared policy snapshot"
        uuid submitted_by
        timestamptz created_at
        timestamptz updated_at
        timestamptz deleted_at
    }
    INVOICE_METADATA {
        uuid id PK
        uuid tenant_id
        uuid invoice_id FK "UNIQUE -> 1:1"
        string invoice_number "dup signature part"
        date invoice_date
        date due_date
        string po_reference "optional"
        string transaction_type "debit | credit"
        bigint amount_minor
        char currency
    }
    INVOICE_DUPLICATES {
        uuid id PK
        uuid tenant_id
        uuid invoice_id FK
        uuid duplicate_of_invoice_id FK
        string signature "hash(vendor|number|amount|currency)"
        string match_type "exact | probable"
        string status "flagged | confirmed | dismissed"
        uuid resolved_by
    }
    INVOICE_APPROVALS {
        uuid id PK
        uuid tenant_id
        uuid invoice_id FK
        uuid approver_user_id
        int approval_level
        string decision "approved | rejected"
        string comment
        boolean active
    }
    INVOICE_ACTIVITIES {
        uuid id PK
        uuid tenant_id
        uuid invoice_id FK
        uuid actor_user_id "null = system"
        string activity_type "InvoiceActivityType"
        json details
        string correlation_id
        timestamptz created_at
    }
```

> The **approval chain definition** (`approval_policies`, `approval_hierarchy`,
> `approver_groups`, `approver_group_members`, `record_approvers`, `approvals`,
> `approval_progress_log`) is the **shared** approval domain, drawn in
> [`07-data-models.md`](../07-data-models.md). Invoice references it (the dashed
> `APPROVAL_POLICIES` link) but does not own it. There is intentionally **no line-item or
> match-group table** in this diagram ([§0](#0-scope--read-this-first)).

---

## 12. Definition of done (this service)

- [x] Header-level model only — **no** line items, **no** line matching, **no** GL codes.
- [x] Status state machine with explicit legal-transition guards + activity timeline.
- [x] "Matching" reframed = duplicate detection + threshold/variance vs optional PO ref +
      approval routing.
- [x] Auto-approval fail-closed behind the [§5](#5-gating-invariants-that-block-auto-approval) invariants.
- [x] Shared multi-level approval engine + next-approver routing (no bespoke chain).
- [x] ERP push of the approved header via [`@aegis/connectors`](../../libs/connectors) (mock connectors, idempotent).
- [x] Every route `authenticate → authorize → handler`; ABAC amount-ceiling + tenant + SoD.
- [x] Tenant `tenant_id NOT NULL` + RLS on every table; money in integer minor units.
- [x] Events via [`@aegis/events`](../../libs/events) (outbox); consumed by workflow/notification/reporting.
