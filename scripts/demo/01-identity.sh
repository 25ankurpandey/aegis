#!/usr/bin/env bash
#
# Suite B — Identity & sessions (flow-catalogue FLOW-010 … FLOW-014).
#
# What this demonstrates, live:
#   - register a fresh user into a tenant (tenant comes from the HEADER, not the body) (FLOW-011)
#   - login → mint a JWT → call a protected route with it (FLOW-012)
#   - /auth/me resolves the principal (roles + permissions)
#   - negative: wrong password → 401; tampered token → 401; A-token + B-header → 403 (defense in depth)
#
# Routes (verified in apps/user-management/src/controllers/auth.controller.ts):
#   POST /user-management/v1/auth/register   (public — no bearer)
#   POST /user-management/v1/auth/login      (public — no bearer)
#   GET  /user-management/v1/auth/me         (authenticated)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

demo_begin "Suite B — Identity & sessions"

# A unique email per run so re-runs don't collide on the users uniqueness constraint.
NEW_EMAIL="e2e-$(date +%s)-$$@demo-org.test"
NEW_PASSWORD="e2e-password-123"

# ===================================================================================================
title "FLOW-011 — Register a user (tenant is derived from the x-tenant-id header)"
# ===================================================================================================

step "Register ${NEW_EMAIL} into tenant A — register is public (no bearer), tenant from the header"
expect "201; a users row created for (user, tenant A)"
CTX_TENANT="${TENANT_A}"   # so http() stamps the right tenant header
http POST /user-management/v1/auth/register \
  "{\"email\":\"${NEW_EMAIL}\",\"password\":\"${NEW_PASSWORD}\",\"firstName\":\"E2E\",\"lastName\":\"User\"}" \
  --no-auth
assert_status_in "200 201" "user registered"

# ===================================================================================================
title "FLOW-012 — Login & token issuance"
# ===================================================================================================

step "Log in the freshly registered user → mint a JWT"
expect "200; a 3-part JWT"
NEW_TOKEN="$(login "${NEW_EMAIL}" "${NEW_PASSWORD}" "${TENANT_A}")"
printf '  %s→ POST %s/user-management/v1/auth/login  (email=%s)%s\n' "${C_BLUE}" "${GW}" "${NEW_EMAIL}" "${C_RESET}"
if [ -n "${NEW_TOKEN}" ]; then
  printf '  %s← JWT %s…%s\n' "${C_BLUE}" "${NEW_TOKEN:0:24}" "${C_RESET}"
  pass "login succeeded; token minted"
else
  fail "login returned no token for the new user"
fi

step "Call a protected route with the new token — the edge + service validate it"
expect "200; /auth/me resolves the new principal"
CTX_TOKEN="${NEW_TOKEN}"
CTX_TENANT="${TENANT_A}"
http GET /user-management/v1/auth/me
assert_status 200 "protected route accepts the minted JWT"
ME_EMAIL="$(printf '%s' "${HTTP_BODY}" | jq -r '.email // .data.email // empty' 2>/dev/null || true)"
assert_eq "${ME_EMAIL}" "${NEW_EMAIL}" "resolved principal email"

# ===================================================================================================
title "FLOW-012 (negatives) — wrong password, tampered token, and cross-tenant token misuse"
# ===================================================================================================

step "Log in with the WRONG password"
expect "401 — credentials rejected; no token"
BAD_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST "${GW}/user-management/v1/auth/login" \
  -H "content-type: application/json" -H "x-tenant-id: ${TENANT_A}" \
  --data "{\"email\":\"${NEW_EMAIL}\",\"password\":\"definitely-wrong\"}" 2>/dev/null || echo 000)"
printf '  %s→ POST /auth/login (wrong password)  ← HTTP %s%s\n' "${C_BLUE}" "${BAD_CODE}" "${C_RESET}"
case "${BAD_CODE}" in 401|400) pass "wrong password rejected (HTTP ${BAD_CODE})" ;; *) fail "expected 401, got ${BAD_CODE}" ;; esac

step "Present a TAMPERED token (flip the signature) on a protected route"
expect "401 at the edge — signature no longer verifies"
TAMPERED="${NEW_TOKEN%.*}.deadbeefdeadbeefdeadbeef"
TAMPER_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${GW}/user-management/v1/auth/me" \
  -H "x-tenant-id: ${TENANT_A}" -H "authorization: Bearer ${TAMPERED}" 2>/dev/null || echo 000)"
printf '  %s→ GET /auth/me (tampered signature)  ← HTTP %s%s\n' "${C_BLUE}" "${TAMPER_CODE}" "${C_RESET}"
case "${TAMPER_CODE}" in 401) pass "tampered token rejected (HTTP 401)" ;; *) fail "expected 401, got ${TAMPER_CODE}" ;; esac

step "Present a valid TENANT-A token but with the TENANT-B header (cross-tenant misuse)"
expect "403 at the downstream PEP — tenant is derived from the validated token, not the header"
CROSS_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${GW}/user-management/v1/auth/me" \
  -H "x-tenant-id: ${TENANT_B}" -H "authorization: Bearer ${NEW_TOKEN}" 2>/dev/null || echo 000)"
printf '  %s→ GET /auth/me (A-token + B-header)  ← HTTP %s%s\n' "${C_BLUE}" "${CROSS_CODE}" "${C_RESET}"
case "${CROSS_CODE}" in 401|403) pass "tenant/token mismatch rejected (HTTP ${CROSS_CODE}) — header cannot override the token" ;; *) fail "expected 401/403, got ${CROSS_CODE}" ;; esac

demo_summary
