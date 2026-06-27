# Aegis E2E Test Tracking Sheet

**Stack:** Dockerized, ISOLATED bring-up
**Gateway base URL:** `http://localhost:14000` (services on `14000-14007`)
**Date executed:** _______________
**Executor:** _______________

> Bring-up note: this is the isolated stack on ports `14000-14007`. Do NOT target `4000-4007` — those belong to a parallel local agent.
>
> Auth model (every authenticated row): `authorization: Bearer <token>` + `x-tenant-id: <tenant UUID>` (REQUIRED, fail-closed; must match the tenant in the validated JWT or the PEP returns 403). A single seeded Tenant-A admin (`admin@demo-org.test` / `demo-admin-pw`, x-tenant-id `00000000-0000-4000-8000-000000000001`) holds EVERY permission and drives all admin flows. Tenant-B admin (`admin@demo-org-b.test` / `demo-admin-pw-b`, x-tenant-id `00000000-0000-4000-8000-000000000002`) exists only for cross-tenant isolation.
>
> Response envelope: list `{ data, meta:{ total, page, pageSize } }` · single `{ data }` · error `{ errors:[{ code, type, message, details, traceId }] }`.

---

## Summary

- **Total cases:** 96
- **By priority:** P1 = 52, P2 = 33, P3 = 11
- **By origin:** documented = 33, gap-added = 63
- **By type:** happy = 34, negative = 24, authz = 27, edge = 11
- **By area:**
  - Platform health: 4
  - Identity & sessions: 12
  - Identity-admin (invites/sessions/tenant/users): 13
  - Tenant config & feature flags: 6
  - Policy admin (ABAC): 5
  - RBAC / PAP (roles & assignment): 9
  - Annotation-governance (teams/tags/records): 14
  - Internal service-to-service (BUG-0015): 4
  - Authorization core / PDP: 6
  - Tenant isolation / RLS: 5
  - Expense lifecycle: 8
  - Invoice: 6
  - Payroll: 6
  - Reporting: 4
  - Workflow & connector-configs: 6
  - Notification: 4
  - Cross-cutting (idempotency / correlation / envelope): 4

> Areas overlap with the "by area" counts in individual subsections; the canonical per-row area label is in the table's **Area** column.

---

## Platform health

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-HEALTH-01 | Platform health | Gateway liveness | happy | GET | `/health` | none | 200 `{service,status:'ok',uptime}` | P1 | documented | Pending | | |
| TC-HEALTH-02 | Platform health | Gateway deep health (deps) | happy | GET | `/health?details=true` | none | 200 `{status:'ok',db:true,cache:true}` | P1 | documented | Pending | | |
| TC-HEALTH-03 | Platform health | Each downstream service health (14001-14007) | happy | GET | `/health` (per service direct) | none | 200 `status:'ok'` for user-management/expense/payroll/reporting/workflow/notification/invoice | P2 | gap-added | Pending | | |
| TC-HEALTH-04 | Platform health | Unknown path proxy resolution | negative | GET | `/nonexistent/v1/x` | none | 404 (no route segment match) | P3 | gap-added | Pending | | |

## Identity & sessions

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-AUTH-01 | Identity & sessions | Register new user (tenant from header) | happy | POST | `/user-management/v1/auth/register` | none (x-tenant-id req) | 201 `{id,email}`; users + membership row | P1 | documented | Pending | | |
| TC-AUTH-02 | Identity & sessions | Register without x-tenant-id | negative | POST | `/user-management/v1/auth/register` | none (no tenant) | 400 fail-closed (tenant required) | P1 | gap-added | Pending | | |
| TC-AUTH-03 | Identity & sessions | Register validation (missing password) | negative | POST | `/user-management/v1/auth/register` | none | 400 registerSchema validation error | P2 | gap-added | Pending | | |
| TC-AUTH-04 | Identity & sessions | Register duplicate email same tenant | negative | POST | `/user-management/v1/auth/register` | none | 409/422 unique violation | P2 | gap-added | Pending | | |
| TC-AUTH-05 | Identity & sessions | Login as Tenant-A admin | happy | POST | `/user-management/v1/auth/login` | none | 200 `{token}` 3-part JWT; sessions row active | P1 | documented | Pending | | |
| TC-AUTH-06 | Identity & sessions | Login without x-tenant-id | negative | POST | `/user-management/v1/auth/login` | none (no tenant) | 400 fail-closed | P1 | documented | Pending | | |
| TC-AUTH-07 | Identity & sessions | Login wrong password | negative | POST | `/user-management/v1/auth/login` | none | 401 invalid credentials | P1 | gap-added | Pending | | |
| TC-AUTH-08 | Identity & sessions | /me current principal (BUG-0012 guard) | happy | GET | `/user-management/v1/auth/me` | admin | 200 `{id,email,roles[],permissions[]}` | P1 | documented | Pending | | |
| TC-AUTH-09 | Identity & sessions | /me without token | authz | GET | `/user-management/v1/auth/me` | none | 401 (authenticate() guard) | P1 | gap-added | Pending | | |
| TC-AUTH-10 | Identity & sessions | /me with tampered/wrong-aud token | authz | GET | `/user-management/v1/auth/me` | admin (bad JWT) | 401 (service re-validates aud) | P1 | documented | Pending | | |
| TC-AUTH-11 | Identity & sessions | Token A presented with x-tenant-id:B | authz | GET | `/user-management/v1/auth/me` | admin (A token + B header) | 403 at PEP (defense-in-depth) | P1 | documented | Pending | | |
| TC-AUTH-12 | Identity & sessions | Workspace switch to tenant B | happy | POST | `/user-management/v1/memberships/active` | admin (multi-membership) | 200; active_workspace→B; re-issued token tenant_id=B | P2 | documented | Pending | | |

## Identity-admin (invites / sessions / tenant / users)

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-IDADM-01 | Identity-admin | List invites | happy | GET | `/user-management/v1/invites` | admin (UserInvite) | 200 `{data:[...]}` | P2 | gap-added | Pending | | |
| TC-IDADM-02 | Identity-admin | Create invite | happy | POST | `/user-management/v1/invites` | admin (UserInvite) | 201 invite row; createInviteSchema | P2 | gap-added | Pending | | |
| TC-IDADM-03 | Identity-admin | Create invite validation | negative | POST | `/user-management/v1/invites` | admin | 400 schema error (bad email) | P3 | gap-added | Pending | | |
| TC-IDADM-04 | Identity-admin | Revoke invite | happy | POST | `/user-management/v1/invites/:id/revoke` | admin (UserInvite) | 200; invite revoked | P2 | gap-added | Pending | | |
| TC-IDADM-05 | Identity-admin | Invites without permission | authz | GET | `/user-management/v1/invites` | admin (member token, no UserInvite) | 403 | P2 | gap-added | Pending | | |
| TC-IDADM-06 | Identity-admin | List sessions | happy | GET | `/user-management/v1/sessions` | admin (SessionView) | 200 `{data:[...]}` | P2 | gap-added | Pending | | |
| TC-IDADM-07 | Identity-admin | Revoke session (DB witness) | happy | DELETE | `/user-management/v1/sessions/:id` | admin (SessionRevoke) | 200; sessions.status='revoked', revoked_at set | P1 | documented | Pending | | |
| TC-IDADM-08 | Identity-admin | Revoke another user's session w/o perm | authz | DELETE | `/user-management/v1/sessions/:id` | admin (no SessionRevoke) | 403 | P1 | documented | Pending | | |
| TC-IDADM-09 | Identity-admin | Cross-tenant session revoke | authz | DELETE | `/user-management/v1/sessions/:id` | admin (B token, A session) | 403/404 | P1 | documented | Pending | | |
| TC-IDADM-10 | Identity-admin | Read current tenant | happy | GET | `/user-management/v1/tenants/current` | admin (TenantView) | 200 caller's tenant | P3 | gap-added | Pending | | |
| TC-IDADM-11 | Identity-admin | List tenant users | happy | GET | `/user-management/v1/users` | admin (UserView) | 200 `{data:[...]}` | P2 | gap-added | Pending | | |
| TC-IDADM-12 | Identity-admin | Read user by id | happy | GET | `/user-management/v1/users/:id` | admin (UserView) | 200 single user | P2 | gap-added | Pending | | |
| TC-IDADM-13 | Identity-admin | Read user — unknown id 404 | negative | GET | `/user-management/v1/users/:id` | admin | 404 | P3 | gap-added | Pending | | |

## Tenant config & feature flags

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-TCFG-01 | Tenant config | Read all tenant config | happy | GET | `/user-management/v1/tenant/config` | admin (TenantView) | 200 config map | P2 | gap-added | Pending | | |
| TC-TCFG-02 | Tenant config | Set a config key | happy | PUT | `/user-management/v1/tenant/config/:key` | admin (TenantManage) | 200; setConfigSchema | P2 | gap-added | Pending | | |
| TC-TCFG-03 | Tenant config | Set config without TenantManage | authz | PUT | `/user-management/v1/tenant/config/:key` | admin (TenantView only) | 403 | P2 | gap-added | Pending | | |
| TC-TCFG-04 | Tenant config | List feature flags | happy | GET | `/user-management/v1/tenant/features` | admin (TenantView) | 200 flags | P2 | gap-added | Pending | | |
| TC-TCFG-05 | Tenant config | Toggle RecordAnnotation flag | happy | PUT | `/user-management/v1/tenant/features/:flag` | admin (TenantManage) | 200; drives annotation list filters | P2 | gap-added | Pending | | |
| TC-TCFG-06 | Tenant config | Toggle flag validation | negative | PUT | `/user-management/v1/tenant/features/:flag` | admin | 400 setFlagSchema | P3 | gap-added | Pending | | |

## Policy admin (ABAC)

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-POL-01 | Policy admin | List policies | happy | GET | `/user-management/v1/policies` | admin (PolicyView) | 200 `{data:[...]}` | P2 | gap-added | Pending | | |
| TC-POL-02 | Policy admin | Create ABAC policy | happy | POST | `/user-management/v1/policies` | admin (PolicyManage) | 201; createPolicySchema | P2 | gap-added | Pending | | |
| TC-POL-03 | Policy admin | Update policy | happy | PATCH | `/user-management/v1/policies/:id` | admin (PolicyManage) | 200 updated | P3 | gap-added | Pending | | |
| TC-POL-04 | Policy admin | Delete policy | happy | DELETE | `/user-management/v1/policies/:id` | admin (PolicyManage) | 200/204 | P3 | gap-added | Pending | | |
| TC-POL-05 | Policy admin | Create policy without PolicyManage | authz | POST | `/user-management/v1/policies` | admin (PolicyView only) | 403 | P2 | gap-added | Pending | | |

## RBAC / PAP (roles & assignment)

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-RBAC-01 | RBAC / PAP | List permission catalog | happy | GET | `/user-management/v1/permissions` | admin (PermissionView) | 200 catalog list | P2 | gap-added | Pending | | |
| TC-RBAC-02 | RBAC / PAP | List roles | happy | GET | `/user-management/v1/roles` | admin (RoleView) | 200 `{data:[...]}` | P2 | gap-added | Pending | | |
| TC-RBAC-03 | RBAC / PAP | Create custom role | happy | POST | `/user-management/v1/roles` | admin (RoleCreate) | 201; roles + role_permissions rows; audit identity.role.updated | P1 | documented | Pending | | |
| TC-RBAC-04 | RBAC / PAP | Create role with permission not in catalog | negative | POST | `/user-management/v1/roles` | admin | 422 | P1 | documented | Pending | | |
| TC-RBAC-05 | RBAC / PAP | Non-admin creates role | authz | POST | `/user-management/v1/roles` | admin (member token) | 403 | P1 | documented | Pending | | |
| TC-RBAC-06 | RBAC / PAP | Assign role to user (grant) | happy | POST | `/user-management/v1/users/:userId/role` | admin (RoleAssign) | 201 user_roles row; PIP cache invalidated; audit identity.role.assigned | P1 | documented | Pending | | |
| TC-RBAC-07 | RBAC / PAP | Protected call flips deny→allow after grant | authz | POST | `/expense/v1/reports/:id/approve` | admin (just-granted user) | 200 now ALLOWED (was 403 before) | P1 | documented | Pending | | |
| TC-RBAC-08 | RBAC / PAP | Revoke role assignment | happy | DELETE | `/user-management/v1/users/:userId/roles/:roleId` | admin (RoleAssign) | 204; cache invalidated; audit identity.role.revoked | P1 | documented | Pending | | |
| TC-RBAC-09 | RBAC / PAP | Protected call flips allow→deny after revoke | authz | POST | `/expense/v1/reports/:id/approve` | admin (revoked user) | 403 now DENIED | P1 | documented | Pending | | |

## Annotation-governance (teams / tags / records)

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-TEAM-01 | Annotation-gov | List teams | happy | GET | `/user-management/v1/teams` | admin (TeamManage) | 200 `{data:[...]}` | P2 | gap-added | Pending | | |
| TC-TEAM-02 | Annotation-gov | Create team | happy | POST | `/user-management/v1/teams` | admin (TeamManage) | 201; createTeamSchema | P2 | gap-added | Pending | | |
| TC-TEAM-03 | Annotation-gov | Update team | happy | PATCH | `/user-management/v1/teams/:teamId` | admin (TeamManage) | 200 updated | P3 | gap-added | Pending | | |
| TC-TEAM-04 | Annotation-gov | Delete team | happy | DELETE | `/user-management/v1/teams/:teamId` | admin (TeamManage) | 200/204 | P3 | gap-added | Pending | | |
| TC-TEAM-05 | Annotation-gov | List team members | happy | GET | `/user-management/v1/teams/:teamId/members` | admin (TeamManage) | 200 members | P3 | gap-added | Pending | | |
| TC-TEAM-06 | Annotation-gov | Add team member | happy | POST | `/user-management/v1/teams/:teamId/members` | admin (TeamManage) | 201; addTeamMemberSchema | P2 | gap-added | Pending | | |
| TC-TEAM-07 | Annotation-gov | Remove team member | happy | DELETE | `/user-management/v1/teams/:teamId/members/:userId` | admin (TeamManage) | 200/204 | P3 | gap-added | Pending | | |
| TC-TAG-01 | Annotation-gov | List tags | happy | GET | `/user-management/v1/tags` | admin (TagList) | 200 `{data:[...]}` | P2 | gap-added | Pending | | |
| TC-TAG-02 | Annotation-gov | Create tag | happy | POST | `/user-management/v1/tags` | admin (TagCreate) | 201; createTagSchema | P2 | gap-added | Pending | | |
| TC-TAG-03 | Annotation-gov | Update / delete tag | happy | PATCH | `/user-management/v1/tags/:tagId` | admin (TagUpdate) | 200 updated (delete = DELETE /tags/:tagId 204) | P3 | gap-added | Pending | | |
| TC-TAG-04 | Annotation-gov | Set team tag set | happy | PUT | `/user-management/v1/teams/:teamId/tags` | admin (TeamTagManage) | 200; setTeamTagsSchema | P3 | gap-added | Pending | | |
| TC-REC-01 | Annotation-gov | Attach tag to record | happy | POST | `/user-management/v1/records/:recordType/:recordId/tags` | admin (RecordTagAdd) | 201; attachRecordTagSchema; recordType validated | P2 | gap-added | Pending | | |
| TC-REC-02 | Annotation-gov | Detach tag from record | happy | DELETE | `/user-management/v1/records/:recordType/:recordId/tags/:tagId` | admin (RecordTagRemove) | 200/204 | P3 | gap-added | Pending | | |
| TC-REC-03 | Annotation-gov | Set record assignee (drives list filter) | happy | PUT | `/user-management/v1/records/:recordType/:recordId/assignee` | admin (RecordAssign) | 200; assignRecordSchema; backs assignee scope on expense/invoice/payroll lists | P2 | gap-added | Pending | | |

## Internal service-to-service (BUG-0015)

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-INT-01 | Internal S2S | Resolve user contact (internal) | happy | GET | `/user-management/internal/users/:id/contact` | internal (internalAuth) | 200 contact email; userContactParamSchema | P2 | gap-added | Pending | | |
| TC-INT-02 | Internal S2S | Recipient directory lookup | happy | GET | `/user-management/internal/recipients` | internal (internalAuth) | 200 recipients by role/perm/team; recipientDirectoryQuerySchema | P2 | gap-added | Pending | | |
| TC-INT-03 | Internal S2S | Internal route rejects public bearer | authz | GET | `/user-management/internal/users/:id/contact` | admin (public JWT, not internal) | 401/403 (internalAuth only) | P1 | gap-added | Pending | | |
| TC-INT-04 | Internal S2S | Internal route rejects unauthenticated | authz | GET | `/user-management/internal/recipients` | none | 401 | P1 | gap-added | Pending | | |

## Authorization core / PDP

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-PDP-01 | Authz core / PDP | Allow: permission + ABAC (own-team, amount<=limit) | authz | POST | `/expense/v1/reports/:id/approve` | admin (approver, own-team, in-limit) | 200 `{allow:true}`; status→approved; expense_approvals row; audit decision=allow | P1 | documented | Pending | | |
| TC-PDP-02 | Authz core / PDP | Deny: missing permission | authz | POST | `/expense/v1/reports/:id/approve` | admin (member, no approve perm) | 403 `{allow:false,reason:'missing permission expense.report.approve'}`; no status change | P1 | documented | Pending | | |
| TC-PDP-03 | Authz core / PDP | Deny: amount over approval_limit | authz | POST | `/expense/v1/reports/:id/approve` | admin (approver, over-limit report) | 403 reason 'amount exceeds approver limit' | P1 | documented | Pending | | |
| TC-PDP-04 | Authz core / PDP | Deny: report outside team scope | authz | POST | `/expense/v1/reports/:id/approve` | admin (approver, other-team report) | 403 (scope) | P1 | documented | Pending | | |
| TC-PDP-05 | Authz core / PDP | Fail-closed on attribute-store error | edge | POST | `/expense/v1/reports/:id/approve` | admin | 403 deny (never default-allow); audit decision=deny | P2 | gap-added | Pending | | |
| TC-PDP-06 | Authz core / PDP | No token to protected route | authz | POST | `/expense/v1/reports/:id/approve` | none | 401 at gateway edge | P1 | gap-added | Pending | | |

## Tenant isolation / RLS

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-RLS-01 | Tenant isolation | Login Tenant-B admin → TOKEN_B | happy | POST | `/user-management/v1/auth/login` | none (B creds) | 200 `{token}` | P1 | documented | Pending | | |
| TC-RLS-02 | Tenant isolation | B reads A's report → invisible | authz | GET | `/expense/v1/reports/:A_report_id` | admin (B token + B header) | 404 (NOT 200/403; RLS makes row invisible) | P1 | documented | Pending | | |
| TC-RLS-03 | Tenant isolation | A reads its own report | happy | GET | `/expense/v1/reports/:A_report_id` | admin (A token + A header) | 200 | P1 | documented | Pending | | |
| TC-RLS-04 | Tenant isolation | B list never leaks A's report | authz | GET | `/expense/v1/reports?page=1&pageSize=100` | admin (B token) | 200; list excludes A's report name | P1 | documented | Pending | | |
| TC-RLS-05 | Tenant isolation | Header forgery (A JWT + x-tenant-id:B) | authz | GET | `/expense/v1/reports/:A_report_id` | admin (A token + B header) | 401/403 (tenant derives from token, not header) | P1 | documented | Pending | | |

## Expense lifecycle

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-EXP-01 | Expense | Create report (open) | happy | POST | `/expense/v1/reports` | admin (ExpenseReportCreate) | 201 `{data:{id}}`; status=open; report_number from per-tenant sequence | P1 | documented | Pending | | |
| TC-EXP-02 | Expense | Attach expense item (total rolls up) | happy | POST | `/expense/v1/reports/:id/expenses` | admin (ExpenseReportUpdate) | 201 `{data}`; total_amount_minor rolls up (integer minor units) | P1 | documented | Pending | | |
| TC-EXP-03 | Expense | Submit report (open→approvals) | happy | POST | `/expense/v1/reports/:id/submit` | admin (ExpenseReportSubmit) | 200; status→approvals; submitted_at; emits expense.submitted to outbox | P1 | documented | Pending | | |
| TC-EXP-04 | Expense | Pending approvals inbox | happy | GET | `/expense/v1/reports/approvals/pending` | admin (approver) | 200 `{data:[...]}` (may be empty when chain auto-completed) | P1 | documented | Pending | | |
| TC-EXP-05 | Expense | Approval decision (approved) | happy | POST | `/expense/v1/reports/:id/decisions` | admin (ExpenseReportApprove) | 200; status→approved; expense_approvals row; emits expense.report.approved | P1 | documented | Pending | | |
| TC-EXP-06 | Expense | Read back report = approved | happy | GET | `/expense/v1/reports/:id` | admin | 200 `data.status='approved'` (or 'approvals' if real approver pending) | P1 | documented | Pending | | |
| TC-EXP-07 | Expense | Read single expense ITEM (BUG-0013) | happy | GET | `/expense/v1/expenses/:id` | admin (ExpenseReportView) | 200 RLS-scoped item; unknown id → 404 | P2 | gap-added | Pending | | |
| TC-EXP-08 | Expense | Submitter self-approve (maker-checker) | authz | POST | `/expense/v1/reports/:id/decisions` | admin (submitter==approver) | 403 maker-checker; item on submitted report → 409 | P1 | gap-added | Pending | | |

## Invoice

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-INV-01 | Invoice | Create invoice | happy | POST | `/invoice/v1/invoices` | admin (InvoiceCreate) | 201 `{data:{id}}` {vendorName,invoiceNumber,amountMinor,currency,poReference?} | P1 | documented | Pending | | |
| TC-INV-02 | Invoice | Duplicate invoice rejected (same vendor+number+amount) | edge | POST | `/invoice/v1/invoices` | admin | 409 duplicate (invoice_duplicate ledger) | P1 | documented | Pending | | |
| TC-INV-03 | Invoice | Duplicate-key differs by currency → allowed | edge | POST | `/invoice/v1/invoices` | admin | 201 (different currency = not a duplicate) | P2 | gap-added | Pending | | |
| TC-INV-04 | Invoice | Read single invoice (RLS) | happy | GET | `/invoice/v1/invoices/:id` | admin (InvoiceView) | 200; unknown id → 404 | P2 | gap-added | Pending | | |
| TC-INV-05 | Invoice | Submit → decisions (approve) | happy | POST | `/invoice/v1/invoices/:id/decisions` | admin (InvoiceApprove) | 200; status→approved; emits invoice approved | P2 | gap-added | Pending | | |
| TC-INV-06 | Invoice | Pending invoice approvals inbox | happy | GET | `/invoice/v1/invoices/approvals/pending` | admin (InvoiceApprove) | 200 `{data:[...]}` | P2 | gap-added | Pending | | |

## Payroll

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-PAY-01 | Payroll | Create employee + contract | happy | POST | `/payroll/v1/employees` | admin (EmployeeManage) | 201 {bankAccount,nationalId,contract{baseAmountMinor,currency,payFrequency}} | P2 | documented | Pending | | |
| TC-PAY-02 | Payroll | Create pay-run (draft) | happy | POST | `/payroll/v1/pay-runs` | admin (PayRunManage) | 201 status=draft {payCalendarId,periodStart,periodEnd,type:'regular'} | P2 | documented | Pending | | |
| TC-PAY-03 | Payroll | Calculate pay-run (gross→net) | happy | POST | `/payroll/v1/pay-runs/:id/calculate` | admin | 200 engine computes per-employee net | P2 | documented | Pending | | |
| TC-PAY-04 | Payroll | Disburse with Idempotency-Key | edge | POST | `/payroll/v1/pay-runs/:id/disburse` | admin (PayRunDisburse) | 200 status→funding; replay with same key = no double-disburse | P1 | documented | Pending | | |
| TC-PAY-05 | Payroll | Own payslip — sensitive fields masked | authz | GET | `/payroll/v1/payslips/:id` | admin (employee, own) | 200 own payslip; bank/national-id MASKED | P1 | documented | Pending | | |
| TC-PAY-06 | Payroll | Read another employee's payslip | authz | GET | `/payroll/v1/payslips/:id` | admin (non-owner, no PayrollAdmin) | 403/404 | P1 | gap-added | Pending | | |

## Reporting

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-RPT-01 | Reporting | Trigger report run (async) | happy | POST | `/reporting/v1/report-runs` | admin (ReportRun) | 202 `{runId}` {definitionId,params} | P2 | documented | Pending | | |
| TC-RPT-02 | Reporting | Poll report run to succeeded | happy | GET | `/reporting/v1/report-runs/:runId` | admin | 200 poll until status=succeeded | P2 | documented | Pending | | |
| TC-RPT-03 | Reporting | Export finished run | happy | GET | `/reporting/v1/report-runs/:id/export` | admin (ReportExport) | 200 export payload | P3 | gap-added | Pending | | |
| TC-RPT-04 | Reporting | List report definitions | happy | GET | `/reporting/v1/report-definitions` | admin (ReportView) | 200 `{data:[...]}` | P3 | gap-added | Pending | | |

## Workflow & connector-configs

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-WF-01 | Workflow | Create rule (steps + actions) | happy | POST | `/workflow/v1/rules` | admin (RuleManage) | 201 {rule_steps[{field,operator,value,conjunction}],rule_actions} | P2 | documented | Pending | | |
| TC-WF-02 | Workflow | Run rule | happy | POST | `/workflow/v1/rules/:id/run` | admin | 200 rule evaluated/executed | P3 | gap-added | Pending | | |
| TC-CONN-01 | Connector-config | List connectors for tenant | happy | GET | `/workflow/v1/connectors` | admin (ConnectorView) | 200 bound connectors | P2 | gap-added | Pending | | |
| TC-CONN-02 | Connector-config | Configure/bind connector (PUT by kind) | happy | PUT | `/workflow/v1/connectors/:kind` | admin (ConnectorManage) | 200 connector-config upserted | P2 | gap-added | Pending | | |
| TC-CONN-03 | Connector-config | Connector sync-state by idempotency key | edge | GET | `/workflow/v1/connectors/sync-state/:idempotencyKey` | admin | 200 push log row (idempotent at-most-once) | P2 | gap-added | Pending | | |
| TC-CONN-04 | Connector-config | Cross-tenant connector config read (RLS) | authz | GET | `/workflow/v1/connectors` | admin (B token) | 200 excludes A's connector config | P1 | gap-added | Pending | | |

## Notification

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-NOTIF-01 | Notification | List notifications (fan-out witness) | happy | GET | `/notification/v1/notifications?page=1&pageSize=20` | admin (approver in A) | 200 `.data` length >= 1 (worker fanned out approval/status notification) | P1 | documented | Pending | | |
| TC-NOTIF-02 | Notification | Inbox isolation — only caller's notifications | authz | GET | `/notification/v1/notifications` | admin (user A) | 200 only A's rows (no cross-user/tenant leak) | P1 | documented | Pending | | |
| TC-NOTIF-03 | Notification | Unread count | happy | GET | `/notification/v1/notifications/inbox/unread-count` | admin | 200 `{count}` | P3 | gap-added | Pending | | |
| TC-NOTIF-04 | Notification | Mark notification read | happy | POST | `/notification/v1/notifications/:id/read` | admin | 200; row marked read | P3 | gap-added | Pending | | |

## Cross-cutting (idempotency / correlation / envelope)

| ID | Area | Title | Type | Method | Path | Auth | Expected | Priority | Origin | Status | Result | Notes |
|----|------|-------|------|--------|------|------|----------|----------|--------|--------|--------|-------|
| TC-XC-01 | Cross-cutting | Idempotency-Key replay returns cached response | edge | POST | `/expense/v1/reports` | admin (repeat same key) | 2xx same body; no duplicate row created | P1 | gap-added | Pending | | |
| TC-XC-02 | Cross-cutting | Idempotency-Key is tenant-scoped | edge | POST | `/expense/v1/reports` | admin (same key, tenant A vs B) | distinct results (CacheAdapter.tenantKey isolation) | P2 | gap-added | Pending | | |
| TC-XC-03 | Cross-cutting | Correlation id minted + echoed | edge | GET | `/user-management/v1/auth/me` | admin (no x-correlation-id) | 200; response carries x-correlation-id for log grep | P3 | gap-added | Pending | | |
| TC-XC-04 | Cross-cutting | Error envelope shape on 4xx | negative | GET | `/expense/v1/reports/:bad_id` | admin | 4xx `{errors:[{code,type,message,details,traceId}]}` | P2 | gap-added | Pending | | |
