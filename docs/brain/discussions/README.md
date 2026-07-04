# Discussions — decisions made (with rationale) and open questions

> The decision ledger. A decision is binding once listed here; changing it requires a new audit-log
> entry + updating this file. Open questions block the work listed against them.

## Decisions made

| # | Decision | Rationale | Ref |
|---|---|---|---|
| D1 | The moat is the governance substrate (RLS+authz+audit+approvals), not the business apps | Business apps are commodity vs Ramp/Bill/Gusto; the substrate is what competitors can't retrofit | T1 |
| D2 | Modular, pay-per-module, per-**tenant** install granularity (Frappe/NetSuite model, not Odoo DB-wide) | True multi-tenant fleet; mixing models later is painful | T2 |
| D3 | Entitlement = thin materialization service over **Chargebee** Feature Mgmt; reuse plutus dual-ledger; no Stripe Entitlements/Lago/Orb now | Chargebee migration already in flight at SiteRecon; plutus maps customer=workspace | T2 |
| D4 | Aegis is a **platform**, not a CRM (a CRM could be a module on it) | Category = aPaaS/composable suite | T3 |
| D5 | Core principle: **"the agent reasons; the governed core acts"** — agent is a principal + interface, never a bypass | Only way "do anything by talking" is safe over money/PII | T4 |
| D6 | LLM strictly at the EDGE, enforced in code: never computes tiers/thresholds, never resolves deictic referents into Tier-4 executes, never carries principal/tenant/permission | Red-team: these are the authority-leak vectors | T7 |
| D7 | AI-Native Module Contract = **minimal viable**: Tools + Risk-tier mandatory (money/irreversible ⇒ Tier 4), eval gate for Tier≥2 writes, all other facets opt-in — NOT the 9-facet mandate | Red-team: full mandate manufactures stub facets + cost that scales with modules not value | T7 |
| D8 | Casbin stays for coarse RBAC; **OpenFGA** added when resource/relationship (ReBAC) authz is needed | Casbin breaks on per-object policy explosion; OpenFGA proven at 1M req/s | T4/T5 |
| D9 | Authz at scale + RLS discipline: leading-tenant_id index + subquery-wrapped `current_setting()`; PgBouncer transaction pooling with `SET LOCAL` only | RLS is ~2–5% overhead done right, catastrophic done wrong | T4 |
| D10 | Four gates on every action: **Authorization × Danger × Autonomy × Verifiability**; danger fires even with permission; graduated responses (confirm→typed→step-up→cooling-off→second-approver→alert→block) | Founder ask + red-team; two orthogonal axes, not one | T8 |
| D11 | Verifiability rule: autonomous result trusted only if deterministically re-checkable OR independently verified (proposer ≠ verifier — agent SoD) OR sampled+audited | Trustworthy autonomy is the product | T8 |
| D12 | Autonomous ops: GitOps (Argo selfHeal) + Kyverno admission + KEDA scale-to-zero + AI SRE; "AI proposes, humans decide" for novel/irreversible/cross-tenant | NoOps = augmented ops with a shrinking human surface, not zero | T5 |
| D13 | Default stack: Claude Agent SDK · MCP TS SDK + openapi-mcp-generator · LiteLLM · Cerbos→OpenFGA · Chargebee+OpenMeter · DBOS · Vercel AI SDK+AG-UI · Langfuse+Promptfoo · pgvector(+scale) · ArgoCD+KEDA+CloudNativePG+PgBouncer | Verified adoption catalog incl. license traps | T5 |
| D14 | YC framing (if applied): lead **SaaS Challengers**; wedge = agent-run AP/expense approvals + SoD + audit for field-services SMBs; do NOT apply without a design partner/traction | Adversarial YC-partner red-team | T6 |
| D15 | Self-sustainability is a hard requirement: new modules/functionality auto-appear in all AI flows (tool registry, capability manifest, brain) via generation + CI drift gates — zero manual AI setup | Founder directive | T9 |
| D16 | Dev knowledge lives in the repo **brain** (`docs/brain/`): targeted docs first, audit log fallback; every session appends | Zero re-explanation for any new/parallel agent | T9 |
| D17 | Research-first + no-implementation-yet: dense, gap-free docs are the current deliverable | Founder directive | T9 |
| D18 | **Safe build sequence adopted** (from `red-team-consolidated.md`): build FIRST = read-only, single-tenant, structured-tool spine + Postgres read-replica diagnostic (NL→SQL behind confirm-before-export) + dogfood maker-checker/hash-audit on our OWN agents + brain Phase-0 scaffolding + manifest-tier generated knowledge only. Everything else gated by the 16-item fix list + 9-row do-not-build-until table. | 9 red-teams converged; ships value on trusted data touching none of the unresolved planes | T13 |
| D19 | **Write-autonomy on money/external/irreversible is GATED** until, in code: (1) dual-LLM/CaMeL prompt-injection isolation (eval-gated); (2) the hardened AND Trust Rule (determinism≠correctness; provably-independent verifier); (3) single-human-tenant independence (external checker / time-delay+notify); (4) GDPR-erasure-vs-immutable-ledger (crypto-shred) across all derived copies; (5) real separate read/write RLS on every derived plane. | The operations + consolidated red-teams: "C on trust-it-with-money-unattended" until these land | T12/T13 |
| D20 | **Sell-the-substrate products (Agentify/Policing) + the AR/cross-company hub are GO/NO-GO gated**, not roadmap: no build without a paid design-partner LOI from a real CISO AND the core SaaS proving the primitive in its own prod; prefer an in-process OSS library + compliance packs over a tier-0 credential-custody gateway. | Crowded/consolidating market; confused-deputy risk of a credential-vault gateway; focus tension with core | T13 |

## Open questions (need the founder)

| # | Question | Blocks | Since |
|---|---|---|---|
| O1 | Ecosystem scope: first-party only / + curated partners / open marketplace? | SDK, sandbox, rev-share sizing (NEXT phase) | T3 |
| O2 | Primary goal now: dogfood at SiteRecon vs sell externally (finance/AP) vs both? | GTM, first module choice | T3 |
| O3 | AI-agent governance module: design now or research spike? | roadmap ordering | T3 |
| O4 | ~~When do we flip to BUILD?~~ **The safe first slice is now defined (D18); remaining decision = when to start it, and who builds.** | everything downstream | T7→T13 |
| O5 | YC: apply next batch or after first design partner? | application timing | T6 |
| O6 | Kernel-free tier boundary (is identity/audit-view free?) + pricing floor | pricing/packaging | T2/T5 |
| O7 | Co-founder / finance-domain expert plan (YC red-team's #1 hesitation) | fundraising credibility | T6 |
| O8 | AR ecosystem + agentify/policing products: research-only for now, or roadmap items with owners? | portfolio focus (platform-vs-products tension) | T9 |
