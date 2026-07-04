# Aegis — Agentic Operations, Governance & Autonomy

> **The one principle everything hangs on:** *the agent reasons; the governed core acts.* The LLM
> plans, converses, retrieves, and **proposes**; every state change executes through the same
> deterministic `authenticate → authorize(PEP/Casbin) → RLS → audit` path a human API call hits. The
> agent is a new **principal** and a new **interface**, never a bypass. The LLM sits at the edge — it
> never carries `tenant_id`, principal, or permission; never computes an authorization or a danger
> score; never does the arithmetic behind a number a user will act on. This document is the full account
> of what that means once the agent stops merely answering and starts *operating* — patrolling,
> reconciling, healing, and acting on the tenant's behalf.

---

## §0. Red-team correction — READ BEFORE IMPLEMENTING (supersedes the body where they conflict)

An adversarial security review of the body below returned: **"Architecturally serious and far above the
field… but NOT yet safe to move money autonomously. Strong B+ design; currently a C on 'trust it with
money unattended.' Ship read-only and propose-only for anything money/external/irreversible; earn
autonomy only after the independence, single-human, and erasure gaps are closed in code, not prose."**
The body (§1–§5) is the right skeleton; these corrections are binding on top of it.

**The two things the body over-sells (fix before any Tier-2+ autonomous *write* ships):**

1. **Determinism ≠ correctness, and identity-SoD ≠ independence-of-judgment.** The verifiability layer as
   written can prove an agent *faithfully executed a wrong decision on wrong evidence* and call it
   "verified": (a) the deterministic re-check query is **LLM-authored**, so a wrong-but-self-consistent
   query re-runs to the same wrong number forever (that proves determinism, not correctness); (b) the
   dual-control verifier is "ideally a different model" — in practice the same family, same blind spots,
   reading the **same** (possibly poisoned) evidence → correlated failure is the default; (c) crypto
   provenance is tamper-*evidence*, not correctness.
2. **The Trust Rule must be an AND for material writes, not an OR.** As written, `sampled+audited` **alone**
   satisfies the rule → individual material financial mutations can execute with **zero per-action
   verification**. Sampling bounds the rate you *discover* errors, not the rate they *happen*.

**The hardened Trust Rule (authoritative):** for any autonomous write with blast ∈ {money, external,
irreversible} or danger ≥ D3 —
- require **V1 deterministic recompute AND V2 provably-independent dual-control** (mandated *different
  model family*; verifier reads its **own fresh independent snapshot**, not the maker's evidence bundle);
- the V1 check query must be **selected from a human-reviewed, version-pinned library of vetted
  reconciliation queries — the LLM selects, never authors, the check** for anything money-touching (or is
  cross-validated by an independently-authored second query);
- **execute-time re-verification of the full evidence** the verifier relied on (not just count/amount
  drift), plus a monitored **maker↔verifier agreement-rate alarm** (too-high agreement = non-independence);
- **`sampled+audited` alone is forbidden** for any individually-material financial mutation; the runtime
  invariant asserts the *specific method set required for the tier*, not merely "satisfies the rule."

**The deepest unresolved contradiction — the single-human SMB tenant.** The entire HITL stack (R5 second
approver, break-glass second staffer, cooling-off watchers, maker-checker) silently assumes **≥2
competent humans**, while the go-to-market is **one-person self-serve SMBs** with no sales/ops/support. In
that population every control degrades to **self-approval — the platform's own cardinal sin.** Design it
head-on: for solo-admin tenants, degrade to mandatory cooling-off + **out-of-band (email/SMS)
second-channel confirmation** + a **platform-side security-review queue as the substitute checker** —
never a silent no-op into self-approval. State it as a first-class flow; it is the majority case.

**Other blocking fixes (from the ranked top-10; full critique in §6):**
- **GDPR/CCPA erasure vs the immutable hash-chained ledger is unreconciled** — a compliance blocker.
  Resolve via per-subject **crypto-shredding** + erasure fan-out to evidence bundles, RAG namespaces,
  backups, and the warehouse (or a documented legal-basis exemption for the ledger).
- **Untrusted connector/PII data → proposal is an injection path** defended by one parenthetical. Enforce
  a real **dual-LLM / code-then-execute** boundary for *every* capability reasoning over external content
  (reconcilers, dedup/anomaly detectors, analyst); quarantine untrusted text from the tool-selection plane.
- **A deterministic, agent-bypassing "human now" control** must exist — a compromised agent can't be the
  sole arbiter of escalation. Add server-side forced-escalation triggers (repeated authz denials,
  injection-pattern detection, verifier ESCALATE, missing confidence schema).
- **Cross-principal / cross-resourceClass / cross-time cumulative blast accounting** — aggregate across a
  human's *all* delegated agent principals (by originating `sub`), across resource classes, over a
  long-enough window (patient/coordinated decomposition is currently a gap).
- **Break the fatigued-acceptance → promotion loop** — exclude sub-N-second-dwell / fatigue-window clicks
  from the K-counter; promote on *active* verification, demote on leading indicators, not only caught errors.
- **Constrain the fat verifier & platform-patrol principals** — least-privilege read scoped to the action
  under review, not standing tenant-wide read; cross-tenant patrols touch only pre-aggregated warehouse
  data, never raw prod PII (enforced, not asserted).
- **Danger-classifier blind spots:** same-count-different-rows TOCTOU; a benign `verbClass` whose side
  effects cascade money in another module (cross-module blast is invisible to a per-tool classifier);
  memoization = a 2× click-through envelope; just-under-D2 campaign evasion.

**Net stance until these land in code:** ship **read-only + propose-only** for anything
money/external/irreversible; full act-then-log autonomy on material writes is **gated** on these fixes.
§1–§5 stand as the target; §0 is what makes them trustworthy. The full ranked critique is in **§6**.

---

## Introduction — four surfaces, four gates, one machine

Making an agent safe enough to move money and touch PII is not one problem; it is four, and they are
**orthogonal**. Conflating them is how governance platforms ship demos that cannot survive an audit.
Aegis keeps them separate, names each, and composes them deterministically in the core:

1. **Autonomy & Verifiability (§1).** *May software act unattended, and can I trust the result?*
   Agents don't just answer — they patrol. But an autonomous result is only sellable if it is
   **provably** correct or **provably** checked. This surface pairs an *agency catalog* (what runs on
   its own) with a *verifiability layer* (why you can trust it), bound by the **Trust Rule**.

2. **Authorization (§2).** *Is this principal allowed to do this?* The agent is a first-class principal
   whose effective authority is a strict intersection of RBAC × ABAC × delegation × entitlement,
   evaluated by the existing Policy Enforcement Point (PEP). The agent never decides authz and never
   carries identity.

3. **Danger (§3).** *This principal is allowed — but is this specific invocation risky enough that we
   should make them prove they mean it?* A second, orthogonal axis that fires **after** a PEP allow and
   **before** the mutation. It never grants; it can only add friction, delay, witnesses, or a
   block-pending-review.

4. **Operational Flows (§4).** *How does the whole machine actually work, walked end to end?* Every
   flow — onboarding, module lifecycle, billing, daily use, admin, support — is the same grammar
   wearing different clothes: a filtered tool catalog going in, a typed re-validated proposal coming
   out, money and irreversibility always stopping at a human.

**The two control axes are genuinely independent.** AUTHORIZATION asks *are you allowed?* DANGER asks
*is this risky even if allowed?* A finance manager with a live payment permission (authorized) issuing
a $2M wire (dangerous) clears the first axis and must still clear the second. A read-only bulk export
of 82,000 PII rows is fully authorized yet maximally dangerous. Neither axis can de-escalate the other;
they compose by taking the most restrictive requirement of each.

Sitting across both is the **autonomy control model** — *who or what may act unattended, and to what
blast radius* — and underneath everything is **verifiability** — *is the produced result trustworthy
enough to act on at all.* The closing section (§5, "How the axes compose") shows how, for any single
action, the effective gate is the conjunction of all four.

Throughout, the same substrate primitives recur by name, because there is exactly one of each and no
parallel system is ever built: the **Casbin PEP/PDP/PAP** (`authenticate` / `authorize` /
`applyPolicyGrant` / `reloadEnforcer`, ABAC via `evaluateAbac` + the condition evaluator, row scope via
`checkRowScope`); **RLS** via `withTenantTransaction → setTenantContext`; the **hash-chained audit
ledger** carrying *permissions-at-time-of-action*; **`@aegis/approvals`** (maker-checker, SoD, quorum);
the **workflow rules-as-data engine** with `runRule(dryRun)`; **entitlements** over `tenant_features` /
Chargebee; the **transactional outbox + Kafka** bus; and the **CapabilityManifest** with its CI
`Validate()` gate. The two new substrate packages this document introduces — **`@aegis/danger`** (§3)
and the **Directive** abstraction with its verification pipeline (§1) — are built *beside* these, reusing
them, never duplicating them.

---

# Section 1 — Autonomous AI Agency & Verifiability

**Thesis.** Aegis agents patrol. Every module ships watchers, auditors, and reconcilers that run
without being asked. But autonomy is only sellable in a *governance* platform if every autonomous
result is provably correct or provably checked. So this section is two halves of one contract: an
**agency catalog** (what runs on its own) and a **verifiability layer** (why you can trust it). The
binding rule, stated up front and enforced in code:

> **THE TRUST RULE.** An autonomous result may be acted on only if it is (a) deterministically
> re-checkable by the governed core, **OR** (b) independently verified by a second, separately-prompted
> agent principal, **OR** (c) part of a sampled population under continuous eval + human audit. A result
> that is none of the three is a **draft**, and drafts never mutate state.

Everything below is a consequence of composing this rule with the platform spine: the agent reasons,
the governed core acts; risk tier = blast radius, not confidence; every action — human or agent — lands
on the hash-chained audit ledger with permissions-at-time-of-action.

## 1.1 Autonomy vocabulary

Three **autonomy modes**, orthogonal to (but bounded by) risk tiers:

| Mode | Meaning | Allowed at risk tier |
|---|---|---|
| **propose-only** | Agent produces a signed proposal + evidence bundle; a human (or a downstream approved workflow) executes. Implemented as `runRule(dryRun)` / `agent.action.proposed` + `@aegis/approvals`. | Any tier (mandatory at Tier 4) |
| **act-then-log** | Agent executes through the governed path immediately; result lands in the audit ledger + activity feed. | Tier 1–2 only, and only with a passing eval gate at Tier 2 |
| **act-with-undo** | Agent executes, but the action is recorded with a materialized compensating action (`undoToken`) valid for a hold window (default 72h); the activity feed shows a one-click revert. | Tier 2 only; the module manifest **must** declare `reversibleBy` for the tool or the mode is unavailable — reversibility is a *declared, CI-validated property* (CapabilityManifest `Validate()` gate), never an LLM's opinion |

**Trigger types:** `scheduled` (cron per tenant), `event` (Kafka topic / outbox), `threshold` (a metric
or aggregate crosses a declared bound), `continuous-watch` (a standing rule evaluated on every matching
event), `on-demand` (admin clicks "run now"), `user-asked` (conversational).

**Blast radius** is declared per capability: `none` (read/report), `tenant-data-reversible`,
`tenant-data-irreversible`, `external` (leaves the tenant: email, ERP push, payment), `platform`
(infra/deploy), `cross-tenant` (forbidden for autonomous execution; always propose-only to the platform
operator).

Every autonomous capability below is *just a module tool* under the AI-native module contract —
auto-generated, authz-bound, entitlement-filtered, risk-tiered — invoked by a scheduler or watcher
instead of a chat turn. **There is no second execution path.** An autonomous agent is a first-class
principal (`agent:auditor@tenantX`) with its own Casbin policy rows, its own token budget, and its own
rows in the ledger.

## 1.2 The Autonomous Capability Catalog

### Domain 1 — Self-audit & compliance (the platform audits itself)

| Capability | Trigger | What it does | Mode | Blast radius |
|---|---|---|---|---|
| **Compliance evidence collector** | scheduled (nightly) + on-demand ("prep my SOC 2 evidence") | Walks the audit ledger, verifies hash-chain continuity, assembles control-evidence packets (access logs, approval records, RLS test proofs, backup attestations) mapped to control frameworks; publishes a signed evidence bundle | act-then-log (Tier 1 — reads + writes a report artifact only) | none |
| **Access review runner** | scheduled (quarterly, tenant-configurable) + event (role granted via `applyPolicyGrant`) | Enumerates every principal→permission edge from the Casbin PAP, diffs against last review, computes "unused for 90d" grants from ledger usage, drafts revocation proposals per owner | propose-only for revocations (Tier 3 — removing access can break someone); act-then-log for the review report | tenant-data-reversible |
| **SoD-violation detector** | continuous-watch on `policy.granted` + `approvals.decided`; scheduled full sweep weekly | Detects (a) *static* SoD conflicts — one principal holds maker+checker for the same object class; (b) *dynamic* violations — same principal (or same human behind two principals, matched by identity linkage) both proposed and approved a concrete action. Flags **agent** principals identically to humans | act-then-log for flag + activity-feed alert; propose-only for auto-remediation | tenant-data-reversible |
| **Entitlement drift auditor** | scheduled (daily) + event (`chargebee.subscription.changed`) | Reconciles `tenant_features` vs Chargebee subscription state vs the actually-exposed (entitlement-filtered) tool set; detects tenants using features they no longer pay for, or paying for features not enabled | act-with-undo for *enabling* under-provisioned features; propose-only for *disabling* (turning things off on a paying customer is customer-facing, Tier 3) | tenant-data-reversible / external |
| **Policy-vs-ledger conformance check** | scheduled (nightly) | Replays a sample of ledger entries: for each recorded action, re-runs the Casbin decision using permissions-at-time-of-action captured in the entry; any mismatch = policy regression or ledger tampering → severity-1 alert | act-then-log (read + alert) | none |

### Domain 2 — Data integrity & cross-module reconciliation

| Capability | Trigger | What it does | Mode | Blast radius |
|---|---|---|---|---|
| **Cross-module reconciler** | scheduled (nightly per module-pair) + on-demand ("reconcile expenses vs GL") | Runs *declared reconciliation contracts*: each manifest may declare invariants against another module's data (e.g. `sum(expense.approved) == sum(gl.postings where source=expense)` per period). The engine computes both sides **in SQL under RLS** — the LLM never does the arithmetic — then the agent explains/triages breaks | act-then-log for the break report; act-with-undo for *mechanical* fixes matching a whitelisted fix-pattern (e.g. re-emit a dropped outbox event); propose-only for anything touching amounts | tenant-data-reversible |
| **Referential/orphan sweeper** | scheduled (weekly) | Finds orphaned rows, dangling cross-module foreign references, outbox entries older than SLA, events consumed but never acknowledged | act-with-undo for quarantine-to-review-table; never hard-deletes | tenant-data-reversible |
| **Connector drift detector** | event (connector sync completed) + threshold (delta > declared bound) | After each connector sync (QBO, ERP, HRIS…), compares external state hash vs the Aegis mirror; flags silent divergence (the classic "someone edited it directly in QuickBooks") | act-then-log flag; propose-only re-sync when re-sync would overwrite local edits | tenant-data-reversible |
| **Duplicate detector (invoices/vendors/employees)** | continuous-watch on create events | Deterministic candidate generation (normalized-field blocking + fuzzy scores computed in code); LLM only *explains* and ranks ambiguous candidates; can place a **hold** (reversible status flag) pending review | act-with-undo for the hold; propose-only for merge/delete | tenant-data-reversible |

### Domain 3 — Anomaly & fraud watch

| Capability | Trigger | What it does | Mode | Blast radius |
|---|---|---|---|---|
| **Transaction anomaly watch** | continuous-watch on money-object events + scheduled batch scoring | Statistical/rule baselines per tenant (amount percentile, new-vendor-first-payment, round-amount clustering, weekend approvals, just-under-threshold splitting to dodge approval limits). Detection is deterministic features + scores; the LLM writes the human-readable case narrative with citations | act-with-undo for **hold** (pause the object in workflow — reversible by design); **never** blocks or reverses money autonomously | tenant-data-reversible |
| **Approval-pattern anomaly** | scheduled (weekly) | Mines `@aegis/approvals` history: rubber-stamping (median decision < 10s), self-dealing, quorum gaming, always-same-pair maker/checker | act-then-log report to the compliance owner | none |
| **Agent-behavior anomaly (watching the watchers)** | continuous-watch on `agent.tool.invoked` ledger stream | Baselines each agent principal's tool-call distribution; alerts on novel tool use, volume spikes, off-schedule activity, or an agent repeatedly hitting authz denials (possible prompt-injection steering) → can trip the tenant's agent kill switch at a declared threshold | act-then-log alert; **kill-switch trip is deterministic threshold logic, not LLM judgment** | tenant-data-reversible |

### Domain 4 — Proactive workflow & business operations

| Capability | Trigger | What it does | Mode | Blast radius |
|---|---|---|---|---|
| **Standing-instruction executor** ("watch for X and do Y") | continuous-watch, compiled from user NL | User states an intent in chat; the agent compiles it into a **rules-as-data workflow rule** (see §1.5) and thereafter the *workflow engine*, not the LLM, evaluates the condition on every event | inherited from Y's risk tier; compilation itself is propose-only (user confirms the compiled rule) | inherits |
| **Deadline/SLA chaser** | scheduled + threshold | Finds approvals idle past SLA, expiring contracts, filing deadlines; nudges owners, escalates per policy chain | act-then-log for internal nudges (Tier 2); Tier 3 review for external notifications | external |
| **Draft-ahead worker** | event + scheduled | Pre-drafts the predictable next artifact: month-end close checklist, renewal quote, variance commentary — always in `draft` status, never submitted | act-then-log (drafts are inert by construction) | none |
| **Proactive insight surfacing** | scheduled (daily digest) + threshold | "Vendor X's prices rose 14% QoQ", "3 duplicate subscriptions detected", "approval load on Priya is 4× team median" — pushed to the activity feed with evidence links | act-then-log | none |

### Domain 5 — Autonomous development (bug-hunt + fix)

Direct adoption of the Wayfinder 3-agent harness (`ai-native-core.md` §5.1), operating on the Aegis
codebase itself:

| Capability | Trigger | What it does | Mode | Blast radius |
|---|---|---|---|---|
| **Bug-hunter** | scheduled (nightly) + event (E2E loop failure, error-budget burn) | Traces one governed flow `authenticate→authorize→RLS→audit` end-to-end; fixes safe bugs on `auto/bughunt`; logs risky/architectural findings to `FINDINGS.md`. Green `nx affected build+lint+typecheck` is a hard precondition to commit; revert-on-red | act-then-log **to a branch** (a branch is inherently propose-only w.r.t. prod — merge to main is the human gate; CI + review are the checker) | platform (bounded to `auto/*` branches) |
| **Tester** | scheduled (continuous E2E every 30 min against a governed test tenant) | Read-only on product code; runs e2e with mock-LLM brain + self-generated fixtures; reports honest PASS/FAIL/SKIP/BLOCKED; failures feed the bug-hunter | act-then-log | none |
| **Build-continuation** | scheduled | Finishes one scaffolded facet/module to complete + eval-green on `auto/impl`; journaling + resume pointers (`JOURNAL.md`) survive session limits | same branch-bounded model as bug-hunter | platform (bounded) |
| **Test-gap prospector** | event (bug-hunter finds a bug) | Every confirmed bug must yield a seam test + runtime invariant before the fix merges (the anti-BLOCKER discipline) | act-then-log to branch | none |

SoD applies to the trio exactly as to finance: **the agent that wrote the fix never marks it verified** —
the tester agent (separate principal, separate context, read-only lane) and CI are the checkers, and a
human merges.

### Domain 6 — Self-healing ops & FinOps

| Capability | Trigger | What it does | Mode | Blast radius |
|---|---|---|---|---|
| **AI SRE agent** | event (alert/SLO burn) + continuous-watch on OTel | Auto-triages, posts a cited hypothesis, then fires a **pre-approved bounded runbook** — and a runbook fires unattended *only after it has survived the matching injected chaos failure* (the chaos-validated promotion gate) | act-with-undo for chaos-validated runbooks (restart, scale, failover, cache flush — all reversible); propose-only for novel remediations | platform |
| **Deploy guardian** | event (deploy) | Progressive-delivery watcher; SLO-gated auto-rollback (rollback = the canonical reversible action); Argo selfHeal reverts drift | act-with-undo | platform |
| **Capacity & cost watch (FinOps)** | scheduled (daily) + threshold | Watches infra spend, per-tenant LLM token burn vs budget, idle resources (KEDA scale-to-zero candidates), egress anomalies; right-sizing proposals as Git PRs (Git is the only write path to prod) | act-then-log reports; act-with-undo for scale-to-zero of idle tenant agents; propose-only (PR) for infra changes | platform |
| **Token-budget enforcer** | continuous (LLM gateway) | Hard budget enforcement is deterministic gateway code; the *agent* part forecasts overruns, attributes burn to capabilities, and proposes budget/model-tier changes | act-then-log forecast; propose-only changes | none |

### Domain 7 — "Anything the user asks about their data"

| Capability | Trigger | What it does | Mode | Blast radius |
|---|---|---|---|---|
| **Governed analyst** | user-asked | Answers arbitrary questions over tenant data via RLS-scoped resources + a **read-only SQL sandbox** (a Tier-1 tool: parameterized, RLS-enforced, `SELECT`-only, row/time-capped). Every numeric claim carries a citation to the query + row provenance (§1.3) | act-then-log | none |
| **Governed operator** | user-asked | "Fix it" follow-ups route to normal module tools at their declared tiers — a question can escalate into an action, but the action goes through the identical gate as if the user had clicked the button. Deictic referents ("hold *those* invoices") are resolved to concrete IDs, echoed back in the confirmation/approval card, and re-validated by the core | inherits tool tier | inherits |
| **"Make it a standing rule"** | user-asked | One-turn conversion of any ad-hoc question/action into a Domain-4 standing instruction | propose-only compile → user confirms | inherits |

## 1.3 The Verifiability Layer — why an autonomous result can be trusted

This is the crux and the product moat: competitors will ship autonomous agents; almost nobody will ship
*auditable* ones. Aegis treats verification as a first-class pipeline stage — **no autonomous write
reaches the governed core without a `VerificationRecord`, and the record is on the ledger next to the
action.**

### The verification ladder

Every capability declares in its manifest which rungs it uses. Higher rungs are stronger; the Trust Rule
requires at least one of V1/V2/V3 for any result that leads to a write.

**V1 — Deterministic re-computation (strongest, always preferred).** If a claim is checkable by code,
code checks it. The reconciler's sums are computed in SQL, twice, through two independent query plans
(module-side aggregate vs ledger-side replay) and compared exactly. The analyst's numbers are never LLM
arithmetic: the LLM writes a query, the core executes it, the answer *is* the query result, and the
check is "does the cited query, re-run, reproduce the quoted number?" — re-run automatically before
render. Design consequence: **capabilities are deliberately architected to maximize the deterministic
share** — LLM for candidate generation, triage, and narrative; code for every number, match score, and
boolean that matters. This is the LLM-at-the-edge rule applied to autonomy.

**V2 — Dual-control adversarial verifier (mandatory before any autonomous write).** Before an
act-then-log or act-with-undo write executes, a **second agent** — distinct principal
(`agent:verifier@tenant`), distinct system prompt, *no access to the maker's chain-of-thought*, ideally
a different model — receives only: the proposed action (tool + args), the evidence bundle, and read
access to the underlying data. Its job is adversarial: *find a reason this is wrong* (wrong entity
resolved, stale data, policy edge case, injection artifact in the evidence). It returns
`CONFIRM | REJECT | ESCALATE` with its own cited reasoning, also ledgered. Maker and verifier can never
be the same principal or share a context window — **this is SoD applied to agents**, enforced by the
approvals engine's existing maker-checker machinery (the verifier is simply a non-human checker
registered for auto-checkable tiers). A REJECT converts the action to propose-only with both traces
attached.

**V3 — Evals + sampled LLM-as-judge (population-level assurance).** Every autonomous capability ships a
Promptfoo eval suite with golden + adversarial cases (injection attempts, ambiguous duplicates,
boundary amounts). Gate: a Tier ≥ 2 write tool may run autonomously **only while its eval suite is
green**; a red eval **demotes the capability to propose-only automatically** — *demotion is
deterministic, promotion requires a human.* In production, N% of autonomous outputs (default 5%,
tenant-tunable, floor 20/month) are re-judged asynchronously by an LLM-as-judge in Langfuse against the
capability's rubric; judge disagreement above a threshold pages the owner and demotes the capability.

**V4 — Cryptographic provenance (the tamper-evident spine).** Every autonomous run writes to the
hash-chained ledger: trigger, inputs-hash, prompt + tool-call trace, evidence-bundle hash, verifier
verdict, permissions-at-time-of-action, and the resulting state-change IDs. Because the chain is
hash-linked, an auditor can prove *after the fact* that the evidence shown today is the evidence the
agent acted on then — the agent cannot retroactively improve its homework. The compliance evidence
collector (Domain 1) verifies chain continuity nightly, so the verification layer is itself verified.

**V5 — Mandatory citations + show-your-work.** No autonomous artifact — report, hold, flag, draft,
proposal — renders without an expandable **evidence panel**: which records (deep links, RLS-checked at
view time so a viewer without access sees a redaction, not the data), which queries (re-runnable
read-only by the viewer with one click), which rule/threshold fired, which model+prompt version, and the
verifier's verdict. A claim without a citation is a rendering error, enforced in the artifact schema
(`claims[].evidenceRefs` is non-optional), not a style guideline.

**V6 — Confidence + ABSTAIN.** Every capability's output schema includes a calibrated confidence, and
the maker must be able to return `ABSTAIN` (insufficient evidence / ambiguous / conflicting data).
ABSTAIN routes to a human queue with the partial trace — it is a *success state*, tracked positively in
evals (an agent that never abstains fails the adversarial suite). Confidence below the capability's floor
⇒ automatic downgrade to propose-only for that instance. Note the asymmetry: **tier (blast radius) is
never a function of confidence, but confidence can only ever move an action toward more human oversight,
never less.**

**V7 — Human sample review.** A standing "autonomy QA" queue serves each tenant admin a random sample of
executed autonomous actions (stratified by capability and tier) for thumbs-up/down + optional
correction. Feedback lands as new eval cases. Sample rate auto-scales with maturity: new capability
20%, declining to a 2% floor as its verified-correct streak grows; any human-confirmed error resets the
rate and opens a bug-hunter task.

### The `VerificationRecord` (concrete contract)

```ts
interface VerificationRecord {
  runId: string;                       // ties to ledger chain entries
  capability: string;                  // e.g. "recon.expense-vs-gl"
  method: Array<'DETERMINISTIC' | 'DUAL_CONTROL' | 'EVAL_GATED' | 'SAMPLED'>;
  deterministic?: { checkQueryHash: string; recomputedMatch: boolean };
  dualControl?: { verifierPrincipal: string; verdict: 'CONFIRM'|'REJECT'|'ESCALATE';
                  verifierTraceRef: string };     // maker ≠ verifier enforced here
  evalGate?: { suite: string; version: string; status: 'GREEN'|'RED' };
  confidence: number;
  abstained: boolean;
  evidenceBundleHash: string;          // anchored in the hash chain (V4)
  citations: EvidenceRef[];            // non-empty or the write is refused (V5)
}
```

The governed core's write path asserts: *a tool call from an agent principal in autonomous context ⇒ a
`VerificationRecord` satisfying the Trust Rule is attached, or 403.* This is a runtime invariant with a
seam test, not a convention.

### What verification does NOT do

It never *raises* autonomy. Verification can demote (REJECT, red eval, low confidence, failed recompute)
but a CONFIRM from the verifier cannot promote a Tier-4 action to auto-execute, cannot skip approvals,
and cannot expand the tool set. **The ceiling is always the manifest's declared tier + mode;
verification only decides whether the action clears the bar *within* that ceiling.**

## 1.4 The Autonomy Control Model — what runs unattended vs what proposes

The decision is a deterministic function evaluated by the core (never the model), composing four
declared properties:

```
mode(action) =
  if tier == 4 or blast in {irreversible, cross-tenant, money}     → PROPOSE-ONLY (mandatory human)
  if blast == external (leaves tenant: email, ERP push)            → PROPOSE-ONLY / Tier-3 cheap review
  if novel (no green eval suite, or capability in probation)       → PROPOSE-ONLY
  if tier == 2 and manifest.reversibleBy defined and eval green
     and VerificationRecord satisfies Trust Rule                   → ACT-WITH-UNDO
  if tier <= 2 and deterministic-verifiable and eval green         → ACT-THEN-LOG
  if tier == 1 (read-only)                                         → ACT-THEN-LOG (always)
  else                                                             → PROPOSE-ONLY (fail-safe default)
```

Opinionated positions:

1. **Fail-safe direction is always propose-only.** Any evaluation error, missing manifest field, expired
   eval result, or budget breach degrades to a proposal, never to silent execution.
2. **Agents obey SoD symmetrically with humans — no exception for "it's just automation."** The maker
   agent never verifies its own work (V2); the verifier never executes; the bug-hunter never merges; the
   SRE agent never approves its own novel runbook; and in `@aegis/approvals`, an agent principal can
   never satisfy a quorum slot for an action *any* agent proposed within the same run lineage. The
   SoD-violation detector audits agent principals with the same rules — the platform's own automation
   shows up in its own compliance reports.
3. **Autonomy is earned per capability per tenant, not granted globally.** Each capability starts life
   at propose-only in every tenant ("probation"). Promotion to act-* requires: green evals, ≥ K
   consecutive human-accepted proposals in that tenant (default K=10), and an explicit admin toggle.
   Demotion is automatic and instant on any tripwire (rejected verification, human-confirmed error,
   anomaly alert on the agent principal). **Promotion is a human decision recorded on the ledger;
   demotion is code.**
4. **Cross-tenant is never autonomous, full stop.** Any capability whose evidence or effect spans tenants
   runs as a *platform* principal, propose-only, to the platform operator — and per-tenant data in its
   evidence is minimized/aggregated.
5. **Thresholds escalate tier contextually** via the manifest's ABAC `thresholds` (e.g. `duplicate-hold`
   is Tier 2, but `amount > $50k ⇒ Tier 3`): big blast radius inside a normally-small capability gets
   caught by data, not by vibes.

## 1.5 Triggering, Scheduling & Governing autonomous work

### The unit of governance: the Directive

Everything autonomous — built-in patrols and user-created watches alike — is a **Directive**: a
rules-as-data record in the workflow engine, tenant-scoped, versioned, and itself governed (creating or
modifying a Directive is a Tier-2/3 action on the ledger; a Directive that would grant an agent a new
write capability requires the same approval as granting it to a human).

```ts
interface Directive {
  id: string; tenantId: string;
  source: 'builtin' | 'user';           // builtin patrols ship enabled-per-plan via entitlements
  trigger: { kind: 'cron'|'event'|'threshold'|'watch'; spec: string };
  capability: string;                    // the module tool / patrol to run
  params: Json;                          // compiled, concrete — no NL at runtime
  mode: 'propose-only'|'act-then-log'|'act-with-undo';   // ≤ ceiling from the control model
  budget: { tokensPerRun: number; runsPerDay: number; monthlyTokenCap: number };
  notify: { channel: 'activity-feed'|'email'|'slack'; onlyOn?: 'finding'|'always' };
  owner: PrincipalRef;                   // the human accountable; receives escalations + ABSTAINs
  status: 'active'|'paused'|'probation';
}
```

### Three ways work gets triggered

1. **Conversational compile ("watch for duplicate invoices and hold them").** The agent parses the
   intent, selects the capability, and produces a *compiled Directive draft* shown as a structured card:
   trigger, exact filter, the concrete action ("place reversible hold, notify AP owner"), computed
   mode/ceiling, and cost estimate. The user confirms the *card*, not the sentence — the NL is gone by
   runtime. First activation runs in **shadow mode** (`runRule(dryRun)` over the last 30 days of
   historical events: "this would have held 7 invoices — here they are") so the user calibrates before
   it goes live.
2. **"Run an audit now" (on-demand).** Every scheduled patrol exposes a run-now surface (button + chat).
   On-demand runs use the same Directive, same budget accounting, same ledger trail — an ad-hoc run is
   not a different code path.
3. **"Every month, reconcile X" (scheduled).** Cron per tenant, executed by the scheduler as the agent
   principal. Missed-run detection is itself a builtin patrol (the platform notices when its own patrols
   don't fire).

### The Autonomy Console (per-tenant admin surface)

One screen, backed by entitlements + Directives + the ledger, where an admin governs the whole
autonomous fleet:

- **Roster:** every Directive with mode, last run, findings count, acceptance rate, token spend, and
  probation status; per-Directive pause/resume and mode downgrade (upgrades go through the
  earned-autonomy flow above).
- **Budgets & rates:** per-tenant LLM token budget (existing gateway enforcement) subdivided per
  Directive; runs-per-day caps; concurrency cap on the agent fleet (protects connection pools). A budget
  breach ⇒ the run degrades to a "budget-exceeded" proposal stub, never a partial silent run.
- **The kill switches, layered:** (1) per-Directive pause; (2) per-capability tenant disable;
  (3) **tenant-wide agent stop** — one action, revokes the agent principals' Casbin grants via
  `applyPolicyGrant` (propagated by the cross-pod watcher, effective fleet-wide in seconds) and drains
  scheduled runs — deliberately implemented as a *policy* revocation so the kill switch works even if the
  scheduler misbehaves, **because the PEP is the choke point every action must cross**;
  (4) platform-wide capability freeze (operator-level, for a bad model/prompt rollout). Kill-switch trips
  are ledgered and reversible.
- **QA queue:** the V7 human-sample review inbox, feeding promotion/demotion.
- **Digest:** "what your agents did this week" — actions taken, actions proposed and awaiting you,
  ABSTAINs, money saved / errors caught — the trust-building artifact that turns autonomy from spooky to
  indispensable.

### Execution substrate

Runs execute on the Wayfinder-derived harness discipline: bounded passes with hard iteration caps
(`ToolLoopRunner`), journaled resume pointers for long reconciliations, honest terminal states
(`DONE | FINDINGS | ABSTAIN | BLOCKED` — a quota/credential block is reported as BLOCKED, never dressed
up as a pass), durable interrupts when a run pauses on an approval (no compute held while a Tier-4
proposal waits days), KEDA scale-to-zero between runs, and cost teardown at the end of every pass.
Dev-domain agents (Domain 5) additionally keep the lane rules: one mutating agent per repo, tester
read-only, serial lane for shared schema/RLS/audit changes, never push main, revert-on-red.

---

# Section 2 — Agentic RBAC/ABAC Enforcement & Per-Role Flows

Grounded in the existing access-control substrate: the PEP (`authenticate` / `authorize` /
`authorizeAny` / `applyPolicyGrant` / `reloadEnforcer`), the PDP (`decide`, `evaluateAbac`), the
condition evaluator (operators `eq/neq/lt/lte/gt/gte/in/contains/owner/manager_of/tenant_match`), row
scope (`Scope.OwnOnly / OwnAndTeam / AllRecords` via `checkRowScope`), RLS (`withTenantTransaction →
setTenantContext`), and the approvals engine (`requestApproval / decide / reassign`, with
requester-exclusion SoD in the resolver).

## 2.1 The enforcement model when the actor is an agent

### The agent is a principal, not a superuser

An agent session is a first-class principal in the same `AccessShape.Principal` shape the PEP already
populates. Nothing downstream of `authenticate()` knows or cares whether the caller is a browser or a
model loop — that is the whole point: **the agent is a new interface, never a bypass.** Every tool
execution is an internal call that traverses the identical middleware chain a human API call traverses:

```
tool call → authenticate()             [JWT verify + tenant-match]
         → authorize(Permission.X, …)  [Casbin RBAC gate + PDP ABAC gate]
         → withTenantTransaction()      [setTenantContext → Postgres RLS]
         → AUDIT append                 [hash-chained, permissions-at-time-of-action + prompt/tool trace]
```

### Effective authority = a strict intersection

The agent's effective permission set is never *granted*; it is *derived*:

```
effective(agent-session) =
      RBAC(user roles, Casbin g-rules in dom=tenant)
    ∩ ABAC(principal.attributes × resource × environment)   // amount caps, ownership, team, time/IP
    ∩ agentScope(delegation token)                          // what the user delegated to THIS session
    ∩ entitlement(tenant_features)                          // modules the tenant has bought/enabled
```

The agent runs on an **On-Behalf-Of (OBO) token minted via RFC 8693 token exchange**:

```jsonc
{
  "sub": "user:priya@acme.com",          // the human — authority ORIGIN
  "act": { "sub": "agent:aegis-assistant", "session_id": "agsn_7f3e" },  // the actor
  "tenant_id": "ten_acme",
  "roles": ["finance_manager"],           // COPIED from the user, never widened
  "scope": "OwnAndTeam",
  "agent_scope": ["invoice:read", "invoice:submit", "approval:decide"],   // delegation subset
  "attributes": { "costCenters": ["cc-401"], "approvalCap": 25000 },
  "exp": 1751479200                        // short-lived; refreshed by exchange, not by the model
}
```

Rules the token-exchange service enforces at mint time (fail-closed):

1. `agent_scope ⊆ permissions reachable from roles` — you cannot delegate what you don't have, verified
   against the same Casbin enforcer, not a parallel table.
2. `exp` capped (default 1h interactive; explicit longer bound for delegations, §2.4).
3. The `act` claim is mandatory whenever the caller is the agent runtime; a token without `act` is
   rejected at the agent gateway, and a token *with* `act` is rejected on human-only endpoints (PAP role
   administration, break-glass, delegation-grant itself — **an agent cannot extend its own leash**).

The PEP change is small: `authenticate()` parses `act` into `principal.actor`, and `authorize()` adds one
pre-gate — `if (principal.actor && !principal.agentScope.includes(action)) deny` — *before* the Casbin
check. Everything else (Casbin, PDP, RLS, approvals) is untouched, which is exactly why it stays
trustworthy.

### The tool registry is filtered before the model sees it

Tool definitions are generated from the module contract (each declares `requiredPermission`, `riskTier`,
`entitlementKey`). At session start — and again on every policy-watcher invalidation
(`invalidatePolicies` → `reloadEnforcer`) — the agent gateway computes:

```ts
const visibleTools = allTools.filter(async (tool) =>
  tenantFeatures.has(tool.entitlementKey) &&                 // entitlement
  principal.agentScope.includes(tool.requiredPermission) &&  // delegation
  await enforce(enforcer, roleOrUser, tenantId, tool.requiredPermission) // RBAC
);
```

So an Operator's model context literally does not contain `payroll_run_execute`. This is
**capability-shaping, not enforcement** — a defense-in-depth UX layer. The authoritative gate remains the
PEP on every call: even if a stale registry, a prompt injection, or a hallucinated tool name produces an
attempt, `authorize()` denies it and the denial is audited. Filtering also removes an entire class of
prompt injection ("call the admin tool") — there is no admin tool to call.

### The LLM never decides authz and never carries identity

Enforced in code, not prose:

- **Identity is ambient, never model-emitted.** Tool-call arguments are validated against a schema with
  *no* `tenant_id`, `user_id`, `role`, or `permission` fields; the gateway injects principal/tenant from
  the verified token into `RequestContext`. A model that emits such a field anyway has it stripped-and-
  flagged (audited `AGENT_ARG_REJECTED`).
- **Authorization is computed only in the PEP/PDP.** Risk-tier classification is static metadata resolved
  by the gateway — the model can neither read nor argue a tool into a lower tier.
- **Deictic referents are resolved by the core.** "Approve *this*" → the gateway resolves the referent to
  a concrete `{recordType, recordId}`, echoes it back in the approval card ("Approve **INV-2024-0871,
  $12,400, vendor Acme Supply**?"), and `ApprovalService.decide()` re-validates that the record still
  exists, is still pending, and still matches the echoed amount hash. A mismatch aborts (audited
  `REFERENT_MISMATCH`).
- **Fail-closed everywhere:** enforcer-load failure ⇒ `clearPolicy()` and deny all; missing roles ⇒ 403;
  PDP error ⇒ 403.

## 2.2 End-to-end flows per role

Common legend: **Ask** → **Tools visible** → **PEP/ABAC path** → **HITL gate** → **Audit.** The
hash-chained audit record shape used throughout:

```jsonc
{
  "seq": 88213, "prev_hash": "b3a1…",
  "tenant_id": "ten_acme",
  "principal": { "sub": "user:priya", "act": "agent:aegis-assistant/agsn_7f3e" },
  "action": "invoice:approve", "resource": "invoice/INV-0871",
  "decision": "ALLOW | DENY(reason) | PENDING_APPROVAL",
  "permissions_at_action": ["invoice:read", "invoice:approve@cap=25000"],
  "abac_evaluated": [{ "attr": "resource.amount", "op": "lte", "value": 25000, "result": true }],
  "agent_trace": { "prompt_hash": "…", "tool_call_id": "tc_91", "model": "…", "referent_echo": "INV-0871/$12,400" },
  "risk_tier": 4, "approval_id": "apr_22 | null"
}
```

**B.1 Platform Super-Admin (Aegis staff, cross-tenant).** Sees platform diagnostics (read-only
cross-tenant: enforcer health, outbox lag, audit-chain verification) plus *dormant* cross-tenant
mutation tools that are absent from the registry until **break-glass** is active. Super-admin tokens
carry `dom='*'` p-rules but **no RLS bypass by default**; touching tenant data requires break-glass — a
second-factor-confirmed, reason-required, time-boxed (≤ 60 min) elevation minting a fresh token with
`bg_id`, gated by `environment.breakGlassActive == true` ABAC + IP allowlist. Break-glass activation is
itself Tier 4 (a *second* staff member approves, except a declared SEV1 solo path that pages security and
auto-expires in 15 min). Audit is the heaviest of all roles — every tenant-data read during break-glass
is logged row-count-level, `bg_id` stitches the whole episode, the tenant owner gets a disclosure event.
*Worked:* "Fix Acme's stuck approval chain" → staff session (no break-glass) sees only diagnostics →
proposes `reassign` → PEP denies mutation → break-glass card → colleague approves → tool appears →
`ApprovalService.reassign()` under `withTenantTransaction` → both the quorum and the reassignment
audited with `act` + `bg_id`. "Show me revenue across all tenants" is denied outright — cross-tenant
*business-data* aggregation isn't break-glass-eligible; platform analytics come from the anonymized
warehouse, not prod.

**B.2 Tenant Owner.** Sees everything the tenant is entitled to, including PAP tools (`role_create`,
`role_assign` → `applyPolicyGrant`), entitlement views, approval-policy editing, audit reading. Broad
p-rules in `dom=ten_acme` but still tenant-bound (RLS makes cross-tenant reads structurally impossible
regardless of role). **SoD still binds:** the owner cannot approve a chain they initiated; changing
approval *policies* is itself Tier 4. Role grants to privileged roles = Tier 4; module enable with
billing impact = Tier 4 with the price echoed. *Worked:* "Make Dana a Finance Manager, cap $50k" → Tier
4 card shows the g-rule + cap delta → owner confirms → `applyPolicyGrant({revokeGroupings, groupings})`
runs **revoke-before-add** (no transient dual-grant) → `invalidatePolicies()` fans out → Dana's own
agent session gains the finance tools on its next registry refresh.

**B.3 Tenant Admin.** User/role management (below owner-level roles), workflow config (`runRule dryRun`
propose mode), module settings, tenant audit reads. **Not** billing/entitlement purchase, approval-policy
thresholds, or owner-role assignment (a deny-override ABAC rule `resource.role in ['owner'] ⇒ deny`).
Bulk role assignment (> 5 users) = Tier 3; workflow activation = Tier 3 with the dryRun diff attached.
*Worked:* "Give Marco the same access as Lena" → the agent diffs Lena's grants, finds `finance_manager`
(above what an admin may grant alone), grants the operator-level subset immediately (Tier 2), and routes
the `finance_manager` grant as an approval to the owner — audit shows a **split decision**: `ALLOW` for
the subset, `PENDING_APPROVAL` for the elevation.

**B.4 Finance Manager / Approver.** Sees `approvals_list_pending`, `approval_decide`, `invoice_*`,
`payment_initiate`, reporting. PDP evaluates `resource.amount lte principal.approvalCap` and
`resource.costCenter in principal.costCenters`. `approval_decide` and `payment_initiate` are Tier 4 — the
agent *stages* the decision; the human clicks the card, which echoes the **core-resolved** referent, not
the model's paraphrase. *Worked:* "Pay all utility invoices under $2k" (14 invoices) → one Tier-4 card
listing all 14 with total; one invoice at $2,150 is excluded by the stated filter; one is *her own*
submitted expense → SoD drops it from the approvable set (requester-exclusion), routed to another
approver. Everything the human sees was computed by the core; the model only narrates.

**B.5 Operator / Member (own + team scope).** Create/read/update on *own* records; team reads if
`Scope.OwnAndTeam`; drafts and submissions. **No** approve/pay/user-manage/admin tool — filtered out
before the model context is built. `checkRowScope` applies `OwnOnly`/`OwnAndTeam`; RLS is the backstop.
*Worked (the canonical denial):* "Approve this $50k invoice" → `approval_decide` isn't in the member's
registry, so the model cannot even form the call; a stale/injected attempt that reaches the PEP anyway is
denied by Casbin. The agent explains: *"You don't have approval authority — this needs a Finance
Manager. The routed approver is Priya; I've added it to her queue"* → `requestApproval()` runs (that, the
member *can* do). Audit: `DENY(no permission)` for the attempted frame + `ALLOW` for the routing.

**B.6 Auditor (read-only + audit access).** Read-only everything (often with PDP masking obligations on
PII columns) + audit-ledger query + hash-chain verification. **Zero write tools** — the registry contains
no mutating tool, making the auditor's agent structurally incapable of state change. *Worked:* "Did
anyone approve their own expense in Q2?" → the agent queries the ledger joining `principal.sub` = the
requester of the approved record; the `permissions_at_action` snapshot lets it answer *as of that
moment*, not today's roles. Findings are a report, not an action; if the auditor says "revoke that
person's access," the agent declines (no tool) and offers to draft a recommendation to the Owner.

**B.7 External / Service Agent (scoped token).** A partner system's agent acting *as itself*: `sub:
"svc:vendor-acme-supply"`, no `act`, `attributes.vendorId = "vnd_17"`; scope exactly `po:read`,
`invoice:submit` for its own vendor records. PDP condition `resource.vendorId eq principal.vendorId` on
every read/write; rate/volume caps; IP allowlist. Everything it submits lands as a *proposal* — invoices
enter the normal human approval pipeline; **the service agent can never trigger money movement.**
*Worked:* it tries `invoice_submit` against PO-233 belonging to a *different* vendor → PDP `eq` fails →
403 audited with the mismatch; three such denials trip a workflow anomaly rule that suspends the token
and notifies the Tenant Admin.

**B.8 Support (scoped, time-boxed impersonation).** Impersonation is a token exchange producing `sub:
"user:marco"` (authorization evaluates *exactly* as Marco) with `act: { sub: "staff:support-jo",
impersonation_id: "imp_44" }`, TTL ≤ 30 min, **read-only enforced by an extra deny-override**
(`environment.impersonation eq true AND action is write ⇒ deny`). Write-capable impersonation requires
the tenant's explicit consent grant (a Tier-4 approval *by the tenant*, not by Aegis staff). Every entry
carries **dual attribution** (`sub=marco`, `act=staff:support-jo/imp_44`) so Marco's history is never
polluted — a filter on `act IS NULL` yields "things Marco actually did." *Worked:* support (as Marco)
opens team reports → hits the same `OwnAndTeam` deny Marco hits → root cause: Marco's `teamId` is unset →
support cannot fix it (write denied under impersonation) → the agent spawns a proposed fix routed to the
Tenant Admin as an approval.

## 2.3 Dynamic / custom roles

**Runtime role creation (tenant-defined).** Owner: "Create a role 'AP Clerk': view + submit invoices up
to $1k, no approvals." (1) The PAP writes role + permission rows to the relational catalog (source of
truth) inside `withTenantTransaction`, then calls `applyPolicyGrant({permissions: […]})` — writing
through the Casbin adapter *and* updating the writer pod's in-memory model. (2) `invalidatePolicies()`
fans out so every other pod's watcher runs `reloadEnforcer()` — no restart, fail-closed if the reload
fails (policy cleared, deny-all until healthy). (3) The $1k cap is **not** a Casbin rule — it lands as an
ABAC policy row (`resource.amount lte 1000` deny-override). (4) **The agent respects it immediately and
symmetrically:** the gateway subscribes to the same invalidation channel; on the next turn the tool
registry for anyone holding `ap_clerk` is re-filtered — there is no second policy system to drift, the
registry filter and the PEP consult the *same* enforcer. (5) Role creation and privileged-permission
inclusion are themselves Tier 4.

**Module install projecting default roles.** A module's manifest ships role templates
(`expense.approver`, `expense.submitter`) with default p-rules + ABAC policies. On install (entitlement
flip), the installer projects them via the same `applyPolicyGrant` path, namespaced per tenant, marked
`system-default` (tenant can clone-and-edit; edits are tenant rows, so a module upgrade never clobbers
customizations). Uninstall revokes with `revokeGroupings`-first ordering so no transient dual-grant
window exists.

## 2.4 Delegation & separation of duties

**Delegating an agent to act while away.** "Let my agent handle expense approvals under $500 while I'm
out this week" mints a **delegation grant**, not a role change:

```jsonc
{
  "delegation_id": "dlg_9a",
  "grantor": "user:priya", "actor": "agent:aegis-assistant",
  "scope": ["approval:decide"],
  "constraints": [{ "attribute": "resource.amount", "operator": "lte", "value": 500 },
                   { "attribute": "resource.recordType", "operator": "eq", "value": "expense" }],
  "risk_tier_ceiling": 3,          // Tier 4 tools NEVER run unattended — they queue for her return
  "not_before": "...", "expires": "...",  // hard expiry; token exchange refuses after
  "revocable": true                 // kill switch; revocation fans out like a policy invalidation
}
```

A delegation can only *narrow* (scope ⊆ her permissions; constraints stack **on top of** her existing
ABAC caps — it can't lift her $25k cap, and adds a tighter $500 one); creating it is itself a Tier-4
action she confirms; every autonomous action under it is audited with `delegation_id` and lands in her
return-summary digest; the tier ceiling means genuinely irreversible actions still wait — they queue,
escalate to her backup approver (`reassign`), or expire. "AI proposes, humans decide" survives her
absence.

**An agent can never be both maker and checker.** Three stacked guarantees:

1. **Identity-level (the main one):** SoD in the approvals resolver excludes the *requester* — and
   requester identity for agent actions is the **originating `sub`, not the `act`**. If Priya's agent
   submitted the expense (`sub=priya`), then Priya — through *any* interface, including a different agent
   session — is excluded from approving it. Two agent sessions of the same human collapse to the same
   `sub`; the "use a second agent to approve my first agent's work" hole does not exist.
2. **Tier-level:** Tier 4 `approval_decide` always requires a live human click; a delegated agent turn
   can never emit the final decide for Tier 4, so even cross-user collusion requires two *humans*.
3. **Chain-level:** `ApprovalService.resolvePolicy` re-runs SoD at decide-time (not just at chain build),
   so a role change between request and decision can't sneak a requester back in; an empty
   post-exclusion chain **fails closed** (the chain short-circuits rather than auto-passes).

**Attribution.** Every entry carries the token's dual identity verbatim — `sub` (whose authority) + `act`
(which actor). "What did Priya do?" → `sub = priya` (includes agent-mediated actions — she owns them;
that's what OBO means). "Personally?" → `sub = priya AND act IS NULL`. "What did the agent do
autonomously?" → `act LIKE 'agent:%' AND delegation_id IS NOT NULL`. "Reconstruct *why*" → the
`agent_trace` (prompt hash, tool-call id, referent echo, model id) chained to the same entry — reasoning
is *evidence attached to* the governed action, never the authority for it. `permissions_at_action` makes
attribution durable against later role changes: the ledger answers "was this allowed *then*", the hash
chain proves nobody rewrote the answer.

---

# Section 3 — The Danger Layer: Confirmation & Step-Up Even With Permission

**Placement in the pipeline.** Authorization (§2) answers *"is this principal allowed to do this?"* This
section answers a different question: *"this principal is allowed — but is this specific invocation
dangerous enough that we should make them prove they mean it, slow it down, tell someone, or both?"* It
is the second, orthogonal axis. It fires **after** `authenticate → authorize(PEP)` succeeds and
**before** the mutation executes inside `withTenantTransaction`. It never grants anything (a PEP deny is
final); it can only add friction, delay, witnesses, or a block-pending-review on top of an allow.

```
authenticate → authorize(PEP/Casbin) → DANGER EVALUATOR → [confirm / step-up / delay / co-sign / alert / soft-block]
            → withTenantTransaction (RLS) → execute → AUDIT ledger (incl. danger verdict + consent evidence)
```

The evaluator is a deterministic core service — **`@aegis/danger`**, a new substrate package beside the
Casbin PEP — invoked by the same execution gateway every principal passes through (human API call, UI
action, or agent tool call). The LLM never computes a danger score, never sees thresholds as mutable
input, and cannot pre-satisfy a challenge (the LLM-at-the-edge rule).

## 3.1 The danger classifier

### Inputs: DangerFacts, derived server-side only

Every governed tool/endpoint carries build-time metadata in its CapabilityManifest entry (validated by
the CI `Validate()` gate, so metadata cannot drift from implementation):

```ts
interface DangerMetadata {
  verbClass: 'read' | 'create' | 'update' | 'disable' | 'delete' | 'purge'
           | 'pay' | 'refund' | 'export' | 'notify' | 'grant' | 'config';
  reversibility: 'reversible' | 'compensable' | 'irreversible';   // compensable = undoable via a compensating action
  resourceClass: string;          // 'invoice', 'payment', 'user_role', 'audit_config', 'module', …
  sensitivity: ('pii' | 'financial' | 'credentials' | 'audit' | 'none')[];
  regulatoryTouch: boolean;       // true iff resourceClass ∈ static registry {audit_config, retention_policy, compliance_rule, ledger_export, sod_policy}
  supportsPreflightCount: boolean;
  supportsUndoWindow: boolean;    // can execution be staged + reverted?
}
```

At request time the gateway assembles **DangerFacts** — every field computed by the core from validated
inputs, never taken from client or model output:

```ts
interface DangerFacts {
  metadata: DangerMetadata;               // from manifest, by tool id
  affectedCount: number;                  // MANDATORY pre-flight COUNT(*) inside the same RLS tx, using the exact filter that will execute
  monetaryValue?: { amount: Decimal; currency: string; normalizedUSD: Decimal };
  exportedRows?: number; exportedFields?: string[];
  targetPrincipal?: { isSelf: boolean; roleDelta: 'none'|'lateral'|'escalation'; grantBreadth: number };
  anomaly: AnomalySignal;                 // advisory only
}
```

The pre-flight count is the linchpin for blast radius: "delete invoices where `status=draft`" is scored
on the **actual** number of rows the predicate matches (4,211), not on what the caller claims. It runs
inside the same tenant transaction with the same RLS context, so it can never see or score another
tenant's rows.

### Dimensions and deterministic scoring

Six dimensions, each scored **independently of permission** on a 0–4 scale. Five are pure functions of
DangerFacts; the sixth (anomaly) is advisory. Thresholds are **rules-as-data** in the workflow rules
engine — per-tenant overridable within platform floors (a tenant may tighten, never loosen below the
floor), versioned, and every change to them is itself a `regulatoryTouch` action (the layer protects its
own configuration).

| # | Dimension | Deterministic inputs | Example scoring (platform defaults) |
|---|-----------|---------------------|-------------------------------------|
| 1 | **Destructiveness / irreversibility** | `verbClass` × `reversibility` | `delete+compensable`=2; `delete+irreversible`=3; `purge`=4; `disable`=2; `update`=1 |
| 2 | **Blast radius** | `affectedCount` vs. resource-class thresholds | invoices: 1=0, 2–25=1, 26–250=2, 251–2,500=3, >2,500=4 → "delete 4,211" = 4 |
| 3 | **Monetary value** | `normalizedUSD` vs. tenant thresholds (+ duplicate-payment detector: same payee+amount within 72h, deterministic not ML) | <$500=0; $500–5k=1; 5k–25k=2; 25k–100k=3; >100k=4; duplicate-match ⇒ min 3 |
| 4 | **Data sensitivity** | `sensitivity` flags × `exportedRows` | any `pii` export: 1–100=1; 101–10k=3; >10k=4; `credentials` read/export ⇒ min 3 |
| 5 | **Regulatory impact** | `regulatoryTouch` (static registry) | any touch=3; *shortening* retention or *disabling* audit=4, always (no tenant override) |
| 6 | **Behavioral anomaly** | §below | advisory: can raise the final level by at most +1 |

**Overall danger level `D = max(dim1..dim5)`, then `D = min(4, D + anomalyBump)`.** *Max, not sum* — one
maxed dimension is enough (a $2M payment is D4 even if it's one reversible row), and summing would let
many small scores manufacture false alarms. Levels: **D0** benign · **D1** notable · **D2** dangerous ·
**D3** high danger · **D4** critical.

**Why deterministic-first.** *Auditability* — the ledger must record *why* a challenge fired, and "rule
`blast_radius.invoice.delete ≥ 2500` matched with count=4211, ruleset v17" is explainable to a
regulator; "the model felt uneasy" is not. *Reproducibility* — the same request always yields the same
verdict, so users can predict and trust the friction (critical for anti-fatigue). *No prompt-injection
surface* — an attacker who compromises the reasoning plane cannot talk the classifier down, because the
classifier never reads model output (symmetric with the deictic-referent rule).

**The anomaly signal — additional trigger, never the sole gate.** An ML/statistical detector scores the
request against the principal's and role-cohort's baseline (time-of-day, geo/ASN, session age, action
velocity, typical `affectedCount`/amount percentiles). Contract, enforced in code: **escalate only,
bump-capped** (`anomalyBump ∈ {0,1}`, never lowers `D`); **never the sole gate for hard responses** (an
anomaly bump can add at most confirmation/step-up/alert — it can never *by itself* cause soft-block or a
second approver; those require a deterministic dimension ≥ 3, so a miscalibrated model cannot lock out
legitimate work). Deterministic floor rules ride alongside it (e.g. "first `export`+`pii` ever by this
principal ⇒ bump"; "role changed within 24h ⇒ bump on `grant`/`pay`"). The anomaly score, feature
snapshot hash, and model version land on the ledger with the verdict.

## 3.2 Graduated responses

### The response ladder

| Code | Response | Mechanics |
|------|----------|-----------|
| **R0** | Execute + log | Normal path; audit only. |
| **R1** | Inline confirm | Modal restating the **server-computed** facts: verb, exact count, amount, resource class ("You are about to delete **4,211 invoices** totaling **$1.2M**"). One click. Facts come from DangerFacts, never the model's phrasing. |
| **R2** | Typed confirmation | User types the server-generated phrase, e.g. `DELETE 4211 INVOICES`. The phrase encodes the blast radius, so it doubles as proof the user *saw* the true scale; a stale count (re-checked at execute) invalidates the challenge. |
| **R3** | Step-up re-auth | Fresh WebAuthn/passkey assertion with user-verification (TOTP fallback), **bound to this challenge id** (the nonce includes the action hash — no replay onto a different action). Session-level "recently MFA'd" does NOT satisfy it. |
| **R4** | Cooling-off + UNDO | Staged (`pending_execution`), executes after a delay (default 15 min; 1h for D4-compensable). Requester and watchers get a one-click **UNDO**. The delay window is announced, so a hijacked-session action is visible before it lands. |
| **R5** | Second approver (SoD) | Routed through **`@aegis/approvals`** with `sodConstraint: approver ≠ requester`, role/quorum per policy. Reuses the existing maker-checker engine — a danger-originated approval request with the verdict attached, not a parallel system. |
| **R6** | Alert | Notify owner/admin/security (§3.5). Non-blocking; composes with any of the above. |
| **R7** | Soft-block pending review | Parks in a security review queue; only a security-admin (never the requester) releases it. Auto-expires (default 72h) into a deny. |

R1–R5 are blocking gates; R6 is a side effect; R7 is terminal-unless-released. Responses **stack**: a D4
payment is R2 + R3 + R5 + R6.

### Default mapping and overrides

| D | Base response stack |
|---|---------------------|
| D0 | R0 |
| D1 | R1 |
| D2 | R2 (or R1 + R3 where typing is impractical, e.g. mobile) |
| D3 | R2 + R3 + R6(admin) |
| D4 | R2 + R3 + R5 + R6(owner+security); + R4 where `reversibility ≠ irreversible`; R7 instead of R5 when the anomaly floor rules also fired |

Deterministic dimension-specific overrides applied on top: regulatory dim = 4 (shorten retention /
disable audit) ⇒ always R2+R3+R5+R6(security), **no tenant opt-down, no memoization**; monetary
duplicate-payment match ⇒ min R2+R6 even if the amount alone is D1; `grant` with `roleDelta='escalation'`
or self-grant ⇒ min R3+R5 (**you can never solely self-confirm your own escalation**); `purge`/
module-delete ⇒ R4 mandatory where staging is possible, else R5 quorum=2.

### Worked examples

| Scenario | Facts (server-derived) | Score | Response |
|---|---|---|---|
| **"delete 4,211 invoices"** | delete+compensable, count 4,211 | radius=4 ⇒ **D4** | type `DELETE 4211 INVOICES` + passkey + 1h cooling-off with UNDO + second approver + owner/security alert |
| **Single draft invoice delete** | count 1, $340 | **D0–D1** | at most an inline confirm — the layer stays quiet on small things |
| **$48,000 payment, same payee+amount as one 3 days ago** | pay, dup-match | money=3, dup⇒min 3 ⇒ **D3** | typed confirm restating payee+amount+"possible duplicate of PMT-2291" + step-up + admin alert |
| **Export 82,000 customer records incl. email+address** | export+pii, 82k | sensitivity=4 ⇒ **D4** | typed confirm + step-up + second approver (data-protection role) + security alert; artifact watermarked + hashed on ledger |
| **Shorten audit retention 7y → 90d** | config, regulatoryTouch, shortening | regulatory=4 ⇒ **D4**, no opt-down | typed confirm + step-up + owner approval + security alert; before/after values ledgered |
| **Escalate a user Clerk → Admin** | grant, roleDelta=escalation | min R3+R5 | step-up + second approver ≠ requester ≠ target; `applyPolicyGrant` executes only after; watcher propagates cross-pod |
| **Mass email to 12,000 customers** | notify, 12k, reversibility n/a | radius=4 (external) ⇒ **D4** | typed confirm `NOTIFY 12000 CUSTOMERS` + 15-min cooling-off with UNDO (queued, cancelable) + admin alert |
| **Delete the Payments module** | purge, module | destruct=4 ⇒ **D4** | R4 staged 72h + typed confirm + step-up + owner quorum 2 + security alert |
| **Admin exporting payroll at 3am from a new country** | export+financial, normal size, anomaly bump + geo floor | D2+1 ⇒ **D3** | typed confirm + step-up + security alert — but *not* soft-blocked (no deterministic dim ≥ 3; anomaly cannot solo-block) |

## 3.3 Composition with risk-tier HITL and `@aegis/approvals`

Risk tiers classify the **tool** (what kind of action, in general); danger classifies the **invocation**
(how bad is this specific call). They multiply; neither replaces the other:

```
effectiveGate(invocation) = max(tierBaseline(tool), dangerStack(D, facts))     // per gate type; never de-escalates either axis
```

| | D0–D1 | D2 | D3 | D4 |
|---|---|---|---|---|
| **Tier 1** (read) | log | log + R1 | R2 + R6 (bulk PII *read*) | R2+R3+R6 — yes, a *read* can hit D4 (mass export) |
| **Tier 2** (reversible write) | autonomous + activity feed | + R1/R2 | **+ R3 + R6** | **escalated to human approval (R5)** — a Tier-2 tool at D4 blast radius behaves like Tier 4 |
| **Tier 3** (external/notify) | review | review + R2 | review + R2 + R4 | review + R2+R4+R5 |
| **Tier 4** (money/irreversible) | R5 (mandatory approval, always) | R5 + R2 | R5 + R2 + R3 | R5 + R2 + R3 + R6; danger also hardens the **approver's** side — the card requires the approver to step-up too, and displays the danger verdict + facts |

Key composition rules: **one approvals engine** (danger-originated R5 creates a standard
`@aegis/approvals` request with `origin: 'danger'`, the verdict attached, SoD merged with any tier-level
policy — most restrictive wins); **danger rides the approval card** (server-derived facts, the same
anti-deictic discipline — the approver approves the *validated action*, not a paraphrase); and
**re-evaluation at execute time** (if a window elapses and pre-flight facts drift — count changed > 2%,
amount changed at all — the challenge is void and the whole gate re-runs; no TOCTOU between "confirmed
4,211" and "deleted 5,900").

## 3.4 Agent-initiated danger

The autonomous agent is just another principal through this gateway, with one extra hard rule:

> **Any agent-proposed action scoring D2 or above escalates to a human, regardless of the agent's
> autonomy tier or eval-gate status.** An eval-passing Tier-2 agent may act autonomously at D0–D1; at D2+
> its "confirmation" gates convert to human gates.

- R1/R2 (confirm/typed) → become a human approval card (the agent cannot click or type its own
  confirmation — challenge issuance is bound to a *human* session principal; an agent principal id is
  rejected at challenge creation, in code).
- R3 (step-up) → satisfiable only by a human's WebAuthn assertion. Agents have no enrolled authenticators
  by construction.
- R4 (cooling-off) → still applies; the UNDO notification goes to the agent's human owner / OBO
  principal.
- R5/R7 → unchanged (already human).

Additional agent-specific rules: the danger verdict is computed on the **validated tool call the core
will execute**, never the model's stated intent (consistent with deictic re-validation — the resolved
referent's DangerFacts are what get scored and echoed). **Cumulative blast radius:** an agent cannot
decompose one D4 bulk operation into 4,211 D0 single deletes — the evaluator keeps a per-principal,
per-verb+resourceClass sliding-window accumulator (default 1h); crossing a radius threshold cumulatively
triggers the same response as crossing it in one call, plus an R6 alert flagged `pattern:
'decomposition'`. **Ledger enrichment:** agent-initiated danger events carry the prompt/tool-call trace
pointer, so a reviewer sees the reasoning trail alongside the deterministic verdict.

## 3.5 Alerting and the audit ledger

**Who is notified.** D2 executed → requester's activity feed (in-app). D3 gate fired → tenant admins
(in-app + email; Slack/Teams via connector if configured). D4 gate fired → tenant **owner** + admins +
security role (in-app + email + Slack/Teams via Kafka topic `aegis.danger.events` on the **transactional
outbox** — the alert cannot be lost if the tx commits, cannot fire if it rolls back). Soft-block (R7),
anomaly-floor hits, and repeated failed challenges (≥ 3 in 10 min ⇒ auto-R7 + lockout of that
verb+resourceClass for the principal) → security role + optional SIEM webhook. Cooling-off staged (R4) →
requester + all D-level recipients, including the one-click UNDO link (the delay only protects against
session hijack if someone *other than the possibly-hijacked session* can see and cancel it). Alert
payloads contain the ledger entry id, verdict, and fact summary — never raw sensitive row data.

**What lands on the hash-chained ledger (non-repudiation).** Every stage is a distinct chained entry, so
the full negotiation is tamper-evident and replayable:

```jsonc
// 1. DANGER_EVALUATED — always written, even for D0 (proves the evaluator ran)
{ "type": "DANGER_EVALUATED", "actionRef": "act_9f2c", "principal": "usr_ankur",
  "permissionsAtTime": ["invoice:delete"],
  "facts": { "verbClass": "delete", "resourceClass": "invoice", "affectedCount": 4211,
             "normalizedUSD": "1204330.00", "preflightQueryHash": "sha256:…" },
  "verdict": { "level": "D4", "dims": { "radius": 4, "destruct": 2, "money": 3 },
               "anomalyBump": 0, "rulesetVersion": "danger-rules@v17" },
  "responseStack": ["R2","R3","R4","R5","R6"], "prevHash": "…", "hash": "…" }

// 2. CHALLENGE_ISSUED     { challengeId, kind:"typed", phrase:"DELETE 4211 INVOICES", expiresAt }
// 3. CHALLENGE_SATISFIED  { challengeId, kind:"typed", typedPhraseHash, uiFactsShownHash }   // consent: hash of the exact facts rendered
// 4. STEPUP_SATISFIED     { webauthn:{ credentialId, amr:["user_verification"], challengeBinding:"sha256(actionRef)" } }
// 5. APPROVAL_GRANTED     (standard @aegis/approvals entry, origin:"danger", approver ≠ requester recorded)
// 6. COOLING_OFF_STARTED / UNDO_INVOKED | COOLING_OFF_ELAPSED
// 7. EXECUTED { factsRecheck:{ affectedCount:4211, drift:0 } }  — or DENIED / EXPIRED / BLOCKED
// 8. ALERT_DISPATCHED     { recipients, channel, outboxMsgId }
```

The pairing of `uiFactsShownHash` + `typedPhraseHash` + a challenge-bound WebAuthn assertion is the
non-repudiation core: the user cannot later claim they didn't know the scale (the phrase contained the
count), didn't see the facts, or weren't present (a fresh user-verified assertion bound to this exact
action hash). Failed and expired challenges are ledgered too — the *attempt* pattern is security signal.

## 3.6 Anti-fatigue calibration

A confirmation layer that fires constantly trains users to click through it, which is worse than no
layer. All calibration mechanisms are deterministic and ledgered: (1) **silence below D1** —
single-row, low-value, reversible actions get zero friction, ever, enforced platform-side so an
over-eager admin can't turn every save into a modal; (2) **confirmation memoization (bounded)** —
satisfying an R1/R2 for `verb+resourceClass` mints a scoped grant (same principal, same session, TTL
15 min, cumulative cap ≤ 2× the confirmed blast radius/amount); *never memoized:* R3 step-up for D4,
anything with `regulatoryTouch`, R5 approvals; (3) **batch, don't repeat** — one workflow run or agent
plan performing N same-shaped operations gets **one** challenge covering the batch, using the §3.4
accumulator's aggregate (`DELETE 4211 INVOICES`, not 4,211 prompts); (4) **no double step-up** — a fresh
R3 assertion satisfies subsequent R3 for D ≤ 3 for 10 minutes (D4 always demands a fresh action-bound
assertion); (5) **threshold hygiene as data** — thresholds live in the rules engine, so proposed
recalibrations run in `runRule(dryRun)` against the last 90 days ("this change would have prompted 34
times instead of 310"); threshold changes are themselves D3; (6) **fatigue telemetry** — per tenant,
track prompt volume/user-week, confirm-through rate, median time-to-confirm, abandon rate; alarm when
confirm-through > 98% with median dwell < 2s on D2+ prompts (rubber stamps) or p95 volume > 5/user/week
(thresholds too tight), and the ops agent *proposes* the recalibration, a human approves it (the
recalibration itself flows through this very surface); (7) **predictability** — because the classifier is
deterministic, the UI warns *pre-submit* ("this will require a typed confirmation — 4,211 rows match"),
the difference between friction that reads as care and friction that reads as noise.

**Entitlement note.** The danger layer is **not** entitlement-gated — every tenant gets it; only
alert-channel richness (SIEM webhook, Slack) varies by plan.

---

# Section 4 — End-to-End Operational Flows

How the whole machine actually works, walked end to end. Every flow follows the same grammar: **the agent
reasons, retrieves, and proposes; the governed core authenticates, authorizes, isolates, executes, and
audits.** The LLM never carries `tenant_id`, principal, or permission — those are re-derived server-side
on every call. Tool catalogs are filtered by *entitlement ∩ permission* before the model ever sees them,
so "the agent can't do that" is enforced by absence, not by prompt. Risk tiers gate autonomy: **T1** read
→ autonomous+log; **T2** reversible write → autonomous+log+activity feed; **T3** external/notify → cheap
review; **T4** irreversible/money → mandatory `@aegis/approvals` (maker-checker, SoD, thresholds,
quorum). Every step lands on the hash-chained ledger with permissions-at-time-of-action, plus prompt +
tool-call trace for agent actions (`agent.tool.invoked`, `agent.action.proposed`,
`agent.action.approved`).

```
GOVERNED EXECUTION PATH (identical for human API call and agent tool call):
authenticate(JWT / short-lived scoped agent credential)
  → gateway ENTITLEMENT check (tenant_modules, Redis read-through, monotonic version, fail-closed for unpurchased)
  → authorize(Permission) at the PEP (Casbin, fail-closed)
  → DANGER EVALUATOR (@aegis/danger — §3) for mutations
  → withTenantTransaction (RLS sets app.current_tenant)
  → execute → domain event → transactional outbox → bus
  → hash-chained AUDIT ledger entry (permissions-at-time-of-action; + prompt/tool trace if agent)
```

## 4.A Tenant onboarding — self-serve, no sales

An anonymous visitor becomes a tenant Owner via the platform onboarding agent (a first-class principal
with a narrow, purpose-built scope). Goal: signup → first real outcome in one conversation, zero human
sales/success.

1. **Signup (core, not agent).** Identity creation, email verification, and tenant-record creation are
   **deterministic core code** — the agent is not trusted to mint principals or tenants. The core creates
   the tenant row and generates RLS policies for all tenant-scoped tables (module authors and agents
   never write RLS by hand). Entitlement: `none → provisioning`.
2. **Workspace provisioning (core, agent-narrated).** The agent greets the Owner and *narrates* while
   core sagas run: default roles projected into Casbin via `applyPolicyGrant()`, `tenant_features`
   seeded, per-tenant vector namespace created for self-knowledge RAG, per-tenant LLM token budget
   initialized, KEDA scale-to-zero profile registered. Each step is idempotent and resumable; failure
   rolls back to `none` — never a half-provisioned tenant.
3. **Owner identity + defaults (T2, autonomous).** Conversational setup ("does anyone sign off on spend
   over some amount?") → **proposed configuration**: role tweaks, a starter approval threshold, workflow
   rules as rules-as-data. Reversible config writes are T2. Anything touching authorization policy itself
   ("give everyone admin") escalates to a confirmation card — deictic content echoed and re-validated by
   the core, never resolved silently from chat context.
4. **Connect data sources (T3 boundary).** "Connect your QuickBooks" opens the connector framework's
   OAuth flow via generative UI (the user authenticates to Intuit directly — **credentials never transit
   the LLM**; the connector config-store holds tokens encrypted, per-tenant). First sync is read-only.
   Ingested external content is untrusted — summarizable and retrievable, but it cannot directly drive
   privileged tool calls (dual-LLM / code-then-execute separation).
5. **Configure the first module (T2 + dryRun).** Enabled through the **same Module Lifecycle flow (4.C)**
   — no onboarding backdoor. Configured by *proposing*: workflow rules in `runRule(dryRun)` replayed
   against freshly synced data — "Under this rule, 14 of last month's 60 bills would have needed your
   approval. Enable?" One click enables; enablement is a T2 governed write.
6. **First outcome (minutes, not weeks).** "You have 3 duplicate vendor bills and $4,200 past due — want
   me to draft the follow-ups?" Drafting is T2; *sending* to an external vendor is T3. The Owner has
   experienced the whole grammar — propose → approve → execute → audit — on day one.

Where the gates fired: identity/tenant minting = never agent-executed; policy grants = PAP-only, audited;
connector auth = out-of-band OAuth; external sends = T3; nothing here is T4 yet, by design — onboarding
must not require trust the tenant hasn't built.

## 4.B User onboarding within a tenant — the agent teaches by doing

Admin, in chat: "Invite priya@acme.com as an AP clerk for the Northeast region" → the agent resolves the
role by name against real tenant roles and renders a confirmation card (`ap-clerk`, ABAC attribute
`region=northeast`); the email and role are echoed literally — no deictic resolution feeds the grant. On
accept, the core binds identity → role via PAP; ABAC attributes land in the principal's attribute set;
the grant is audited with who-approved-what — the agent never writes a Casbin line, it calls a grant tool
whose parameters are validated against the manifest-declared role catalog. Priya's first session
introduces *only what she can do* (her tool surface is already entitlement ∩ permission filtered, so the
agent literally cannot describe-and-offer actions she lacks), walks her through her first real bill
(retrieval T1, executing the coding as a T2 write *in her name* — she is the principal, the agent acts
on-behalf-of via the RFC 8693 `act` chain, so the ledger shows *Priya, assisted by agent*), and surfaces
the next capability at the moment it's relevant ("this bill exceeds your $5k limit — it routes to Marcus;
here's why"), every "why" citing the rule-as-data and the ledger. Onboarding doubles as governance
literacy and feeds §4.F's access reviews with zero extra work.

## 4.C Module lifecycle — discover → buy → configure → upgrade → uninstall

- **Discover (T1).** "What can help me with AP?" → the agent queries the module registry's
  natural-language capability descriptions (a governed catalog, not web search) and answers with what
  each module does, its price, and what it would look like *on this tenant's data* ("it would auto-code
  ~80% of the 240 bills/month you import from QuickBooks"). Pure read, autonomous, logged.
- **Buy / enable (the entitlement saga — T4-gated because it's money).** The agent proposes; a purchase
  card shows module, plan, price, and billing effect; a billing-admin human confirms (step-up if
  configured). The **core** then runs the grant saga — ordered, idempotent, serialized per
  `(tenant, module)` via advisory lock: (1) `provisioning` — run module migrations, platform-generated
  RLS on module tables, cross-tenant leakage test gate; (2) create the Chargebee subscription item,
  materialize the `tenant_modules` entitlement; (3) `applyPolicyGrant()` projects the manifest's
  roles/permissions into live Casbin, cross-pod watcher fans out reload (instant, no deploy);
  (4) entitlement flips `active`, the gateway's Redis-cached, monotonically versioned entitlement opens
  the routes; (5) the module's tools appear in filtered catalogs, `module.enabled` lands on the bus and
  the ledger. **Permissions are granted only after migrations finish** — a grant racing an incomplete
  migration is a correctness incident, so the ordering is enforced by the saga, not convention.
- **Configure (T2 + dryRun).** As in 4.A.5: author rules-as-data in propose mode, replay against
  historical tenant data, show counterfactuals, enable on confirm. Config changes that alter *who can
  approve what* are governance changes → T3/T4 per the manifest's risk annotations.
- **Update / upgrade.** First-party (in-process) modules upgrade **fleet-wide in lockstep** with a kill
  switch; data-shape changes follow expand/contract so rollback is always possible. Per-tenant version
  pinning exists only for out-of-process partner modules. The agent notifies affected tenants, runs the
  module's Promptfoo eval suite against the new version's tools, and **suspends autonomous use of any
  Tier ≥ 2 tool whose eval gate fails** until it passes again (the §1.3 V3 eval gate). Migration
  execution is core; SLO-gated auto-rollback applies.
- **Disable / uninstall (the dangerous inverse).** Revoke is *not* symmetric with grant. (1) **Danger
  gate (T4):** the agent states the consequence concretely — "You have 4,300 AP records. Disabling
  **tombstones** them (retained 90 days, restorable if you re-subscribe). Do you want an **export**
  first?" `export(tenant)` is a manifest-mandated capability, offered by default. (2) The core runs the
  revoke saga: `revokePolicyGrant()` pulls the projected Casbin grants + watcher reload; the gateway
  flips to deny **after a bounded grace period** (never mid-request lockout); in-flight sagas drain or
  compensate; Chargebee item removed; state → `suspended`/`deprovisioning`. (3) Three explicit data
  outcomes: **tombstone** (default — schema+data retained through the retention window), **export** then
  tombstone, or **erasure** (hard drop of module-owned tables only after explicit second confirmation
  *and* window expiry, with GDPR/CCPA `deleteSubject` fan-out tracked to completion across every module's
  schema). Dunning-driven suspension (4.D) reaches the same `suspended` state via `past_due` — it never
  triggers erasure.

## 4.D Payments / billing — no sales, no billing support

- **Self-serve buying & plan/seat changes.** All purchases flow through 4.C's T4 purchase card. Seat
  changes show the exact Chargebee proration before a billing-admin confirms. **Downgrades get a danger
  gate with a concrete loss statement** — "Dropping to Starter removes the Workflow module — your 12
  active rules stop running and their data is tombstoned. 3 rules currently gate payments over $10k;
  those payments would flow un-gated." That sentence is computed by the *core* from real rule data (the
  LLM phrases it; it does not compute it). Step-up for plan changes above a tenant-configured threshold.
- **Usage & metering visibility (T1).** "What's driving our bill?" Module services meter usage to a local
  sub-ledger, mirrored async to billing (**fail-open but bounded** — capped unbilled accrual + alert, so
  a Chargebee outage never blocks the product but can't become an unbounded revenue leak). The agent
  answers from the sub-ledger with generative-UI breakdowns per module/seat/meter — including **AI usage
  itself** (per-tenant token budgets are metered like any other resource).
- **Cost guardrails + alerts (T2 to set, autonomous to enforce).** "Alert me at $500/mo and hard-cap AI
  spend at $800." The agent writes these as rules-as-data; **enforcement is deterministic core** — the
  LLM gateway's budget check throttles at the cap regardless of what any model says. Alerts fire as T2
  activity-feed items; the approaching-cap conversation is agent-mediated.
- **Dunning / past-due.** A Chargebee webhook (plus **periodic pull reconciliation** — webhooks are
  best-effort) drives `active → past_due`. In grace: full function, agent nudges the billing admin with a
  one-click payment-update card (T3 notify). Grace expiry → `suspended`: gateway closes module routes
  fail-closed, **data tombstoned, never erased by dunning.** Payment fixed → reconciliation flips back to
  `active`, `applyPolicyGrant` re-projects, watcher reloads — self-healing, no human on Aegis's side.
- **Invoices/receipts (T1).** Fetched from Chargebee, explained line-by-line, with drill-down from any
  line item to the metering events and audit entries behind it. Disputes rarely need escalation because
  **the ledger is the receipt.**

## 4.E Everyday module usage — talk or type, governed inline

- **Submit an expense (T2).** "Expense yesterday's client lunch, $84, receipt attached." Agent extracts
  fields (OCR/vision at the edge), pre-checks against *this tenant's* policy rules (core-evaluated),
  renders a filled generative-UI card for one-tap confirm. Core executes as the user; the workflow engine
  routes per rules-as-data. If it violates policy, the agent says so *before* submission, citing the rule.
- **Approve an invoice (T4 — the money moment).** "Approve the Meridian invoice." The referent is
  **never resolved by the LLM into an execute**: the core renders an approval card with invoice ID,
  vendor, amount, and Marcus's authority check already evaluated — the card *is* the referent.
  `@aegis/approvals` enforces maker-checker/SoD (if Marcus submitted it, the core blocks him from
  approving it — no prompt overrides a PDP decision). Approval is durable — the workflow can wait days
  without holding compute.
- **Run a report (T1).** "Q2 spend by vendor, region Northeast." RLS + ABAC guarantee she sees only her
  scope — the *database*, not the prompt, enforces it. Results render as generative UI with export.
- **Author a workflow rule (T2 propose → confirm).** "Route any invoice from a new vendor over $2k to
  Priya first." The agent drafts the rule-as-data, runs `runRule(dryRun)` over 90 days ("this would have
  caught 7 invoices"), and activates on confirm. Rules that *weaken* controls (raising thresholds,
  removing approvers) are manifest-flagged and escalate to T3/T4.
- **"Why was this rejected?" (T1 — the trust moment).** The agent joins the audit ledger (the exact
  evaluated rule, permissions-at-time-of-action, who/what/when) with self-knowledge RAG (what the rule
  means): "Rejected by rule *vendor-risk-3*: Meridian was added 4 days ago and the amount exceeds the
  new-vendor threshold Priya set on June 12 — here's the ledger entry." Then it offers the governed fix
  path: "Want me to request an exception? That goes to Marcus as a T3 approval."

## 4.F Admin operations — the tenant runs itself by chat

- **Users/roles/teams.** "Move the Boston team under Northeast and give team leads expense-approval up to
  $10k." The agent decomposes into grant/regroup operations and renders a **single diff-style
  confirmation card** (before → after, per person). Structure changes are T3; expanding money/irreversible
  authority is T4. Core applies via PAP; watcher reloads; every grant individually audited.
- **Entitlements.** "What are we paying for, what's actually used?" The agent cross-references
  entitlements with usage metering (the §1.2 Domain-1 entitlement drift auditor made conversational) —
  "nobody has used the Contracts module in 60 days; downgrading saves $199/mo" — cost-optimization advice
  with the downgrade danger gate one click away.
- **Security settings.** Session policy, SSO enforcement, step-up thresholds, retention windows — all
  conversational, all rendered as explicit-diff confirmation cards, mostly T3/T4 because misconfiguration
  here is blast-radius-maximal. **Fail-safe floors are core-enforced:** the agent cannot propose disabling
  the audit ledger or RLS — those aren't settings, and no tool exists for them.
- **Audit & access reviews.** "Show me everything the agent did autonomously last week" / "who can
  approve payments over $50k, and who actually did?" — T1 queries over the ledger, which stores
  permissions-at-time-of-action, so reviews reflect *what was true then*. The agent drafts the quarterly
  access-review packet (dormant accounts, SoD conflicts, privilege drift); each recommended revocation is
  a one-click governed action. Ledger hash-chain verification runs continuously; the agent surfaces (and
  cannot suppress) any integrity alarm.
- **Autonomous-agent policies (governance of the agent itself).** The admin tunes the risk-tier policy
  per tool within manifest floors: "require review for any external email until further notice" (tighten
  T3 → always-review — allowed); "let the agent auto-approve invoices under $500" (**refused by the
  core** — invoice approval is manifest-floored at T4; the agent explains the floor and cites it).
  Per-agent token budgets, allowed hours, and kill switches ("pause all autonomous actions now" — an
  immediate T1-priority core control, not a request the agent may decline) live here — this **is** the
  §1.5 Autonomy Console. Changes to agent policy are themselves T4 and audited.

## 4.G Agentic customer support — replaces human CS, with a bounded human tail

- **"How do I…?" (T1).** Answered from self-knowledge RAG — module capability descriptions, the tenant's
  own config, *this tenant's* usage patterns — so the answer is "here's how **your** approval chain
  handles that," not generic docs. When the fix is an action the user is permitted to take, the agent
  offers to **do it** on the spot (at that action's normal tier), collapsing "support" into "usage."
- **"What happened / why?" (T1).** Answered from the tenant's own audit ledger + workflow rule data.
  Because every action (human and agent) is on the hash-chained ledger with its authorization context,
  "why" always has a definitive, citable answer. **This is the structural reason agentic support works
  here where it fails elsewhere: the system of record explains itself.**
- **"Fix this" (scoped action, normal tiers).** The support agent has *no elevated powers* — it acts
  on-behalf-of the asking user through the identical governed path. Re-run a stuck sync (T2), re-send a
  lost invoice email (T3), un-tombstone recently disabled module data within the retention window (T4 for
  the billing admin). A user without permission gets a routed request-card to someone who has it —
  support becomes a workflow, not a dead end.
- **Platform-fault detection → NoOps handoff.** If diagnosis points at Aegis rather than tenant config
  (webhook lag, connector outage, SLO breach), the agent checks platform health, tells the user honestly
  ("Chargebee webhooks are delayed ~20 min; reconciliation will self-correct; nothing on your side"), and
  files a structured incident to the AI SRE agent (§1.2 Domain 6), which self-heals under the same "AI
  proposes, humans decide for novel/irreversible/cross-tenant" rule.
- **Bounded human escalation (the Klarna lesson).** A thin, free, always-available human path exists for
  the long tail; the agent escalates **automatically** on triggers (user asks twice, expresses
  frustration, dispute involves money/legal/data-loss, confidence below threshold, or any suspected
  cross-tenant issue — instant, never agent-handled). The human receives full context (conversation,
  tool-call trace, relevant ledger entries), so escalation is minutes, not "please explain again."
  **Resolution quality is measured per segment** (Langfuse + eval scoring), not aggregate deflection, and
  every escalation transcript feeds the eval suite so the same gap doesn't escalate twice.

## The one-paragraph takeaway

Every flow above is the same machine wearing different clothes. Discovery, teaching, drafting,
diagnosis, and phrasing are the agent's job; identity, entitlement, authorization, tenancy, execution,
and memory of what happened are the core's job — and the seam between them is a filtered tool catalog
going in and a typed, re-validated proposal coming out. Money and irreversibility always stop at a human.
Everything, including the agent's own reasoning trace, lands on a ledger the tenant can interrogate in
plain language. That is why there is no sales team, no support team, and no ops team in any of these
flows — and why removing them doesn't remove accountability.

---

# Section 5 — How the axes compose

The four surfaces are deliberately orthogonal so that each can be reasoned about, tested, and audited on
its own. But at the moment any single action executes, all four collapse into one deterministic decision,
evaluated by the core, never the model. For any action:

> **effective gate = AUTHORIZATION ∧ DANGER ∧ AUTONOMY ∧ VERIFIABILITY**

where each conjunct is:

- **AUTHORIZATION (§2)** — the PEP verdict: `RBAC(roles) ∩ ABAC(attributes × resource × environment) ∩
  agentScope(delegation) ∩ entitlement(tenant_features)`, fail-closed. *Are you allowed at all?* A deny
  here is final; nothing downstream can rescue it.
- **DANGER (§3)** — `@aegis/danger`'s response stack for this specific invocation: confirm / typed /
  step-up / cooling-off / second-approver / alert / soft-block, computed from server-derived DangerFacts.
  *Is this risky even though you're allowed?* This axis can only add friction, never remove it.
- **AUTONOMY (§1.4)** — the control-model mode: propose-only / act-then-log / act-with-undo, a function of
  risk tier, declared blast radius, eval-gate status, and per-tenant earned-autonomy state. *May this be
  done unattended, or must a human be in the loop?*
- **VERIFIABILITY (§1.3)** — the Trust Rule: a `VerificationRecord` that is deterministic, dual-controlled,
  or eval-sampled, with mandatory citations and an ABSTAIN option. *Is the result the agent produced
  trustworthy enough to act on?* No record ⇒ the result is a draft and cannot mutate state.

The conjunction is strict: **the action executes only when all four clear, and each clears at the most
restrictive setting any of them demands.** Authorization and danger take the *max* of their per-gate
requirements (§3.3); autonomy fails safe to propose-only on any ambiguity (§1.4); verifiability can only
ever demote, never promote (§1.3). There is no path where a strong result on one axis buys leniency on
another — a verifier's CONFIRM cannot skip an approval, an entitlement cannot lower a danger score, a low
danger score cannot grant a missing permission. Each axis can *tighten* the gate; none can *loosen* it.

### Worked example — an autonomous agent proposing a bulk vendor payment

A tenant has promoted the **Draft-ahead worker** (§1.2 Domain 4) to act-with-undo for low-tier tasks and
runs a standing **Directive**: *"every Friday, pay all approved utility invoices under $2,000."* On this
Friday the Directive fires and the agent assembles a batch of **38 invoices totaling $61,400**, one of
which is a **$1,950 payment to a vendor first seen this week**. Trace the four axes:

1. **VERIFIABILITY first — is the batch even actable?** The agent did not do the arithmetic: the core
   computed the 38-invoice selection and the $61,400 total **in SQL under RLS (V1 deterministic)**, and
   the claim "38 invoices match the filter" is re-run and reproduced before render. A **second agent
   principal** (`agent:verifier`, separate prompt, no access to the maker's chain-of-thought) reviews the
   batch adversarially and returns CONFIRM with cited reasoning — except it flags the new-vendor line for
   human attention (V2). The capability's eval suite is green (V3). A `VerificationRecord` with
   `method: [DETERMINISTIC, DUAL_CONTROL, EVAL_GATED]`, non-empty citations, and confidence above floor
   is attached and anchored in the hash chain (V4/V5). **Axis result:** the result is trustworthy enough
   to be *acted on* — but "acted on" still means only "eligible to proceed to the other three gates," not
   "auto-executed."

2. **AUTONOMY — may this run unattended?** The control model (§1.4) evaluates the batch. `verbClass=pay`,
   `blast ∈ {external, money}`, and the tool is **manifest-floored at Tier 4**. The very first clause
   fires: `tier == 4 or blast in {…, money} → PROPOSE-ONLY (mandatory human)`. The Directive's declared
   `mode` ceiling is irrelevant — it can never exceed this. **Axis result:** propose-only. The agent
   *cannot* pay; it can only stage a proposal. (Had a mischievous prompt tried to decompose the batch
   into 38 single sub-$2k payments to dodge a threshold, the §3.4 cumulative-blast-radius accumulator
   would re-aggregate them and flag `pattern: 'decomposition'`.)

3. **AUTHORIZATION — is the acting human even allowed?** The proposal routes to the tenant's Finance
   Manager. The PEP evaluates her live authority: Casbin grants `payment:initiate`; ABAC checks each
   line's `resource.amount lte principal.approvalCap` and `resource.costCenter in
   principal.costCenters`. One invoice sits in a cost center outside her scope, so the PEP returns ALLOW
   for 37 lines and DENY for that one, which is split off and routed to the correct approver (the
   split-decision pattern of §2.2 B.4). SoD (§2.4) also drops any line she herself submitted. **Axis
   result:** ALLOW for the authorized subset; the rest re-routed, never silently dropped.

4. **DANGER — even allowed, how risky is this exact invocation?** `@aegis/danger` scores the (now
   37-line) batch on server-derived facts: the monetary dimension on the ~$59k total ⇒ D3; blast radius
   on 37 external payments ⇒ D3; the new-vendor line trips the deterministic first-payment floor rule and
   the duplicate-payment detector runs clean. `D = max(...) = D3`, no anomaly bump needed. Because the
   tool is Tier 4, §3.3 composition already mandates R5 (approval); danger *hardens the approver's side*:
   the card requires **her own step-up (R3)** and displays the full verdict + the new-vendor flag the
   verifier raised. She reviews the core-computed card (never the model's paraphrase), passes a fresh
   WebAuthn assertion **bound to this action hash**, and approves. At execute time the core re-checks the
   pre-flight facts for drift (§3.3); count and total are unchanged, so the challenge stands. **Axis
   result:** confirm + step-up + second-approver-for-the-split-line + owner/security alert, all
   satisfied.

Only now — **verifiable ∧ propose-only-then-human-approved ∧ authorized ∧ danger-cleared** — does the
core enter `withTenantTransaction`, initiate the 37 payments, and write the full negotiation to the
hash-chained ledger: the Directive that triggered it, the `VerificationRecord`, the dual-control verdict,
the PEP decisions (ALLOW ×37, DENY ×1 with reason), every danger stage (`DANGER_EVALUATED` →
`CHALLENGE_SATISFIED` → `STEPUP_SATISFIED` → `APPROVAL_GRANTED` → `EXECUTED`), the `undoToken` for the
compensable hold window, and the agent's prompt/tool-call trace as *evidence attached to* — never
*authority for* — the action. The one line that was denied and the one routed elsewhere are on the same
chain. A month later an auditor can prove, from the chain alone, that every one of these gates fired, in
this order, on the evidence shown at the time — which is the entire point: **the agent reasoned; the
governed core acted.**

---

## §6. Full red-team (authoritative — §0 is its distillation)

Verdict: *"Architecturally serious and far above the field… the LLM-at-the-edge principle, single
governed execution path, deterministic danger classifier, and hash-chained attribution are the right
bones and most competitors will not get this far. But NOT yet safe to move money autonomously in a
multi-tenant financial platform. Grade: strong B+ design, currently a C on 'trust it with money
unattended.'"*

### 6.1 Verifiability holes
1. **Dual-control is theater against correlated failure.** "Ideally a different model" = in practice the
   same family, same blind spots. If the maker resolved the wrong entity from corrupted/injected upstream
   data, the verifier reads the *same* data and confirms. The doc never bounds the verifier's
   independent-error rate or *requires* a different model.
2. **Determinism is sold as correctness.** V1's re-check query is LLM-authored; a wrong JOIN / wrong
   period boundary / dropped NULLs / RLS-invisible filter produces a number that re-runs identically
   forever. "Does the cited query reproduce the number" proves determinism, not correctness. Two
   LLM-authored invariants from the same wrong mental model agree and hide the break.
3. **Sampled LLM-judge is an LLM checking an LLM.** For the unsampled 95% and shared-error cases, wrong
   results are acted on with zero human eyes. Sampling bounds the *discovery* rate, not the *occurrence*
   rate — misapplied to individually-material financial mutations.
4. **The Trust Rule is an OR; OR is the weakness.** `sampled+audited` alone satisfies it for a Tier-2
   write → individual autonomous financial writes with no per-action verification, fully "compliant" and
   still wrong.
5. **Confidence calibration is unspecified.** LLM confidence is miscalibrated and drifts with model
   updates; a capability that becomes overconfident after a version bump keeps auto-executing while real
   accuracy craters, unless the eval suite happens to cover the regression.
6. **Crypto provenance = tamper-evidence, not correctness.** It proves the agent didn't change its
   homework, not that the homework was right; an auditor can prove a wrong decision was made faithfully.
7. **Evidence drift.** The evidence-bundle hash anchors what the maker saw, but the verifier reads live
   mutable data; between maker action and verifier read the world changes → CONFIRM attests to a state
   that no longer matches execution. Drift recheck covers danger facts (count/amount) but not the full
   evidence.

### 6.2 Authorization leaks
1. **Standing Directives outliving the grant.** A broadly-permitted user compiles an NL Directive
   (concrete params, no runtime NL); if their roles are later narrowed, the Directive's capability binding
   isn't obviously re-intersected against *current* permissions at each fire — only the token exchange is.
   A longer-lived delegation token lets scope outlive the grant.
2. **The verifier is a fat, standing, cross-capability read principal** fed attacker-influenced evidence
   bundles → prompt-injection-to-data-exfil surface. Its scope is never specified; the doc hardens the
   maker and treats the verifier as trusted.
3. **Platform patrols do cross-principal / cross-tenant reasoning** (SoD detector's identity linkage
   implies a cross-tenant identity graph). "Minimized/aggregated" is asserted, not enforced — nothing
   structurally stops a patrol carrying raw cross-tenant PII in context.
4. **Write-capable impersonation via a consent card the support agent itself phrases** = a persuasion
   surface for staff-driven writes as a tenant user.
5. **Kill-switch propagation window.** Grant sagas + "bounded grace" + cross-pod watcher ("effective in
   seconds") ≠ atomic; a stale-enforcer pod can authorize an already-revoked action, including revoking
   the kill switch, during propagation.
6. **OBO widens with the human.** If the user's roles are elevated mid-session, the refreshed OBO token
   copies the broader roles automatically — the agent silently gains authority with no per-agent
   re-consent.

### 6.3 Danger-layer gaps
1. **Same-count-different-rows TOCTOU** — a JOIN-on-mutable-state filter can keep COUNT stable while the
   row *set* shifts between count and execute; passes the 2% drift check and deletes the wrong rows.
2. **Cross-module side-effect blast is invisible** to a per-tool classifier — a benign `update` that flips
   a status which cascades to releasing held payments via an outbox event scores as `update=1`.
3. **Memoization = a 2× click-through envelope** — confirm one $25k payment and get a 15-min $50k
   un-challenged envelope for that verb+resourceClass.
4. **Deterministic predictability enables just-under-threshold evasion** across *every* dimension, not
   just payments.
5. **Below-D1 silence is a hard floor attackers learn** — keep each action D0–D1 across different
   verbs/resourceClasses and both the per-action floor and the per-(verb,resourceClass) accumulator are
   evaded.
6. **Cooling-off/second-approver degenerate for solo-admin tenants** — the undo goes to requester+watchers;
   if the requester is compromised and there are no watchers (the self-serve SMB case), R4/R5 are
   decorative.

### 6.4 Autonomy risks
1. **Maker/checker collapse at the model layer** — identity-SoD ≠ independence-of-judgment; two distinct
   principals on the same weights are maker and checker in name only.
2. **Fatigued-acceptance → promotion loop** — K=10 consecutive human-accepted proposals drives promotion;
   tired rubber-stamping is indistinguishable from genuine acceptance, so the system can bootstrap to full
   autonomy on 10 tired clicks; demotion needs a *caught* error caught by the same tired humans.
3. **Cost-bomb via verification amplification** — a token-budget breach "degrades to a proposal stub," so
   an attacker inflating token burn starves verification first, flooding human queues (denial-of-autonomy).
4. **Auto-kill on statistical anomaly is a runaway in the other direction** — a poisoned slowly-normalized
   baseline defeats it; a miscalibrated threshold self-DoSes the tenant.
5. **Cross-principal decomposition uncovered** — two users each delegate an agent and each does half a bulk
   op; neither crosses the per-principal accumulator.
6. **Silently-over-broad compiled Directives** — subtle mis-compilation (inclusive/exclusive date edge)
   becomes a standing weekly autonomous rule everyone believes was verified because they clicked the card.

### 6.5 Flow gaps
1. **Pre-tenant onboarding agent** acts for an anonymous visitor with no tenant/RLS context and an
   unspecified "narrow scope" — the softest authz surface, hand-waved.
2. **Untrusted-connector-data → proposal injection** — reconcilers/dedup/drift detectors all reason over
   attacker-influenceable synced data; the dual-LLM defense is one parenthetical, never shown in the arch.
3. **RAG gloss vs ledger truth** — "why was this rejected" JOINs the tamper-evident ledger with
   *un-hash-chained* RAG explanation; a poisoned RAG gloss on a correct ledger entry yields a
   confidently-wrong "why."
4. **Erasure vs immutable ledger** — deleteSubject fan-out ignores the ledger, backups, RAG namespace,
   warehouse, and evidence bundles → direct GDPR conflict, unaddressed.
5. **Billing split-brain** — features fail-closed (stale Redis) while usage metering fails-open; a tenant
   can be denied a paid feature while accruing charges, with no human ops to intervene in the grace.
6. **The escalation hatch depends on the possibly-compromised agent** to self-assess low confidence; no
   deterministic, agent-bypassing "get me a human NOW."

### 6.6 Where a human is still genuinely required (honest list)
Novel incidents/remediations (not matching a chaos-validated runbook) — and a human must be *reachable*,
which conflicts with no-ops at night/weekends for SMBs · **first-time high-value external actions**
(first payment to any new payee, first bulk PII export, first real-data run of any new Directive) —
regardless of eval/verifier state, because there's no track record yet · legal/liability/regulatory
judgment (retention, audit config, erasure scope, disputes) — approval ≠ competent judgment; needs a
named accountable human · anything cross-tenant · **calibration & threshold governance** (danger
thresholds, promotion rubric, what "anomalous" means) — governing the governors can't be automated
without infinite regress · **the solo-admin tenant** broadly — SoD/second-approver/watchers/break-glass
all assume ≥2 humans; the self-serve GTM frequently has one → controls silently degrade to self-approval.

### 6.7 Ranked top fixes (implement in this order)
1. Split the Trust Rule OR into a **tiered AND** (money/external/irreversible/D≥3 ⇒ V1∧V2 with a provably
   independent checker; forbid sampled-alone for material writes; runtime invariant asserts the required
   method set).
2. Fix **deterministic ≠ correct**: V1 check queries come from a human-reviewed, version-pinned library
   (LLM selects, never authors, for money-touching) or cross-validated by an independently-authored
   query; label same-query reproduction as determinism-only.
3. Make the checker **independent for real**: different model provider/family; verifier reads its own
   fresh snapshot; execute-time re-verify the *full* evidence; alarm on too-high maker↔verifier agreement.
4. Close the **SMB single-human contradiction** head-on (cooling-off + out-of-band 2nd-channel confirm +
   platform-side security-review queue as substitute checker; never silent self-approval).
5. Add **cross-principal / cross-resourceClass / cross-time** cumulative blast accounting.
6. Harden the **untrusted-data → proposal** path (enforced dual-LLM/code-then-execute for every capability
   over external content; provenance flag forces stricter review).
7. Guarantee a **deterministic, agent-bypassing "human now"** control + server-side forced escalation.
8. Reconcile **immutable audit + GDPR erasure** (crypto-shred per-subject keys; erasure fan-out to
   bundles/RAG/backups/warehouse; or documented legal-basis exemption).
9. Break the **fatigued-acceptance → promotion** loop (dwell-time/fatigue-window exclusion; promote on
   active verification; demote on leading indicators).
10. Constrain the **fat verifier & platform-patrol** principals (least-privilege scoped read; patrols use
    pre-aggregated warehouse data only).

*Net: excellent governance skeleton; dangerous only if "minimal human intervention on money" is taken
literally today. Ship read-only + propose-only for money/external/irreversible; earn write-autonomy as the
§0/§6 fixes land in code, not prose.*
