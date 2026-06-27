# Aegis — Flow Recording Plan

This document defines how to capture shareable proof for the catalogue flows. The recordings are
evidence, not the source of truth: assertions live in Jest/curl/SQL, while recordings make the
review path easy to follow.

## What To Record

Record one clip per suite from [`flow-catalogue.md`](./flow-catalogue.md):

| Suite | Focus | Primary driver |
|---|---|---|
| A | Platform and tenancy foundation | live curl + SQL witness |
| B | Identity and sessions | live curl |
| C | Access control and PAP | live curl + SQL witness |
| D | Expense flow | live curl + outbox/audit SQL |
| E | Invoice flow | live curl + duplicate/status SQL |
| F | Workflow approvals | live curl + event/audit SQL |
| G | Payroll flow | live curl + ledger SQL |
| H | Reporting | live curl + run status/export lookup |
| I | Notification | live curl + notification/email-log SQL |
| J | Service-to-service integrity | live Jest + SQL witness |

For the first release pass, record the P0/P1 flows only. Mark aspirational or deferred flows as
`skipped` in the sidecar JSON until the backing implementation exists.

## File Layout

Use a single folder per run:

```text
recordings/<run-id>/
  A_platform_tenancy.cast
  A_platform_tenancy.json
  D_expense_flow.cast
  D_expense_flow.json
  run-summary.json
```

Recommended run id: `<yyyy-mm-dd>-<git-sha-short>`.

## Capture Tools

Terminal-first flows can use `asciinema`:

```bash
asciinema rec recordings/<run-id>/D_expense_flow.cast
```

Browser or Postman walkthroughs can use the macOS screen recorder. Keep the sidecar JSON identical
regardless of capture tool.

## Sidecar Format

Every clip has a JSON sidecar:

```json
{
  "suite": "D",
  "flowIds": ["FLOW-030", "FLOW-031", "FLOW-032"],
  "title": "Expense create, submit, approve, and ERP push",
  "driver": "curl",
  "status": "pass",
  "startedAt": "2026-06-27T10:00:00.000Z",
  "commit": "<git-sha>",
  "steps": [
    { "t": 0, "action": "Login as tenant admin", "expect": "200 and JWT" },
    { "t": 12, "action": "Create expense report", "expect": "201, status=open" },
    { "t": 40, "action": "Approve report", "expect": "approved, outbox connector event staged" }
  ],
  "evidence": {
    "commands": ["docs/testing/CURL_EXAMPLES.md#expense"],
    "dbWitnesses": ["expense_reports", "event_outbox", "audit_log"],
    "testResults": "test-results/<run-id>.json"
  },
  "notes": []
}
```

`status` is one of `pass`, `fail`, or `skipped`. A failing recording must have a matching
`BUGLOG.md` entry. A skipped recording must name the deferred implementation in `notes`.

## Acceptance Bar

A recording is complete only when:

- The clip shows the command/request and the relevant success or failure response.
- At least one DB witness is visible for state-changing flows.
- The sidecar lists flow ids and matches the final result.
- Any failure is logged in `BUGLOG.md` with a reproducible command.
