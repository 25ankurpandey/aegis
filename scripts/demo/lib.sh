#!/usr/bin/env bash
#
# Aegis demo — shared helpers (sourced by every NN-*.sh script).
#
# This is the narration + HTTP layer the suite scripts build on. It gives every demo:
#   - a colored STEP banner + EXPECT line + PASS/FAIL VERDICT (mirrors the flow-catalogue caption track)
#   - an http() that prints the request, captures the response body + status, and returns both
#   - jq-based extractors with guards (fail loudly when a field the next step needs is missing)
#   - JWT capture (login → token) and a stack-up gate (curl /health, friendly pointer to setup.sh)
#
# Everything goes through the GATEWAY on :4000 (the single entry point); each service re-enforces
# auth via its own PEP. Conventions match docs/testing/CURL_EXAMPLES.md:
#   x-tenant-id   required, fail-closed (never defaulted)
#   x-correlation-id  optional in, echoed back (we set our own so logs are greppable)
#   authorization: Bearer <jwt>  on every route except /auth/register and /auth/login
#
# Sourced, not executed. The suite scripts set `set -euo pipefail`; this file assumes it.

# ---------------------------------------------------------------------------------------------------
# Config (override via env). The seeded demo tenants + admins come from scripts/setup.sh output.
# ---------------------------------------------------------------------------------------------------
: "${GW:=http://localhost:4000}"                                  # gateway base url
: "${TENANT_A:=00000000-0000-4000-8000-000000000001}"            # Demo Org (tenant A)
: "${TENANT_B:=00000000-0000-4000-8000-000000000002}"            # Demo Org B (tenant B) — RLS isolation
: "${ADMIN_A_EMAIL:=admin@demo-org.test}"
: "${ADMIN_A_PASSWORD:=demo-admin-pw}"
: "${ADMIN_B_EMAIL:=admin@demo-org-b.test}"
: "${ADMIN_B_PASSWORD:=demo-admin-pw-b}"
: "${CID:=demo-$(date +%s)-$$}"                                   # correlation id for this whole run

# ---------------------------------------------------------------------------------------------------
# Colors (only when stdout is a TTY — keeps recordings/pipes clean).
# ---------------------------------------------------------------------------------------------------
if [ -t 1 ]; then
  C_RESET="$(printf '\033[0m')";  C_BOLD="$(printf '\033[1m')";  C_DIM="$(printf '\033[2m')"
  C_GREEN="$(printf '\033[32m')"; C_RED="$(printf '\033[31m')"; C_YELLOW="$(printf '\033[33m')"
  C_CYAN="$(printf '\033[36m')";  C_BLUE="$(printf '\033[34m')"; C_MAGENTA="$(printf '\033[35m')"
else
  C_RESET=""; C_BOLD=""; C_DIM=""; C_GREEN=""; C_RED=""; C_YELLOW=""; C_CYAN=""; C_BLUE=""; C_MAGENTA=""
fi

# Pass/fail tallies (a suite prints a summary at the end via demo_summary).
DEMO_PASS=0
DEMO_FAIL=0
STEP_NO=0

# ---------------------------------------------------------------------------------------------------
# Narration banners — the on-screen caption track from the flow catalogue, rendered in the terminal.
# ---------------------------------------------------------------------------------------------------

# title "FLOW-0NN — ..."  — the TITLE caption, shown once at the top of a flow.
title() {
  printf '\n%s%s┏━━ %s ━━%s\n' "${C_MAGENTA}" "${C_BOLD}" "$*" "${C_RESET}"
}

# step "what is being done"  — increments the step counter and prints a STEP banner.
step() {
  STEP_NO=$((STEP_NO + 1))
  printf '\n%s%s▶ STEP %s: %s%s\n' "${C_CYAN}" "${C_BOLD}" "${STEP_NO}" "$*" "${C_RESET}"
}

# expect "the expected result"  — the EXPECT caption, shown before the response renders.
expect() {
  printf '  %sEXPECT:%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*"
}

# note "..."  — a dim aside (context the catalogue carries as prose).
note() {
  printf '  %s· %s%s\n' "${C_DIM}" "$*" "${C_RESET}"
}

# pass "asserted fact"  — green VERDICT, bumps the pass tally.
pass() {
  DEMO_PASS=$((DEMO_PASS + 1))
  printf '  %s%s✔ PASS%s — %s\n' "${C_GREEN}" "${C_BOLD}" "${C_RESET}${C_GREEN}" "$*${C_RESET}"
}

# fail "what broke"  — red VERDICT, bumps the fail tally. Does NOT exit (a suite keeps going so the
# reviewer sees every result); the suite's exit code reflects the tally via demo_summary.
fail() {
  DEMO_FAIL=$((DEMO_FAIL + 1))
  printf '  %s%s✖ FAIL%s — %s\n' "${C_RED}" "${C_BOLD}" "${C_RESET}${C_RED}" "$*${C_RESET}" 1>&2
}

# ---------------------------------------------------------------------------------------------------
# Preflight — tools + a running stack. Friendly, with a pointer to setup.sh when the stack is down.
# ---------------------------------------------------------------------------------------------------

require_tools() {
  local missing=0
  for tool in curl jq; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
      fail "required tool '${tool}' is not on PATH"
      missing=1
    fi
  done
  if [ "${missing}" -ne 0 ]; then
    printf '\n  %sInstall the missing tool(s) and re-run.%s  (macOS: brew install jq)\n\n' "${C_YELLOW}" "${C_RESET}"
    exit 1
  fi
}

# require_stack — gate every demo on the gateway answering /health. If it is down, print the exact
# command to bring the stack up and exit non-zero (so run-all.sh stops cleanly).
require_stack() {
  local code
  # Capture curl's -w status; tolerate curl's non-zero exit on connection failure (don't trip set -e).
  code="$(curl -s -o /dev/null -w '%{http_code}' "${GW}/health" 2>/dev/null)" || true
  case "${code}" in (''|*[!0-9]*) code=000 ;; esac
  case "${code}" in
    2*)
      printf '%s✓ Stack is up%s — gateway healthy at %s/health\n' "${C_GREEN}" "${C_RESET}" "${GW}"
      ;;
    *)
      printf '\n%s%s✖ The Aegis stack is not reachable%s (GET %s/health → HTTP %s).\n' \
        "${C_RED}" "${C_BOLD}" "${C_RESET}" "${GW}" "${code}" 1>&2
      printf '\n  Bring the whole platform up first:\n\n    %sbash scripts/setup.sh%s\n\n' "${C_BOLD}" "${C_RESET}" 1>&2
      printf '  (Postgres + RLS, Redis, Kafka, all 9 services + workers. Then re-run this demo.)\n\n' 1>&2
      exit 1
      ;;
  esac
}

# ---------------------------------------------------------------------------------------------------
# HTTP core — http() prints the request, runs curl, captures body + status into globals, pretty-prints
# the response, and leaves the result for the caller's assertions.
#
#   http METHOD PATH [JSON_BODY] [extra curl args...]
#
# Globals it sets (read these right after the call):
#   HTTP_STATUS  — numeric HTTP status code
#   HTTP_BODY    — raw response body (string; may be empty for 204)
#
# Auth/tenant headers are pulled from the current context, set by `as_tenant_a` / `as_tenant_b` /
# `auth_as`. Pass --no-auth to omit the bearer (e.g. register/login), --tenant <uuid> to override the
# tenant header for one call (header-forgery negative tests), and --header 'K: V' for extras.
# ---------------------------------------------------------------------------------------------------

# Context the http() helper reads. Set by the auth helpers below.
CTX_TENANT="${TENANT_A}"
CTX_TOKEN=""

http() {
  local method="$1"; shift
  local path="$1"; shift
  local body=""
  local use_auth=1
  local tenant="${CTX_TENANT}"
  local -a extra_headers=()

  # First non-flag positional after method/path is the JSON body (if it doesn't start with --).
  if [ "$#" -gt 0 ] && [ "${1#--}" = "${1}" ]; then
    body="$1"; shift
  fi
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-auth) use_auth=0; shift ;;
      --tenant)  tenant="$2"; shift 2 ;;
      --header)  extra_headers+=("-H" "$2"); shift 2 ;;
      *) extra_headers+=("$1"); shift ;;
    esac
  done

  local url="${GW}${path}"

  # ---- print the request (so the reviewer SEES exactly what is sent) ----
  printf '  %s→ %s %s%s\n' "${C_BLUE}" "${method}" "${url}" "${C_RESET}"
  printf '    %sx-tenant-id: %s%s\n' "${C_DIM}" "${tenant}" "${C_RESET}"
  printf '    %sx-correlation-id: %s%s\n' "${C_DIM}" "${CID}" "${C_RESET}"
  if [ "${use_auth}" -eq 1 ] && [ -n "${CTX_TOKEN}" ]; then
    printf '    %sauthorization: Bearer %s…%s\n' "${C_DIM}" "${CTX_TOKEN:0:18}" "${C_RESET}"
  fi
  if [ -n "${body}" ]; then
    printf '    %sbody: %s%s\n' "${C_DIM}" "${body}" "${C_RESET}"
  fi

  # ---- build curl args ----
  local -a args=(-sS -X "${method}" "${url}"
    -H "content-type: application/json"
    -H "x-tenant-id: ${tenant}"
    -H "x-correlation-id: ${CID}")
  if [ "${use_auth}" -eq 1 ] && [ -n "${CTX_TOKEN}" ]; then
    args+=(-H "authorization: Bearer ${CTX_TOKEN}")
  fi
  if [ "${#extra_headers[@]}" -gt 0 ]; then
    args+=("${extra_headers[@]}")
  fi
  if [ -n "${body}" ]; then
    args+=(--data "${body}")
  fi

  # Capture body + status in one shot. We append a sentinel line with the status so we can split it
  # off without a temp file (and without losing a body that has no trailing newline).
  local raw
  raw="$(curl "${args[@]}" -w $'\n__HTTP_STATUS__:%{http_code}' 2>/dev/null || true)"
  HTTP_STATUS="${raw##*__HTTP_STATUS__:}"
  HTTP_BODY="${raw%$'\n'__HTTP_STATUS__:*}"
  # Guard: if curl produced nothing at all, normalize.
  case "${HTTP_STATUS}" in (''|*[!0-9]*) HTTP_STATUS=000 ;; esac

  # ---- print the response ----
  printf '  %s← HTTP %s%s\n' "${C_BLUE}" "${HTTP_STATUS}" "${C_RESET}"
  if [ -n "${HTTP_BODY}" ]; then
    if printf '%s' "${HTTP_BODY}" | jq . >/dev/null 2>&1; then
      printf '%s' "${HTTP_BODY}" | jq . | sed 's/^/    /'
    else
      printf '    %s\n' "${HTTP_BODY}"
    fi
  fi
}

# ---------------------------------------------------------------------------------------------------
# Assertions — each prints a PASS/FAIL VERDICT and updates the tally.
# ---------------------------------------------------------------------------------------------------

# assert_status EXPECTED "label"  — asserts HTTP_STATUS equals EXPECTED.
assert_status() {
  local want="$1"; local label="${2:-status}"
  if [ "${HTTP_STATUS}" = "${want}" ]; then
    pass "${label} (HTTP ${HTTP_STATUS})"
    return 0
  fi
  fail "${label} — expected HTTP ${want}, got ${HTTP_STATUS}"
  return 1
}

# assert_status_in "200 201" "label"  — asserts HTTP_STATUS is one of a set (some routes return 200|201).
assert_status_in() {
  local set="$1"; local label="${2:-status}"
  local s
  for s in ${set}; do
    if [ "${HTTP_STATUS}" = "${s}" ]; then
      pass "${label} (HTTP ${HTTP_STATUS})"
      return 0
    fi
  done
  fail "${label} — expected HTTP one of [${set}], got ${HTTP_STATUS}"
  return 1
}

# assert_eq ACTUAL EXPECTED "label"  — generic equality verdict (e.g. a status field).
assert_eq() {
  local actual="$1"; local want="$2"; local label="${3:-value}"
  if [ "${actual}" = "${want}" ]; then
    pass "${label} = ${actual}"
    return 0
  fi
  fail "${label} — expected '${want}', got '${actual}'"
  return 1
}

# ---------------------------------------------------------------------------------------------------
# jq extractors with guards — pull a field out of HTTP_BODY; on a missing/null field, FAIL loudly so
# the next step doesn't run on garbage. Usage: id="$(json_get '.data.id' 'report id')".
# ---------------------------------------------------------------------------------------------------

# json_get FILTER "label"  — echoes the extracted value; FAILs (and echoes empty) when null/missing.
json_get() {
  local filter="$1"; local label="${2:-field}"
  local val
  val="$(printf '%s' "${HTTP_BODY}" | jq -r "${filter} // empty" 2>/dev/null || true)"
  if [ -z "${val}" ]; then
    fail "could not extract ${label} (${filter}) from response" 1>&2
    printf ''
    return 1
  fi
  printf '%s' "${val}"
}

# require_var NAME VALUE  — guard a captured id before reusing it; aborts the suite if empty.
require_var() {
  local name="$1"; local value="$2"
  if [ -z "${value}" ]; then
    fail "expected '${name}' to be captured by now, but it is empty — cannot continue this flow"
    return 1
  fi
  note "${name} = ${value}"
  return 0
}

# ---------------------------------------------------------------------------------------------------
# Auth helpers — login captures a JWT; the context switches drive which tenant/token http() uses.
# ---------------------------------------------------------------------------------------------------

# login EMAIL PASSWORD TENANT  — POST /auth/login, echo the JWT (empty on failure). No narration; the
# caller decides how to present it. Uses --no-auth (login needs no bearer) + the given tenant header.
login() {
  local email="$1"; local password="$2"; local tenant="$3"
  local raw token
  raw="$(curl -sS -X POST "${GW}/user-management/v1/auth/login" \
    -H "content-type: application/json" -H "x-tenant-id: ${tenant}" -H "x-correlation-id: ${CID}" \
    --data "{\"email\":\"${email}\",\"password\":\"${password}\"}" 2>/dev/null || true)"
  token="$(printf '%s' "${raw}" | jq -r '.token // empty' 2>/dev/null || true)"
  printf '%s' "${token}"
}

# auth_as EMAIL PASSWORD TENANT "label"  — login + narrate + set the http() context to that identity.
auth_as() {
  local email="$1"; local password="$2"; local tenant="$3"; local label="${4:-$email}"
  step "Authenticating as ${label} (${email})"
  expect "200 + a 3-part JWT (header.payload.signature)"
  local token
  token="$(login "${email}" "${password}" "${tenant}")"
  if [ -z "${token}" ]; then
    fail "login failed for ${email} in tenant ${tenant} (no token returned)"
    CTX_TOKEN=""; CTX_TENANT="${tenant}"
    return 1
  fi
  CTX_TOKEN="${token}"
  CTX_TENANT="${tenant}"
  pass "logged in as ${label}; JWT ${token:0:24}…"
  return 0
}

# Convenience: switch the active context to the seeded admin of tenant A or B (most demos use A).
as_tenant_a() { auth_as "${ADMIN_A_EMAIL}" "${ADMIN_A_PASSWORD}" "${TENANT_A}" "Tenant-A admin"; }
as_tenant_b() { auth_as "${ADMIN_B_EMAIL}" "${ADMIN_B_PASSWORD}" "${TENANT_B}" "Tenant-B admin"; }

# ---------------------------------------------------------------------------------------------------
# Suite lifecycle — call demo_begin at the top of a suite and demo_summary at the end.
# ---------------------------------------------------------------------------------------------------

demo_begin() {
  local suite="$1"
  printf '%s%s' "${C_BOLD}" "${C_MAGENTA}"
  printf '╔══════════════════════════════════════════════════════════════════════╗\n'
  printf '║  Aegis demo — %-55s║\n' "${suite}"
  printf '╚══════════════════════════════════════════════════════════════════════╝'
  printf '%s\n' "${C_RESET}"
  note "gateway ${GW}  ·  correlation-id ${CID}"
  require_tools
  require_stack
}

# demo_summary  — print the PASS/FAIL tally and exit non-zero if anything failed (so CI/run-all catch it).
demo_summary() {
  printf '\n%s%s── Summary ──%s  %s%d passed%s' \
    "${C_BOLD}" "${C_MAGENTA}" "${C_RESET}" "${C_GREEN}" "${DEMO_PASS}" "${C_RESET}"
  if [ "${DEMO_FAIL}" -gt 0 ]; then
    printf '  ·  %s%d failed%s\n' "${C_RED}" "${DEMO_FAIL}" "${C_RESET}"
    return 1
  fi
  printf '  ·  0 failed\n'
  return 0
}
