#!/usr/bin/env bash
#
# Suite E — Invoice lifecycle (flow-catalogue FLOW-040 … FLOW-042).
#
# What this demonstrates, live:
#   - create an invoice header (no line items, header-level only) (FLOW-040)
#   - DUPLICATE DETECTION: re-posting the SAME (vendorName, invoiceNumber, amountMinor, currency) is
#     still accepted (201) but FLAGGED status=duplicate, with the original untouched (FLOW-041)
#   - submit → engine-backed approve decision → read back (FLOW-042 approve path)
#
# Routes (verified in apps/invoice/src/controllers/invoice.controller.ts):
#   POST /invoice/v1/invoices                 { vendorName, invoiceNumber, invoiceDate, amountMinor, currency }
#   POST /invoice/v1/invoices/:id/submit
#   POST /invoice/v1/invoices/:id/decisions   { decision: approved|rejected, comment? }
#   GET  /invoice/v1/invoices/:id
#
# Duplicate detection here is FLAG-not-reject (documented in CURL_EXAMPLES.md §3e): the duplicate gate
# (tenant_id, vendor_name, invoice_number, amount_minor) matches an existing header and writes a
# duplicate link; the second create returns 201 with status="duplicate".

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

demo_begin "Suite E — Invoice lifecycle (create → duplicate-detect → approve)"

as_tenant_a

# A unique invoice number per run so re-runs start from a clean slate for the duplicate gate.
INV_NUM="INV-$(date +%s)-$$"
INV_BODY="{\"vendorName\":\"Acme Freight\",\"invoiceNumber\":\"${INV_NUM}\",\"invoiceDate\":\"2026-06-01\",\"amountMinor\":125000,\"currency\":\"USD\"}"

# ===================================================================================================
title "FLOW-040 — Create invoice header (header-level only; routed to review)"
# ===================================================================================================

step "Create the ORIGINAL invoice ${INV_NUM} for Acme Freight (\$1,250.00)"
expect "201; an invoices row; status is a live review state (NOT duplicate)"
http POST /invoice/v1/invoices "${INV_BODY}"
assert_status_in "200 201" "original invoice created"
IID="$(printf '%s' "${HTTP_BODY}" | jq -r '.data.id // .id // empty' 2>/dev/null || true)"
require_var "IID" "${IID}" || true
ORIG_STATUS="$(printf '%s' "${HTTP_BODY}" | jq -r '.data.status // .status // empty' 2>/dev/null || true)"
note "original status: ${ORIG_STATUS:-<unknown>}"
if [ "${ORIG_STATUS}" = "duplicate" ]; then
  fail "the FIRST create should not be flagged duplicate (got '${ORIG_STATUS}')"
else
  pass "original invoice landed in a live state ('${ORIG_STATUS:-received/under_review}'), not duplicate"
fi

# ===================================================================================================
title "FLOW-041 — Duplicate detection (the second identical header MUST be flagged)"
# ===================================================================================================

step "Re-post the SAME vendor + number + amount + currency"
expect "201, but status=duplicate; a duplicate link is written; the ORIGINAL is untouched"
http POST /invoice/v1/invoices "${INV_BODY}"
assert_status_in "200 201" "second create accepted (flag-not-reject)"
DUP_STATUS="$(printf '%s' "${HTTP_BODY}" | jq -r '.data.status // .status // empty' 2>/dev/null || true)"
DUP_ID="$(printf '%s' "${HTTP_BODY}" | jq -r '.data.id // .id // empty' 2>/dev/null || true)"
assert_eq "${DUP_STATUS}" "duplicate" "second invoice status (duplicate gate fired)"

step "Confirm the ORIGINAL invoice is untouched by the duplicate"
expect "200; the original keeps its own (non-duplicate) status"
http GET "/invoice/v1/invoices/${IID}"
assert_status 200 "original invoice still readable"
ORIG_AFTER="$(printf '%s' "${HTTP_BODY}" | jq -r '.data.status // .status // empty' 2>/dev/null || true)"
if [ "${ORIG_AFTER}" != "duplicate" ]; then
  pass "original intact (status='${ORIG_AFTER}') — only the SECOND header was flagged"
else
  fail "the original was wrongly flagged duplicate"
fi

# ===================================================================================================
title "FLOW-042 — Submit → approve (engine-backed decision)"
# ===================================================================================================

step "Submit the original invoice for approval"
expect "200; routed into the approval engine"
http POST "/invoice/v1/invoices/${IID}/submit"
assert_status_in "200 204" "invoice submitted"

step "Record the engine-backed APPROVE decision"
expect "200; status advances toward approved (final level → approved)"
http POST "/invoice/v1/invoices/${IID}/decisions" '{"decision":"approved","comment":"ok to pay"}'
assert_status 200 "approval decision recorded"

step "Read the invoice back — confirm the post-approval state"
expect "status=approved (or the terminal state the engine reached)"
http GET "/invoice/v1/invoices/${IID}"
assert_status 200 "invoice readable"
INV_FINAL="$(printf '%s' "${HTTP_BODY}" | jq -r '.data.status // .status // empty' 2>/dev/null || true)"
case "${INV_FINAL}" in
  approved|paid) pass "invoice reached terminal '${INV_FINAL}' via the approval engine" ;;
  *)             fail "unexpected final invoice status '${INV_FINAL}' (expected approved)" ;;
esac

demo_summary
