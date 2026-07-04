# T9 Strategy Red-Team — Consolidated Findings

**Status:** Consolidated by lead architect from five independent red-team passes (each appended a correction banner to its own source doc), cross-referenced against the four earlier-red-teamed docs.
**Date:** 2026-07-03
**Audience:** Founder (go/no-go + sequencing decisions) and implementing agents (fix-before-build gates).

---

## 1. What was reviewed & overall confidence

Nine strategy docs make up the T9 corpus. Five were red-teamed in this pass:

- `platform-omniscience.md` — three-plane diagnostic/observability substrate
- `stack-sufficiency.md` — TS/Node spine + Python sidecars language decision
- `knowledge-brain.md` — two-brain knowledge/RAG architecture
- `ecosystem-ar-protocol.md` — A2A/A2UI cross-company + AR interaction profile
- `agentify-and-policing.md` — extract-and-sell enforcement gateway products

Four were red-teamed earlier and are carried in here for the cross-cutting synthesis and the unified fix list:

- `modular-platform-plan.md`
- `agentic-platform-design.md`
- `ai-native-core.md`
- `agentic-operations.md`

**Overall confidence: the architecture is largely right; the safety-critical specifications are not yet done.** Every reviewed doc has an **honest, defensible thesis** and every one is **not ship-ready as literally worded.** The recurring pattern is a gap between the docs' *honesty posture* and their *boundary rigor*: the hard-to-get-right controls (tenant isolation under new data planes, credential boundaries, injection isolation, erasure, single-human separation-of-duties) are named as principles but under-specified or contradicted in the details. **No doc is architecturally wrong. Four of five reviewed docs are "high" severity on specification/wording, not on direction. The fifth (`agentify-and-policing`) is "high" on *timing and business bet*, not architecture — the correct call there is "don't build now."**

Net: **safe to proceed on the spine and the read-only DB slice; not safe to wire anything with autonomy, cross-tenant reach, untrusted-data ingestion, or a second (non-RLS) data plane until the fixes below land.**

---

## 2. Per-doc verdict table

| Doc | Severity | One-line verdict |
|---|---|---|
| `platform-omniscience.md` | **High** | Three-plane thesis + propose-only ceiling sound, but "read-only by construction" is false for 5/8 connectors, auto key-rotation is self-referential blast radius, and the audit-ledger MCP is the richest exfil target dressed as a free win. |
| `stack-sufficiency.md` | **High** | Language decision (TS spine, 4 Python sidecars, no Go/Rust) is correct and settled; the doc is weakest exactly where safety lives — the object-store extract seam is a second, weaker isolation plane it won't admit, with no lifecycle/erasure story and no sidecar failure-mode design. |
| `knowledge-brain.md` | **High** | Two-brain / generate-over-curate / cite-or-abstain calls are right, but it ships live protocol-vs-reality drift today (mandated read path 404s), RLS is one commented line (read/write conflated, ANN-under-RLS unproven), and poisoned-brain authz-escalation is a rule not an enforced gate. |
| `ecosystem-ar-protocol.md` | **High** | A2A/A2UI sourcing verified and "profile not protocol" is right, but the crown-jewel "what-you-see-is-what-you-sign" is forensic-only (signs a nonce, not the transaction) so a compromised hub can get a Tier-4 wire authorized behind a benign card; hub aggregation is an ungoverned cross-tenant surface. Founder-dogfood track, not v1. |
| `agentify-and-policing.md` | **High** | Strong research, wrong bet now: the enforcement wedge is a feature not a moat, already being closed by AWS AgentCore/Okta, pursued by a solo founder with zero core traction. Fail-open, credential-honeypot blast radius, and GDPR-vs-immutable-ledger holes on top. Do not build; extract nothing to sell yet. |
| `modular-platform-plan.md` | (prior pass) | Carried forward — foundational sequencing doc; feeds RLS/module-boundary items below. |
| `agentic-platform-design.md` | (prior pass) | Carried forward — agent-as-principal + OBO (RFC 8693) is M-effort *unbuilt* work, which several other docs assume as existing substrate. |
| `ai-native-core.md` | (prior pass) | Carried forward — source of `withTenantTransaction`/platform-generated RLS; §894 explicitly states **no PII/erasure story** for embedded content, which multiple docs inherit. |
| `agentic-operations.md` | (prior pass) | Carried forward — origin of the single-human-tenant maker-checker break and untrusted-connector injection vector flagged across the corpus. |

---

## 3. Cross-cutting themes (these matter most)

These recur across three or more docs. Fixing them once, in the substrate, retires the same finding in many places. This is where architectural leverage is.

### T1 — Determinism / tamper-evidence ≠ correctness (and ≠ independent verification)
Appears in `agentify-and-policing` (hash-chained ledger sold as "trustworthy verification"), `stack-sufficiency` (audit-the-model-version proves reproducibility, not correctness), `platform-omniscience` (NL→SQL returns wrong-but-authorized data; stale-read RCA), `knowledge-brain` (freshness-by-construction only true for the manifest tier). The corpus repeatedly conflates *"we can prove nothing was tampered / it ran deterministically"* with *"the decision was right."* There is **no ground-truth / environment-grounded eval gate** anywhere for ML outputs, RCA proposals, NL→SQL results, or retrieved knowledge. **Immutability is not correctness; RLS makes wrong data un-leaky, not right.**

### T2 — Single-human SMB tenant breaks maker-checker / separation-of-duties
Appears in `agentic-operations` (origin), `platform-omniscience`, `stack-sufficiency`, `knowledge-brain`, `agentify-and-policing`. The crown-jewel differentiator (maker-checker SoD) **assumes ≥2 humans.** In a one-person tenant the proposer is the approver, so every Tier-4 remediation/export, every ML output routed through `@aegis/approvals`, and every procedural-memory edit becomes an *unchecked autonomous actor with a signature.* Identity-SoD without independence-of-judgment is not a control. Needs an **external checker** (platform-side reviewer, mandatory time-delay-and-notify, or provider attestation) or platform-tier-only autonomy for solo tenants — **not a second seat that does not exist.**

### T3 — Untrusted-data / prompt-injection is a live path to a privileged action, treated as a footnote
Appears in `platform-omniscience` (telemetry→context→remediation proposal), `stack-sufficiency` (connector data→extracts→sidecars; poisoned feedback), `knowledge-brain` (tenant invoice memo→extraction→knowledge_item→future context; poisoned skill body saying "auto-approve under $10k"), `ecosystem-ar-protocol` (injection in company A's data steers a context holding company B's data + routing authority), `agentify-and-policing` (authz-at-tool-call authorizes a correctly-authenticated-but-manipulated action). The dual-LLM / CaMeL privilege-separation pattern is **named as mitigation everywhere and implemented nowhere.** Untrusted text reaches ledgers, SQL tools, and remediation paths ungated. **This is a Phase-0 blocker, not a §10 managed risk.**

### T4 — Tenant isolation depends on a second, weaker, non-RLS plane the docs won't admit
RLS is real and grounded for the **live DB** (`withTenantTransaction`, platform-generated policies in `ai-native-core`). But isolation is quietly re-established — weaker — on every *derived* copy: object-store extracts behind pre-signed URLs (`stack-sufficiency`), the `agent.*` audit ledger (`platform-omniscience`), the hub's commingled multi-company read models with no RLS/PDP/audit (`ecosystem-ar-protocol`), ANN-under-RLS on pgvector HNSW which does not compose like btree (`knowledge-brain`), and RLS-scoped-only-for-operators whose role is cross-tenant by definition (`platform-omniscience`). RLS is asserted as "one plane" but the platform actually has **several isolation planes of uneven strength.**

### T5 — GDPR erasure vs. immutable/append-only ledger + derived copies — unresolved everywhere
Appears in `ai-native-core` (§894: no erasure story), `platform-omniscience`, `stack-sufficiency`, `knowledge-brain`, `agentify-and-policing`. The immutable hash-chained ledger and versioned brain conflict with Art-17 erasure, and the design **multiplies copies of tenant PII outside RLS** (extracts, training corpora, GraphRAG artifacts, forecast aggregates, derived embeddings, Mem0-distilled facts, ledger payloads in cleartext) with **zero lifecycle policy.** Needs a crypto-shredding vs tombstone decision, reconciled with versioning + ledger, propagated to derived embeddings and extracted facts. **This is a legal/DPO call, not an engineering guess** — and a hard blocker for EU sales.

### T6 — Over-claimed market / feasibility / "it already exists"
Appears in `agentify-and-policing` ("niche unoccupied" while conceding AWS AgentCore GA'd; "80% already exists" when the missing 20% is the company; team-of-4 priced against a solo founder), `ecosystem-ar-protocol` ("~80% of wire exists" / 5-6wk renderer floor on the least de-risked, pre-1.0 A2UI→Unity piece), `platform-omniscience` (agent-as-principal+OBO presented as substrate, actually M-effort unbuilt in `agentic-platform-design`), `stack-sufficiency` (over-claimed Splink/statsforecast/fraud-pipeline single-source figures; "4-hop peak" citation embellishment; "operationally boring" understates ONNX model-ops + dual supply chain). The pattern: **specced-not-built is presented as existing, and single-source marketing figures are quoted as neutral fact.**

### T7 — Self-referential / confused-deputy blast radius from over-broad autonomy
`platform-omniscience` auto key-rotation lets a (possibly injection-steered) agent rotate the very credentials enforcing its own read-only-ness and lock humans out. `agentify-and-policing` gateway holds every downstream credential (tier-0 honeypot) and offers fail-open reads (defeats the enforcement product exactly under attack). `ecosystem-ar-protocol` hub is a single-point cross-company token vault with no revocation/kill-switch. The substrate exists to *prevent* confused-deputy footguns; several docs re-introduce them as convenience features.

---

## 4. Unified "fix-before-build" list — all nine docs, ranked by severity × blast-radius

Ranked so that the highest-leverage substrate fixes (retire findings in many docs at once, or gate real damage) come first.

| # | Fix | Doc(s) touched | Theme | Why this rank |
|---|---|---|---|---|
| **1** | **Implement + eval-gate prompt-injection privilege separation (dual-LLM/CaMeL) as a Phase-0 gate.** No remediation autonomy, no ledger/SQL exposure, no cross-tenant hub context, no extraction-into-knowledge until untrusted content is isolated with acceptance criteria. | omniscience, stack, knowledge, ecosystem-ar, operations, agentify | T3 | Live path from untrusted text → privileged action across the entire corpus; blocks the most doors at once. |
| **2** | **Reclassify the audit/agent ledger as the highest-value exfil target, not a free win.** Field-level secret/PII redaction at write-time; separate high-tier scope for raw `agent.*` traces; egress metering on ledger reads; drop "operator sees only permitted tenants" as the control for cross-tenant operators. | omniscience, ai-native-core, agentify | T1, T4, T5 | Richest store in the platform (prompts + tool-call payloads in cleartext), read by the plane most exposed to injection, cross-tenant by operator role. |
| **3** | **Resolve GDPR erasure vs. immutable ledger + all derived copies** (crypto-shred per-subject/tenant key vs tombstone), reconciled with versioning; propagate to derived embeddings, training corpora, extracts, and distilled facts. Legal/DPO sign-off. | ai-native-core, stack, knowledge, omniscience, agentify | T5 | Cross-cutting legal blocker; hard gate for EU; changes schema + ledger contract, so must precede the migrations that assume it. |
| **4** | **Solve single-human-tenant independence** with an external checker (platform-side reviewer / mandatory time-delay + notify / provider attestation) or platform-tier-only autonomy for solo tenants. Carry as a named blocker on all remediation/export/ML-output/procedural-memory autonomy. | operations, omniscience, stack, knowledge, agentify | T2 | Breaks the crown-jewel differentiator for the exact self-serve segment the pricing targets; touches every autonomy path. |
| **5** | **Write real RLS: separate SELECT vs INSERT/UPDATE policies, deny-by-default on unset GUC** (two-arg `current_setting(name, true)` + null guard), platform-tier rows read-only to tenants, and a documented **RLS-aware ANN retrieval path** (partial indexes + the <k / timing-correctness argument). Spike ANN-under-RLS at scale. | knowledge, ai-native-core | T4 | The single commented line carries the platform's safety weight; write-policy reuse can poison the shared platform brain for all tenants. |
| **6** | **Fix credential-boundary claims and self-referential autonomy.** Re-word "read-only by construction / physically cannot mutate" → "read-only by credential, per-source, verified"; add per-connector RO-assertion tests, pinned versions, deny-by-default egress. **Remove auto key-rotation from the unattended set** — suspected-leak rotation is propose-only, human-executed. | omniscience | T4, T7 | False for 5/8 connectors (same class as the CVE the doc cites); auto-rotation is the confused-deputy footgun the substrate exists to prevent. |
| **7** | **Bind step-up factor to transaction content, not a nonce.** Put a canonical transaction digest (amount+counterparty / surfaceHash) *inside* the signed WebAuthn challenge and render it on the phone (the trusted signing device) — or demote AR to display-only for money and confirm Tier-4 on the phone. Make surfaceHash an authorization input, not a ledger field. | ecosystem-ar | T7 | Defeats the doc's central Tier-4 defense against a compromised hub; "what-you-see-is-what-you-sign" is currently forensic-only. |
| **8** | **Govern the object-store extract seam as a first-class artifact.** Extract query via `withTenantTransaction` (never hand-written); per-tenant bucket prefixes; TTL ≤ job SLA; encryption-at-rest with tenant-scoped keys; audit-bind `input_ref → tenant → row-count → hash`. Stop claiming "RLS in one plane" for sidecars. | stack | T4 | The isolation plane the doc won't admit; every sidecar path depends on it. |
| **9** | **Govern the hub aggregation boundary.** Hub-side audit log, provenance-tagged per-company context partitions, per-company revocation + rogue-hub kill-switch, injection threat model for the aggregation prompt. Document the hub as a first-class trust node. | ecosystem-ar | T4, T7 | Ungoverned cross-tenant surface holding all live tokens; contradicts the "no cross-company authority" claim. |
| **10** | **Add environment-grounded eval/correctness gates** (labeled evals) for ML outputs, RCA proposals, NL→SQL exports, and retrieved knowledge, stamped with confidence/version/staleness before entering approvals. Stop selling tamper-evidence as correctness. | agentify, stack, omniscience, knowledge | T1 | Retires the determinism≠correctness theme; without it, "verified" is a false comfort. |
| **11** | **Add sidecar/diagnostic failure-mode design:** SLA/timeout/circuit-breaker, DLQ replay, model-staleness bound + rollback, mandatory fall-back to TS Tier-1 rules; and a **stale-read guardrail** (replica-lag detection + primary cross-check for load-bearing facts before any RCA proposal). | stack, omniscience | T1 | Silent-wrong-output governance failures; RCA on stale replicas during incidents is when it matters most. |
| **12** | **Elevate poisoned-knowledge authz-escalation from written rule to enforced invariant:** retrieved knowledge can NEVER widen authz/tier/autonomy; PDP/entitlement computed by the governed core *before and independent of* any retrieved text; `max_risk_tier` a PEP-enforced ceiling; adversarial evals where a poisoned chunk tries to escalate and the gate holds. | knowledge, agentify | T3, T1 | Attacker-controllable text → context is a real injection pipeline; the CI check validates tool existence, not prose semantics. |
| **13** | **Fix knowledge-brain protocol-vs-reality drift + concurrency:** make Phase-0 (create `STATE.md`, `RESOLVER.md`, `log/`, `.gitattributes`) a hard prerequisite of the mandated read protocol (which currently 404s at step 1), move STATE claims off git last-writer-wins to an advisory-lock/claims table, remove the LLM from control-surface conflict resolution. | knowledge | — | Ships broken today; git is the wrong substrate for the control surface. |
| **14** | **Mark specced-not-built dependencies honestly.** agent-as-principal + OBO (RFC 8693) is M-effort unbuilt — flag the PEP→RLS parity guarantee as a *dependency, not a given* wherever it's assumed. | agentic-platform-design, omniscience | T6 | Prevents building on substrate that does not exist yet. |
| **15** | **Correct over-claims / citations / market framing.** Drop "no sidecar on a latency path" (false; ONNX is inline in-process), apply vendor-bias disclaimer to Splink/statsforecast/fraud figures, drop "4-hop peak," widen renderer estimate to 8-10wk gated on A2UI v1.0, re-test "enforcement niche unoccupied" on a 12-month incumbent clock, align omniscience TL;DR self-growth with §9.2. | stack, ecosystem-ar, agentify, omniscience, knowledge | T6 | Credibility + planning-integrity; cheap to fix, expensive if believed. |
| **16** | **Add go/no-go business gates for the sell-the-substrate products.** No gateway/enforcement build without a paid design-partner LOI from a real CISO **and** the core SaaS proving the primitive in its own prod; prefer in-process OSS library + compliance packs over a tier-0 data-path gateway (no credential custody, no fail-open, no VPC ops). | agentify, ecosystem-ar | T6, T7 | The correct answer is "don't build now"; make that a gate, not a footnote. |

---

## 5. What is safe to build FIRST (smallest slice that ships value)

Build the **read-only, single-tenant, structured-tool spine** — the part that is already grounded and does not depend on any pending hard fix:

1. **TS/Node spine + the four batch-shaped Python sidecars as pure dependencies** (`stack-sufficiency`'s settled language decision needs no further debate).
2. **The Postgres read-replica diagnostic read** (the *one* connector that is genuinely physically read-only) with **structured tools first, NL→SQL behind confirm-before-export** and cost caps — *provided* fix #11's stale-read guardrail is in place before any output is load-bearing.
3. **`withTenantTransaction`-scoped, in-DB, single-tenant reads** — the RLS plane that is real today. No derived copies, no object-store extracts, no cross-tenant operator reads yet.
4. **Maker-checker + hash-chained audit proven on Aegis's own agents in prod** (dogfood), explicitly labeled tamper-evidence-not-correctness — as the *validation* of the primitive, not a product to sell.
5. **`knowledge-brain` Phase-0 scaffolding** (`STATE.md`/`RESOLVER.md`/`log/`/`.gitattributes` + README "current state") so the mandated protocol stops 404-ing — pure repo hygiene, no enforcement code.
6. **Manifest-tier (generated) knowledge only** — the one slice that is genuinely drift-proof; defer curated skills and the graph layer.

This slice ships real diagnostic value on trusted, single-tenant, read-only data with an honest audit trail, and touches **none** of the unresolved isolation/injection/erasure/autonomy planes.

---

## 6. Do NOT build until X (honest blockers)

| Do not build | Until (blocker) | Fix # |
|---|---|---|
| Any remediation autonomy, or exposing ledger/SQL/knowledge tools to untrusted content | dual-LLM/CaMeL injection isolation is implemented **and** eval-gated | 1 |
| Any object-store extract / sidecar-on-derived-data path | the extract seam is governed as a first-class artifact (per-tenant keys, TTL, audit-bind) **and** a data-lifecycle/erasure policy exists | 3, 8 |
| The tenant knowledge brain / RAG enforcement, ANN retrieval | real separate read/write RLS policies + deny-on-unset-GUC + an ANN-under-RLS correctness spike | 5, 12 |
| Any autonomous action in a single-human tenant (remediation, export, ML output, procedural-memory edit) | an external-checker / time-delay independence mechanism exists | 4 |
| Auto credential rotation; any "read-only by construction" claim on the 5 config-only connectors | per-connector RO-assertion tests + deny-by-default egress; rotation demoted to propose-only | 6 |
| The AR / cross-company hub track (Tier-4 money over AR) | step-up is transaction-bound on the phone **and** the hub aggregation boundary is governed (audit, partitions, kill-switch) — and confirmed as founder-dogfood, not v1 | 7, 9, 16 |
| The Agentify / Policing sell-the-substrate products | a paid design-partner LOI from a real CISO **and** the core SaaS has proven the primitive in prod **and** GDPR/Art-12 + credential-custody reviewed by counsel; prefer OSS-library shape over tier-0 gateway | 16, 3 |
| Any store of tenant PII outside RLS (embeddings, training corpora, ledger payloads) | crypto-shred/tombstone erasure decision reconciled with versioning + ledger, DPO sign-off | 3 |
| Anything relying on agent-as-principal + OBO act-chain / PEP→RLS parity | that substrate is actually built (currently M-effort unbuilt) | 14 |
