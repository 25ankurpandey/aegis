#!/usr/bin/env bash
#
# Aegis demo — run every suite in order.
#
#   bash scripts/demo/run-all.sh
#
# Runs the narrated curl walkthroughs for suites A→G against the running stack (gateway :4000), in the
# canonical recording order (fixtures within a suite are self-contained; suites are independent). Each
# suite prints its own STEP/EXPECT/PASS-FAIL narration and a per-suite summary. This wrapper prints a
# banner before each, tallies suite-level pass/fail, and exits non-zero if ANY suite failed — so a
# reviewer (or CI) runs one command and sees the whole platform exercised end to end.
#
# Gate: the first suite's demo_begin checks the stack is up (curl /health) and points at
# scripts/setup.sh if it is down; we also pre-check here for a friendlier early exit.

set -uo pipefail   # NOTE: not -e — we want to run every suite even if one fails, then report.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

# Share ONE correlation id across every suite so the whole run is greppable in the service logs.
export CID

SUITES=(
  "00-platform-tenancy.sh:Suite A — Platform & tenancy"
  "01-identity.sh:Suite B — Identity & sessions"
  "02-access-control.sh:Suite C — Access-control core"
  "03-expense.sh:Suite D — Expense lifecycle"
  "04-invoice.sh:Suite E — Invoice lifecycle"
  "05-workflow-approvals.sh:Suite F — Workflow & approvals"
  "06-payroll.sh:Suite G — Payroll"
)

printf '%s%s\n' "${C_BOLD}${C_MAGENTA}" "════════════════════════════════════════════════════════════════════════"
printf '%s  AEGIS — end-to-end demo: running all suites in order%s\n' "${C_BOLD}${C_MAGENTA}" "${C_RESET}"
printf '%s%s%s\n' "${C_BOLD}${C_MAGENTA}" "════════════════════════════════════════════════════════════════════════" "${C_RESET}"

# Friendly early gate (each suite re-checks, but fail fast here with the setup.sh pointer).
require_tools
require_stack

suites_passed=0
suites_failed=0
declare -a failed_names=()

for entry in "${SUITES[@]}"; do
  script="${entry%%:*}"
  label="${entry#*:}"
  path="${SCRIPT_DIR}/${script}"

  printf '\n%s%s━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━%s\n' \
    "${C_BOLD}" "${C_BLUE}" "${C_RESET}"
  printf '%s▶▶ %s  (%s)%s\n' "${C_BOLD}${C_BLUE}" "${label}" "${script}" "${C_RESET}"

  if [ ! -f "${path}" ]; then
    printf '%s✖ missing suite script: %s%s\n' "${C_RED}" "${path}" "${C_RESET}" 1>&2
    suites_failed=$((suites_failed + 1)); failed_names+=("${label} (missing)")
    continue
  fi

  # Run the suite in a subshell (its set -e / globals don't leak back here); CID is exported.
  if bash "${path}"; then
    suites_passed=$((suites_passed + 1))
  else
    suites_failed=$((suites_failed + 1)); failed_names+=("${label}")
  fi
done

printf '\n%s%s════════════════════════════════════════════════════════════════════════%s\n' \
  "${C_BOLD}" "${C_MAGENTA}" "${C_RESET}"
printf '%sRUN-ALL SUMMARY%s  %s%d suite(s) passed%s' \
  "${C_BOLD}${C_MAGENTA}" "${C_RESET}" "${C_GREEN}" "${suites_passed}" "${C_RESET}"
if [ "${suites_failed}" -gt 0 ]; then
  printf '  ·  %s%d suite(s) failed%s\n' "${C_RED}" "${suites_failed}" "${C_RESET}"
  for n in "${failed_names[@]}"; do printf '   %s✖ %s%s\n' "${C_RED}" "${n}" "${C_RESET}"; done
  exit 1
fi
printf '  ·  0 failed\n'
printf '%s✓ Every suite passed — the platform was exercised end to end.%s\n' "${C_GREEN}${C_BOLD}" "${C_RESET}"
