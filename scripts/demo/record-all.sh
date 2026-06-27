#!/usr/bin/env bash
#
# Aegis demo — record every suite as a terminal cast.
#
#   bash scripts/demo/record-all.sh
#
# Wraps each NN-*.sh demo in `asciinema rec` to produce one self-contained, replayable terminal cast
# per suite under docs/recordings/. The casts capture the full STEP/EXPECT/PASS-FAIL narration + the
# real request/response traffic, so a reviewer can replay (or convert to GIF/SVG) without re-running
# the stack.
#
# If asciinema is NOT installed, this prints the macOS built-in screen-recording instruction
# (Cmd+Shift+5) for each suite instead of failing — so the recordings can still be produced manually.
#
# Prereq: a running stack (each suite gates on /health and points at scripts/setup.sh if it is down).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT_DIR="${ROOT_DIR}/docs/recordings"
# shellcheck source=lib.sh
. "${SCRIPT_DIR}/lib.sh"

mkdir -p "${OUT_DIR}"

SUITES=(
  "00-platform-tenancy.sh:platform-tenancy"
  "01-identity.sh:identity"
  "02-access-control.sh:access-control"
  "03-expense.sh:expense"
  "04-invoice.sh:invoice"
  "05-workflow-approvals.sh:workflow-approvals"
  "06-payroll.sh:payroll"
)

STAMP="$(date +%Y%m%d-%H%M%S)"

printf '%s%sAegis demo — recording all suites → %s%s\n' "${C_BOLD}" "${C_MAGENTA}" "${OUT_DIR}" "${C_RESET}"

if command -v asciinema >/dev/null 2>&1; then
  printf '%s✓ asciinema found%s — recording one cast per suite.\n\n' "${C_GREEN}" "${C_RESET}"
  # Pre-gate so we don't record a cast that just prints "stack down".
  require_tools
  require_stack

  rec_failed=0
  for entry in "${SUITES[@]}"; do
    script="${entry%%:*}"; name="${entry#*:}"
    cast="${OUT_DIR}/${name}-${STAMP}.cast"
    title="Aegis demo — ${name}"
    printf '%s▶ recording %s → %s%s\n' "${C_CYAN}${C_BOLD}" "${script}" "${cast}" "${C_RESET}"
    # --overwrite: deterministic path; --command: run the suite non-interactively; --title: cast metadata.
    if asciinema rec --overwrite --title "${title}" --command "bash '${SCRIPT_DIR}/${script}'" "${cast}"; then
      printf '%s  ✓ saved %s%s\n\n' "${C_GREEN}" "${cast}" "${C_RESET}"
    else
      printf '%s  ✖ recording failed for %s%s\n\n' "${C_RED}" "${script}" "${C_RESET}" 1>&2
      rec_failed=1
    fi
  done

  printf '%sReplay a cast:%s  asciinema play %s/<name>-%s.cast\n' "${C_BOLD}" "${C_RESET}" "${OUT_DIR}" "${STAMP}"
  printf '%sShare/convert:%s  asciinema upload <cast>   (or agg <cast> out.gif to make a GIF)\n' "${C_BOLD}" "${C_RESET}"
  exit "${rec_failed}"
else
  printf '%s! asciinema is not installed.%s\n\n' "${C_YELLOW}" "${C_RESET}"
  printf '  Install it for one-command casts:\n'
  printf '    macOS:  brew install asciinema       (optional GIF export: brew install agg)\n'
  printf '    Linux:  pipx install asciinema  (or your package manager)\n\n'
  printf '  %sOr record manually with the macOS built-in screen recorder:%s\n' "${C_BOLD}" "${C_RESET}"
  printf '    1. Press %sCmd+Shift+5%s → choose "Record Selected Portion" → frame your terminal.\n' "${C_BOLD}" "${C_RESET}"
  printf '    2. Click Record, then run the suite, e.g.:\n\n'
  for entry in "${SUITES[@]}"; do
    script="${entry%%:*}"; name="${entry#*:}"
    printf '         bash %s/%s        %s# → save as %s/%s-%s.mov%s\n' \
      "${SCRIPT_DIR}" "${script}" "${C_DIM}" "${OUT_DIR}" "${name}" "${STAMP}" "${C_RESET}"
  done
  printf '\n    3. Press %sCmd+Ctrl+Esc%s (or the menu-bar stop button) to stop; drag the .mov into %s.\n' \
    "${C_BOLD}" "${C_RESET}" "${OUT_DIR}"
  printf '\n  (Each suite narrates itself with STEP / EXPECT / PASS-FAIL banners, so the recording is\n'
  printf '   self-explanatory to a viewer.)\n'
  # Not an error: the instruction path is a valid outcome.
  exit 0
fi
