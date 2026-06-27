#!/usr/bin/env bash
#
# Suite C — Access-control core / PDP·PEP·PAP (flow-catalogue FLOW-020 … FLOW-024).
#
# What this demonstrates, live:
#   - create a custom role at runtime, catalog-validated (FLOW-020): role_permissions is the truth
#   - rejecting an unknown permission name (catalog guard) (FLOW-020 negative)
#   - assign that role to a user at runtime (PAP) — takes effect immediately (FLOW-021)
#   - allowed vs denied decisions: the seeded admin (all perms) is allowed; a low-priv user is denied (FLOW-022/023)
#   - cross-tenant isolation MUST fail: tenant B cannot read tenant A's row → 404 (RLS) (FLOW-024)
#
# Routes (verified in apps/user-management/src/controllers/role.controller.ts):
#   GET  /user-management/v1/roles
#   POST /user-management/v1/roles                 { name, description?, permissions:[...] }
#   POST /user-management/v1/users/:userId/role    { roleId, scope? }   (NOTE: singular /role)
# The role surface returns the row(s) directly (NOT wrapped in {data}).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

demo_begin "Suite C — Access-control core (PDP / PEP / PAP)"

as_tenant_a   # the seeded admin holds role.create / role.assign / permission.manage

# A target low-privilege user we will create and (later) grant a role to.
TARGET_EMAIL="rbac-target-$(date +%s)-$$@demo-org.test"
TARGET_PASSWORD="target-password-123"

# ===================================================================================================
title "FLOW-020 — Define a custom role at runtime (PAP); role_permissions is the source of truth"
# ===================================================================================================

step "Create role 'RegionalApprover' with two catalog permissions (read + approve expense reports)"
expect "201; a tenant-scoped role; its permission set is exactly the two requested"
http POST /user-management/v1/roles \
  '{"name":"RegionalApprover-'"$$"'","description":"runtime demo role","permissions":["expense.report.view","expense.report.approve"]}'
assert_status_in "200 201" "custom role created"
ROLE_ID="$(printf '%s' "${HTTP_BODY}" | jq -r '.id // .data.id // empty' 2>/dev/null || true)"
require_var "ROLE_ID" "${ROLE_ID}" || true

step "Negative — try to create a role with a permission NOT in the catalog"
expect "4xx (422/400) — the PAP rejects unknown permissions (catalog guard)"
http POST /user-management/v1/roles \
  '{"name":"BogusRole-'"$$"'","permissions":["totally.made.up.permission"]}'
case "${HTTP_STATUS}" in
  4*) pass "unknown permission rejected (HTTP ${HTTP_STATUS}) — catalog is enforced" ;;
  *)  fail "expected a 4xx for an unknown permission, got HTTP ${HTTP_STATUS}" ;;
esac

# ===================================================================================================
title "FLOW-021 — Assign a custom role to a user at runtime (effective immediately)"
# ===================================================================================================

step "Register a low-privilege target user to receive the role"
expect "201; a fresh user with no elevated permissions yet"
http POST /user-management/v1/auth/register \
  "{\"email\":\"${TARGET_EMAIL}\",\"password\":\"${TARGET_PASSWORD}\",\"firstName\":\"Target\",\"lastName\":\"User\"}" \
  --no-auth
assert_status_in "200 201" "target user registered"

# We need the target user's id. /auth/me as the target gives it to us without admin user-lookup routes.
TARGET_TOKEN="$(login "${TARGET_EMAIL}" "${TARGET_PASSWORD}" "${TENANT_A}")"
TARGET_ID=""
if [ -n "${TARGET_TOKEN}" ]; then
  ME_BODY="$(curl -sS "${GW}/user-management/v1/auth/me" \
    -H "x-tenant-id: ${TENANT_A}" -H "authorization: Bearer ${TARGET_TOKEN}" 2>/dev/null || true)"
  TARGET_ID="$(printf '%s' "${ME_BODY}" | jq -r '.id // .data.id // empty' 2>/dev/null || true)"
fi

step "As the admin, assign 'RegionalApprover' to the target user (scope OwnAndTeam)"
expect "200; a user_roles grant; the PIP cache is invalidated so the NEXT decision sees it"
# restore admin context (login above switched no globals, but be explicit)
CTX_TENANT="${TENANT_A}"; as_tenant_a >/dev/null 2>&1 || as_tenant_a
if [ -n "${ROLE_ID}" ] && [ -n "${TARGET_ID}" ]; then
  http POST "/user-management/v1/users/${TARGET_ID}/role" \
    "{\"roleId\":\"${ROLE_ID}\",\"scope\":\"OwnAndTeam\"}"
  assert_status_in "200 201" "role assigned to target user at runtime"
else
  fail "missing ROLE_ID or TARGET_ID; cannot assign (ROLE_ID='${ROLE_ID}' TARGET_ID='${TARGET_ID}')"
fi

# ===================================================================================================
title "FLOW-022 / FLOW-023 — Allowed vs denied authorization decision (RBAC)"
# ===================================================================================================

step "ALLOWED — the seeded admin (holds every permission) lists roles (a permissioned route)"
expect "200; RBAC grants the admin role.view"
http GET /user-management/v1/roles
assert_status 200 "admin allowed on a permissioned route"

step "DENIED — the low-privilege target user calls an admin-only route (create a role)"
expect "403; PDP fails closed — the target lacks role.create"
DENY_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${GW}/user-management/v1/roles" \
  -H "content-type: application/json" -H "x-tenant-id: ${TENANT_A}" \
  -H "authorization: Bearer ${TARGET_TOKEN}" \
  --data '{"name":"ShouldNotExist","permissions":["expense.report.view"]}' 2>/dev/null || echo 000)"
printf '  %s→ POST /roles as the low-priv target  ← HTTP %s%s\n' "${C_BLUE}" "${DENY_CODE}" "${C_RESET}"
case "${DENY_CODE}" in 403) pass "denied (HTTP 403) — PDP fails closed, no privilege escalation" ;; *) fail "expected 403, got ${DENY_CODE}" ;; esac

# ===================================================================================================
title "FLOW-024 — Cross-tenant isolation attempt (MUST fail)"
# ===================================================================================================

# Create a report in tenant A so there's a concrete row to attempt to read across the tenant boundary.
step "As tenant-A admin, create an expense report (a tenant-A-owned row to probe)"
expect "201; a tenant-A expense report"
as_tenant_a >/dev/null 2>&1 || true
CTX_TENANT="${TENANT_A}"; CTX_TOKEN="$(login "${ADMIN_A_EMAIL}" "${ADMIN_A_PASSWORD}" "${TENANT_A}")"
http POST /expense/v1/reports '{"name":"RLS probe report","currency":"USD"}'
assert_status_in "200 201" "tenant-A report created"
A_REPORT_ID="$(printf '%s' "${HTTP_BODY}" | jq -r '.data.id // .id // empty' 2>/dev/null || true)"
require_var "A_REPORT_ID" "${A_REPORT_ID}" || true

step "Tenant A reads its OWN report — the control case"
expect "200; the owning tenant sees its row"
http GET "/expense/v1/reports/${A_REPORT_ID}"
assert_status 200 "owning tenant reads its own report"

step "Tenant B logs in and requests TENANT A's report id directly"
expect "404 — RLS makes A's row invisible to B (not 200, and not 403, to avoid confirming existence)"
B_TOKEN="$(login "${ADMIN_B_EMAIL}" "${ADMIN_B_PASSWORD}" "${TENANT_B}")"
if [ -z "${B_TOKEN}" ]; then
  fail "could not log in tenant-B admin — is tenant B seeded? (admin@demo-org-b.test)"
else
  XT_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${GW}/expense/v1/reports/${A_REPORT_ID}" \
    -H "x-tenant-id: ${TENANT_B}" -H "authorization: Bearer ${B_TOKEN}" 2>/dev/null || echo 000)"
  printf '  %s→ GET /expense/v1/reports/%s  as TENANT B  ← HTTP %s%s\n' "${C_BLUE}" "${A_REPORT_ID}" "${XT_CODE}" "${C_RESET}"
  case "${XT_CODE}" in
    404) pass "cross-tenant read blocked (HTTP 404) — RLS isolation holds; existence not confirmed" ;;
    403) pass "cross-tenant read blocked (HTTP 403) — isolation holds (scope gate)" ;;
    *)   fail "cross-tenant read should be 404 (or 403), got HTTP ${XT_CODE} — ISOLATION BREACH if 200" ;;
  esac
fi

step "Header forgery — tenant-B token but with the TENANT-A header (try to ride into A)"
expect "401/403 — tenant is derived from the validated token, not the header; mismatch fails closed"
FORGE_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${GW}/expense/v1/reports/${A_REPORT_ID}" \
  -H "x-tenant-id: ${TENANT_A}" -H "authorization: Bearer ${B_TOKEN}" 2>/dev/null || echo 000)"
printf '  %s→ GET A-report with B-token + A-header  ← HTTP %s%s\n' "${C_BLUE}" "${FORGE_CODE}" "${C_RESET}"
case "${FORGE_CODE}" in 401|403|404) pass "header forgery rejected (HTTP ${FORGE_CODE}) — header cannot override the token" ;; *) fail "expected 401/403/404, got ${FORGE_CODE}" ;; esac

demo_summary
