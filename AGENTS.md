# AGENTS.md — Context for AI agents working on Aegis

<!-- ▶ RESUME HERE — refresh this block at the end of every pass. Canonical status = docs/brain/STATE.md. -->
> ## ▶ RESUME HERE — where we are & what to pick up next (updated 2026-07-10, T30)
>
> **Branch:** `feat/agentic-platform` (pushed to origin = personal GitHub `25ankurpandey/aegis`; `main`
> untouched). **Infra:** local pgvector Postgres @ 55432 + Redis @ 6380 — a Docker restart stops them, so
> run `AEGIS_POSTGRES_PORT=55432 AEGIS_REDIS_PORT=6380 docker compose up -d` before live tests.
>
> **Where we are.** Aegis is evolved from the shipped access-control platform into an **agentic-first
> platform** on the governed core, on real infra, now **fully security-hardened**: the agentic layer
> (read/propose/human-supervised), multi-LLM gateway, module-entitlement loop, pgvector app-brain + agent
> memory (Wayfinder port), and a security audit with **ALL 16 of 16 findings remediated** — tenant +
> user/team fence enforced end-to-end (RLS + single-resource + list, off the signed scope claim,
> fail-closed) and **regression-gated** (`row-scope-gate.spec.ts`); amount-cap ENFORCES; memory is per-user
> isolated; conversation keys bind userId. **RECONCILIATION is a COMPLETE financial-integrity capability**
> (T29–T30): 3 vetted RLS-scoped deterministic checks over the REAL schema (expense-report total vs line
> items · unresolved duplicate invoices · orphaned expenses) → verified findings → recallable app-brain
> proposals → a per-tenant runner + an `--all` scheduled sweep + an HTTP surface in expense (`POST
> /_ai/reconcile` runs it; `GET /_ai/reconcile/findings` lists proposals; guarded by `audit.view`);
> propose-only, live-tested, LLM-free. All green (~850 tests across 9 projects), strict typechecks clean,
> tree clean & pushed. Migrations through **0036**.
>
> **What to pick up next** (security is DONE, reconciliation is COMPLETE — all net-new / founder-gated):
> 1. **Founder-gated unlocks (need YOU, not code):** drop `AEGIS_LLM_*` → the live end-to-end demo
>    (`/_ai/act` + agent memory + reconciliation via MCP/Claude Desktop); an embedding-provider key →
>    semantic app-brain recall (currently lexical/hashing).
> 2. **Other net-new (buildable now):** more reconciliation checks (payroll tax, invoice AR vs ledger);
>    generative-UI renderer + voice; Chargebee live webhook wiring (flip `AEGIS_ENTITLEMENT_FILTER=on`);
>    ABAC Phase 3+ (env/time conditions, obligations); a real scheduler/worker for the `--all` sweep.
>
> **Read next, in order:** `docs/brain/STATE.md` (canonical current state + Next) → `docs/brain/PROGRESS.md`
> (standing narrative briefing) → `docs/strategy/security-findings.md` (the audit + what's left) →
> `CONTEXT.md` (full vision/architecture). Update `STATE.md` + append to `docs/brain/AUDIT_LOG.md` every pass.

---

> **⚠️ START HERE — the product vision has evolved far beyond this file.** This document remains accurate
> for the *originally-built access-control platform* (the current shipped code), but Aegis is becoming an
> **agentic-first, modular, multi-industry, governance-native platform**. For the FULL current context —
> the vision, every idea, the architecture, all decisions, the current build state, and the roadmap —
> **read [`CONTEXT.md`](CONTEXT.md) first**, then the "second brain" at
> [`docs/brain/`](docs/brain/README.md) (memory map + append-only audit log + decisions). This file below
> is authoritative only for the existing access-control code; `CONTEXT.md` is authoritative for the vision.

> Read this file **first**, every time. Then read [`SPEC.md`](SPEC.md) (authoritative spec),
> the relevant file under [`docs/`](docs/), and the phase you are picking up in
> [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md). **Keep these documents updated** as you work
> (see "Documentation discipline" below).

## 1. What you are building

Aegis is an **enterprise access-control system for a multi-tenant microservices SaaS**. Seven
business services (user-management, expense, payroll, reporting, workflow, notification, invoice)
+ a gateway + a cli, all sharing a central access-control library, on an Nx monorepo with
PostgreSQL + Row-Level Security. Present it as a production platform — **production framing only,
no exercise/evaluation wording anywhere**.

What matters most: **depth, security correctness, distributed-systems soundness, and coherence of
the access-control story across services.** When in doubt, make the access-control demonstration
sharper. See [`SPEC.md`](SPEC.md) §10 (Amendments — 2026-06-26) for the latest scope decisions
(no GL codes / no line items, header-level invoice, pluggable ERP connectors, local one-command
Docker run, Terraform, testing/recording, frontend analysis).

## 2. Provenance — where the patterns come from (READ-ONLY references)

Aegis is synthesized from external reference codebases. **You may read them for patterns; you must
NOT copy any branding or import any of their code.**

- **Architecture reference** — an Express + InversifyJS + Sequelize + Kafka service template. We
  follow its *per-service internals*: bootstrap, DI, controllers/services/repositories/interfaces
  layering, request-context middleware, error envelope, constants pattern. **Its security backbone
  is a closed-source package we do NOT have — we re-implement those responsibilities in
  `@aegis/service-core`.**
- **Domain reference** — an Nx monorepo (Express + Sequelize/Postgres, Casbin). We follow its
  *monorepo structure, enum/type organization, make-factory + event-bus patterns, Umzug migrations,
  and the superior deployment model*. We do **NOT** copy its neutered Casbin authz (`dom='*'`,
  migration-only roles) — Aegis builds a clean RBAC+ABAC engine instead.
- **Expense reference** — a Python/FastAPI expense application. Domain reference for the Expense
  service (data model, approval state machine). We **port it to Node/TS**; we do not run the Python
  service. (No GL codes / line items.)
- **Cross-cutting reference** — an internal web reference's backend utils
  (`src/utils/{context,middleware}`). The concrete, available reference for the request-context /
  context-manager / middleware / logger / http-client that `@aegis/service-core` re-implements
  (de-branded). Add header validation to the context middleware.
- **ERP-integration reference** — a Python ERP-integration service (`app/services/erps/`). Pattern
  source for the pluggable **`@aegis/connectors`** ERP framework (adapter/strategy + registry). We
  ship **mock** connectors (neutral names), not real ERPs.
- **IaC reference** — a Terraform infrastructure repo (`infra/terraform/`). Module structure
  reference (env/{dev,prod} + modules/) for our showcase Terraform (VM/MIG or container service +
  Pub/Sub + autoscaling + NAT + monitoring).

Distilled research notes from the analysis pass live in the design docs under `docs/`. **The latest
scope decisions are in [`SPEC.md`](SPEC.md) §10 — read it.**

## 3. HARD CONSTRAINT — naming

Naming: use only the `@aegis/*` scope and Aegis domain names; do not reference external reference
codebases, their internal packages, or their customers by name anywhere in the repo. Use neutral
domain terms. Before committing, grep to confirm no external reference identifier has crept in.
(Aegis itself is renameable: it's the npm scope `@aegis` + the word "aegis" in configs — a single
search-replace if the owner prefers another name.)

## 4. Locked decisions (full rationale in SPEC.md §1)

Nx monorepo · all 7 services built fully · per-service internals = service-template-reference pattern
(Express + Inversify) · cross-cutting = `@aegis/service-core` · **PostgreSQL + RLS** for tenant
isolation · enums/types = domain-reference pattern · constants = service-template-reference pattern ·
migrations = Umzug code-first · deployment = domain-reference single-image + `PROCESS_TYPE` ·
audit = hybrid + hash-chained.

> **⚠️ v2 realignment in progress — SPEC.md §11 OVERRIDES earlier choices. Follow it + Phase R in
> IMPLEMENTATION_PLAN.md:** access control = **Casbin** (`casbin-pg-adapter`, `dom`=tenant), NOT the
> in-house PDP · eventing = **Kafka** (kafkajs, service-template `kafka-client` pattern), NOT Redis · per-file
> structure (one model/repo/controller/validator per resource) · validation via middleware (not in
> controllers) · thin `index.ts` → `bootstrap.ts` · all domain types/enums/constants in `libs/shared/*` ·
> tests in a per-project `test/` folder · tenant `tenant_config`/`tenant_features` (feature flags) ·
> ERP connectors = transformer + factory · per-route guards only · no root `.env`.

## 5. Repo map

```
apps/<svc>/src   controllers/ services/ repositories/ models/ interfaces/ validators/ constants/ ioc/ bootstrap.ts index.ts
libs/service-core      request context (AsyncLocalStorage), logger, errors+envelope, http client, config/secrets, cache, middleware
libs/access-control    PDP: RBAC engine, ABAC eval, permission catalog; PEP guards (authorize)
libs/shared/enums      one <domain>.enum.ts + barrel, HttpHeaderKey, TableName
libs/shared/types      <domain>.shape.ts namespaces
libs/shared/constants  per-area Constants classes
libs/db                Sequelize connection/adapter, DatabaseContext, Umzug migrations, RLS helpers
libs/events            event bus (publish/consume registry, outbox, transport adapters)
libs/testing           test utils
docs/                  explainers + diagrams + docs/interactive/index.html
```

## 6. Conventions (enforce these)

- UUID v4 PKs; money in integer minor units; `created_at`/`updated_at`, `underscored: true`.
- Every tenant-scoped table has `tenant_id NOT NULL` + an RLS policy; the app DB role is a
  **non-owner without BYPASSRLS**; set tenant via `SET LOCAL app.current_tenant` inside the txn.
- Every route is wrapped `authenticate → authorize(permission, …) → handler`. Only `/health`
  and docs are unauthenticated.
- Typed errors → one Express error middleware → `{ errors: [{ code, type, message, details, traceId }] }`.
- Responses are explicit DTOs; lists are `{ data, meta: { total, page, pageSize } }`.
- Permissions are `domain.action[.sub]`, lower-case dotted; resources referenced by enum.
- Headers come from the `HttpHeaderKey` enum; table names from the `TableName` enum.
- DI tokens are concrete classes (`@provideSingleton(Class)`); interfaces are typing-only.

## 7. How to pick up work

1. Open [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md); find the first task not `[x]`.
2. Read the relevant `docs/` file + `SPEC.md` section for that area.
3. Implement following §6 conventions and the established reference patterns (without their names).
4. Add unit tests; run `nx affected -t lint test`.
5. Update the plan checkbox, the "Current status" block, and any doc your change affects.

## 8. Definition of Done (per service)

A service is done only when it: shares `@aegis/service-core` + `@aegis/access-control`; enforces
tenant RLS; has a PEP `authorize(...)` on every route; emits audit entries on writes; has unit
tests above the coverage gate; and has an up-to-date `docs/services/<svc>.md`.

## 9. Documentation discipline (do this every session)

After a meaningful change, update — in the same commit:
- `IMPLEMENTATION_PLAN.md` — tick tasks, refresh the "Current status" + "Last updated" line.
- The affected `docs/*.md` (and `SPEC.md` if a decision changed — change SPEC *deliberately*).
- `docs/interactive/index.html` if you changed the architecture or service topology.
Treat docs as part of the change, not an afterthought. The next agent relies on them.
