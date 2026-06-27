# Access-Control Matrix

> The authoritative role → permission grant table for Aegis's seeded **system roles**.
> Every `✓` in this document is generated from
> [`apps/cli/src/seeders/rbac-catalog.ts`](../apps/cli/src/seeders/rbac-catalog.ts)
> (`ROLE_PERMS`) and the permission vocabulary in
> [`libs/shared/enums/src/access.enum.ts`](../libs/shared/enums/src/access.enum.ts).
> Companion design doc: [`03-access-control-model.md`](03-access-control-model.md).

---

## 1. What this matrix is

This is the **RBAC grant matrix**: for each of Aegis's 11 seeded system roles, exactly which of the
57 platform permissions that role is granted by default.

The model in one paragraph: **Aegis authorizes over a flat, dotted `domain.action[.sub]` permission
vocabulary** (e.g. `expense.report.approve`, `payroll.run.disburse`). Roles are named bundles of
those permissions. The role → permission grants seeded in `ROLE_PERMS` are projected into the
**Casbin** policy store by [`0003_casbin_policies.ts`](../apps/cli/src/seeders/0003_casbin_policies.ts):
each grant becomes a `p` policy `[sub = role name, dom, act = permission, eft = 'allow']`. **System
roles apply across every tenant** — their `dom` is `'*'` (one row serves all tenants, because a
seeded system role has `tenant_id = NULL`) — while **custom roles are tenant-scoped**, with
`dom = tenantId`. Users are bound to roles by `g` policies `[user_id, role name, tenant_id]`, one
grouping per tenant membership, so the same user can hold different roles in different tenants.

RBAC is **necessary but not sufficient**. The grant shown here is layered with two further checks
evaluated at decision time (see [`03-access-control-model.md`](03-access-control-model.md) §6–§7):

- **ABAC conditions** — attribute-based rules that can *further restrict* an RBAC allow, most
  notably **approval amount caps** (an approver may hold `expense.report.approve` yet still be denied
  a report above their `approvalLimit`). ABAC can only narrow, never widen, the RBAC grant.
- **Row-level scope** — `AllRecords | OwnAndTeam | OwnOnly`, carried on the user's role assignment,
  decides *which rows* a permitted action may touch (backstopped by Postgres RLS).

So a `✓` below means "this role carries this permission." Whether a *specific* request succeeds also
depends on the resource's attributes (amount, owner, status, tenant) and the user's scope.

---

## 2. The 11 system roles

| Role | Abbrev | Intent (derived from its actual grants) |
|---|---|---|
| **Owner** | Own | Full permission catalog — every one of the 57 permissions. |
| **Admin** | Adm | Full permission catalog — identical grant to Owner. |
| **Manager** | Mgr | Team/org administration + tag & record taxonomy, expense & invoice **approve/reject**, reporting (run + view), and audit-view. |
| **Approver** | Apv | Expense & invoice **approval/rejection** only (plus tag list). No create/update. |
| **Contributor** | Con | **Create / view / update / submit** expense reports and **create / view / update** invoices (plus tag list). No approval. |
| **Viewer** | Vwr | Read-only: view expenses, invoices, reports, users, roles (plus tag list). |
| **PayrollAdmin** | PAdm | Payroll employee management, sensitive-field read, pay-run **create + calculate**, view all payslips, and ERP **connector** manage/push. |
| **PayrollApprover** | PApv | Pay-run **approve** only, plus payroll employee view and view all payslips. |
| **FinanceDisburser** | FDis | Pay-run **disburse** + expense **reimburse**, plus view all payslips and expense view. The money-out role. |
| **Auditor** | Aud | Read-only oversight: audit view, plus user/role/permission/policy/session view and expense/invoice/report view. |
| **Employee** | Emp | Self-service: **create / view / submit** own expense reports and view **own** payslip. |

> Owner and Admin are seeded with `ALL_PERMISSIONS` (the entire enum), so they are `✓` on every row
> of the matrix below.

---

## 3. The matrix

Permissions are **rows** (grouped by domain), the 11 roles are **columns**. `✓` = granted by
`ROLE_PERMS`; blank = not granted.

**Legend (column abbreviations):**

| Abbrev | Role | Abbrev | Role |
|---|---|---|---|
| **Own** | Owner | **PAdm** | PayrollAdmin |
| **Adm** | Admin | **PApv** | PayrollApprover |
| **Mgr** | Manager | **FDis** | FinanceDisburser |
| **Apv** | Approver | **Aud** | Auditor |
| **Con** | Contributor | **Emp** | Employee |
| **Vwr** | Viewer | | |

### Identity & Tenant

| Permission | Own | Adm | Mgr | Apv | Con | Vwr | PAdm | PApv | FDis | Aud | Emp |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `tenant.manage` | ✓ | ✓ | | | | | | | | | |
| `tenant.view` | ✓ | ✓ | | | | | | | | | |
| `user.create` | ✓ | ✓ | | | | | | | | | |
| `user.view` | ✓ | ✓ | ✓ | | | ✓ | | | | ✓ | |
| `user.update` | ✓ | ✓ | | | | | | | | | |
| `user.invite` | ✓ | ✓ | | | | | | | | | |

### Roles, Permissions, Policy & Sessions

| Permission | Own | Adm | Mgr | Apv | Con | Vwr | PAdm | PApv | FDis | Aud | Emp |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `session.view` | ✓ | ✓ | | | | | | | | ✓ | |
| `session.revoke` | ✓ | ✓ | | | | | | | | | |
| `role.create` | ✓ | ✓ | | | | | | | | | |
| `role.view` | ✓ | ✓ | ✓ | | | ✓ | | | | ✓ | |
| `role.update` | ✓ | ✓ | | | | | | | | | |
| `role.delete` | ✓ | ✓ | | | | | | | | | |
| `role.assign` | ✓ | ✓ | | | | | | | | | |
| `permission.view` | ✓ | ✓ | | | | | | | | ✓ | |
| `policy.view` | ✓ | ✓ | | | | | | | | ✓ | |
| `policy.manage` | ✓ | ✓ | | | | | | | | | |

### Org, Teams, Tags & Annotations

| Permission | Own | Adm | Mgr | Apv | Con | Vwr | PAdm | PApv | FDis | Aud | Emp |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `team.manage` | ✓ | ✓ | ✓ | | | | | | | | |
| `org.manage` | ✓ | ✓ | ✓ | | | | | | | | |
| `tag.create` | ✓ | ✓ | ✓ | | | | | | | | |
| `tag.update` | ✓ | ✓ | ✓ | | | | | | | | |
| `tag.delete` | ✓ | ✓ | ✓ | | | | | | | | |
| `tag.list` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `record.tag.add` | ✓ | ✓ | ✓ | | | | | | | | |
| `record.tag.remove` | ✓ | ✓ | ✓ | | | | | | | | |
| `record.assign` | ✓ | ✓ | ✓ | | | | | | | | |
| `team.tag.manage` | ✓ | ✓ | ✓ | | | | | | | | |

### Expense

| Permission | Own | Adm | Mgr | Apv | Con | Vwr | PAdm | PApv | FDis | Aud | Emp |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `expense.report.create` | ✓ | ✓ | | | ✓ | | | | | | ✓ |
| `expense.report.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | ✓ | ✓ | ✓ |
| `expense.report.update` | ✓ | ✓ | | | ✓ | | | | | | |
| `expense.report.submit` | ✓ | ✓ | | | ✓ | | | | | | ✓ |
| `expense.report.approve` | ✓ | ✓ | ✓ | ✓ | | | | | | | |
| `expense.report.reject` | ✓ | ✓ | ✓ | ✓ | | | | | | | |
| `expense.report.reimburse` | ✓ | ✓ | | | | | | | ✓ | | |

### Invoice

| Permission | Own | Adm | Mgr | Apv | Con | Vwr | PAdm | PApv | FDis | Aud | Emp |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `invoice.create` | ✓ | ✓ | | | ✓ | | | | | | |
| `invoice.view` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | | | ✓ | |
| `invoice.update` | ✓ | ✓ | | | ✓ | | | | | | |
| `invoice.approve` | ✓ | ✓ | ✓ | ✓ | | | | | | | |

### Payroll

| Permission | Own | Adm | Mgr | Apv | Con | Vwr | PAdm | PApv | FDis | Aud | Emp |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `payroll.employee.view` | ✓ | ✓ | | | | | ✓ | ✓ | | | |
| `payroll.employee.manage` | ✓ | ✓ | | | | | ✓ | | | | |
| `payroll.sensitive.read` | ✓ | ✓ | | | | | ✓ | | | | |
| `payroll.run.create` | ✓ | ✓ | | | | | ✓ | | | | |
| `payroll.run.calculate` | ✓ | ✓ | | | | | ✓ | | | | |
| `payroll.run.approve` | ✓ | ✓ | | | | | | ✓ | | | |
| `payroll.run.disburse` | ✓ | ✓ | | | | | | | ✓ | | |
| `payroll.payslip.view.own` | ✓ | ✓ | | | | | | | | | ✓ |
| `payroll.payslip.view.all` | ✓ | ✓ | | | | | ✓ | ✓ | ✓ | | |

### Workflow

| Permission | Own | Adm | Mgr | Apv | Con | Vwr | PAdm | PApv | FDis | Aud | Emp |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `workflow.rule.create` | ✓ | ✓ | | | | | | | | | |
| `workflow.rule.view` | ✓ | ✓ | | | | | | | | | |
| `workflow.rule.update` | ✓ | ✓ | | | | | | | | | |
| `workflow.rule.run` | ✓ | ✓ | | | | | | | | | |

### Reporting

| Permission | Own | Adm | Mgr | Apv | Con | Vwr | PAdm | PApv | FDis | Aud | Emp |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `report.define` | ✓ | ✓ | | | | | | | | | |
| `report.run` | ✓ | ✓ | ✓ | | | | | | | | |
| `report.view` | ✓ | ✓ | ✓ | | | ✓ | | | | ✓ | |

### Notification

| Permission | Own | Adm | Mgr | Apv | Con | Vwr | PAdm | PApv | FDis | Aud | Emp |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `notification.view` | ✓ | ✓ | | | | | | | | | |

### Connectors (ERP)

| Permission | Own | Adm | Mgr | Apv | Con | Vwr | PAdm | PApv | FDis | Aud | Emp |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `connector.manage` | ✓ | ✓ | | | | | ✓ | | | | |
| `connector.push` | ✓ | ✓ | | | | | ✓ | | | | |

### Audit

| Permission | Own | Adm | Mgr | Apv | Con | Vwr | PAdm | PApv | FDis | Aud | Emp |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `audit.view` | ✓ | ✓ | ✓ | | | | | | | ✓ | |

### Per-role grant totals

These totals must equal the length of each role's array in `ROLE_PERMS`
(Owner/Admin = the full catalog of 57):

| Own | Adm | Mgr | Apv | Con | Vwr | PAdm | PApv | FDis | Aud | Emp |
|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 57 | 57 | 20 | 6 | 8 | 6 | 9 | 4 | 5 | 10 | 5 |

---

## 4. Notes

### 4.1 Granting a role to a user

A user gains a role through a **role assignment**, which materializes as a Casbin `g` (grouping)
policy. Per [`0003_casbin_policies.ts`](../apps/cli/src/seeders/0003_casbin_policies.ts), `g` rows
are projected from the `user_roles` table as:

```
g, <user_id>, <role name>, <tenant_id>
```

— one grouping per `(user, role, tenant)` membership. The `tenant_id` is the **domain** of the
membership, so a user can hold `manager` in tenant A and `viewer` in tenant B simultaneously; each
`g` row is independent. At runtime, role assignment is done through the **PAP** in
`apps/user-management` (`POST /users/:id/roles`, guarded by `role.assign` — see
[`03-access-control-model.md`](03-access-control-model.md) §5), which writes `user_roles`, emits a
hash-chained audit entry, and bumps `policy_version` to invalidate caches. The role assignment also
carries the user's **row-level scope** (`AllRecords | OwnAndTeam | OwnOnly`) on that grant.

### 4.2 System roles vs. custom tenant roles

| | System roles (this matrix) | Custom tenant roles |
|---|---|---|
| Defined by | Seeded in migrations (`ROLE_PERMS`) | A tenant admin at runtime via the PAP (`role.create`) |
| `roles.tenant_id` | `NULL` | the tenant's id |
| Casbin `p` domain (`dom`) | `'*'` — applies across **every** tenant | `tenant_id` — applies **only** within that tenant |
| Grant source | Fixed `ROLE_PERMS` catalog | `role_permissions` rows added at runtime (`permission.grant`) |
| Blast radius of a change | Global (all tenants) | Tenant-scoped, reversible via API |

The two share the same permission vocabulary and the same `p` / `g` projection — the only structural
difference is the `dom` value (`'*'` vs. `tenantId`) and where the grant edges come from. A custom
role can grant **any** subset of the 57 permissions; the matrix above is just the seeded defaults.

### 4.3 The matrix is necessary, not sufficient — ABAC amount caps for money flows

A `✓` is the **RBAC** layer only. For money-moving actions, the **ABAC** layer can still deny an
otherwise-granted request. The most important case is **approval amount caps**: holding
`expense.report.approve` (Manager, Approver) or `invoice.approve` does **not** mean a user can
approve any amount. The PDP evaluates a policy like
`lte(resource.amount, subject.approvalLimit)` (see
[`03-access-control-model.md`](03-access-control-model.md) §6, Example A) using the approver's
`approvalLimit` supplied by the PIP; a report above the cap is denied with
`amount … exceeds approval limit …`. The amount-cap routing therefore lives in the
**approvals / ABAC engine** inside `@aegis/access-control` (the PDP), evaluated by the per-service
PEP — **not** in this RBAC table.

Other ABAC overlays that constrain `✓` rows in money flows:

- **Segregation of duties / maker-checker** for payroll, expressed as `deny` policies (e.g. the
  pay-run approver must differ from the input editor; a payroll admin may not read their own
  payslip). Under deny-overrides, an applicable `deny` beats any RBAC allow.
- **Column-masking obligations** on payroll reads — a role may `payroll.payslip.view.all` yet have
  sensitive columns (bank account, national id) masked unless it also holds `payroll.sensitive.read`.
- **Row-level scope** — `expense.report.view` returns only the rows in the user's scope
  (`OwnOnly` / `OwnAndTeam` / `AllRecords`), compiled into the SQL predicate and backstopped by RLS.

> **Bottom line:** use this matrix to answer "which roles *carry* a permission." For "can this user
> actually perform this action on this resource," the RBAC grant must additionally survive ABAC
> conditions, scope resolution, and deny-overrides at decision time.
