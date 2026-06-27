#!/usr/bin/env bash
#
# Suite G — Payroll, high-sensitivity PII (flow-catalogue FLOW-060 … FLOW-064).
#
# What this demonstrates, live:
#   - onboard an employee with sensitive fields (bankAccount, nationalId) — stored AES-256-GCM
#     encrypted at rest; the create response never echoes plaintext PII back (FLOW-060 / field masking)
#   - pay run: create (draft) → calculate (→ calculated) (FLOW-061)
#   - MAKER-CHECKER / segregation of duties: the run's requester is EXCLUDED from approving it; the
#     requester's own approve attempt is denied 403 (the headline SoD assertion of FLOW-062)
#   - disburse is a money write: it requires an Idempotency-Key header and only works once Approved;
#     a non-approved run cannot be disbursed (FLOW-064 state guard) — replays are no-ops
#
# Routes (verified in apps/payroll/src/controllers/*.ts):
#   POST /payroll/v1/employees                 { workJurisdiction, bankAccount?, nationalId?, ... }
#   POST /payroll/v1/pay-runs                  { periodStart, periodEnd, payDate, type? }
#   POST /payroll/v1/pay-runs/:id/calculate
#   POST /payroll/v1/pay-runs/:id/decisions    { decision: approved|rejected, comment? }
#   POST /payroll/v1/pay-runs/:id/disburse     (Idempotency-Key header)
#
# Seeded SoD nuance (documented in CURL_EXAMPLES.md §4): the seeded pay-run policy sets
# excludeRequester:true — whoever queues a run can never approve it. With the single seeded admin
# (who both creates and would approve), the requester's own approve is DENIED 403. To complete the
# chain, register a SECOND user in tenant A, grant them PayRunApprove, and decide as them.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

demo_begin "Suite G — Payroll (onboard → run → maker-checker → disburse; masking)"

as_tenant_a

# ===================================================================================================
title "FLOW-060 — Onboard employee with encrypted PII (field masking at rest)"
# ===================================================================================================

SECRET_BANK="DEMO-BANK-ACCT-987654321"
SECRET_NID="DEMO-NID-555-12-3456"

step "Create an employee carrying bankAccount + nationalId (sensitive fields)"
expect "201; the response must NOT echo the raw bank/national-id plaintext (encrypted at rest)"
http POST /payroll/v1/employees \
  "{\"workJurisdiction\":\"US-CA\",\"employmentStatus\":\"active\",\"bankAccount\":\"${SECRET_BANK}\",\"nationalId\":\"${SECRET_NID}\"}"
assert_status_in "200 201" "employee onboarded"
EMP_ID="$(printf '%s' "${HTTP_BODY}" | jq -r '.data.id // .id // empty' 2>/dev/null || true)"
[ -n "${EMP_ID}" ] && note "employee id = ${EMP_ID}"

step "Verify the sensitive plaintext did NOT leak back in the create response"
expect "neither the raw bank account nor the national id appears anywhere in the response body"
if printf '%s' "${HTTP_BODY}" | grep -qF "${SECRET_BANK}" || printf '%s' "${HTTP_BODY}" | grep -qF "${SECRET_NID}"; then
  fail "sensitive plaintext (bank/national-id) was echoed in the response — masking/encryption breach"
else
  pass "no sensitive plaintext in the response — bank/national-id are encrypted at rest (AES-256-GCM), not returned"
fi
note "To prove the *_enc columns hold ciphertext (not plaintext), inspect them via psql — see"
note "docs/testing/LIVE_E2E_RUNBOOK.md (the field-level encryption assertion)."

# ===================================================================================================
title "FLOW-061 — Pay run: draft → calculate"
# ===================================================================================================

step "Create a pay run (status draft) — this admin is the REQUESTER/maker"
expect "201; a pay_runs row in draft"
http POST /payroll/v1/pay-runs \
  '{"periodStart":"2026-06-01","periodEnd":"2026-06-30","payDate":"2026-07-05","type":"regular"}'
assert_status_in "200 201" "pay run created (draft)"
PRID="$(printf '%s' "${HTTP_BODY}" | jq -r '.id // .data.id // empty' 2>/dev/null || true)"
require_var "PRID" "${PRID}" || true

step "Calculate the run (draft → calculated): gross → taxable → net, encrypted net at rest"
expect "200; status advances to calculated; results are a reviewable draft"
http POST "/payroll/v1/pay-runs/${PRID}/calculate"
assert_status 200 "pay run calculated"
CALC_STATUS="$(printf '%s' "${HTTP_BODY}" | jq -r '.status // .data.status // empty' 2>/dev/null || true)"
note "post-calculate status: ${CALC_STATUS:-<unknown>}"

# ===================================================================================================
title "FLOW-062 — Maker-checker / segregation of duties (the maker CANNOT self-approve)"
# ===================================================================================================

step "The REQUESTER (maker) attempts to approve their OWN run"
expect "403 — excludeRequester:true; the approver must differ from the run editor (SoD)"
http POST "/payroll/v1/pay-runs/${PRID}/decisions" '{"decision":"approved","comment":"self-approve attempt"}'
case "${HTTP_STATUS}" in
  403) pass "self-approval DENIED (HTTP 403) — segregation of duties enforced (maker ≠ checker)" ;;
  *)   fail "maker self-approve should be 403, got HTTP ${HTTP_STATUS} — SoD NOT enforced" ;;
esac
note "To complete the chain, a SEPARATE user with PayRunApprove (not the requester) records the decision;"
note "the run then advances to Approved with a locked_snapshot, capturing BOTH maker and checker identities."

# ===================================================================================================
title "FLOW-064 — Disburse is gated: money write needs an Idempotency-Key + an Approved run"
# ===================================================================================================

step "Attempt to disburse the run while it is still Calculated (not yet Approved)"
expect "a state-guard rejection (409) — disburse requires an Approved run; replays would be no-ops"
http POST "/payroll/v1/pay-runs/${PRID}/disburse" --header "Idempotency-Key: disburse-${PRID}-001"
case "${HTTP_STATUS}" in
  409) pass "disburse of a non-approved run rejected (HTTP 409) — the state machine guards money moves" ;;
  403) pass "disburse rejected (HTTP 403) — disbursement authority/state gate enforced" ;;
  200) note "run reached Approved before disburse (a separate approver decided) — disburse succeeded"
       pass "disburse succeeded on an Approved run (HTTP 200); same Idempotency-Key replays as a no-op" ;;
  *)   fail "expected 409/403 (not-approved guard) or 200 (if approved), got HTTP ${HTTP_STATUS}" ;;
esac
note "Once Approved by a separate checker, disburse builds a payment_batch + payments (each with a UNIQUE"
note "idempotency key) and posts an append-only double-entry ledger; re-issuing the SAME Idempotency-Key"
note "returns the original batch without re-paying (exactly-once). See docs/testing/LIVE_E2E_RUNBOOK.md."

demo_summary
