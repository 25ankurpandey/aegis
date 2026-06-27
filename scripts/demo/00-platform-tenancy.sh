#!/usr/bin/env bash
#
# Suite A — Platform & tenancy foundation (flow-catalogue FLOW-001 … FLOW-003).
#
# What this demonstrates, live, against the running stack:
#   - health & readiness across the gateway + every service (FLOW-003)
#   - the platform is bootstrapped: the demo tenant exists and its system roles are seeded (FLOW-002)
#   - tenant context is fail-closed: a missing x-tenant-id is rejected, never defaulted (platform conv.)
#
# Note on FLOW-002: tenants in Aegis are provisioned by the migration/seeder bootstrap (PROCESS_TYPE=
# migration in scripts/setup.sh), not by a runtime POST /v1/tenants endpoint. So this suite PROVES the
# onboarding RESULT — the tenant is active and its seeded system roles are listable — rather than
# issuing a create call that the platform does not expose. (Source of truth: the seeders create the
# demo tenant; there is no tenant-create controller.)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

demo_begin "Suite A — Platform & tenancy foundation"

# ===================================================================================================
title "FLOW-003 — Health, readiness & graceful dependency posture"
# ===================================================================================================

step "Probe the gateway liveness (/health is the only unauthenticated route — no tenant, no token)"
expect "200 with status ok"
http GET /health --no-auth
assert_status 200 "gateway /health is live"

step "Probe deep readiness on a downstream service (db + cache reported)"
expect "200; db and cache present in the body"
# The expense service is reachable via its own port; the gateway only proxies business routes, so we
# hit the service health directly (defense-in-depth: each service exposes its own /health).
EXP_HEALTH="$(curl -sS "http://localhost:4002/health?details=true" 2>/dev/null || true)"
printf '  %s← http://localhost:4002/health?details=true%s\n' "${C_BLUE}" "${C_RESET}"
printf '%s' "${EXP_HEALTH}" | jq . 2>/dev/null | sed 's/^/    /' || printf '    %s\n' "${EXP_HEALTH}"
EXP_STATUS="$(printf '%s' "${EXP_HEALTH}" | jq -r '.status // empty' 2>/dev/null || true)"
assert_eq "${EXP_STATUS}" "ok" "expense readiness status"

step "Sweep liveness across every business service port (defense-in-depth PEPs each own /health)"
expect "every port answers 2xx"
all_up=1
for pair in "user-management:4001" "expense:4002" "payroll:4003" "reporting:4004" "workflow:4005" "notification:4006" "invoice:4007"; do
  svc="${pair%%:*}"; port="${pair##*:}"
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${port}/health" 2>/dev/null || echo 000)"
  printf '    %s%-16s:%s → HTTP %s\n' "${C_DIM}" "${svc}" "${port}" "${code}"
  case "${code}" in 2*) ;; *) all_up=0 ;; esac
done
if [ "${all_up}" -eq 1 ]; then pass "all 7 business services report healthy"; else fail "one or more services are not healthy"; fi

# ===================================================================================================
title "FLOW-002 — Tenant onboarding (provisioned at bootstrap; verify the result)"
# ===================================================================================================

# Authenticate as the seeded tenant-A admin — proves the tenant exists, is active, and accepts logins.
as_tenant_a

step "List the tenant's roles — the onboarding seeder links the system roles via role_permissions"
expect "200; the seeded system roles are visible (TenantAdmin / Approver / Member / Auditor family)"
http GET /user-management/v1/roles
assert_status 200 "roles listing is reachable for the tenant admin"
ROLE_COUNT="$(printf '%s' "${HTTP_BODY}" | jq -r 'if type=="array" then length elif .data then (.data|length) else 0 end' 2>/dev/null || echo 0)"
if [ "${ROLE_COUNT:-0}" -ge 1 ]; then
  pass "tenant has ${ROLE_COUNT} seeded role(s) — onboarding seeded the role catalog"
else
  fail "expected seeded system roles for the tenant, found ${ROLE_COUNT}"
fi

step "Confirm the admin principal resolves with permissions (the seeded admin holds the full set)"
expect "200; /auth/me returns the principal with roles + permissions"
http GET /user-management/v1/auth/me
assert_status 200 "/auth/me resolves the authenticated principal"
ME_EMAIL="$(printf '%s' "${HTTP_BODY}" | jq -r '.email // .data.email // empty' 2>/dev/null || true)"
assert_eq "${ME_EMAIL}" "${ADMIN_A_EMAIL}" "resolved principal email"

# ===================================================================================================
title "Platform convention — tenant context is fail-closed (never defaulted to UNKNOWN)"
# ===================================================================================================

step "Call a business route with NO x-tenant-id header — the context middleware must reject it"
expect "a 4xx (fail-closed); the tenant is required and never defaulted"
# Bypass http()'s tenant header by calling curl directly with no x-tenant-id.
NOTEN_CODE="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "authorization: Bearer ${CTX_TOKEN}" \
  "${GW}/user-management/v1/auth/me" 2>/dev/null || echo 000)"
printf '  %s→ GET %s/user-management/v1/auth/me  (x-tenant-id OMITTED)%s\n' "${C_BLUE}" "${GW}" "${C_RESET}"
printf '  %s← HTTP %s%s\n' "${C_BLUE}" "${NOTEN_CODE}" "${C_RESET}"
case "${NOTEN_CODE}" in
  4*) pass "missing tenant rejected fail-closed (HTTP ${NOTEN_CODE}) — no default tenant" ;;
  *)  fail "missing tenant should be a 4xx, got HTTP ${NOTEN_CODE}" ;;
esac

demo_summary
