# Aegis × YC Summer 2026 RFS — Fit Analysis & Positioning

> Which YC Request-for-Startups category does Aegis fall into, what can it credibly support, and how a
> YC partner actually reacts. Based on an adversarial pass: each candidate category was steelmanned
> *and* stress-tested, scores were deliberately kept honest (a horizontal platform can look like it
> "fits everything"), then the whole positioning was red-teamed as if reviewing a YC application.
>
> **Source:** YC RFS Summer 2026 (16 ideas), fetched 2026-07-01.

---

## Bottom line (read this first)

1. **Aegis does not "fit" any single RFS category cleanly — it scores 2–3/5 across a cluster of ~7
   software ideas.** Its crown-jewel strength (governance: RLS + Casbin + audit + approvals) is
   *orthogonal* to what most of those categories actually grade on.
2. **If you apply, lead with ONE: `SaaS Challengers`** (the AI-native replacement for an ERP's
   controls/approvals/audit stack). It's the only category where your live assets *are* the thing YC
   names, and where the horizontal-platform smell can be amputated into one budget line.
3. **The multi-category story is real but must be *sequenced*, not spread:** the wedge is #12; #13
   (Software for Agents) is the moat; #14 (Sell to Huge Companies) is the TAM; #3/#5/#16/#7 are the
   expansion. "You built one thing that shows up in seven RFS windows" — not seven things.
4. **The red-team verdict is blunt and correct: not yet fundable as framed** — no customer, no revenue,
   no co-founder, and the agent-does-the-work layer is designed, not shipped. The *depth of this very
   analysis* signals the risk (over-building/over-thinking vs. selling). **The one change that beats
   every positioning tweak: put one real company's money through the governed core with the agent in
   the loop, and lead with that.**

---

## The 16 RFS ideas, triaged

**Out of scope (no Aegis assets — do not chase):** AI for Low-Pesticide Agriculture · AI-Native
Discovery Engines (science) · AI Personalized Medicine · Counter-Swarm Defense · Electronics in Space ·
Industrial Capabilities in Space · Hardware Supply Chain · Supply Chain 2.0 for Semiconductors ·
Inference Chips for Agent Workflows. (Hardware/bio/defense/space — zero fit.)

**In scope (the candidate cluster), scored honestly:**

| Rank | RFS category | Fit | Role in the story | Why this score |
|---|---|:---:|---|---|
| 1 | **SaaS Challengers** | **3/5** | **The lead / wedge** | Live expense/invoice/payroll + approvals + audit *are* the ERP-controls surface that makes NetSuite/SAP sticky and hated. Named incumbent, real budget line, "AI-native" is credible. Only category where best assets = scoring axis. |
| 2 | **Software for Agents** | **3/5** | **The moat / why-now** | Auto-generated, authz-bound, audited tool registry from the live route stack is genuinely novel — "software for agents" turned inward. But zero external adopters today. |
| 3 | **Startups That Sell to Huge Companies** | **3/5** | **The TAM / expansion** | RLS/audit/approvals pass an F100 security review out of the box; solo+AI *is* the "small team ships nuanced product fast" thesis. But no logo, no pipeline, and "no-sales/no-humans" contradicts how whales close. |
| 4 | **AI-Native Service Companies** | **2/5** | **Pivot option** | Great *back end* for an AI service firm — but YC wants you to *be* the firm and capture services revenue, not sell picks-and-shovels. |
| 5 | **Company Brain** | **2/5** | **Adjacent (reliability half)** | "Executable skill files → reliable agent automation" = you own the reliable-*execution* half; the knowledge-*ingestion* half is unbuilt. |
| 6 | **The AI Operating System for Companies** | **2/5** | **Adjacent (action half)** | This RFS is a *read/context* play (ingest Slack/Linear/GitHub, make the company queryable). Aegis is a *write/governed-action* play. You're the safe-action tier a context-OS eventually needs — not the context-OS. |
| 7 | **Dynamic Software Interfaces** | **2/5** | **Roadmap flourish** | Governed generative UI is a real angle, but designed, not shipped. |

> The instinct to claim #16 ("AI OS for companies") because it matches our tagline is a trap: the RFS
> rewards *context ingestion breadth*, which we don't have. Our governance depth scores a 2 there. This
> is exactly the over-claim the adversarial pass caught.

---

## The lead: SaaS Challengers

**One-sentence pitch:**
> *"Aegis is the AI-native alternative to NetSuite's controls-and-approvals stack: mid-market finance
> teams get audited, SoD-governed expense/invoice/payroll workflows that an agent runs end-to-end and
> that go live in days — not a six-figure, six-month implementation."*

**Why this and not the grander framings:** YC applications reward focus, and "fits every RFS" is the
pattern they distrust most — our own fit matrix shows the platform framing dragged 5/7 categories to a
2. Don't abandon the platform thesis; **sequence** it. Lead with the wedge as *proof*; reveal the
platform as *where the wedge inevitably goes*.

## The unifying narrative (for the application)

> Every company is racing to put agents in front of operations and hits the same wall: **an LLM cannot
> be allowed to touch money or PII unsupervised.** The industry's answer is a human-in-the-loop for
> everything — which throws away the economic point of agents. Aegis removes the wall with one
> architectural choice: **the agent reasons; the governed core acts.** The agent is a new principal,
> never a bypass — every state change it proposes executes as the same deterministic, permission-guarded,
> tenant-isolated, tamper-evident-audited operation a human API call hits. That's why an Aegis agent can
> safely run an expense approval, post an invoice, or execute payroll when every other "AI for finance"
> demo has to gate behind a human because it can't *prove* what the agent did or *stop* it doing wrong.
>
> This makes Aegis three things that reinforce each other: (1) an **AI-native SaaS challenger** to the
> ERP controls stack; (2) **software for agents** — the self-describing, authz-bound tool layer any
> agent needs to act over sensitive systems; (3) the **substrate for AI-native businesses** that put
> agents in charge of regulated work. We start at (1) — named incumbent, legible budget line, revenue
> now. (2) and (3) are where the wedge goes, and why it's defensible.

## The wedge (one thing, for whom, first)

- **Customer:** mid-market, multi-location **field-services / construction SMBs** (SiteRecon's world —
  real distribution + domain proximity). On QuickBooks + spreadsheets + email approvals; real SoD pain;
  too small for NetSuite, too complex for pure QuickBooks.
- **Module:** **agent-run AP + expense approvals with SoD and a tamper-evident audit trail** — not the
  platform, this one workflow. QuickBooks connector day one (QBO tools already wired), then the
  controls/approval/audit system-of-record migrates onto Aegis.
- **Metric YC probes hardest:** *submitted → SoD-approved-and-posted with zero controller keystrokes on
  the clean path; the human-in-the-loop exception rate drops from X% → Y% over the first N engagements;
  every action on an exportable audit ledger; live in days.* The **improving HITL ratio** is the
  unit-economics story — make it the headline.

**Why it proves the whole thesis:** one demo is simultaneously (a) the SaaS-challenger displacement,
(b) live proof the governed tool layer lets an agent safely touch money (Software for Agents), and (c)
the workflow an enterprise security review scrutinizes (Sell to Huge Companies).

## What to build / demo (priority order)

1. **Flagship money-workflow demo (non-negotiable):** submit an expense/invoice by chat or voice → agent
   routes through SoD approval → posts to QuickBooks → every action on the hash-chained ledger with
   one-click export. Lead with this, never an architecture tour.
2. **Quantified cost/time-to-value:** "NetSuite = $X/yr + $Y implementation over N months; Aegis =
   self-serve agentic onboarding, live in days, $Z." The RFS literally tests "dramatically lower cost."
3. **Wrap-then-replace migration, shown live:** QuickBooks day one; controls/workflow/audit progressively
   migrate onto Aegis — neutralizes "you ride on incumbents, you don't replace them."
4. **One paying design-partner logo** from field-services doing real money workflows, with revenue
   reported. This outweighs everything else here.
5. **Audit-ledger-as-eval-primitive:** score the agent's tool-use against the ledger — "did the agent
   stay in-policy?" Reframes governance as *reliability*, not compliance. Highest-leverage build for the
   Software-for-Agents pillar.
6. *(stretch)* one external agent calling a governed Aegis MCP tool end-to-end, no human — moves Software
   for Agents 3→4. Only after the core demo is solid.
7. **Enterprise-procurement kit** (pre-filled SIG/CAIQ, SOC2 control→primitive map, DPA, live ledger
   export). Cheap from what exists; converts compliance-by-design into a sales accelerant. **Do not lead
   with "no humans / AI SRE"** — have a CISO-survivable accountability answer.

**Explicitly do NOT build for the application:** the Slack/Linear/GitHub context-ingestion layer (#16/#5)
or the morphing generative-UI (#7). They chase 2-fit categories and reintroduce the horizontal smell.
Name them as roadmap; build none now.

---

## Red-team: how a YC partner actually reacts

**Verdict: not yet fundable as framed** — a sophisticated positioning essay around a pre-traction,
solo-built platform with no customers, no revenue, no co-founder, and an unshipped core capability (the
agent doing the work). The strategy is above average and the architectural insight is real, but **YC
funds evidence of pull, not eloquence.** The depth of this analysis itself signals the core risk: *this
founder over-builds and over-thinks instead of selling.*

**The one change worth more than any repositioning:** stop writing positioning; get one field-services
customer to run real expense/AP approvals through Aegis with the agent in the loop; then lead with that
customer, that dollar, and the measured HITL ratio — replacing the entire 7-category matrix with a
single sentence of traction.

**Over-claims to stop making:**
- "Live finance workflows" means *coded*, not *in production with a paying user*. Payroll/invoice
  execution over real money is not something a solo-built 46k-LOC substrate has done in production.
- "Agent runs it end-to-end / zero keystrokes" is the pitch, but the agent layer is *designed, not
  shipped* — the single most important thing is currently vaporware.
- The self-scored 3/3/3 matrix is the founder grading against a self-inferred rubric; a partner discounts
  it to ~zero.
- "Governance-as-architecture is the moat" — real but narrow; Ramp/Bill/Brex/NetSuite already have
  approvals/SoD/audit, and tool registries are commoditizing.
- Solo-founder-as-strength is rhetorical sleight of hand for enterprise vendor-viability review.

**The hardest questions to prepare for:**
- *Show me one customer whose real money moved through Aegis, and one dollar of revenue.* (If none, the
  46k LOC is a liability — time spent building before validating — not an asset.)
- *Who's your co-founder / finance-domain expert?* Solo technical founder selling controls to CPAs in a
  domain you don't come from — YC's #1 hesitation.
- *If Ramp/Bill/Brex ship "an AI agent that files expenses with approvals + audit" next quarter — with
  distribution, money movement, and millions of users — what stops them?*
- *Is this AI-native or a deterministic backend with an LLM stapled on?*
- *How do you close a finance buyer — let alone an enterprise security review — with "no humans"?*
- *Is the SiteRecon "distribution" real (commercial rights, warm channel, validated demand) or just an
  adjacent company you can access?*

**What this analysis is missing (address before applying):**
- **Real competitive teardown of the *actual* wedge incumbents** — Ramp, Bill.com, Brex, Airbase,
  Tipalti (NOT NetSuite/SAP) own mid-market AP/expense/approvals, already have audit trails, and are
  shipping AI agents now. The wedge is more crowded than the framing admits.
- **Pricing & unit economics** — what a customer pays, CAC under a no-sales motion, path to venture-scale
  ARR; the HITL-ratio metric has no baseline/target.
- **Evidence of demand** — not one interview, LOI, or waitlist; the field-services SoD pain is asserted,
  not validated.
- **Liability/regulatory reality** — who is liable when the agent mis-pays or mis-classifies payroll?
  This is *the* reason "AI for finance" keeps a human in the loop; it's a legal/insurance/trust problem,
  not just a governance-tech one.
- **Migration/switching friction** — moving controls + audit system-of-record is high-fear; "replace" is
  where challengers die.
- **Market sizing** — mid-market field-services AP-with-SoD may be a $10–30M ARR tool, not a
  multi-billion company; the "platform" answer to TAM is exactly the horizontal smell YC just flagged.

**Strongest angle:** the architectural one-liner — *"the agent reasons, the governed core acts; the
agent is a new principal, never a bypass"* — reframed as **reliability/eval infrastructure** (governance
makes agent actions provable and reversible), backed by actually-built primitives. Most "AI for finance"
demos genuinely cannot replicate this because they bolted the agent on afterward. The
**audit-ledger-as-eval-primitive** is the sharpest under-exploited asset.

**Weakest angle:** "Sell to Huge Companies" — cut it from an application entirely. Graded on the closed
whale deal; you have no logo, no pipeline, an anti-sales principle, solo-founder vendor-viability risk,
and an "AI SRE/no humans" support answer a CISO rejects. Presenting it as a scored strength undermines
the categories that are real.

---

*Analysis produced by an adversarial workflow (7 per-category fit assessments → synthesis → YC-partner
red-team). Fit scores are honest self-assessments against inferred YC rubrics — treat as directional,
not external validation. The real validation YC wants is one customer's money safely moving through the
governed core.*
