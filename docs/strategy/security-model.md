# Aegis Security Model — how the fences work (and how AI rides on them)

> **What this is.** The single reference for Aegis's authorization/isolation model: the layers that
> fence data, how a request (human OR agent) traverses them, what is a *hard guarantee* vs. an
> *application-layer* control, and how the agentic layer inherits all of it. Every claim here is
> grounded in code the T25 security audit read line-by-line (see the companion
> [`security-findings.md`](security-findings.md) for the audit's confirmed gaps).
>
> **One-line summary.** *The agent reasons; the governed core acts.* Every state change — whether a
> human hits a route or an LLM calls a tool — runs the same pipeline:
> **authenticate → authorize (Casbin RBAC × ABAC PDP × row-scope) → Joi validate → RLS transaction → hash-chained audit.**

---

## 1. The four fences (defense in depth)

Aegis stacks four independent authorization layers. A request must pass **all** of them; each is
fail-closed on its own axis. Two are *hard guarantees* (enforced by Postgres / cryptography and not
bypassable by an application bug); two are *application-layer* (only as strong as the route wiring —
this is where the audit found gaps).

| # | Fence | Question it answers | Where | Strength |
|---|-------|---------------------|-------|----------|
| 1 | **Tenant isolation (RLS)** | "Is this row in *my tenant*?" | Postgres FORCE + RESTRICTIVE row-level security | **HARD** — DB-enforced, non-bypassable |
| 2 | **RBAC (Casbin)** | "Does my *role* grant this permission in this tenant?" | `libs/access-control` PEP + Casbin enforcer | Guaranteed at every guarded route |
| 3 | **ABAC (PDP)** | "Do the *attributes* (amount, status, time, …) permit it?" | PDP + condition-evaluator, deny-overrides | App-layer; **attribute-dependent rules currently inert** — see §6 |
| 4 | **Row scope** | "Is this *my* record / my *team's*?" (own / own_and_team / all) | `checkRowScope` via a per-route resource loader | App-layer; **per-route opt-in — coverage gaps** — see §6 |

### Fence 1 — Tenant isolation (the bedrock, HARD guarantee)
Every tenant table has `ENABLE` + `FORCE` + a `RESTRICTIVE` RLS policy whose predicate is purely
`tenant_id = current_setting('app.current_tenant')::uuid` ([libs/db/src/rls.ts:41-52](../../libs/db/src/rls.ts)).
- **FORCE** means even the table owner is subject to it; the **runtime connects as the non-owner,
  non-superuser `aegis_app` role** (no `BYPASSRLS`), so the application literally cannot see another
  tenant's rows.
- **RESTRICTIVE** means the tenant predicate is `AND`-combined — a permissive policy can never `OR`
  it away.
- The tenant is set **transaction-locally** via `set_config('app.current_tenant', …, true)` inside
  `withTenantTransaction`, so the binding is per-request and pool-safe.
- **Empirically verified live** by the audit: as `aegis_app` with `app.current_tenant = tenantB`, a
  read of tenantA's rows returned nothing and an `INSERT` tagged `tenant_id = tenantA` raised a
  `WITH CHECK` violation.

> **This is why "can a user read another tenant's data?" is a flat no** — it would take a Postgres
> RLS bug or a superuser connection, neither of which the app has.

### Fence 2 — RBAC (Casbin, per guarded route)
`authenticate()` verifies the HS256 JWT and asserts the **token's `tenant_id` equals the
`x-tenant-id` header** (blocks cross-tenant token replay), then `authorize()` runs the Casbin gate
(role × tenant-domain × permission) before any handler ([pep.ts:36-67, 243-301](../../libs/access-control/src/pep.ts)).
The `permissions`/`roles`/`scope` claims are **server-derived from the DB at login** — the login
endpoint takes only email+password, so a client cannot forge or elevate them
([auth.service.ts](../../apps/user-management/src/services/auth.service.ts),
[user.repository.ts:95-111](../../apps/user-management/src/repositories/user.repository.ts)).

### Fence 3 — ABAC (the PDP)
When a route supplies a resource, the PDP evaluates persisted `PolicyRule`s with **deny-overrides**
(any matching deny wins) against principal/resource/environment attributes
([pdp.ts](../../libs/access-control/src/pdp.ts), [condition-evaluator.ts](../../libs/access-control/src/condition-evaluator.ts)).
As of T24 the persisted-policy path is real (ABAC Phase 0 mapper + Phase 1 DB loader); **but** rules
that reference *principal* attributes (`approvalLimit`, `teamIds`, `managerOf`) are currently inert
because those attributes are never populated — see §6 and the
[ABAC generalization plan](abac-generalization.md).

### Fence 4 — Row scope (own / own_and_team / all)
`checkRowScope` is the within-tenant, per-user/per-team fence
([scope.ts:23-38](../../libs/access-control/src/scope.ts)):
- `own_only` → the resource's `ownerId` must equal the caller's `userId` (fail-closed).
- `own_and_team` → owner **OR** the resource's `teamId` ∈ the caller's `teamIds`.
- `all` → no row restriction (the permission itself is the gate).

Scope runs **only when the route hands `authorize()` a resource loader** (or the service applies a
scope-derived query filter for list routes — there is no single row to check on a list). This
per-route opt-in is deliberate but means coverage must be audited route-by-route — and the audit
found several routes that skip it (§6).

---

## 2. The request lifecycle (one diagram for humans and agents)

```
            ┌─────────────────────────── same pipeline for BOTH ───────────────────────────┐
 Human UI ─▶│                                                                               │
            │  authenticate()      JWT verified; token.tenant_id == x-tenant-id (else 403)  │
 Agent  ───▶│        │                                                                      │
 (LLM tool) │        ▼                                                                      │
            │  authorize()  ── Casbin RBAC (role×tenant×perm) ─▶ ABAC PDP (deny-overrides)  │
            │        │                              └─▶ checkRowScope (own/team/all)        │
            │        ▼                                                                      │
            │  validate()   Joi schema on body/query/params                                 │
            │        ▼                                                                      │
            │  withTenantTransaction  set_config('app.current_tenant') ▶ FORCE RLS          │
            │        ▼                                                                      │
            │  handler → repository (RLS-scoped SQL)                                        │
            │        ▼                                                                      │
            │  hash-chained audit log                                                       │
            └───────────────────────────────────────────────────────────────────────────────┘
```

The critical property: **the agent does not get a side door.** See §3.

---

## 3. How AI inherits the fences (the agent tool-calling path)

The whole agentic layer is built so an LLM can **never** reach data or actions a human with the same
identity couldn't. Verified guarantees:

- **Tools execute over the real guarded route.** `invokeTool` issues an actual HTTP request to the
  tool's own route, attaching the **caller's own** `Authorization: Bearer <token>` and `x-tenant-id`
  ([tool-server.ts:75-92](../../libs/ai-core/src/tool-server/tool-server.ts)). So the request
  re-traverses authenticate → authorize → validate → RLS → audit *as the caller*. There is **no
  in-process shortcut** for route-derived tools.
- **The pre-model tool filter is UX, not the boundary.** `filterToolsForPrincipal` narrows what the
  model is *offered* (by permission + entitlement), but the PEP on each route is re-run at execute
  time regardless — a tool that slipped the filter is still rejected by the route
  ([filter-tools.ts:20-35](../../libs/ai-core/src/tool-registry/filter-tools.ts)).
- **Off-offer tools are refused.** If the model names a tool outside the filtered set, the turn is
  refused and no HTTP call is made ([agent-orchestrator.ts:216-221](../../libs/ai-core/src/orchestrator/agent-orchestrator.ts)).
- **Built-ins can't shadow governed routes.** On a name collision the registry tool wins
  ([agent-orchestrator.ts:201-202](../../libs/ai-core/src/orchestrator/agent-orchestrator.ts)).
- **The danger gate is model-proof.** Danger facts (money/irreversible/bulk/regulatory) are derived
  server-side from the tool's static method/path + structural args
  ([derive-danger-facts.ts:75-97](../../libs/ai-core/src/orchestrator/derive-danger-facts.ts)) — the
  LLM cannot talk the classifier down — and each rule can only *tighten* the ceremony.
- **Supervised writes are fail-closed and AND-composed.** `executeSupervisedWrite` reaches
  `invokeTool` only after the human ceremony is satisfied **and** (for material writes) an
  independent, different-model verifier passes ([supervised-write.ts:238-280](../../libs/ai-core/src/execution/supervised-write.ts)).
  A confirmed pending action is deleted (no replay) and Redis TTLs stale challenges.

> **These are the strong parts of the agent story and they hold.** The gaps the audit found are
> *not* in this backbone — they are in (a) the row-scope coverage the agent inherits from the routes
> (so an agent inherits the same route gaps a human has), (b) the propose→confirm *binding*, and
> (c) built-in *memory* tools, which do **not** go over a guarded route. See §6.

---

## 4. Memory & conversation security

- **Tenant isolation of the app-brain is a HARD guarantee.** `app_brain_memory` runs FORCE +
  RESTRICTIVE RLS keyed on `tenant_id` (verified live); every read path (`recall`/`profile`/
  `salient`/`search`) runs inside `withTenantTransaction`, and reads see only live rows
  (`valid_to IS NULL`) so soft-invalidated facts can't leak back.
- **User-level isolation within a tenant is NOT yet enforced.** The app-brain is a *tenant* brain:
  there is no `owner_user_id` column, so user B's `memory_recall` can read user A's memories, and
  `memory_remember`/`forgetBySubject` can overwrite/erase another user's facts in the same tenant.
  Whether that's "shared team memory" (sometimes desirable) or a leak is a **product decision** — but
  today there is no way to scope it per-user, and no user provenance is recorded. See findings
  MEM-01/02/03 and AGENT-03.
- **Conversation history** is keyed `tenant:session`; isolation currently relies on the caller
  supplying a trusted `sessionId`. Safe in the in-process flows today, but any future HTTP surface
  that trusts a client-supplied `sessionId` must fold `userId` into the key (MEM-04).

---

## 5. What is a hard guarantee vs. application-layer (read this before trusting a fence)

| Guarantee | Class | Trust it? |
|---|---|---|
| No cross-tenant read/write | **HARD** (Postgres FORCE RLS, non-super role) | ✅ Yes — DB-enforced |
| Scope claim can't be client-forged | **HARD** (server-derived, JWT-signed) | ✅ Yes |
| Token can't be replayed cross-tenant | **HARD** (token↔header tenant check) | ✅ Yes |
| Agent uses the same guarded route as a human | **Strong** (no in-process bypass exists) | ✅ Yes |
| Danger classification can't be gamed by the LLM | **Strong** (server-derived facts) | ✅ Yes |
| Supervised material write needs human + verifier | **Strong** (fail-closed AND) | ✅ Yes |
| A user only sees *their team's* records | **App-layer** | ⚠️ **Gaps** — per-route; `own_and_team` inert (§6) |
| Approval amount caps | **App-layer** | ❌ **Inert today** — needs the PIP (§6) |
| Per-user memory privacy | **App-layer** | ❌ **Not implemented** — tenant-shared brain (§6) |

---

## 6. Known gaps (summary — full detail in [security-findings.md](security-findings.md))

The T25 audit confirmed **16 findings**, all *within-tenant* (the tenant fence itself is intact).
The single root cause behind most of them is the **missing PIP (Policy Information Point)**: login
never populates `principal.attributes` (`teamIds`, `approvalLimit`, `managerOf`), so:
- `own_and_team` silently degrades (→ owner-only on single-resource, → **all records** on the expense
  list) — **SCOPE-04, ROWSCOPE-03**;
- the **approval amount cap is inert** — an approver can approve any amount — **ABAC-01, AGENT-04**;
- `manager_of` policies never match — **ABAC-02**.

Plus per-service coverage gaps (invoice & pay-run routes with **no** row scope — SCOPE-01/02),
a fail-*open* on an unrecognized scope value (SCOPE-05), the propose→confirm not binding confirmer to
proposer (AGENT-01), and the tenant-shared memory (MEM-01/02/03, AGENT-03).

**The remediation is already scoped:** ABAC Phase 1 (the DB policy loader) landed in T24; **Phase 2
(the PIP)** — populate `principal.attributes` at `authenticate()` via the `AttributeReadPort` that
already exists but is never invoked — closes the entire attribute-dependent class at the source. See
[abac-generalization.md §5](abac-generalization.md).
