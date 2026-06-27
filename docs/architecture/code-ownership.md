# Code ownership — where a model, table, interface, or DTO lives (and why)

> **Read this when you're about to add a new model, table, repository, interface, enum, or DTO and
> you're not sure where it goes.** Aegis is one Nx monorepo developed atomically but deployed as
> separate stateless processes, so "who owns what" is a deliberate design decision, not an accident
> of where a file happened to land. This document makes the rule explicit so the layout reads as
> intentional and so two agents working in parallel never disagree about ownership.
>
> When this doc and `SPEC.md` disagree, **`SPEC.md` is the single source of truth** — fix the drift,
> don't paper over it. Physical table names always come from `TableName` in
> `libs/shared/enums/src/table-name.enum.ts` (one source of truth, grouped by owner).

---

## TL;DR decision table

| You are adding… | It belongs to… | Concretely |
|---|---|---|
| A **domain** model / table / repository (something one service is the system-of-record for) | the **service** that owns that domain | `apps/<svc>/src/models/<x>.model.ts`, `apps/<svc>/src/repositories/` |
| A **cross-cutting platform/engine** table every service writes (audit, activity, approvals, outbox, casbin) | the **infra/engine lib** that defines it (deliberate **shared kernel**) | `@aegis/audit`, `@aegis/activity`, `@aegis/approvals`, `@aegis/events`, `@aegis/access-control` |
| A **lib-contract interface** (the public API of a lib) | the **lib itself** (its `index.ts` re-exports it) | `Connector`, `EventBus`, `EventEnvelope`, `AuditInput`, `PolicyRule`, `MigrationModule`, … |
| A **domain DTO / shape / enum / constant** shared across services | `libs/shared/{types,enums,constants}` | `*.shape.ts`, `*.enum.ts`, `*.constants.ts` |
| An **event payload** interface (the bus wire-contract) | `@aegis/events` — **by design**, the one nuance | `libs/events/src/payloads.ts` |

The four rows are: **DOMAIN → service**, **CROSS-CUTTING → infra/engine lib**, **CONTRACT → its lib**,
**DTO/enum/constant → shared**. The single deliberate exception to "DTOs live in shared" is the event
payload contract, which lives with the bus (see §5).

---

## 1. Domain models, tables, and repositories → owned by their SERVICE

A service is the **system-of-record** for its domain. Its tables, Sequelize models, and repositories
live under `apps/<svc>/src/models` (and `apps/<svc>/src/repositories`). No other service reaches into
them — cross-service reads go through HTTP (via the gateway / signed s2s) or the event bus, never by
importing another app's model.

**Why:** a service owns its schema so it can evolve it without a cross-team change, and so the RLS
tenant boundary and the deployment boundary line up with the data boundary.

**Examples (real files):**

| Domain | Owner service | Models | Tables (`TableName`) |
|---|---|---|---|
| Identity / access admin | `apps/user-management` | `apps/user-management/src/models/{user,tenant,role,permission,role-permission,user-role,tenant-config,tenant-feature}.model.ts` | `users`, `tenants`, `roles`, `permissions`, `role_permissions`, `user_roles`, `policies`, `teams`, `tenant_config`, `tenant_features`, … |
| Expense | `apps/expense` | `apps/expense/src/models/{expense,expense-report,expense-category,expense-approval,expense-comment,expense-activity}.model.ts` | `expense_reports`, `expenses`, `expense_categories`, … |
| Invoice | `apps/invoice` | `apps/invoice/src/models/…` | `invoices`, `invoice_metadata`, `invoice_duplicates`, … |
| Payroll | `apps/payroll` | `apps/payroll/src/models/…` | `employees`, `pay_runs`, `payslips`, `payments`, `ledger_entries`, … |
| Workflow | `apps/workflow` | `apps/workflow/src/models/…` | `rules`, `rule_steps`, `rule_actions`, `rule_audit_logs` |
| Notification | `apps/notification` | `apps/notification/src/models/…` | `notifications`, `email_notification_logs`, `notification_preferences`, `email_suppressions` |
| Reporting | `apps/reporting` | `apps/reporting/src/models/…` | `report_definitions`, `report_schedules`, `report_runs`, `report_access_policies` |

> Note `policies` (the ABAC/PAP policy rows) and `connector_configs` are domain tables of
> user-management / the connector-owning services respectively — distinct from the **`casbin`**
> enforcement table (see §2).

---

## 2. Cross-cutting platform / engine tables → owned by their INFRA/ENGINE lib (shared kernel)

A small set of tables are written by **every** service, not by one. These are deliberately owned by
an **infra/engine lib** and treated as a **shared kernel**: the lib defines the model + the only
writer, and each service calls the lib in-process.

| Table(s) | Owning lib | The model / writer (real file) |
|---|---|---|
| `audit_log` | `@aegis/audit` | `libs/audit/src/audit-log.model.ts` (`getAuditModel`) + `libs/audit/src/audit-logger.ts` |
| `activity_log` | `@aegis/activity` | `libs/activity/src/activity-log.model.ts` + `libs/activity/src/activity-logger.ts` |
| `approval_policies`, `approval_hierarchy`, `approver_groups`, `approver_group_members`, `record_approvers`, `approvals` | `@aegis/approvals` | `libs/approvals/src/models/*.model.ts` + `libs/approvals/src/repositories/*` |
| `event_outbox` | `@aegis/events` | `libs/events/src/outbox.ts` (the transactional outbox staged inside the business tx) |
| `casbin` (the Casbin enforcement rules) | `@aegis/access-control` | loaded/persisted by the enforcer via `casbin-pg-adapter` in `libs/access-control/src/enforcer.ts`; table created by migration `apps/cli/src/migrations/0009_casbin.ts` |

**Why a shared kernel and not "each service owns its own copy":** every service must write these
(audit on every guarded action, activity on every business mutation, an approval row whenever any
record routes for approval, an outbox row whenever any business tx emits an event, a casbin lookup on
every authorize). If ownership were pushed into one service, every other service would take **a
network hop per write** — an audit RPC on the hot path of every request, an outbox RPC inside every
business transaction (re-introducing the dual-write gap the outbox exists to close). Co-locating the
model with the lib lets the write happen **in the same local transaction** as the business change,
which is exactly what tamper-evident auditing and the transactional outbox require. So this is a
considered trade: one shared-kernel schema, written in-process by all, versus N services each paying a
per-write hop for a table they all need anyway.

These tables still obey the platform rules: tenant-scoped, `tenant_id NOT NULL`, RLS-enforced (audit
and activity are additionally append-only; audit is hash-chained — see
`docs/10-auditability-and-compliance.md`).

---

## 3. Lib-contract interfaces → live WITH their lib (the lib's public API)

An interface that **is** a lib's contract — the seam a consumer codes against — lives inside that lib
and is re-exported from its `index.ts`. The interface and its reference implementation ship together;
that is the whole point of the lib.

| Interface | Lib | Real file |
|---|---|---|
| `Connector`, `ConnectorConfig`, `PushRequest`, `PushResult` | `@aegis/connectors` | `libs/connectors/src/connector.ts` (re-exported from `libs/connectors/src/index.ts`) |
| `Transformer` (domain entity → ERP payload) | `@aegis/connectors` | `libs/connectors/src/transformer.ts` |
| `EventBus`, `EventHandler`, `DeadLetterSink` | `@aegis/events` | `libs/events/src/bus.ts` |
| `EventEnvelope`, `EventTopic` | `@aegis/events` | `libs/events/src/topics.ts` |
| `AuditInput` | `@aegis/audit` | `libs/audit/src/audit-logger.ts` |
| `MigrationModule` | `@aegis/db` | `libs/db/src/migrator.ts` |
| PEP/PDP contracts (`authorize`/`authenticate` options, policy-rule loaders) | `@aegis/access-control` | `libs/access-control/src/{pep,pdp,policy-loader}.ts` |

**Why:** the contract and the engine that satisfies it are one unit of meaning and change. A service
imports the interface from the lib (`import type { Connector } from '@aegis/connectors'`) and either
consumes the bundled implementation or registers its own adapter against the same seam (e.g. a real
ERP plugs in via one class implementing `Connector`). Putting the interface in `shared` would split a
lib's public API across two packages.

> The on-disk **resolved row shape** of a cross-kernel concept (e.g. `AccessShape.PolicyRule`, the
> shape the PDP evaluates) is a DTO and lives in `libs/shared/types` (§4) — distinct from the
> behavioral contract (`authorize`, `Connector`) which lives in the lib. Rule of thumb: **data shapes
> → shared; behavioral seams → the lib.**

---

## 4. Domain DTOs / enums / constants → `libs/shared/{types,enums,constants}`

Plain data that crosses service boundaries — request/response shapes, enums, and constants — lives in
the framework-free `shared` libs so producer and consumer compile against one definition.

- **`libs/shared/types`** — one `*.shape.ts` per domain, each wrapping a TS namespace of DTO/shape
  interfaces: `common.shape.ts`, `access.shape.ts`, `expense.shape.ts`, `invoice.shape.ts`,
  `payroll.shape.ts`, `workflow.shape.ts`, `notification.shape.ts`, `approval.shape.ts`, … (see
  `libs/shared/types/src/index.ts`).
- **`libs/shared/enums`** — domain + platform enums: `table-name.enum.ts` (the table-name source of
  truth), `http-header-key.enum.ts`, the dotted `Permission` catalog, `audit.enum.ts`,
  `approval.enum.ts`, `connector.enum.ts`, `expense.enum.ts`, etc. (`libs/shared/enums/src/`).
- **`libs/shared/constants`** — per-area constants: `app.constants.ts`, `expense.constants.ts`,
  `notification.constants.ts` (`libs/shared/constants/src/`).

**Why:** these have **no behavior and no dependency on infra** — keeping them in dependency-free
packages means any service or lib can import them without dragging in Sequelize, Kafka, or Casbin, and
a shape change is a single-source compile-time break on every side.

---

## 5. The one nuance — event payload interfaces live in `@aegis/events` by design

Event **payload** interfaces (e.g. `ExpenseSubmittedPayload`, `ExpenseApprovedPayload`,
`RecipientHint`, and the `PayloadOf<T>` mapping) live in `libs/events/src/payloads.ts`, **not** in
`libs/shared/types` — even though they are "just data shapes."

This is deliberate. The payload set is the **wire-contract of the bus**: there is exactly **one typed
payload per `EventTopic`**, shared by producers and consumers so a shape change is a compile-time
break on **both ends** (`PayloadOf<T>` ties each `EventTopic` to its payload, and `EventBus.publish`/
`subscribe` are typed through it — see `libs/events/src/bus.ts`). The envelope
(`libs/events/src/topics.ts`) carries `tenantId` + `correlationId` from the producer's
`RequestContext`, so payloads deliberately do **not** repeat tenant/correlation. Because the payloads,
the topics they key off, and the `EventEnvelope`/`EventBus` that transports them form one
tightly-coupled contract, they live together in `@aegis/events`. Splitting the payloads into
`shared` would let the bus contract and its payloads drift independently — the opposite of what a
single-source wire-contract is for.

**Mnemonic:** generic domain DTOs → `shared`; the **bus** wire-contract (envelope + per-topic
payloads) → `@aegis/events`.

---

## Quick "where does it go?" worked examples

- *Add a `pay_run_locks` table for payroll maker-checker* → payroll domain →
  `apps/payroll/src/models/…`, add the name to `TableName` (payroll group).
- *Add an `outcome` column to the audit log* → cross-cutting kernel →
  `libs/audit/src/audit-log.model.ts` + a migration; never per-service.
- *Add a new ERP connector for "FooLedger"* → implement the existing seam →
  a new class implementing `Connector` (`libs/connectors/src/connector.ts`) under
  `libs/connectors/src/`; no new interface, no service-owned table.
- *Add an `invoice.voided` event* → add the topic to `libs/events/src/topics.ts` **and** its payload
  interface to `libs/events/src/payloads.ts` (bus wire-contract), wire `PayloadOf`.
- *Add a shared `Money` shape used by expense and invoice responses* → domain DTO →
  `libs/shared/types/src/common.shape.ts`.
- *Add a new approval mode enum value* → `libs/shared/enums/src/approval.enum.ts`; the engine that
  reads it stays in `@aegis/approvals`.
</content>
</invoke>
