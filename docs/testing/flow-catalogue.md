# Aegis — End-to-End Flow Catalogue

> **Status:** authoritative test script. This catalogue enumerates every user/system flow
> across the Aegis platform as a numbered, recordable entry. It is the script that both the
> **annotated screen recordings** and the **scheduled testing / bug-hunting agents** follow.
> It is consistent with [`SPEC.md`](../../SPEC.md) (including **§10 Amendments — 2026-06-26**)
> and [`AGENTS.md`](../../AGENTS.md). When a flow conflicts with SPEC, SPEC wins — fix the flow.
>
> **Sibling docs:**
> [`../03-access-control-model.md`](../03-access-control-model.md) ·
> [`../04-multi-tenancy.md`](../04-multi-tenancy.md) ·
> [`../05-authn-authz-flow.md`](../05-authn-authz-flow.md) ·
> [`../06-service-to-service.md`](../06-service-to-service.md) ·
> [`../07-data-models.md`](../07-data-models.md) ·
> [`../08-api-conventions.md`](../08-api-conventions.md) ·
> [`../10-auditability-and-compliance.md`](../10-auditability-and-compliance.md) ·
> service docs under [`../services/`](../services/).
>
> **Wave 1–3 hardening surface:** the shared approval engine, transactional outbox + relay + DLQ,
> eventing-contract split, optimistic locking, idempotency-replay middleware, graceful shutdown,
> notification fan-out/preferences/SMS, ERP-via-consumer, and gateway upstream resilience are covered
> in depth by the executable companion plan [`FLOWS_v2.md`](./FLOWS_v2.md) (entries `FV2-NNN`, each
> marked `INT` code-level integration vs `E2E` Docker-gated). This baseline catalogue (FLOW-NNN) and
> FLOWS v2 together form the full test surface.

---

## How to read this catalogue

Every flow is a numbered entry **FLOW-NNN** with a fixed shape so a recorder, a human
reviewer, and an autonomous agent all read it the same way:

| Field | Meaning |
|---|---|
| **id / title** | Stable identifier (`FLOW-NNN`) + one-line name. Referenced by `BUGLOG.md`. |
| **Suite** | The logical grouping (see suite index below). |
| **Services** | Aegis apps/libs exercised: `user-management`, `expense`, `payroll`, `reporting`, `workflow`, `notification`, `invoice`, `gateway`, `cli`, and libs `@aegis/access-control`, `@aegis/db`, `@aegis/events`, `@aegis/connectors`. |
| **Preconditions / fixtures** | Seed data and prior flows that must have run. |
| **Steps** | Ordered actions: the API call (method + path), inputs, and **expected result** at each step. |
| **DB state to verify** | Rows/columns the agent asserts after the flow, including the audit hash chain. |
| **Access-control assertions** | Who **can** and who **cannot** perform the action (the PDP verdict matrix). The negative cases are mandatory. |
| **Recording spec** | What the annotated screen capture must show + the **on-screen caption track** so a viewer understands *what is happening*, *what is expected*, and *whether it passed*. |

### Platform conventions every flow inherits

- **Auth wrapper.** Every business route is `authenticate → authorize(permission, …) → handler`.
  Only `/health` and docs are unauthenticated. A missing/invalid token ⇒ `401`; an authenticated
  principal lacking the permission/scope ⇒ `403` with `{ errors: [{ code, type, message, details, traceId }] }`.
- **Tenant context.** The gateway mints **`X-Correlation-Id`** once per inbound business request and
  propagates it unchanged through every downstream hop and async message. Each service derives
  `tenantId`/`userId`/`roles` from the validated JWT into the AsyncLocalStorage `RequestContext`, and
  sets `SET LOCAL app.current_tenant` per transaction so **Postgres RLS** is the backstop. There is
  **no `X-Trend`/`X-Tracker`** header.
- **Strict header validation (s2s).** Internal hops assert required headers (`X-Tenant-Id`,
  `X-Correlation-Id`, `X-Caller`, `X-Internal-Origin`, `X-Source-Service`) and **fail closed** —
  never defaulted to `"UNKNOWN"`. There is **no `entryContext`**.
- **Money** is integer minor units; **IDs** are UUID v4; lists return `{ data, meta: { total, page, pageSize } }`.
- **Audit** rows are hash-chained (`prev_hash → entry_hash`), capturing actor, tenant, intent,
  decision, and permissions-at-time-of-action.
- **Idempotency.** Money/state-moving writes and event consumers carry an idempotency key; a replay
  is a no-op that returns the original result.

### Suite index

| Suite | Flows | Theme |
|---|---|---|
| **A. Platform & tenancy foundation** | FLOW-001 … FLOW-003 | Tenant onboarding, health, migrations |
| **B. Identity & sessions** | FLOW-010 … FLOW-014 | Invite, register, login, workspace switch, revoke |
| **C. Access-control core (PDP/PEP/PAP)** | FLOW-020 … FLOW-024 | Runtime role admin, allow vs deny, cross-tenant isolation |
| **D. Expense lifecycle** | FLOW-030 … FLOW-033 | Create → submit → approve → ERP push (connectors) |
| **E. Invoice lifecycle** | FLOW-040 … FLOW-042 | Create → duplicate detection → variance → approve |
| **F. Workflow & approvals** | FLOW-050 … FLOW-052 | Rule fires on event; multi-level approval chain |
| **G. Payroll (high-sensitivity)** | FLOW-060 … FLOW-064 | Draft → calculate → maker-checker approve → disburse; field masking |
| **H. Reporting** | FLOW-070 … FLOW-071 | Report run with column masking; scope-keyed cache |
| **I. Notification** | FLOW-080 … FLOW-081 | Idempotent delivery; ambient-authority guard |
| **J. Service-to-service & integrity** | FLOW-090 … FLOW-093 | Header validation, internal JWT, connector push, audit hash-chain verification |

A typical recording session runs the suites in order; flows within a suite share fixtures.

### On-screen annotation format (applies to every recording spec)

Each recording carries a **caption track** with four caption kinds, shown as lower-third banners:

- **`TITLE`** — flow id + title, shown for the first 2 s.
- **`STEP`** — what is being done right now ("Submitting expense report ER-1042").
- **`EXPECT`** — the expected result, shown *before* the response renders ("Expect 200; status → submitted").
- **`VERDICT`** — `PASS` (green) or `FAIL` (red) with the asserted fact ("PASS — status=submitted, audit chain intact").

Captions are sourced verbatim from each flow's **Recording spec → captions** list so recordings stay
in lock-step with this document.

---

## Suite A — Platform & tenancy foundation

### FLOW-001 — Platform bootstrap & migration (cli)

- **Suite:** A. Platform & tenancy foundation
- **Services:** `cli`, `@aegis/db`, all service schemas
- **Preconditions / fixtures:** Fresh Postgres + Redis (via `scripts/dev-up.sh`). No app data.
- **Steps:**
  1. Run the migration process: `PROCESS_TYPE=migration` one-shot container.
     **Expect:** Umzug applies every numbered migration `NNNN_subject.ts` top-to-bottom; exit 0.
  2. Confirm the RLS posture: the migrations create the app DB role as a **non-owner without
     `BYPASSRLS`**, and every tenant-scoped table has `ENABLE` + `FORCE ROW LEVEL SECURITY` with a
     `RESTRICTIVE` policy `USING (tenant_id = current_setting('app.current_tenant')::uuid)`.
     **Expect:** `pg_policies` lists a restrictive tenant policy per table; `rolbypassrls = false`.
  3. `GET /health?details=true` on each service.
     **Expect:** `200` with `db`, `cache`, `bus` all `up`; readiness only flips after deps are ready.
- **DB state to verify:**
  - `SequelizeMeta`/Umzug ledger contains one row per migration, in order.
  - `SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user` ⇒ `false`.
  - `SELECT count(*) FROM pg_policies WHERE policyname LIKE '%tenant%'` ⇒ one per tenant table.
- **Access-control assertions:**
  - **Can:** the migration runner (owner role) creates schema.
  - **Cannot:** the runtime app role cannot `ALTER`/own tables and cannot bypass RLS.
- **Recording spec:**
  - **Show:** the migration container log scrolling, then a `psql` panel querying `pg_policies` and `pg_roles`.
  - **Captions:**
    - `TITLE` — "FLOW-001 — Platform bootstrap & migration"
    - `STEP` — "Running Umzug migrations (PROCESS_TYPE=migration)"
    - `EXPECT` — "Expect exit 0; FORCE RLS + non-owner app role"
    - `VERDICT` — "PASS — all migrations applied, rolbypassrls=false, restrictive policies present"

### FLOW-002 — Tenant onboarding (provision an organization)

- **Suite:** A. Platform & tenancy foundation
- **Services:** `user-management` (PAP), `@aegis/access-control`, `@aegis/db`, `@aegis/events`
- **Preconditions / fixtures:** Platform bootstrapped (FLOW-001). A **platform operator** token
  with `tenant.manage`. No tenant yet.
- **Steps:**
  1. `POST /v1/tenants` `{ "name": "Northwind Logistics", "baseCurrency": "USD", "defaultLocale": "en-US" }`.
     **Expect:** `201`; body `{ data: { id, name, status: "active" } }`. A new `tenant_id` (UUID v4).
  2. The handler seeds **system roles** for the tenant (e.g. `TenantAdmin`, `Approver`, `Member`,
     `Auditor`) by linking the seeded `permissions` catalog through `role_permissions`.
     **Expect:** seeded roles visible at `GET /v1/roles` (scoped to the new tenant).
  3. `@aegis/events` publishes `identity.tenant.created`; `notification` consumes it for the welcome notice.
     **Expect:** one consumed event, one notification row.
- **DB state to verify:**
  - `tenants` has the new row; `status = 'active'`.
  - `roles` rows for the tenant (system roles, `tenant_id` set); `role_permissions` populated.
  - `audit_log` has an `identity.tenant.created` entry whose `entry_hash` chains from the prior tail.
- **Access-control assertions:**
  - **Can:** platform operator with `tenant.manage`.
  - **Cannot:** any tenant-scoped user (no `tenant.manage`) ⇒ `403`. A second tenant's admin cannot
    see or mutate this tenant's roles (RLS + scope) ⇒ `403`/empty.
- **Recording spec:**
  - **Show:** the `POST /v1/tenants` request/response, then `GET /v1/roles` listing seeded roles, then the audit row.
  - **Captions:**
    - `TITLE` — "FLOW-002 — Tenant onboarding"
    - `STEP` — "Provisioning tenant 'Northwind Logistics'"
    - `EXPECT` — "Expect 201; system roles seeded; tenant.created audited"
    - `VERDICT` — "PASS — tenant active, 4 system roles seeded, audit chained"

### FLOW-003 — Health, readiness, and graceful dependency failure

- **Suite:** A. Platform & tenancy foundation
- **Services:** every app, `gateway`
- **Preconditions / fixtures:** Platform up (FLOW-001).
- **Steps:**
  1. `GET /health` on the gateway and each service. **Expect:** `200` `{ status: "ok" }`.
  2. `GET /health?details=true`. **Expect:** per-dependency `db`/`cache`/`bus` statuses.
  3. **Fault inject:** stop Redis; re-probe readiness. **Expect:** readiness `503` (not ready); the
     service stops accepting traffic but liveness stays `200` (no crash loop). Restore Redis ⇒ readiness recovers.
- **DB state to verify:** none (health is stateless); confirm no orphaned writes during the outage.
- **Access-control assertions:** `/health` is the only unauthenticated route; an authenticated probe is **not** required.
- **Recording spec:**
  - **Show:** healthy probe, the Redis stop, the readiness flip to `503`, then recovery.
  - **Captions:**
    - `TITLE` — "FLOW-003 — Health & graceful degradation"
    - `STEP` — "Stopping Redis to test readiness gating"
    - `EXPECT` — "Expect readiness 503, liveness 200, recovery on restore"
    - `VERDICT` — "PASS — traffic gated while dep down, recovered cleanly"

---

## Suite B — Identity & sessions

### FLOW-010 — User invite (PAP issues an invitation)

- **Suite:** B. Identity & sessions
- **Services:** `user-management`, `notification`, `@aegis/events`
- **Preconditions / fixtures:** Tenant from FLOW-002. A `TenantAdmin` with `user.invite`.
- **Steps:**
  1. `POST /v1/invites` `{ "email": "dana@northwind.example", "roleId": "<Approver role id>" }`.
     **Expect:** `201`; `invites` row `status = 'pending'` with a single-use token (hashed at rest).
  2. The response includes a one-time raw token while the row stores only `token_hash`.
     **Expect:** token present in the response; no raw token persisted.
- **DB state to verify:** `invites(status='pending', tenant_id=…, role_id=…, token_hash=sha256(token))`.
- **Access-control assertions:**
  - **Can:** `TenantAdmin` (`user.invite`).
  - **Cannot:** `Member` (no `user.invite`) ⇒ `403`. Cannot invite into **another** tenant ⇒ scope `403`.
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-010 — User invite"
    - `STEP` — "Admin invites dana@northwind.example as Approver"
    - `EXPECT` — "Expect 201; pending invite; raw token returned once"
    - `VERDICT` — "PASS — invite pending; token stored as hash"

### FLOW-011 — Register against an invite

- **Suite:** B. Identity & sessions
- **Services:** `user-management`
- **Preconditions / fixtures:** Pending invite (FLOW-010).
- **Steps:**
  1. `POST /v1/auth/register` `{ "inviteToken": "<token>", "password": "…", "displayName": "Dana R." }`.
     **Expect:** `201`; creates a `users` row and a `memberships` row for `(user, tenant)` with
     `active_workspace = true`; the invite flips `status = 'accepted'`.
  2. The invited role is bound via `user_roles(user_id, tenant_id, role_id, scope)`.
     **Expect:** Dana now resolves to "current tenant + Approver role".
- **DB state to verify:** `users` (1), `memberships(active_workspace=true)`, `user_roles` (Approver),
  `invites(status='accepted')`, audit `identity.user.registered` + `identity.membership.created`.
- **Access-control assertions:**
  - **Can:** anyone holding a valid, unexpired, unused invite token.
  - **Cannot:** a reused token ⇒ `409`/`410`; an expired token ⇒ `403`. Registration cannot self-assign
    a role not named in the invite.
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-011 — Register against invite"
    - `STEP` — "Redeeming invite token; creating user + membership"
    - `EXPECT` — "Expect 201; invite→accepted; Approver bound"
    - `VERDICT` — "PASS — user+membership created, single-use token consumed"

### FLOW-012 — Login & token issuance (reference IdP)

- **Suite:** B. Identity & sessions
- **Services:** `gateway`, `user-management` (IdP)
- **Preconditions / fixtures:** Registered user (FLOW-011).
- **Steps:**
  1. `POST /v1/auth/login` `{ "email": "dana@northwind.example", "password": "…" }`.
     **Expect:** `200`; a short-lived JWT with claims `sub`, `tenant_id`, `roles`, `aud`, `exp`, and
     `jti`; a server-side `sessions` row is created with the same `jti`.
  2. Call a protected route through the gateway with the token. **Expect:** gateway validates at the
     edge; the service re-validates the token and checks `aud` ⇒ `200`.
  3. Tamper with the token signature and retry. **Expect:** `401` at the edge.
- **DB state to verify:** `sessions(status='active', jti=token.jti)` row; login audit entry.
- **Access-control assertions:**
  - **Can:** correct credentials.
  - **Cannot:** wrong password ⇒ `401`; a token whose `aud` does not match the target service ⇒ `401`;
    a revoked session token (see FLOW-014) ⇒ `401`.
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-012 — Login & token issuance"
    - `STEP` — "Logging in; minting RS256 JWT (aud per-service)"
    - `EXPECT` — "Expect 200 + session row; tampered token → 401"
    - `VERDICT` — "PASS — token validates at edge & service, tamper rejected"

### FLOW-013 — Workspace switch (multi-tenant membership)

- **Suite:** B. Identity & sessions
- **Services:** `user-management`
- **Preconditions / fixtures:** A user with **two** memberships (member of tenant A and tenant B).
- **Steps:**
  1. `POST /v1/memberships/active` `{ "tenantId": "<B>" }`.
     **Expect:** `200`; `active_workspace` moves to B (exactly one active per user); a re-issued token
     now carries `tenant_id = B` and B's roles.
- **DB state to verify:** exactly one `memberships` row with `active_workspace = true` per user; audit
  `identity.workspace.switched`.
- **Access-control assertions:**
  - **Can:** a user switch to a tenant they are a member of.
  - **Cannot:** switch to a tenant they have **no** membership in ⇒ `403`. After switching to B, the same
    token cannot read A's data (RLS).
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-013 — Workspace switch"
    - `STEP` — "Switching active workspace A → B"
    - `EXPECT` — "Expect token re-scoped to B; A data now invisible"
    - `VERDICT` — "PASS — single active membership, scope follows the switch"

### FLOW-014 — Session revocation row

- **Suite:** B. Identity & sessions
- **Services:** `user-management`, `gateway`
- **Preconditions / fixtures:** A logged-in session (FLOW-012).
- **Steps:**
  1. `DELETE /v1/sessions/{id}` (admin with `session.revoke`).
     **Expect:** `200`; `sessions.status = 'revoked'` and `revoked_at` is set.
  2. Reuse the now-revoked token on any route. **Expect:** currently still cryptographic-JWT behavior;
     per-request session introspection is a production hardening hook.
- **DB state to verify:** `sessions.status = 'revoked'`; audit/event wiring is planned hardening.
- **Access-control assertions:**
  - **Can:** the session owner; an admin with `session.revoke`.
  - **Cannot:** revoke **another** user's session without `session.revoke`; cross-tenant revoke ⇒ `403`.
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-014 — Instant session revocation"
    - `STEP` — "Revoking active session; replaying old token"
    - `EXPECT` — "Expect 200 revoke; replay → 401 before JWT exp"
    - `VERDICT` — "PASS — revocation is immediate, not exp-bound"

---

## Suite C — Access-control core (PDP / PEP / PAP)

### FLOW-020 — Define a custom role at runtime (PAP)

- **Suite:** C. Access-control core
- **Services:** `user-management` (PAP), `@aegis/access-control`
- **Preconditions / fixtures:** Tenant + `TenantAdmin` with `role.create` / `permission.manage`.
- **Steps:**
  1. `POST /v1/roles` `{ "name": "RegionalApprover", "permissions": ["expense.report.read", "expense.report.approve"] }`.
     **Expect:** `201`; `roles(tenant_id=…)` + `role_permissions` rows; **no policy-engine grouping hack** —
     the join table is the single source of truth.
  2. `GET /v1/roles/{id}` reflects the exact permission set.
- **DB state to verify:** `roles` custom row (`tenant_id` non-null); `role_permissions` two rows; audit
  `identity.role.updated`.
- **Access-control assertions:**
  - **Can:** `TenantAdmin` (`role.create`).
  - **Cannot:** grant a permission not present in the catalog ⇒ `422`; create a role in another tenant ⇒ `403`.
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-020 — Define custom role (PAP)"
    - `STEP` — "Creating role 'RegionalApprover' with 2 permissions"
    - `EXPECT` — "Expect 201; role_permissions is the source of truth"
    - `VERDICT` — "PASS — runtime role created, catalog-validated, audited"

### FLOW-021 — Assign & revoke a custom role at runtime

- **Suite:** C. Access-control core
- **Services:** `user-management` (PAP), `@aegis/access-control` (PIP cache)
- **Preconditions / fixtures:** Custom role (FLOW-020); target user Dana (FLOW-011).
- **Steps:**
  1. `POST /v1/users/{danaId}/roles` `{ "roleId": "<RegionalApprover>", "scope": "OwnAndTeam" }`.
     **Expect:** `201`; `user_roles` row. The PIP cache is invalidated so the **next** decision sees it.
  2. Dana calls `expense.report.approve` — now **allowed** (see FLOW-022).
  3. `DELETE /v1/users/{danaId}/roles/{roleId}`. **Expect:** `204`; the grant is gone; cache invalidated.
  4. Dana retries the approve — now **denied** `403`.
- **DB state to verify:** `user_roles` appears then disappears; audit `identity.role.assigned` then
  `identity.role.revoked`, each carrying `permissions-at-time-of-action`.
- **Access-control assertions:**
  - **Can:** `TenantAdmin` with `role.assign`.
  - **Cannot:** a user assign themselves a role (no `role.assign`) ⇒ `403`; assign a role from another tenant ⇒ `403`.
- **Recording spec:**
  - **Show:** the same protected call transitioning **deny → allow → deny** across the grant/revoke.
  - **Captions:**
    - `TITLE` — "FLOW-021 — Assign & revoke role at runtime"
    - `STEP` — "Granting RegionalApprover to Dana, then revoking it"
    - `EXPECT` — "Expect approve to flip allow→deny when grant removed"
    - `VERDICT` — "PASS — runtime PAP changes take effect immediately (cache invalidated)"

### FLOW-022 — Allowed authorization decision (RBAC + ABAC)

- **Suite:** C. Access-control core
- **Services:** target service (`expense`), `@aegis/access-control` (PDP/PEP)
- **Preconditions / fixtures:** Dana holds `RegionalApprover` with scope `OwnAndTeam`; a submitted report
  owned by a member of Dana's team, amount within the ABAC approval limit.
- **Steps:**
  1. `POST /expense/v1/reports/{id}/approve`.
     **Expect:** PEP loads the resource, calls `decide(principal, action, resource, context)`; the PDP
     returns `{ allow: true, reason, obligations: [] }` because **RBAC** grants `expense.report.approve`
     **and** the **ABAC** condition (own-team ownership + amount ≤ limit) holds. `200`.
- **DB state to verify:** report `status = approved`; `expense_approvals` decision row; audit
  `expense.report.approved` with `decision = allow` and the permission set captured.
- **Access-control assertions:**
  - **Can:** Dana for an **own-team** report under the limit.
  - **Cannot:** Dana for a report **outside** her team (scope) ⇒ `403`; Dana for an amount **over** her
    approval limit (ABAC) ⇒ `403` with `reason = "amount exceeds approver limit"`.
- **Recording spec:**
  - **Show:** the PDP decision object (allow + reason) alongside the `200`.
  - **Captions:**
    - `TITLE` — "FLOW-022 — Allowed decision (RBAC+ABAC)"
    - `STEP` — "Dana approves an own-team report under her limit"
    - `EXPECT` — "Expect allow=true; RBAC grants, ABAC condition holds"
    - `VERDICT` — "PASS — 200, decision allow, audited with reason"

### FLOW-023 — Denied authorization decision (fail-closed)

- **Suite:** C. Access-control core
- **Services:** `expense`, `@aegis/access-control`
- **Preconditions / fixtures:** A `Member` (no approve permission); a report over the approver limit.
- **Steps:**
  1. A `Member` calls `POST /expense/v1/reports/{id}/approve`.
     **Expect:** `403`; PDP `{ allow: false, reason: "missing permission expense.report.approve" }`.
  2. An `Approver` calls approve on a report **above** their `approval_limit`.
     **Expect:** `403`; PDP `{ allow: false, reason: "amount exceeds approver limit" }`.
  3. **PIP unavailable** simulation (attribute store error). **Expect:** PDP **fails closed** ⇒ `403`,
     never a default-allow.
- **DB state to verify:** **no** status change on the report; audit row with `decision = deny` and the reason.
- **Access-control assertions:** the deny cases above are the assertion; confirm **no obligations** leaked
  data and the response envelope carries `traceId`.
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-023 — Denied decision (fail-closed)"
    - `STEP` — "Member approves (no perm); Approver approves over limit; PIP down"
    - `EXPECT` — "Expect 403 in all three; PDP fails closed"
    - `VERDICT` — "PASS — denied with reasons, no state change, no leak"

### FLOW-024 — Cross-tenant isolation attempt (MUST fail)

- **Suite:** C. Access-control core
- **Services:** any tenant-scoped service (use `expense`), `@aegis/db` (RLS)
- **Preconditions / fixtures:** Two tenants A and B, each with their own report. A user authenticated to **A**.
- **Steps:**
  1. User A requests **B's** report id directly: `GET /expense/v1/reports/{B_report_id}`.
     **Expect:** `404` (RLS makes B's row invisible; we return not-found, not forbidden, to avoid
     confirming existence). The query predicate AND `SET LOCAL app.current_tenant = A` both exclude it.
  2. **Forge attempt:** craft a request with `X-Tenant-Id: B` but an **A**-scoped JWT.
     **Expect:** rejected — the tenant is derived from the **validated token**, not the header; the
     mismatch fails closed `401/403`. RLS still keyed to A regardless.
  3. **Direct DB probe:** with the app role, `SELECT * FROM expense_reports WHERE id = '<B_report_id>'`
     under `app.current_tenant = A`. **Expect:** **0 rows** — RLS filters it even for a raw query.
- **DB state to verify:** no cross-tenant read succeeds at API or SQL layer; audit records the denied attempt.
- **Access-control assertions:**
  - **Cannot (the whole point):** no principal in A can read, list, or mutate any B-owned row by id, by
    header forgery, or by raw SQL under the app role.
- **Recording spec:**
  - **Show:** the `404`, the header-forgery rejection, and the `psql` `0 rows` under RLS — three panels.
  - **Captions:**
    - `TITLE` — "FLOW-024 — Cross-tenant isolation (must fail)"
    - `STEP` — "Tenant-A user fetches Tenant-B record by id, by header, by SQL"
    - `EXPECT` — "Expect 404 / 401 / 0-rows — isolation holds at every layer"
    - `VERDICT` — "PASS — RLS + token-derived tenant block all three vectors"

---

## Suite D — Expense lifecycle

### FLOW-030 — Create expense report & items (draft)

- **Suite:** D. Expense lifecycle
- **Services:** `expense`
- **Preconditions / fixtures:** Tenant; a `Member` (submitter) with `expense.report.create` / `expense.item.create`.
- **Steps:**
  1. `POST /expense/v1/reports` `{ "name": "Q3 travel", "periodStart": "…", "periodEnd": "…" }`.
     **Expect:** `201`; `expense_reports` row `status = draft`, `report_number` from the **per-tenant** sequence.
  2. `POST /expense/v1/reports/{id}/items` (×N) — user-entered items `{ amountMinor, currency, merchant, date, description }`.
     **Expect:** `201` each; `expenses` rows; `total_amount_minor` rolls up. *(No GL codes, no extracted line items — §10.1.)*
- **DB state to verify:** `expense_reports(status='draft')`; `expenses` rows; `total_amount_minor` = Σ items;
  audit `expense.report.created` + `expense.item.create`.
- **Access-control assertions:**
  - **Can:** the owner.
  - **Cannot:** another member edit **this** draft (`OwnOnly` scope) ⇒ `403`; create an item on a
    submitted report ⇒ `409`.
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-030 — Create expense report (draft)"
    - `STEP` — "Creating report 'Q3 travel' + 3 items"
    - `EXPECT` — "Expect 201; status=draft; total rolls up; no GL/line-extract"
    - `VERDICT` — "PASS — draft created, totals correct, owner-only edit"

### FLOW-031 — Submit → enters shared approval engine

- **Suite:** D. Expense lifecycle
- **Services:** `expense`, `workflow`/shared approval engine, `@aegis/events`, `notification`
- **Preconditions / fixtures:** Draft report (FLOW-030).
- **Steps:**
  1. `POST /expense/v1/reports/{id}/submit`.
     **Expect:** `200`; `status: draft → submitted → in_approval`; `submitted_at` set; an approval
     instance is opened against the tenant's `approval_policies`. `expense.report.submitted` published.
  2. `notification` consumes the event and notifies the first-level approver.
     **Expect:** notification row for the approver.
- **DB state to verify:** `expense_reports(status='in_approval')`; `approvals`/`approval_progress_log`
  opened at level 1; audit `expense.report.submitted`.
- **Access-control assertions:**
  - **Can:** the **submitter** (`expense.report.submit`).
  - **Cannot:** a non-owner submit someone else's draft ⇒ `403`; re-submit an `in_approval` report ⇒ `409`
    (state-machine guard).
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-031 — Submit report"
    - `STEP` — "Submitting ER; opening approval instance"
    - `EXPECT` — "Expect 200; status→in_approval; approver notified"
    - `VERDICT` — "PASS — state transition gated, approval opened, event fired"

### FLOW-032 — Approve → ERP push via connector framework

- **Suite:** D. Expense lifecycle
- **Services:** `expense`, `@aegis/connectors` (MOCK connector), `@aegis/events`
- **Preconditions / fixtures:** `in_approval` report (FLOW-031); approver with `expense.report.approve`;
  the tenant has a connector bound (e.g. **LedgerOne** mock).
- **Steps:**
  1. `POST /expense/v1/reports/{id}/approve`.
     **Expect:** `200`; `status → approved`; `expense_approvals` decision row; `expense.report.approved` published.
  2. On approval, expense calls `@aegis/connectors` to **push** the approved header to the tenant's bound
     ERP via the pluggable adapter (a MOCK connector emulating the auth handshake + push). The push carries
     an **idempotency key**; s2s headers + internal JWT apply (Suite J).
     **Expect:** `connector.push.acknowledged`; the connector's idempotent push log records `synced`.
  3. **Replay** the same push (same idempotency key). **Expect:** no duplicate ERP record — the log
     returns the original ack.
- **DB state to verify:** `expense_reports(status='approved', synced_at set)`; connector push log row
  `status = synced` with the idempotency key; audit `expense.report.approved` + `connector.push.acknowledged`.
- **Access-control assertions:**
  - **Can:** an approver in scope for an own-team report under the limit.
  - **Cannot:** the **submitter** approve their own report (unless self-manager rule applies) ⇒ `403`;
    push to an ERP not bound to the tenant ⇒ rejected by the connector registry.
- **Recording spec:**
  - **Show:** the approve `200`, the connector adapter log (mock handshake + push), then the replay no-op.
  - **Captions:**
    - `TITLE` — "FLOW-032 — Approve → ERP push (connectors)"
    - `STEP` — "Approving ER; pushing header to LedgerOne (mock) with idempotency key"
    - `EXPECT` — "Expect 200; push acknowledged; replay is a no-op"
    - `VERDICT` — "PASS — pushed once, idempotent on replay, synced_at set"

### FLOW-033 — Reject → reopen → resubmit

- **Suite:** D. Expense lifecycle
- **Services:** `expense`, shared approval engine
- **Preconditions / fixtures:** `in_approval` report; an approver.
- **Steps:**
  1. `POST /expense/v1/reports/{id}/reject` `{ "comment": "missing receipt" }`.
     **Expect:** `200`; `status → rejected`; decision row with comment.
  2. Submitter `POST …/reopen` ⇒ `status → draft`; edit; `…/submit` again ⇒ `in_approval`.
     **Expect:** the report re-enters approval at level 1.
- **DB state to verify:** decision row `rejected`; status walks `rejected → draft → in_approval`; audit chain across all.
- **Access-control assertions:**
  - **Cannot:** mutate an `approved` (terminal-ish) report back to draft ⇒ `409`; a non-submitter reopen ⇒ `403`.
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-033 — Reject, reopen, resubmit"
    - `STEP` — "Rejecting with comment; submitter reopens & resubmits"
    - `EXPECT` — "Expect status rejected→draft→in_approval; approved is locked"
    - `VERDICT` — "PASS — state machine enforces legal transitions only"

---

## Suite E — Invoice lifecycle (header-level)

### FLOW-040 — Create invoice (header) → routed to review

- **Suite:** E. Invoice lifecycle
- **Services:** `invoice`, `@aegis/events`
- **Preconditions / fixtures:** Tenant; an AP clerk with `invoice.create`.
- **Steps:**
  1. `POST /invoice/v1/invoices` `{ "vendorName": "Acme Freight", "invoiceNumber": "INV-7781", "amountMinor": 125000, "currency": "USD", "poReference": "PO-55" (optional) }`.
     **Expect:** `201`; `invoices` row `status = received`. *(Header-level only — no line items, no GL codes, §10.)*
  2. Clean header within tolerance vs the optional PO ⇒ `received → under_review` (routed to approval).
     **Expect:** `invoice.received` published; approval instance opened.
- **DB state to verify:** `invoices(status='under_review')`; `invoice_metadata`; audit `invoice.received`.
- **Access-control assertions:**
  - **Can:** AP clerk (`invoice.create`).
  - **Cannot:** a `Member` create an invoice ⇒ `403`; cross-tenant create ⇒ `403`.
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-040 — Create invoice (header)"
    - `STEP` — "Creating header INV-7781 for Acme Freight"
    - `EXPECT` — "Expect 201; status received→under_review; no line items"
    - `VERDICT` — "PASS — header created, routed to review"

### FLOW-041 — Duplicate detection (MUST catch the second one)

- **Suite:** E. Invoice lifecycle
- **Services:** `invoice`
- **Preconditions / fixtures:** Invoice INV-7781 exists (FLOW-040).
- **Steps:**
  1. `POST /invoice/v1/invoices` with the **same** `(vendorName, invoiceNumber, amountMinor)`.
     **Expect:** `201`/`200` but `status = duplicate` — the duplicate gate
     `(tenant_id, vendor_name, invoice_number, amount_minor)` matches an existing header; an
     `invoice_duplicates` link row is written.
  2. Resolve: `POST …/{id}/dismiss-duplicate` (not a dup) ⇒ `under_review`; **or** `…/confirm-duplicate` ⇒ `void`.
     **Expect:** the chosen transition; the **original** is untouched.
- **DB state to verify:** `invoice_duplicates` link; second invoice `status` ∈ {`duplicate`→`void`|`under_review`};
  audit `invoice.duplicate.detect`.
- **Access-control assertions:**
  - **Can:** AP clerk to create; an AP supervisor with `invoice.duplicate.detect`/resolve to dismiss/confirm.
  - **Cannot:** confirm/dismiss a duplicate in another tenant ⇒ `403`.
- **Recording spec:**
  - **Show:** the second create flagged `duplicate`, the link row, and a resolve transition.
  - **Captions:**
    - `TITLE` — "FLOW-041 — Duplicate detection"
    - `STEP` — "Re-submitting identical vendor+number+amount"
    - `EXPECT` — "Expect status=duplicate; original untouched; resolvable to void/review"
    - `VERDICT` — "PASS — duplicate caught & linked, original intact"

### FLOW-042 — Variance hold & approve

- **Suite:** E. Invoice lifecycle
- **Services:** `invoice`, shared approval engine, `@aegis/events`
- **Preconditions / fixtures:** A clean invoice in `under_review`; per-tenant variance tolerance configured.
- **Steps:**
  1. Submit a header whose `amountMinor` exceeds the PO reference beyond tolerance ⇒ `received → variance_hold`.
     **Expect:** `invoice.approval.required` published; held pending override.
  2. A supervisor overrides/accepts the variance ⇒ `variance_hold → under_review`.
  3. Approver `POST …/{id}/approve` ⇒ `under_review → approved`; later `→ paid` on settlement.
     **Expect:** `invoice.approve` audited; `status = approved`.
- **DB state to verify:** status walks `variance_hold → under_review → approved`; `invoice_approvals` row; audit chain.
- **Access-control assertions:**
  - **Can:** supervisor override variance; approver approve.
  - **Cannot:** an AP clerk approve (no `invoice.approve`) ⇒ `403`; approve while still in `variance_hold` ⇒ `409`.
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-042 — Variance hold & approve"
    - `STEP` — "Header over PO tolerance → variance_hold → override → approve"
    - `EXPECT` — "Expect hold, then approve only after override"
    - `VERDICT` — "PASS — threshold/variance gate enforced before approval"

---

## Suite F — Workflow & approvals

### FLOW-050 — Workflow rule fires on a domain event

- **Suite:** F. Workflow & approvals
- **Services:** `workflow`, `@aegis/events`, `notification`
- **Preconditions / fixtures:** Tenant admin with `workflow.rule.create`. A rule:
  *when `expense.report.submitted` AND `total_amount_minor > 500000` → action: notify finance + escalate level*.
- **Steps:**
  1. `POST /workflow/v1/rules` with `rule_steps` (`{field, operator, value, conjunction}`) + `rule_actions`.
     **Expect:** `201`; rule active.
  2. Trigger by submitting a large expense report (FLOW-031 with amount > 5,000.00).
     **Expect:** the engine evaluates conditions in order; on match, runs the action; a
     `rule_audit_logs` row records the firing; `notification` produces the finance notice.
  3. Submit a **small** report. **Expect:** the rule does **not** fire (condition false) — recorded as evaluated-no-match.
- **DB state to verify:** `rules` + `rule_steps` + `rule_actions`; `rule_audit_logs` shows one fire (large)
  and one no-match (small); audit chain intact.
- **Access-control assertions:**
  - **Can:** admin with `workflow.rule.create`.
  - **Cannot:** a `Member` create/run rules ⇒ `403`; a rule in tenant A cannot read tenant B events (RLS + scope).
- **Recording spec:**
  - **Show:** rule creation, the large submit firing the action (notification appears), and the small submit not firing.
  - **Captions:**
    - `TITLE` — "FLOW-050 — Rule fires on event"
    - `STEP` — "Submitting large report to trip the >5,000 rule"
    - `EXPECT` — "Expect rule fires on large, no-match on small; both audited"
    - `VERDICT` — "PASS — conditions evaluated as data, action ran once"

### FLOW-051 — Multi-level approval chain

- **Suite:** F. Workflow & approvals
- **Services:** shared approval engine, `expense` (or `invoice`), `notification`
- **Preconditions / fixtures:** `approval_hierarchy` with **two** levels (L1 manager, L2 finance);
  `record_approvers` thresholds set; a submitted high-value report.
- **Steps:**
  1. Submit ⇒ approval opens at **L1**. L1 approver approves.
     **Expect:** `approval_progress_log` advances L1→done; instance moves to **L2** (not yet final).
  2. L2 finance approves. **Expect:** all required levels complete ⇒ record `status → approved`.
  3. **Negative:** at L2, instead **reject** ⇒ record `→ rejected`, chain halts; remaining levels skipped.
- **DB state to verify:** `approval_progress_log` shows ordered level completion; the record flips to
  `approved` only after the **last** required level; on reject it halts immediately.
- **Access-control assertions:**
  - **Can:** only the **assigned** approver for each level (by user/role/team/persona in `approver_group_members`).
  - **Cannot:** L2 approve before L1 completes ⇒ `409`; an out-of-chain user approve any level ⇒ `403`;
    the same person satisfy two distinct required levels if policy forbids it.
- **Recording spec:**
  - **Show:** the progress log advancing L1→L2→approved; then a separate run where L2 rejects and halts.
  - **Captions:**
    - `TITLE` — "FLOW-051 — Multi-level approval chain"
    - `STEP` — "L1 approves → L2 approves → final; then a reject at L2"
    - `EXPECT` — "Expect approved only after last level; reject halts chain"
    - `VERDICT` — "PASS — ordered levels enforced, per-level approver gated"

### FLOW-052 — Delegated approval (sub + act)

- **Suite:** F. Workflow & approvals
- **Services:** shared approval engine, `@aegis/access-control`
- **Preconditions / fixtures:** An approver who delegates to a deputy via a delegation token (`sub` = approver, `act` = deputy).
- **Steps:**
  1. The deputy approves using the delegated token. **Expect:** `200`; the decision records **both**
     the principal (`sub`) and the actor (`act`) for audit attribution.
- **DB state to verify:** decision/audit row carries delegation (`sub`+`act`); the approval counts toward the delegator's authority.
- **Access-control assertions:**
  - **Can:** the deputy **only** within the delegated scope/expiry.
  - **Cannot:** the deputy act outside the delegation window or on records outside the delegated scope ⇒ `403`.
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-052 — Delegated approval (sub+act)"
    - `STEP` — "Deputy approves on behalf of approver via delegation token"
    - `EXPECT` — "Expect 200; audit shows sub (delegator) + act (deputy)"
    - `VERDICT` — "PASS — delegation attributed, scope/expiry enforced"

---

## Suite G — Payroll (high-sensitivity PII)

### FLOW-060 — Onboard employee with encrypted fields

- **Suite:** G. Payroll
- **Services:** `payroll`, `@aegis/db`
- **Preconditions / fixtures:** Tenant; a `PayrollAdmin` with `payroll.employee` write.
- **Steps:**
  1. `POST /payroll/v1/employees` `{ … bankAccount, nationalId … }` + a contract `{ baseAmountMinor, currency, payFrequency }`.
     **Expect:** `201`; `employees.bank_account_enc` / `national_id_enc` and `contracts.base_amount_enc`
     hold **AES-256-GCM** envelopes — plaintext never lands in a column.
- **DB state to verify:** the `*_enc` columns are ciphertext envelopes (not readable plaintext); audit
  `payroll.employee` write with **no** sensitive plaintext in the audit payload.
- **Access-control assertions:**
  - **Can:** `PayrollAdmin`.
  - **Cannot:** a junior `Manager` write bank/national-id fields ⇒ `403`; any role read the raw `*_enc`
    without `payroll.sensitive.read` (see FLOW-063).
- **Recording spec:**
  - **Show:** the create, then a `psql` view of the `*_enc` column proving it's ciphertext.
  - **Captions:**
    - `TITLE` — "FLOW-060 — Onboard employee (encrypted PII)"
    - `STEP` — "Creating employee + contract with bank/national-id"
    - `EXPECT` — "Expect *_enc columns are AES-256 ciphertext, never plaintext"
    - `VERDICT` — "PASS — sensitive fields encrypted at field level"

### FLOW-061 — Pay run: draft → calculate

- **Suite:** G. Payroll
- **Services:** `payroll`
- **Preconditions / fixtures:** Employees with contracts + pay items; a `PayrollProcessor` with `payroll.input.create` and run-create.
- **Steps:**
  1. `POST /payroll/v1/pay-runs` `{ payCalendarId, periodStart, periodEnd, type: "regular" }` ⇒ `status = draft`.
  2. `POST /payroll/v1/pay-runs/{id}/calculate` ⇒ engine computes gross → taxable base → net per employee,
     resolving tax rules by **(jurisdiction, effective date)**; `status → calculated`; `payslips`/`payslip_lines` produced.
     **Expect:** `200`; `net_enc` stored encrypted; calculation is a reviewable draft.
- **DB state to verify:** `pay_runs(status='calculated')`; `payslips` (Σ checks: gross = base+earnings,
  net = gross − tax − post-tax deductions); `payslip_lines` per code; audit on the transition.
- **Access-control assertions:**
  - **Can:** `PayrollProcessor`.
  - **Cannot:** approve from `draft` (must `calculate` first) ⇒ `409`; a `Manager`/`Employee` trigger a calculate ⇒ `403`.
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-061 — Pay run draft → calculate"
    - `STEP` — "Creating draft run; calculating gross/tax/net"
    - `EXPECT` — "Expect status calculated; net_enc encrypted; tax by jurisdiction"
    - `VERDICT` — "PASS — calculation correct, results are a reviewable draft"

### FLOW-062 — Approve with maker-checker (segregation of duties)

- **Suite:** G. Payroll
- **Services:** `payroll`, `@aegis/access-control`
- **Preconditions / fixtures:** A `calculated` run created/edited by **Processor P**; a separate
  `PayrollApprover` **A** (A ≠ P).
- **Steps:**
  1. **Maker-checker violation:** P (the creator/editor) calls `POST …/{id}/approve`.
     **Expect:** `403` — the approver **must differ** from the input editor; reason
     `"approver must differ from run editor (segregation of duties)"`.
  2. Approver **A** approves. **Expect:** `200`; `status → approved`; the calculation is **snapshotted**
     (`locked_snapshot`) — an immutable boundary; further edits are blocked.
- **DB state to verify:** `pay_runs(status='approved', approved_by = A, approved_by ≠ created_by)`,
  `locked_snapshot` populated; audit `pay_run.approved` capturing both maker and checker identities.
- **Access-control assertions:**
  - **Can:** an approver who is **not** the maker.
  - **Cannot:** the maker self-approve (the headline assertion); a `Processor` approve at all (no approve permission) ⇒ `403`.
- **Recording spec:**
  - **Show:** P's approve denied with the SoD reason, then A's approve succeeding and the run locking.
  - **Captions:**
    - `TITLE` — "FLOW-062 — Maker-checker approval"
    - `STEP` — "Maker P tries to self-approve (denied), then checker A approves"
    - `EXPECT` — "Expect P→403 (SoD); A→200; run snapshot-locked"
    - `VERDICT` — "PASS — separation of duties enforced, calc snapshotted"

### FLOW-063 — Field masking on payslip read

- **Suite:** G. Payroll
- **Services:** `payroll`, `@aegis/access-control` (PEP obligations)
- **Preconditions / fixtures:** An approved run with payslips; three readers: an **Employee** (own
  payslip), a **Manager** (own team, no sensitive read), an **Auditor**/`PayrollAdmin` with `payroll.sensitive.read`.
- **Steps:**
  1. Employee `GET /payroll/v1/payslips/{ownId}` ⇒ `200`, **own** payslip; bank/national-id **masked**.
  2. Manager `GET …/{teamMemberId}` ⇒ `200` for own-team net summary, but salary/bank/national-id **masked**
     (PEP applies a **masking obligation** from the PDP).
  3. `PayrollAdmin` with `payroll.sensitive.read` ⇒ `200` with fields **unmasked**; every such read writes
     a `sensitive_read` audit entry.
- **DB state to verify:** for each masked read, **no** decrypt occurred / values returned masked; for the
  privileged read, an audit row with `sensitive_read = true` and the field list.
- **Access-control assertions:**
  - **Can:** Employee → own only; Manager → own team (masked); privileged role → unmasked + audited.
  - **Cannot:** Employee read **another** employee's payslip ⇒ `403`; Manager read outside their team ⇒ `403`;
    anyone get **unmasked** sensitive fields without `payroll.sensitive.read`.
- **Recording spec:**
  - **Show:** the same payslip rendered three ways (masked employee, masked manager, unmasked admin) + the sensitive-read audit row.
  - **Captions:**
    - `TITLE` — "FLOW-063 — Payslip field masking"
    - `STEP` — "Reading payslip as Employee, Manager, then privileged Admin"
    - `EXPECT` — "Expect bank/national-id masked except for sensitive.read; reads audited"
    - `VERDICT` — "PASS — masking obligation applied by role, privileged read audited"

### FLOW-064 — Disburse → ledger → settlement (idempotent)

- **Suite:** G. Payroll
- **Services:** `payroll`, `@aegis/connectors` (payment rail mock), `@aegis/events`, `notification`
- **Preconditions / fixtures:** An `approved` run (FLOW-062); a `FinanceDisburser` with `payroll.payment.disburse`.
- **Steps:**
  1. `POST /payroll/v1/pay-runs/{id}/disburse` with an `Idempotency-Key` header ⇒ `status → funding`;
     builds a `payment_batch` + `payments` (each with a UNIQUE idempotency key) and posts an
     **append-only double-entry** `ledger_entries` set (debit wage expense / credit cash + liabilities).
     **Expect:** `200`; no negative net pay; payment-rail credential stays server-side (key-proxy).
  2. **Settlement callback** `POST /payroll/v1/payments/{id}/status` `{ "status": "settled" }` ⇒ payslip `paid`;
     run `funding → paid`. A **returned** callback ⇒ `failed` + a reversal ledger entry.
  3. **Replay** the disburse with the same idempotency key. **Expect:** no double payment — returns the original batch.
- **DB state to verify:** `payments` (unique idempotency key), `payment_batch`, `ledger_entries`
  **append-only** (corrections are reversals, never edits); replay adds **no** new payment rows.
- **Access-control assertions:**
  - **Can:** `FinanceDisburser` only.
  - **Cannot:** the approver/maker also disburse if policy separates disbursement from approval ⇒ `403`;
    disburse a non-`approved` run ⇒ `409`.
- **Recording spec:**
  - **Show:** the disburse, the ledger rows (balanced), the settlement callback flipping to paid, and the idempotent replay no-op.
  - **Captions:**
    - `TITLE` — "FLOW-064 — Disburse → ledger → settle (idempotent)"
    - `STEP` — "Disbursing run; posting double-entry ledger; replaying key"
    - `EXPECT` — "Expect funding→paid; append-only ledger; replay pays nothing"
    - `VERDICT` — "PASS — exactly-once disbursement, ledger balanced & append-only"

---

## Suite H — Reporting

### FLOW-070 — Run a report with column masking

- **Suite:** H. Reporting
- **Services:** `reporting`, `@aegis/db` (RLS), `@aegis/access-control`
- **Preconditions / fixtures:** Fact tables populated (`fact_expense`/`fact_payroll`); a
  `report_definition` (declarative spec, not raw SQL); a `report_access_policy` with
  `allowed_columns` / `masked_columns` / `row_filter` per role; a finance role and a restricted HR role.
- **Steps:**
  1. `POST /reporting/v1/report-runs` `{ definitionId, params }` ⇒ `202 { runId }` (async).
  2. `GET /reporting/v1/report-runs/{runId}` ⇒ poll until `succeeded`.
  3. `GET …/{runId}/data` **as finance** ⇒ full columns within the tenant (RLS-scoped).
  4. The same run requested **as the restricted HR role** ⇒ `salary`/`bank` columns **masked or dropped**
     by the definition compiler **before** SQL is generated (never trust the client to omit).
- **DB state to verify:** `report_runs(status='succeeded', artifact_url)`; the compiled query carried the
  tenant RLS predicate and the role's column policy; an **as-of** freshness timestamp is surfaced.
- **Access-control assertions:**
  - **Can:** a role with `reporting.report.run` + `reporting.report.read` within its column policy.
  - **Cannot:** any role retrieve a **masked** column it is not entitled to; cross-tenant facts appear
    (RLS) ⇒ never; bypass RLS via the report path ⇒ never.
- **Recording spec:**
  - **Show:** the 202+poll, then the same run rendered for finance (full) vs HR (masked columns).
  - **Captions:**
    - `TITLE` — "FLOW-070 — Report run with column masking"
    - `STEP` — "Running def as Finance, then as restricted HR"
    - `EXPECT` — "Expect masked salary/bank for HR; columns dropped pre-SQL; RLS-scoped"
    - `VERDICT` — "PASS — column policy applied in compiler, tenant isolation intact"

### FLOW-071 — Scope-keyed result cache (no cross-user leakage)

- **Suite:** H. Reporting
- **Services:** `reporting`, Redis (result cache)
- **Preconditions / fixtures:** Two users in the **same** tenant with **different** row scopes
  (e.g. manager of cost-center X vs cost-center Y).
- **Steps:**
  1. User X runs report R ⇒ result cached under key `hash{tenantId, accessScope(X), defId, params}`.
  2. User Y runs the **same** definition R with the same params.
     **Expect:** a **different** cache key (scope differs) ⇒ Y gets **Y's** rows, never a cache hit on X's data.
  3. A source event/CDC update (or TTL) invalidates the relevant entries.
- **DB/cache state to verify:** distinct Redis keys per access scope; no key collision across users; a
  TTL/invalidation aligned to refresh cadence.
- **Access-control assertions:**
  - **Cannot (the assertion):** the access scope is part of every cache key — Y can never receive X's
    cached rows even for an identical definition + params.
- **Recording spec:**
  - **Show:** two users, same report, the two distinct cache keys, and that each sees only their own scope.
  - **Captions:**
    - `TITLE` — "FLOW-071 — Scope-keyed report cache"
    - `STEP` — "Two same-tenant users run identical report at different scopes"
    - `EXPECT` — "Expect distinct cache keys; no cross-scope leakage"
    - `VERDICT` — "PASS — access scope in cache key, rows isolated per user"

---

## Suite I — Notification

### FLOW-080 — Idempotent notification delivery

- **Suite:** I. Notification
- **Services:** `notification`, `@aegis/events`
- **Preconditions / fixtures:** A consumer subscribed to `expense.report.approved`.
- **Steps:**
  1. Publish `expense.report.approved` (e.g. from FLOW-032). **Expect:** one `notifications` row +
     one `email_notification_logs(status='sent')`.
  2. **Redeliver** the same event (same idempotency/event id). **Expect:** **no** duplicate notification —
     the consumer is idempotent; the redelivery is a recorded no-op.
- **DB state to verify:** exactly **one** notification per logical event despite redelivery; the log shows
  the dedupe.
- **Access-control assertions:**
  - **Cannot:** `notification` **re-derive** authority — it consumes an already-authorized event and never
    makes its own access decision (guards ambient authority). A user reads only **own** inbox
    (`notification.inbox.read`) ⇒ cross-user inbox read `403`.
- **Recording spec:**
  - **Show:** the first delivery, the redelivery, and that the count stays at 1.
  - **Captions:**
    - `TITLE` — "FLOW-080 — Idempotent notification"
    - `STEP` — "Delivering event, then redelivering the same event id"
    - `EXPECT` — "Expect exactly one notification; redelivery is a no-op"
    - `VERDICT` — "PASS — exactly-once delivery, no ambient re-authorization"

### FLOW-081 — In-app inbox scoping

- **Suite:** I. Notification
- **Services:** `notification`
- **Preconditions / fixtures:** Two users with notifications in the same tenant.
- **Steps:**
  1. User A `GET /notification/v1/inbox` ⇒ only A's notifications.
  2. A `PATCH …/{id}` to mark read ⇒ only A's items mutable.
- **DB state to verify:** list filtered to the caller; mark-read mutates only own rows.
- **Access-control assertions:**
  - **Cannot:** read or mutate **another** user's inbox item ⇒ `403`/`404`; cross-tenant inbox ⇒ RLS-blocked.
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-081 — Inbox scoping"
    - `STEP` — "User A lists & marks own inbox; tries B's item"
    - `EXPECT` — "Expect own-only visibility; B's item → 403/404"
    - `VERDICT` — "PASS — inbox strictly per-user within tenant"

---

## Suite J — Service-to-service & integrity

### FLOW-090 — Service-to-service call with strict header validation

- **Suite:** J. Service-to-service & integrity
- **Services:** any caller → callee (use `reporting` → `payroll` read), `@aegis/service-core`
- **Preconditions / fixtures:** Two running services; a valid internal JWT issuer.
- **Steps:**
  1. A **well-formed** internal call carries `X-Tenant-Id`, `X-Correlation-Id`, `X-Caller`,
     `X-Internal-Origin`, `X-Source-Service` (typed enum) + a signed internal JWT (issuer/audience/exp).
     **Expect:** `200`; the context middleware asserts every required header and populates `RequestContext`.
  2. **Drop** `X-Internal-Origin` (or `X-Source-Service`). **Expect:** **fail-closed** `401/400` — never
     defaulted to `"UNKNOWN"`; no `entryContext` exists to fall back on.
  3. **Stale/forged internal JWT** (bad audience or expired). **Expect:** `401`.
  4. Confirm the **`X-Correlation-Id` propagates unchanged** across the hop (same id in caller and callee logs).
- **DB state to verify:** the callee's audit/log entries carry the **same** correlation id and the
  `X-Source-Service` attribution; no write on the rejected calls.
- **Access-control assertions:**
  - **Can:** a registered internal caller with a valid internal JWT + complete headers.
  - **Cannot:** an external client reach internal routes (origin gate) ⇒ `401`; a call with missing/forged
    headers ⇒ fail-closed.
- **Recording spec:**
  - **Show:** the good call (200, correlation id matches), then each header dropped/forged failing closed.
  - **Captions:**
    - `TITLE` — "FLOW-090 — S2S strict header validation"
    - `STEP` — "Internal call with full headers, then missing/forged ones"
    - `EXPECT` — "Expect 200 valid; fail-closed on missing/forged; correlation id propagates"
    - `VERDICT` — "PASS — required headers asserted, no UNKNOWN default, internal JWT checked"

### FLOW-091 — Token exchange / downscope for an internal hop

- **Suite:** J. Service-to-service & integrity
- **Services:** `gateway`, callee service, `@aegis/access-control`
- **Preconditions / fixtures:** A user token with broad audience.
- **Steps:**
  1. Before an internal hop, the gateway performs **RFC 8693 token exchange** to **downscope** +
     re-audience the token (prefer delegation `sub`+`act` over impersonation).
     **Expect:** the downstream service receives a narrowly-scoped token whose `aud` matches it.
  2. Attempt to reuse the **original** broad token directly against the internal service.
     **Expect:** `401` (wrong audience).
- **DB state to verify:** audit attributes the action to the original `sub` with the acting service.
- **Access-control assertions:**
  - **Cannot:** a downscoped token exceed its reduced scope; a broad token be replayed at an internal audience.
- **Recording spec:**
  - **Captions:**
    - `TITLE` — "FLOW-091 — Token exchange / downscope"
    - `STEP` — "Downscoping + re-audiencing a token for an internal hop"
    - `EXPECT` — "Expect narrowed token accepted; broad token → 401"
    - `VERDICT` — "PASS — least-privilege internal tokens, audience-bound"

### FLOW-092 — Connector framework: pluggable mock ERP push

- **Suite:** J. Service-to-service & integrity
- **Services:** `@aegis/connectors`, `expense`/`invoice`/`payroll`
- **Preconditions / fixtures:** Mock connectors registered (`LedgerOne`, `Finovo`, `AcctBridge`); a tenant
  bound to one of them.
- **Steps:**
  1. A push goes through the common connector **interface** + the tenant's configured adapter (mock
     handshake → push transaction → fetch status), carrying an **idempotency key**; outbound auth uses the
     **connector's configured scheme** (no global cross-service header).
     **Expect:** `acknowledged`; idempotent push log `synced`.
  2. **Swap** the tenant's binding to a different mock connector and push again.
     **Expect:** no code change — a new adapter handles it; the registry routes by binding.
  3. Replay with the same idempotency key ⇒ no duplicate ERP record.
- **DB state to verify:** per-connector push log rows keyed by idempotency key; status transitions
  `queued → synced` (or `error` surfaced, not swallowed).
- **Access-control assertions:**
  - **Cannot:** push to a connector **not bound** to the tenant; a tenant read another tenant's connector config (RLS).
- **Recording spec:**
  - **Show:** a push to LedgerOne, then re-binding to Finovo and pushing with **zero** code change, then the replay no-op.
  - **Captions:**
    - `TITLE` — "FLOW-092 — Pluggable connector push"
    - `STEP` — "Pushing via LedgerOne, re-binding to Finovo, replaying key"
    - `EXPECT` — "Expect adapter swap with no code change; idempotent replay"
    - `VERDICT` — "PASS — one interface, many adapters, exactly-once push"

### FLOW-093 — Audit hash-chain verification (tamper-evident)

- **Suite:** J. Service-to-service & integrity
- **Services:** `@aegis/access-control` audit, `cli` (verifier), every service that writes audit
- **Preconditions / fixtures:** A populated `audit_log` produced by the prior flows.
- **Steps:**
  1. Run the chain verifier (`cli` ops task). **Expect:** each entry's `entry_hash` =
     `H(prev_hash || canonical(entry))`; the chain is contiguous from genesis to tail ⇒ `VALID`.
  2. **Tamper test (in a copy):** flip one byte of a historical entry's payload and re-verify.
     **Expect:** verification **fails at that entry** and every entry **after** it — pinpointing the break.
  3. Confirm each entry captured **actor, tenant, intent, decision, permissions-at-time-of-action**.
- **DB state to verify:** an unbroken `prev_hash → entry_hash` chain per tenant scope; the tamper copy
  reports the first broken index.
- **Access-control assertions:**
  - **Can:** an `Auditor`/admin with `*.audit.read` run verification (read-only).
  - **Cannot:** any role mutate a past audit row (append-only); cross-tenant audit read ⇒ RLS-blocked.
- **Recording spec:**
  - **Show:** the verifier printing `VALID` over the real chain, then `BROKEN at #N` over the tampered copy.
  - **Captions:**
    - `TITLE` — "FLOW-093 — Audit hash-chain verification"
    - `STEP` — "Verifying chain, then re-verifying a tampered copy"
    - `EXPECT` — "Expect VALID on real chain; BROKEN at the tampered entry"
    - `VERDICT` — "PASS — tamper detected at first altered entry, chain otherwise intact"

---

## Coverage matrix (flows × required scenarios)

| Required scenario (SPEC §10.6) | Flow(s) |
|---|---|
| Tenant onboarding | FLOW-002 |
| User invite + register + login | FLOW-010, FLOW-011, FLOW-012 |
| Assign/revoke a custom role at runtime (PAP) | FLOW-020, FLOW-021 |
| Allowed vs denied authorization decision | FLOW-022, FLOW-023 |
| Cross-tenant isolation attempt (must fail) | FLOW-024 |
| Expense create→submit→approve→ERP push | FLOW-030, FLOW-031, FLOW-032 |
| Invoice create→duplicate detection→approve | FLOW-040, FLOW-041, FLOW-042 |
| Workflow rule firing on an event | FLOW-050 |
| Multi-level approval chain | FLOW-051 |
| Payroll draft→calculate→approve(maker-checker)→disburse + masking | FLOW-060…FLOW-064 |
| Report run with column masking | FLOW-070, FLOW-071 |
| Notification idempotency | FLOW-080 |
| Audit hash-chain verification | FLOW-093 |
| Service-to-service call with header validation | FLOW-090 |

## How the testing agents consume this catalogue

- The **scheduled testing / bug-hunting agents** (SPEC §10.6, §10.8) iterate the suites in order,
  reusing fixtures within a suite, and **assert each flow's DB-state + access-control matrix** — both the
  positive **Can** and the negative **Cannot** cases. Negative cases are not optional: a flow only passes
  when the denials deny.
- On any mismatch (wrong status, missing audit link, a denial that allowed, a cache key collision, a
  broken hash chain), the agent appends an entry to [`../../BUGLOG.md`](../../BUGLOG.md) with
  `{ id, flow: "FLOW-NNN", severity, repro, expected, actual, status }`.
- Each flow's **Recording spec** drives the annotated screen capture: the caption track (`TITLE` / `STEP`
  / `EXPECT` / `VERDICT`) is emitted verbatim so a reviewer can watch any recording and know what was
  done, what was expected, and whether it passed — without reading the code.
