# Agentify Existing Companies + AI Policing as Products

**Status:** Strategy + implementation-ready design. Research conducted 2026-07-02 (web sources cited inline).
**Reads with:** `docs/strategy/agentic-platform-design.md` (master design), `docs/strategy/ai-native-core.md` (§0.5 Minimal Viable Contract, §8 red-team).
**One-line thesis:** Everything Aegis built for itself — the auto-generated authz-bound tool registry, the capability manifest, the governed orchestrator, and the four-gate enforcement substrate (AUTHORIZATION × DANGER × AUTONOMY × VERIFIABILITY) — is sellable twice: once as **AGENTIFY** (make *their* legacy system agentic) and once as **AI POLICING** (enforce *their* rules on agents they already have). The two share ~80% of code and one wedge: **enforcement with maker-checker approvals and a tamper-evident ledger, at the tool-call, in the data path — not observability dashboards.**

---

## 0. Executive summary

1. **The market timing is unusually good and the window is short.** 88% of enterprises deploying agents reported confirmed or suspected agent security incidents in the last year ([VentureBeat survey](https://venturebeat.com/security/most-enterprises-cant-stop-stage-three-ai-agent-threats-venturebeat-survey-finds)); only 14.4% of deployed agents went live with full security approval; only 5% of CISOs feel confident they could contain a compromised agent (Saviynt 2026 CISO AI Risk Report, n=235, per same source). Gartner predicts 40% of enterprise apps will embed task-specific agents by end of 2026 ([Gartner PR](https://www.gartner.com/en/newsroom/press-releases/2025-08-26-gartner-predicts-40-percent-of-enterprise-apps-will-feature-task-specific-ai-agents-by-2026-up-from-less-than-5-percent-in-2025)) and that by 2027 **40% of enterprises will demote or decommission autonomous agents due to governance gaps found only after production incidents** ([Gartner, May 2026](https://www.gartner.com/en/newsroom/press-releases/2026-05-26-gartner-says-applying-uniform-governance-across-ai-agents-will-lead-to-enterprise-ai-agent-failure)). EU AI Act Article 12 (tamper-evident, hash-chained logs for high-risk systems) becomes enforceable **August 2, 2026** — next month ([Asqav](https://www.asqav.com/blog/posts/eu-ai-act-audit-trail-requirements), [CertifiedData](https://certifieddata.io/eu-ai-act/article-12-record-keeping)).
2. **The governance/security market is crowded but almost everyone is observability-first or content-firewall-first.** Zenity ($59.5M raised) leads posture+detection; Prompt Security sold to SentinelOne (~$250M) and CalypsoAI to F5 for prompt/response firewalls; Credo AI and Holistic AI are compliance-workflow platforms. Almost nobody ships **transactional enforcement**: maker-checker approvals bound to the tool call, permissions-at-time-of-action snapshots, and a cryptographically verifiable ledger. That is our wedge and it is genuinely differentiated today.
3. **The "agentify legacy" market is being framed by giants as an integration problem** (MuleSoft MCP servers, UiPath Maestro, Copilot Studio's 1,400 connectors) **and by OpenAPI→MCP tooling as a codegen problem** (Speakeasy Gram, Stainless, AutoMCP). Nobody packages the *whole* path — discovery → governed tool registry → risk-tiered orchestrator in your VPC — as a product for non-Salesforce/non-Microsoft shops. That's Agentify.
4. **Sell POLICING first, AGENTIFY second.** Policing is a standalone, low-services product with a compliance deadline tailwind; Agentify is higher-ACV but services-heavy and competes with SIs. Policing deployments create Agentify pipeline (once you police their agents, you know their systems well enough to agentify more of them).
5. **~80% of both products already exists in Aegis** (audit ledger, @aegis/approvals, Casbin PEP/PDP/PAP, entitlement, LLM gateway budgets, tool-registry generator, manifest). The productization work is extraction into a deployable gateway + tenant-neutral packaging, not new invention.

---

## 1. Research part A — who already "agentifies" legacy systems

### 1.1 Platform giants (the integration framing)

**MuleSoft / Salesforce Agentforce.** MuleSoft now positions its entire connector catalog (hundreds of connectors to SaaS/legacy/DBs) as "agent-ready tools": any API implemented as a Mule app can be exposed to agents as a governed MCP tool via the MCP Connector, and an **A2A Bridge** (July 2026) coordinates agents across Agentforce and Copilot Studio ([MuleSoft Agentforce](https://www.mulesoft.com/platform/agentforce), [MCP servers blog](https://blogs.mulesoft.com/news/connect-agentforce-to-any-system-with-mulesoft-mcp-servers/), [agentic innovations blog](https://blogs.mulesoft.com/news/new-mulesoft-innovations-for-speed-governance-scale/), [Salesforce architect guide](https://architect.salesforce.com/docs/architect/fundamentals/guide/mulesoft-architecting-agentic-enterprise)). **Read:** the "agent fabric" framing is exactly our Agentify pitch, but it presumes you buy the Salesforce estate. Their governance is API-management governance (rate limits, catalogs), not maker-checker/danger-tiering at the action level.

**UiPath.** Repositioned from RPA to "agentic automation"; **UiPath Maestro** is a vendor-agnostic control plane orchestrating UiPath agents alongside Claude/OpenAI/Gemini/Copilot agents, robots, APIs and people under one governance/audit/observability layer, with BPMN 2.0 modeling ([Maestro](https://www.uipath.com/platform/agentic-automation/agentic-orchestration), [platform](https://www.uipath.com/platform/agentic-automation), [analysis](https://aigovmap.com/uipath-report.html)). Their unique asset: RPA "body" for legacy systems with **no APIs at all** (UI automation). **Read:** strongest incumbent for deep-legacy (green-screen/thick-client) agentification. We should not compete there; our sweet spot is companies that *have* APIs/OpenAPI/DB schemas but no agent layer.

**Microsoft Copilot Studio.** 1,400+ connectors, MCP support, agent flows, and Computer-Using Agents (CUA) for GUI-only legacy systems. Pricing is public and cheap: $200/month per tenant for 25,000 messages, pay-as-you-go Copilot Credits via Azure, and included entitlements with M365 Copilot ([pricing](https://www.microsoft.com/en-us/microsoft-365-copilot/pricing/copilot-studio), [licensing](https://learn.microsoft.com/en-us/microsoft-copilot-studio/billing-licensing), [SamExpert guide](https://samexpert.com/copilot-studio-licensing-guide/)). **Read:** commoditizes the "chat over your connectors" layer inside the Microsoft estate. It does *not* give an enterprise a governed agent layer over their own bespoke product/APIs with their own IdP roles — that's our gap.

**Sierra & Decagon (the deployment/pricing benchmark, not competitors).** Sierra ("Agent OS", $150M ARR by Feb 2026, 40%+ of Fortune 50) sells **outcome-based pricing** — pay per resolved conversation; third-party estimates put contracts at $150K+/yr with $50–200K setup and year-one budgets of $200–350K+ ([Sierra outcome-based pricing](https://sierra.ai/blog/outcome-based-pricing-for-ai-agents), [Lorikeet pricing analysis](https://www.lorikeetcx.ai/articles/sierra-ai-pricing-alternatives), [Quiq](https://quiq.com/blog/sierra-ai-pricing/)). Decagon: per-conversation or per-resolution, contracts $95K–$590K/yr, median ~$400K ([Cresta buyer guide](https://cresta.com/guides/decagon-vs-sierra), [eesel](https://www.eesel.ai/blog/decagon-vs-sierra)). Both use a dual-surface model: engineer SDK + operator studio. **Read:** (a) enterprises will pay $200–500K/yr for a *working* agent on top of their systems; (b) the SDK+Studio split and outcome-based pricing are patterns to copy; (c) they are single-vertical (CX) — Agentify is the horizontal version.

**System integrators.** Accenture's gen/agentic AI revenue hit $2.7B (bookings $5.9B) in the year to Aug 31 2025, with $3B tech + $1B talent investment; joint offerings with ServiceNow automate migration off legacy platforms; Deloitte is investing $4B in AI services ([CIO Dive](https://www.ciodive.com/news/accenture-generative-ai-revenue-skills-training-data-modernization/761161/), [Accenture/ServiceNow](https://newsroom.accenture.com/news/2026/servicenow-and-accenture-launch-ai-powered-services-to-accelerate-the-shift-from-legacy-risk-platforms-to-agentic-ai), [eMarketer](https://www.emarketer.com/content/accenture--deloitte-push-agentic-ai-enterprise-territory-shift)). **Read:** the demand for "agentify us" is provably enormous and currently absorbed by services. Product-shaped Agentify wins on cost and repeatability; alternatively, SIs are a **channel** (they need exactly our substrate to deliver).

### 1.2 The enabler layer: OpenAPI → MCP tooling

- **Speakeasy Gram** — evolved from hosted OpenAPI→MCP into an open-source (AGPL-3.0) "AI control plane": connect agents to APIs with access controls, prompt/response inspection, IdP-synced permissions, usage/budget tracking. 251 stars, hosted platform is the commercial product ([repo](https://github.com/speakeasy-api/gram), [launch blog](https://www.speakeasy.com/blog/release-gram-beta), [OpenAPI→MCP](https://www.speakeasy.com/blog/generate-mcp-from-openapi)). **Closest single company to the Agentify concept.**
- **Stainless** — free MCP-server generation from OpenAPI alongside SDKs; notable architecture insight: instead of one-tool-per-endpoint they ship **two tools (code-execution + docs-search)**, which is more token-efficient and accurate at large API surface ([blog](https://www.stainless.com/blog/generate-mcp-servers-from-openapi-specs/), [docs](https://www.stainless.com/docs/mcp/), [lessons](https://www.stainless.com/blog/lessons-from-openapi-to-mcp-server-conversion/)). This matches our C.3 "too many tools" finding — adopt it.
- **AutoMCP** — academic compiler (OpenAPI 2/3 → deployable MCP server; resolves $refs, generates schemas, auth middleware) ([arXiv 2507.16044](https://arxiv.org/html/2507.16044v2)); OSS equivalents like [harsha-iiiv/openapi-mcp-generator](https://github.com/harsha-iiiv/openapi-mcp-generator).
- **Composio** — 900+ apps / 3,000+ tools as managed integrations + MCP gateway; pricing public: free 20K tool calls/mo, $29/mo (200K), $229/mo (2M), enterprise adds VPC/on-prem, HITL review policies, audit trails; $25M Series A (Lightspeed, Jul 2025) ([pricing](https://composio.dev/pricing), [enterprise](https://composio.dev/enterprise)). **Read:** third-party SaaS tools are commoditized at fractions of a cent per call. Agentify's value must be in *their proprietary systems* + governance, never in Gmail/Slack connectors.

**Conclusion A:** codegen from OpenAPI is table stakes and free. Nobody sells the *governed* end-to-end: discovery → manifest → authz-bound tools mapped to the customer's IdP → risk-tiered orchestrator → audit. That composite is Agentify.

### 1.3 What none of them have (our Agentify differentiators)

1. **Authz-binding at generation time** — our registry derives tools from live routes *with* their Joi schemas *and* Permission annotations; ports directly to binding generated tools to the customer's IdP roles/claims. Gram syncs IdP permissions but doesn't do per-action risk tiers or approvals.
2. **Permissions-at-time-of-action audit** + hash-chained ledger (EU AI Act Art 12-shaped) — absent everywhere in this cohort.
3. **Maker-checker / SoD on agent actions** (@aegis/approvals) — HumanLayer is the only pure-play HITL API (YC-backed, free→$500/mo; @require_approval decorator, Slack/email approvals, multi-approver, escalation) ([humanlayer](https://humanlayer.systems/index-en), [PyPI](https://pypi.org/project/humanlayer/)) — validation that the primitive is wanted, but it's a bolt-on without authz/audit integration.
4. **Self-knowledge brain** — pgvector RAG over their docs/schemas so the agent explains *their* system; the "understands your system the way it understands ours" promise.

---

## 2. Research part B — the agent governance/security market

### 2.1 Vendor-by-vendor

| Vendor | What they actually do | Enforcement at tool-call? | Pricing (public?) | Notes |
|---|---|---|---|---|
| **Zenity** | Discovery/inventory of agents across SaaS+cloud+endpoint, posture management (block risky configs pre-runtime), AIDR detection & response; recently added runtime blocking ("enforcing deterministic, policy-based security that blocks unsafe actions") incl. OpenAI AgentKit runtime protection | Partial — posture + detect/respond first; runtime blocking is newer, focused on prompt-injection/data-leak classes, not business-rule authz | No (custom enterprise, demo-gated) | $59.5M raised, $38M Series B (Intel Capital et al.); public-sector via Carahsoft. The category leader in *visibility*. ([zenity.io/platform](https://zenity.io/platform), [Series B](https://www.intelcapital.com/zenity-raises-38m-series-b-funding-round-to-secure-ai-and-low-code-apps/), [AgentKit runtime](https://zenity.io/company-overview/newsroom/company-news/zenity-launches-runtime-protection-for-ai-agents-built-with-openai-agentkit), [WorkOS teardown](https://workos.com/blog/zenity-vs-workos-agentic-security)) |
| **Lasso Security** | Red-teaming + runtime enforcement ("continuously validating agents operate within intended scope"); ships an **open-source MCP gateway** with server reputation scanning | Yes (content/scope guardrails), but LLM-guardrail-shaped, not permission-model-shaped | No | ([lasso.security](https://www.lasso.security/), [agentic platform](https://www.lasso.security/resources/agentic-ai-security-platform), [Portkey integration](https://portkey.ai/docs/integrations/guardrails/lasso)) |
| **Prompt Security** | GenAI/prompt firewall, data-leak prevention, agent protection — **acquired by SentinelOne, ~$250M** (cash+stock; reports $250–300M) | Inline on prompts/responses, not on business actions | No | Signals: endpoint-security majors are buying their way in. ([SentinelOne PR](https://investors.sentinelone.com/press-releases/news-details/2025/SentinelOne-to-Acquire-Prompt-Security-to-Advance-GenAI-Security-and-Agent-Security-Strategy/default.aspx), [Calcalist](https://www.calcalistech.com/ctechnews/article/te0d99mpu)) |
| **CalypsoAI** | Adversarial testing at scale + real-time inline shield blocking prompt injection/exfiltration — **acquired by F5**, now "F5 AI Guardrails" | Inline on model traffic (data path), not authz | No | ([F5 blog](https://www.f5.com/company/blog/securing-ai-models-and-agents-without-compromise), [Network World](https://www.networkworld.com/article/4055857/f5-to-acquire-calypsoai-for-advanced-ai-security-capabilities.html)) |
| **Knostic** | "Need-to-know" knowledge-layer access control for Copilot/Glean/Gemini — governs what AI *answers*, not what agents *do*; RSAC 2025 Innovation Sandbox | Yes for knowledge access; no for actions | No | Complementary, not competitive. ([knostic.ai](https://www.knostic.ai/), [NSFOCUS analysis](https://nsfocusglobal.com/rsac-2025-innovation-sandbox-knostic-reshaping-the-access-control-paradigm-for-enterprise-ai-security/)) |
| **Credo AI** | AI governance-of-record: register/assess/govern/monitor/report across regulatory frameworks | **No** — workflows and evidence, explicitly needs complementary runtime tooling | No | ([credo.ai/product](https://www.credo.ai/product), [WitnessAI comparison](https://witness.ai/blog/best-ai-compliance-tools-for-businesses/)) |
| **Holistic AI** | Similar compliance/assurance platform (EU AI Act readiness, bias audits, inventory) | No | No | Governance-workflow tier, same read as Credo. |
| **MCP gateways (OSS)** | MetaMCP (MIT, ~950★): aggregator/middleware/gateway w/ API-key & OIDC auth; Bifrost (Apache-2.0, 6.2k★): LLM+MCP gateway, RBAC on tools, budgets, virtual keys, claims 50x LiteLLM perf; Lunar MCPX (MIT core + enterprise tier); Obot (self-host K8s control plane, RBAC, IdP, catalog); IBM ContextForge (MIT); Docker MCP Gateway; Lasso gateway | RBAC/allowlist-level yes; **no approvals, no danger tiers, no tamper-evident audit, no permissions-at-time-of-action** | Free (OSS) + enterprise tiers | ([MetaMCP](https://github.com/metatool-ai/metamcp), [Bifrost](https://github.com/maximhq/bifrost), [MCPX](https://www.lunar.dev/post/the-best-open-source-mcp-gateways-in-2026), [Obot](https://obot.ai/blog/the-13-best-mcp-gateways-for-enterprise-teams/), [awesome-mcp-gateways](https://github.com/e2b-dev/awesome-mcp-gateways), [Zuplo comparison](https://zuplo.com/blog/mcp-gateway-comparison)) |
| **AWS Bedrock AgentCore** | Gateway (MCP targets) + Identity (OBO token exchange, short-lived scoped creds, free with Gateway/Runtime) + **Policy (GA Mar 2026): natural-language → Cedar policies evaluated at the Gateway per tool call**, Lambda interceptors for custom authz | **Yes — the most direct competitor to Policing**, but AWS-only, Cedar-only, no maker-checker approvals, no hash-chained ledger, no cross-cloud | Public: 12 billable components; Runtime $0.0895/vCPU-hr + $0.00945/GB-hr; Policy bills per 1M tokens for NL→Cedar conversion | ([AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/), [Policy GA](https://aws.amazon.com/about-aws/whats-new/2026/03/policy-amazon-bedrock-agentcore-generally-available/), [interceptors](https://aws.amazon.com/blogs/machine-learning/apply-fine-grained-access-control-with-bedrock-agentcore-gateway-interceptors/), [OBO identity](https://aws.amazon.com/blogs/machine-learning/connecting-mcp-servers-to-amazon-bedrock-agentcore-gateway-using-authorization-code-flow/)) |
| **Okta/Auth0, WorkOS** | Auth for GenAI: Token Vault (OAuth for agents to SaaS), async authorization (CIBA-style long-running approval), fine-grained authz for RAG; **Cross App Access (XAA)** protocol for agent→app delegation. WorkOS: AuthKit + agent-identity positioning (content marketing hard against Zenity/Okta) | Identity/credential layer only — *who the agent is*, not *whether this action is allowed by business policy* | Auth0 usage-based public | We should *integrate*, not compete: accept their tokens as PIP input. ([Okta PR](https://www.okta.com/newsroom/press-releases/auth0-platform-innovation/), [XAA](https://www.okta.com/blog/ai/okta-helps-secure-ai-agent-identity/), [WorkOS](https://workos.com/blog/okta-vs-workos-agent-identity-enterprise-authentication)) |

### 2.2 Standards to build against (checklist compliance = sales asset)

- **OWASP Agentic Security Initiative**: 5-document suite — threat taxonomy (agent design/memory/planning/tool use/ops), MAESTRO architectural threat modeling, developer+operator controls, **Agentic Top 10 (ASI01–ASI10)**, governance/regulatory mapping ([OWASP ASI](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/), [Top 10 PR](https://www.prnewswire.com/news-releases/owasp-genai-security-project-releases-top-10-risks-and-mitigations-for-agentic-ai-security-302637364.html)). Ship a "coverage matrix: which ASI risks the gateway mitigates."
- **NIST**: AI RMF (Govern/Map/Measure/Manage); CSA published an **Agentic profile of the AI RMF** ([CSA lab](https://labs.cloudsecurityalliance.org/agentic/agentic-nist-ai-rmf-profile-v1/)); NIST CAISI launched an **AI Agent Standards Initiative (Feb 2026)** covering identity+authorization, security, monitoring/logging, with an Interoperability Profile due Q4 2026 ([nhimg.org](https://nhimg.org/nhi-news/nist-iso-ai-agent-identity-governance-frameworks)). Track the Q4 profile; be first to certify against it.
- **EU AI Act Article 12**: automatic, tamper-evident logging; hash chaining (SHA-256 minimum) is the cited technical standard; retention ≥6 months; high-risk enforceable **Aug 2, 2026** ([Asqav](https://www.asqav.com/blog/posts/eu-ai-act-audit-trail-requirements), [CertifiedData](https://certifieddata.io/eu-ai-act/article-12-record-keeping), [Salt Security](https://salt.security/eu-ai-act-compliance)). Our hash-chained ledger is *literally the mandated artifact*. Even LangChain has an open feature request for Art-12 structured audit logging ([langchain#35357](https://github.com/langchain-ai/langchain/issues/35357)) — the gap is felt at the framework level.

### 2.3 Demand evidence

- **Incidents:** 88% of orgs deploying agents had confirmed/suspected agent security incidents (92.7% in healthcare); HiddenLayer 2026: autonomous agents = >1 in 8 reported AI breaches; Meta's March 2026 rogue-agent incident (agent passed identity checks, posted sensitive data publicly for ~2h) is the reference case ([VentureBeat](https://venturebeat.com/security/most-enterprises-cant-stop-stage-three-ai-agent-threats-venturebeat-survey-finds), [VentureBeat Meta analysis](https://venturebeat.com/security/meta-rogue-ai-agent-confused-deputy-iam-identity-governance-matrix)).
- **Governance gap:** ~80% of orgs lack mature agentic governance (decision boundaries, real-time monitoring, full-chain audit trails); 81% of teams past planning but 14.4% with full security approval ([Deloitte](https://www.deloitte.com/us/en/insights/topics/emerging-technologies/ai-agents-scaling-faster.html), [Gravitee State of AI Agent Security 2026](https://www.gravitee.io/blog/state-of-ai-agent-security-2026-report-when-adoption-outpaces-control)).
- **HITL is a production reality, not a phase:** legal/compliance workloads run at 61% human-in-the-loop ([digitalapplied datapoints](https://www.digitalapplied.com/blog/ai-agent-adoption-2026-enterprise-data-points)). Selling *efficient, risk-tiered* HITL (only tier-3+ actions pause) is a cost-reduction pitch, not a friction pitch.
- **Market size / analyst:** agentic AI security $1.65B (2026) → $13.52B (2032), 42% CAGR ([MarketsandMarkets](https://www.marketsandmarkets.com/PressReleases/agentic-ai-security.asp)); Gartner: guardian agents = 10–15% of the agentic AI market by 2030, 50% of surveyed orgs researching them ([Gartner](https://www.gartner.com/en/newsroom/press-releases/2025-06-11-gartner-predicts-that-guardian-agents-will-capture-10-15-percent-of-the-agentic-ai-market-by-2030)); Gartner explicitly warns **uniform governance across all agents fails** → validates our per-action risk-tier model ([Gartner May 2026](https://www.gartner.com/en/newsroom/press-releases/2026-05-26-gartner-says-applying-uniform-governance-across-ai-agents-will-lead-to-enterprise-ai-agent-failure)).

### 2.3b Independent capability re-confirmation (direct source reads, Jul 2026)

A second research pass fetched primary pages to verify the "enforcement-light" claim first-hand — it holds:
- **AWS AgentCore Policy** is Cedar `permit`/`forbid` over principal/action/resource, deny-by-default, tool-level only (not even `tools/call` vs `tools/list`), with a CloudWatch allow/deny audit trail. The docs make **no mention of human-in-the-loop approvals, maker-checker, or tamper-evident audit** — it is allow/deny + log ([interceptors+policy blog](https://aws.amazon.com/blogs/machine-learning/secure-ai-agents-with-policy-and-lambda-interceptors-in-amazon-bedrock-agentcore-gateway/)).
- **Portkey / Bifrost** runtime governance is explicitly three modes — **Log / Flag / Block** — a binary gate on the *LLM request*, not a maker-checker approval on a *business action* ([Portkey guardrails](https://portkey.ai/features/guardrails), [Bifrost](https://www.getmaxim.ai/bifrost)).
- **Zenity** documents step-level monitoring, intent-based detection, and "automated response playbooks/containment," but its public platform page gives **no maker-checker workflow, tool-call-gating spec, or tamper-evident audit** ([Zenity platform](https://zenity.io/platform)).
- **Speakeasy's "50+ production servers"** post confirms the enabler tail we solve for free: tool explosion at 200+ endpoints, human-doc/LLM description mismatch, and generated servers exposing **all** capabilities with no server-side protection — mitigated by pruning + scopes, **not** authz binding / approvals / audit ([Speakeasy lessons](https://www.speakeasy.com/blog/generating-mcp-from-openapi-lessons-from-50-production-servers)).
- **Demand corroboration:** OWASP **Top 10 for Agentic Applications (ASI01–ASI10) shipped Dec 2025** with Identity & Privilege Abuse (ASI03) and Rogue Agents (ASI10) named risks ([Practical DevSecOps](https://www.practical-devsecops.com/owasp-top-10-agentic-applications/)); Kiteworks 2026 puts agent-incident firms at **65%** ([Kiteworks](https://www.kiteworks.com/cybersecurity-risk-management/ai-agent-security-incidents-2026/)) and CSA at **82% shadow agents / >50% scope violations** ([CSA](https://cloudsecurityalliance.org/press-releases/2026/04/21/new-cloud-security-alliance-survey-reveals-82-of-enterprises-have-unknown-ai-agents-in-their-environments)).

### 2.4 The competitive map in one sentence each

- **Observability/posture (Zenity, Lasso partially):** see everything, block little; no business-authz model.
- **Content firewalls (Prompt Security/SentinelOne, CalypsoAI/F5, Lakera, HiddenLayer):** inspect text in/out of the model; blind to *whether this principal may perform this action on this resource*.
- **Compliance-of-record (Credo, Holistic):** paperwork and evidence; zero runtime.
- **Identity (Okta/Auth0, WorkOS, AgentCore Identity):** who the agent is + credential plumbing; not policy on actions.
- **MCP gateways (OSS + AgentCore Policy):** the right chokepoint, RBAC-level policy; **missing approvals/maker-checker, danger tiers, tamper-evident ledger, permissions-at-time-of-action, budgets+kill-switch as one unit.**
- **Us:** the only stack where PEP authz + step-up danger gating + risk-tiered HITL approvals + hash-chained audit are one transaction on every tool call.

---

## 3. Direct answers to the founder's questions

**Q: Can we package what we built so an existing large company's legacy system becomes agentic without rebuilding?**
Yes — with one honest constraint. If they have OpenAPI specs / REST APIs / readable DB schemas + an IdP, the pipeline is genuinely productizable (§4). If their "legacy" is green-screen/thick-client with no API surface, that's UiPath's turf (UI automation) and we should decline or partner. The differentiated part is not codegen (free from Stainless/Gram) — it's the governed composite: manifest + authz binding to *their* roles + risk tiers + orchestrator + ledger.

**Q: Will the AI "understand their system the way it understands ours"?**
Yes, via the same two mechanisms Aegis uses on itself: (1) the capability manifest (Facets 1/3/5 minimum, per ai-native-core §8.5 minimal contract) generated from their specs and enriched by an LLM pass over their docs; (2) the pgvector self-knowledge RAG ingesting their API docs, runbooks, schema comments, and past tickets. Honest limit: quality is bounded by their documentation quality; discovery phase must include a documentation-gap report and human SME interviews.

**Q: Is the policing layer sellable standalone to companies whose agents we didn't build?**
Yes, if and only if we meet agents where they are: a gateway/proxy they route through (MCP + OpenAI-compatible LLM proxy + SDK hooks), zero rebuild required (§5.2). AgentCore Policy proves buyers accept "policy evaluated at a gateway per tool call" — but it's AWS-locked and approval-less. The standalone wedge is: works on any cloud/framework, adds maker-checker + tamper-evident audit, deployable in their VPC.

**Q: Which do we lead with?**
Policing. Lower services load, compliance deadline (EU AI Act Aug 2026), CISO budget exists now (88% incident rate makes it a board topic), and it creates Agentify pipeline. Agentify deals are bigger but 3–6 month cycles with services risk.

**Q: Does this conflict with building our own SaaS?**
Partially (§8, Risk 2). Resolution: the substrate (gateway, ledger, approvals, registry-gen) is one codebase — Aegis-the-SaaS is tenant #1 and the permanent demo. Modules (accounting, etc.) stay ours; the substrate is what's sold. This is the AWS pattern (internal platform → product) and keeps one engineering roadmap.

---

## 4. Product design — AGENTIFY (working name: **Aegis Ignite**)

**Promise:** "Your existing system, agentic in 6 weeks — governed from day one. No rebuild."
**Buyer:** CTO/CIO of mid-to-large product companies and enterprises with in-house software (50–5,000 engineers) outside the Salesforce/Microsoft gravity wells. **Champion:** platform/infra engineering lead.

### 4.1 Pipeline (four stages, each a gate with exit criteria)

**Stage 1 — Discovery (1–2 weeks, fixed-fee).**
Inputs: OpenAPI/Swagger specs, Postman collections, DB schemas (read-only introspection), API docs, runbooks, IdP role model export (Okta/AD/Auth0), sample audit logs.
Process:
1. `ignite-scan` CLI (new, thin) ingests specs → normalized operation inventory (method, path, params schema, auth scopes found).
2. LLM enrichment pass (via our LLM gateway, their data never trains anything — contractual): per-operation NL description, side-effect classification (read/write/destructive/financial/PII-touching), suggested risk tier. Human review required for every write-class tier assignment (this is the SME workshop).
3. DB-schema + docs ingestion into a dedicated pgvector brain (reuse Aegis RAG pipeline unchanged).
4. Output artifacts: **Capability Manifest v1** (Aegis manifest format, Facets 1/3/5 — tools, intents, risk tiers per ai-native-core §8.5), **coverage & gap report** (undocumented endpoints, missing auth metadata, ambiguous operations), **role-mapping draft** (their IdP groups → proposed Casbin model).
Exit gate: customer signs off manifest + risk tiers. *This artifact alone is billable and is the qualification filter — if discovery is a mess, the engagement stops there profitably.*

**Stage 2 — Tool generation + authz binding (1–2 weeks, mostly automated).**
1. Manifest → MCP server generation. Adopt the **Stainless two-tool pattern for large surfaces** (code-execution tool + docs-search tool over the manifest) and per-operation tools only for the curated high-frequency set (per our C.3 too-many-tools rule; [Stainless rationale](https://www.stainless.com/blog/generate-mcp-servers-from-openapi-specs/)). Generator: extend our route-walk registry generator to accept OpenAPI as an input source alongside live routes (est. 2–3 weeks eng, one-time).
2. Authz binding: OIDC federation with their IdP; their groups/claims map into a Casbin model instance (RBAC base + ABAC conditions where their claims carry attributes). Every generated tool carries `requiredPermission` + `riskTier` + `dangerFlags` metadata. **The LLM never sees or carries the principal — identity flows in the session/gateway layer, per the core principle.**
3. Credential handling for their downstream APIs: their vault (preferred) or our sealed per-tenant credential store; adopt AgentCore-style OBO/token-exchange pattern where their IdP supports it; Auth0 Token Vault / XAA compatibility for SaaS-side tools ([Okta XAA](https://www.okta.com/newsroom/press-releases/auth0-platform-innovation/)).
Exit gate: generated tool registry passes contract tests (auto-generated from their OpenAPI examples) against a staging environment.

**Stage 3 — Governed orchestrator deployment (1–2 weeks).**
Deploy the Aegis agent runtime as a Helm chart / Docker compose to **their VPC** (default for enterprises) or our managed cells: orchestrator + LLM gateway (LiteLLM, their model keys or ours) + PDP (Casbin) + @aegis/approvals + hash-chained ledger (their Postgres) + Langfuse traces + Promptfoo eval harness. Four gates active on every call from day one. Approval routing wired to their Slack/Teams/email.
Exit gate: red-team script (prompt-injection suite mapped to OWASP ASI Top 10) passes; eval suite ≥ agreed accuracy threshold on 50 golden tasks defined with the customer.

**Stage 4 — Per-module rollout + evals (ongoing, land-and-expand).**
Ship one workflow domain at a time (mirrors our pay-per-module model): each "module" = a manifest slice + golden-task eval set + risk-tier signoff. Expansion pricing attaches here. Continuous: eval regression in CI, drift detection when their OpenAPI changes (webhook/poll → re-gen → diff → human approval of registry changes — the drift-proof CapabilityManifest + CI Validate gate pattern lifted from Wayfinder).

### 4.2 What we reuse from Aegis **verbatim**

| Aegis asset | Agentify use | Change needed |
|---|---|---|
| Route-walk tool registry generator | Core of Stage 2 | Add OpenAPI-as-source input adapter |
| Capability manifest schema (ai-native-core §2.0, Facets 1/3/5) | The discovery deliverable | None — it's already system-agnostic JSON |
| Casbin PEP/PDP/PAP + runtime-mutable policies | Authz binding | IdP-claim → policy mapping templates per IdP (Okta/AD/Auth0) |
| @aegis/approvals (maker-checker/SoD) | Tier-3+ action gating | Slack/Teams adapters if not present |
| Hash-chained audit ledger | Their compliance artifact | Deployment-local Postgres target; export/anchor job |
| LLM gateway + per-tenant budgets | Their model spend control | Per-agent budget keys |
| pgvector RAG pipeline | Their system brain | Ingestion connectors for their doc formats |
| Langfuse + Promptfoo harness | Stage 3/4 evals | Golden-task templating |

### 4.3 Packaging & pricing hypotheses (Agentify)

- **Discovery sprint:** $30–75K fixed fee (sized by endpoint count). Standalone value; qualifies the account.
- **Platform license:** $60–150K/yr base (orchestrator + gateway + ledger in their VPC, up to N tools / M agent principals) + **$15–40K/yr per rolled-out module/domain**. Anchors under Sierra/Decagon's $200–400K single-use-case spend while being horizontal.
- **Optional outcome layer** (later, once we can measure): per-completed-workflow pricing for specific high-volume flows, copying Sierra's model ([Sierra](https://sierra.ai/blog/outcome-based-pricing-for-ai-agents)).
- **SI channel:** certify 2–3 boutique SIs to run Stages 1–4; we keep license, they keep services. Counteracts the services-heaviness risk.

---

## 5. Product design — AI POLICING (working name: **Aegis Warden**)

**Promise:** "Every action every agent takes in your company — authorized, risk-gated, approved when it matters, and provably logged. Works with agents you built on any framework. Deployed in your VPC."
**Buyer:** CISO / VP Security Engineering. Trigger events: agent incident (88% have one), EU AI Act deadline, board asking "what are our agents allowed to do?", failed audit.

### 5.1 Architecture (the PEP gateway)

```
their agents (LangChain / OpenAI Agents SDK / Vercel AI / Claude Code / custom / Copilot Studio via MCP)
        │  (A) MCP protocol          (B) OpenAI-compatible LLM proxy      (C) SDK middleware      (D) HTTP egress sidecar
        ▼
┌─────────────────────────  WARDEN GATEWAY (stateless, horizontally scaled)  ─────────────────────────┐
│ 1. Identity resolution: agent principal (mTLS/SPIFFE or OAuth client) + on-behalf-of human (OIDC/    │
│    XAA/OBO token). Reject unattributed traffic. Agent = first-class principal in the directory.      │
│ 2. AUTHORIZATION gate: Casbin PDP — (principal, action, resource, tenant, attrs) → allow/deny.       │
│    Policies runtime-mutable via PAP UI/API; synced from their IdP groups (SCIM).                     │
│ 3. DANGER gate: static risk tier from tool metadata (or assigned in Warden console for unknown       │
│    tools) + dynamic flags (bulk scope, financial amount thresholds, PII classifier on args).         │
│ 4. AUTONOMY gate: per-agent autonomy level × risk tier matrix → auto-allow / step-up / require       │
│    approval. Tier-3+ → @aegis/approvals: maker-checker, SoD (requester ≠ approver), timeout,         │
│    escalation, Slack/Teams/email. Async pattern = CIBA-style, matches Auth0 async authorization.     │
│ 5. Budgets & limits: per-agent token/cost budgets (LLM proxy mode), per-agent action rate limits,    │
│    per-tool quotas. KILL SWITCH: revoke principal → propagated to all gateway replicas <1s (Redis    │
│    pub/sub cache bust); "freeze all agents" tenant-level break-glass.                                │
│ 6. VERIFIABILITY gate: hash-chained append-only ledger entry per decision — request, principal       │
│    chain, POLICY SNAPSHOT (permissions-at-time-of-action), decision, approver identity, tool         │
│    result digest. Periodic external anchoring (RFC3161 timestamp / public chain / customer S3        │
│    object-lock). Verification CLI ships to their auditors. EU AI Act Art 12 exportable format.       │
│ 7. Optional content guardrails: pluggable (Lasso/Prompt-style checks, or their existing firewall)    │
│    — we are the action-policy layer, we interop with content firewalls rather than rebuild them.     │
└──────────────┬───────────────────────────────────────────────────────────────────────────────────────┘
               ▼ (on allow) upstream MCP servers / their APIs / SaaS tools
Console: agent inventory, policy editor (PAP), approval inbox, ledger explorer, OWASP-ASI coverage report.
```

Design rules carried over unchanged from Aegis: the LLM never decides authz; principals/permissions never ride in prompts; deny-by-default for unregistered tools; every decision logged even when denied.

### 5.2 Integration modes (the adoption make-or-break)

1. **MCP gateway (primary):** their agents point at Warden as their MCP endpoint; Warden aggregates/virtualizes their upstream MCP servers (MetaMCP-style namespacing). Zero code change for MCP-native agents.
2. **LLM proxy:** OpenAI/Anthropic-compatible endpoint; Warden inspects tool_calls in the completion loop, gates them, forwards approved calls. Catches frameworks that do local function-calling without MCP. (Bifrost proves the perf pattern: <100µs overhead is achievable — [Bifrost](https://github.com/maximhq/bifrost).)
3. **SDK middleware:** thin `@warden/hooks` for LangChain callbacks / OpenAI Agents SDK guardrails / Vercel AI middleware — for teams that want in-process gating with the same PDP over gRPC.
4. **Egress sidecar (later):** transparent HTTP proxy for non-MCP tool traffic; needed for full coverage claims but heavy; Phase 3.

### 5.3 What we reuse verbatim (Policing)

@aegis/approvals (unchanged — this is the crown jewel nobody else has), Casbin PEP/PDP/PAP (unchanged), hash-chained ledger (add anchoring job + auditor CLI), LLM gateway budgets (per-agent keys), entitlement service (Chargebee — Warden itself is per-module entitled), Langfuse tracing. **Net-new build:** the gateway shell (MCP server+client plumbing — adopt/fork rather than write, §6), SCIM sync, console UI, verification CLI, ASI/Art-12 report generators.

### 5.4 Packaging & pricing hypotheses (Policing)

- **Free/OSS core** (gateway + basic RBAC + local audit log): open-source the shell to compete with MetaMCP/MCPX for developer mindshare; keeps us honest on integration friction. License: Apache-2.0 for the shell; approvals/ledger-anchoring/console are commercial (open-core).
- **Team:** $2–4K/mo — up to 25 agent principals, approvals, hosted or self-hosted, standard audit export.
- **Enterprise:** $80–250K/yr — VPC deployment, SoD policies, external anchoring, SCIM, compliance report packs (EU AI Act Art 12, OWASP ASI coverage, NIST RMF mapping), SLA. Metering dimension: enforced actions/month (aligns price with agent scale; mirrors AgentCore's per-request pattern and Composio's per-call tiers).
- Benchmark: agentic-AI-security budgets are forming now inside a $1.65B→$13.52B market ([MarketsandMarkets](https://www.marketsandmarkets.com/PressReleases/agentic-ai-security.asp)); Zenity et al. price custom-enterprise — public pricing is itself a differentiator (per WorkOS's positioning against Zenity/Okta).

---

## 6. Adoption candidates (build vs adopt)

| Project | License | Fit | Verdict |
|---|---|---|---|
| [Bifrost](https://github.com/maximhq/bifrost) (6.2k★) | Apache-2.0 | LLM+MCP gateway shell, Go, virtual keys, budgets, OIDC | **Adopt/fork as Warden's data-plane shell** — strongest perf + license; add PDP/approvals/ledger as middleware. Risk: Go vs our TS estate → keep PDP/approvals as TS services called over gRPC |
| [MetaMCP](https://github.com/metatool-ai/metamcp) (~950★) | MIT | MCP aggregation/namespacing patterns, OIDC | **Mine for MCP-virtualization design**; TS — could be shell alternative if we stay all-TS; less battle-tested |
| [Gram](https://github.com/speakeasy-api/gram) | AGPL-3.0 | OpenAPI→MCP + curation + IdP sync | **Do not fork (AGPL contaminates commercial core); study hard.** Their toolset-curation UX is the best reference for Agentify Stage 2 |
| Stainless MCP gen | Commercial (free tier) | Two-tool architecture for large APIs | **Adopt the pattern, not the product** ([design writeup](https://www.stainless.com/blog/generate-mcp-servers-from-openapi-specs/)) |
| [openapi-mcp-generator](https://github.com/harsha-iiiv/openapi-mcp-generator) / [AutoMCP paper](https://arxiv.org/html/2507.16044v2) | MIT / paper | Baseline OpenAPI→MCP codegen | **Adopt as Stage-2 starting point**, wrap with our authz-metadata injector |
| [HumanLayer](https://pypi.org/project/humanlayer/) | OSS SDK + SaaS | HITL approval UX patterns | Study the @require_approval DX; our approvals stay in-house (SoD + ledger integration is the moat) |
| MCPX ([Lunar](https://www.lunar.dev/post/the-best-open-source-mcp-gateways-in-2026)) / Obot / IBM ContextForge | MIT / OSS / MIT | Gateway comparisons, K8s control-plane patterns | Reference implementations; validate our enterprise-tier feature list against theirs |
| Cedar (AWS policy lang) | Apache-2.0 | Alternative PDP | **No** — Casbin already deployed, runtime-mutable, and multi-model; but ship a Cedar-policy *importer* for AgentCore refugees |
| OWASP ASI docs / CSA MAESTRO | Open | Threat model + marketing artifact | **Adopt as certification target**; ship coverage matrix in the console |

---

## 7. Phased build outline

**Phase 0 (2 wks) — Extraction.** Pull approvals, ledger, Casbin PDP, budget middleware out of the Aegis app into standalone deployable services with their own Helm charts + versioned APIs (they're already packages; this is packaging + config surface). Exit: `docker compose up warden` gives PDP+approvals+ledger against a blank Postgres.

**Phase 1 (6–8 wks) — Warden MVP (Policing).** Fork Bifrost (or build TS shell from MetaMCP patterns — decide via 1-wk spike on gRPC latency to TS PDP); wire gates 1–6; agent-principal registry; Slack approvals; ledger anchoring to S3 object-lock; minimal console (inventory, policy editor, approval inbox, ledger explorer); EU AI Act Art-12 export + OWASP ASI coverage report. Design partner: run **Aegis's own agents through Warden in prod** (tenant #1, dogfood), plus 2–3 externals from SiteRecon network. Exit: one external design partner enforcing tier-3 approvals in prod.

**Phase 2 (6 wks, overlapping) — Agentify pipeline v1.** `ignite-scan` CLI + OpenAPI adapter for the registry generator + manifest review UI + golden-task eval templating. Run one paid discovery ($30K+) with a design partner. Exit: Stage 1–3 delivered to one customer in ≤6 wks calendar.

**Phase 3 (quarter 2) — Depth.** LLM-proxy mode + SDK middleware; SCIM; XAA/Token Vault interop; Cedar importer; egress sidecar spike; SI channel kit (delivery playbook + certification); outcome-metering for Agentify modules; NIST CAISI Interop Profile (Q4 2026) conformance work.

**Phase 4 — Scale bets.** OSS launch of gateway shell (Apache-2.0, open-core); marketplace of pre-built manifests for common enterprise systems (SAP/NetSuite/ServiceNow read-tiers); managed multi-tenant cells for mid-market.

Team estimate through Phase 2: 3 engineers + founder (design/sales); reuses ≥80% existing code by line count of the substrate.

---

## 8. Risks and honest limits

1. **Crowded, consolidating market.** SentinelOne (~$250M for Prompt), F5 (CalypsoAI), AWS (AgentCore Policy GA) are already in; Zenity has 3 years of enterprise logos and a runtime story now. Mitigation: we don't out-market them — we out-*specificity* them: maker-checker + tamper-evident ledger + VPC + public pricing is a checklist no one else completes today. Honest limit: that checklist gap could close within 12–18 months; the moat must move to accumulated policy templates, manifests, and audit-grade trust.
2. **Platform-vs-product tension.** Selling the substrate while building our own SaaS splits focus and creates "are you a competitor?" questions when Agentify prospects overlap our module verticals. Mitigation: substrate is one codebase, Aegis SaaS is tenant #1; declare vertical non-compete in Agentify contracts where needed. Honest limit: at some point one motion wins the roadmap; decide by revenue mix at ~$1M ARR.
3. **Services gravity in Agentify.** Discovery quality depends on their docs; SME workshops don't automate; every enterprise wants "one small custom thing." Mitigation: fixed-fee discovery with hard exit gates, SI channel for Stages 1–4, refuse no-API engagements (UiPath's turf). Honest limit: Agentify will run 30–50% services revenue in year one no matter what.
4. **Data-path trust + operational burden.** A policing gateway is a single point of failure and a tier-0 dependency owned by a tiny vendor. Mitigation: stateless horizontal gateway, fail-policy configurable (fail-closed default for tier-2+, fail-open option for tier-0 reads), VPC deployment so *their* SRE runs it, <5ms p99 added latency budget (Bifrost baseline shows it's feasible). Honest limit: some CISOs will only buy this from AWS/Microsoft/Okta regardless of merit.
5. **Standard churn.** MCP is moving fast (auth spec revisions), NIST agent profile lands Q4 2026, XAA is pre-standard. Mitigation: gateway shell isolates protocol churn from the PDP/ledger core (which is protocol-agnostic). Honest limit: a breaking MCP auth change costs us a quarter roughly annually.
6. **OSS commoditization from below.** Bifrost/MCPX/MetaMCP add governance features monthly; "RBAC on tools" is already free. Mitigation: our commercial line sits above RBAC (approvals/SoD, anchored ledger, compliance packs) — features that require product depth and auditor credibility, not gateway code. Honest limit: if an OSS gateway ships credible maker-checker + hash-chained audit, price pressure is immediate.
7. **Verification-of-claims risk in this doc.** Several 2026 figures come from vendor-adjacent surveys (Gravitee, Saviynt via VentureBeat) and market-research PRs (MarketsandMarkets); treat magnitudes as directional. Gartner citations are press releases, not full notes.

---

## 9. Source index (primary)

Agentify space: [MuleSoft Agentforce](https://www.mulesoft.com/platform/agentforce) · [MuleSoft MCP](https://blogs.mulesoft.com/news/connect-agentforce-to-any-system-with-mulesoft-mcp-servers/) · [UiPath Maestro](https://www.uipath.com/platform/agentic-automation/agentic-orchestration) · [Copilot Studio pricing](https://www.microsoft.com/en-us/microsoft-365-copilot/pricing/copilot-studio) · [Sierra pricing](https://sierra.ai/blog/outcome-based-pricing-for-ai-agents) · [Decagon vs Sierra](https://cresta.com/guides/decagon-vs-sierra) · [Gram](https://github.com/speakeasy-api/gram) · [Stainless MCP](https://www.stainless.com/blog/generate-mcp-servers-from-openapi-specs/) · [AutoMCP](https://arxiv.org/html/2507.16044v2) · [Composio pricing](https://composio.dev/pricing) · [Accenture AI revenue](https://www.ciodive.com/news/accenture-generative-ai-revenue-skills-training-data-modernization/761161/)
Policing space: [Zenity platform](https://zenity.io/platform) · [Zenity Series B](https://www.intelcapital.com/zenity-raises-38m-series-b-funding-round-to-secure-ai-and-low-code-apps/) · [SentinelOne–Prompt](https://investors.sentinelone.com/press-releases/news-details/2025/SentinelOne-to-Acquire-Prompt-Security-to-Advance-GenAI-Security-and-Agent-Security-Strategy/default.aspx) · [F5–CalypsoAI](https://www.f5.com/company/blog/securing-ai-models-and-agents-without-compromise) · [Lasso](https://www.lasso.security/) · [Knostic](https://www.knostic.ai/) · [Credo AI](https://www.credo.ai/product) · [Bifrost](https://github.com/maximhq/bifrost) · [MetaMCP](https://github.com/metatool-ai/metamcp) · [MCP gateway comparison](https://zuplo.com/blog/mcp-gateway-comparison) · [AgentCore pricing](https://aws.amazon.com/bedrock/agentcore/pricing/) · [AgentCore Policy GA](https://aws.amazon.com/about-aws/whats-new/2026/03/policy-amazon-bedrock-agentcore-generally-available/) · [Auth0 for GenAI](https://www.okta.com/newsroom/press-releases/auth0-platform-innovation/) · [HumanLayer](https://humanlayer.systems/index-en)
Standards/demand: [OWASP ASI](https://genai.owasp.org/resource/agentic-ai-threats-and-mitigations/) · [ASI Top 10](https://www.prnewswire.com/news-releases/owasp-genai-security-project-releases-top-10-risks-and-mitigations-for-agentic-ai-security-302637364.html) · [CSA NIST-RMF agentic profile](https://labs.cloudsecurityalliance.org/agentic/agentic-nist-ai-rmf-profile-v1/) · [NIST agent standards](https://nhimg.org/nhi-news/nist-iso-ai-agent-identity-governance-frameworks) · [EU AI Act Art 12](https://www.asqav.com/blog/posts/eu-ai-act-audit-trail-requirements) · [88% incidents](https://venturebeat.com/security/most-enterprises-cant-stop-stage-three-ai-agent-threats-venturebeat-survey-finds) · [Meta rogue agent](https://venturebeat.com/security/meta-rogue-ai-agent-confused-deputy-iam-identity-governance-matrix) · [Gartner 40% apps](https://www.gartner.com/en/newsroom/press-releases/2025-08-26-gartner-predicts-40-percent-of-enterprise-apps-will-feature-task-specific-ai-agents-by-2026-up-from-less-than-5-percent-in-2025) · [Gartner guardian agents](https://www.gartner.com/en/newsroom/press-releases/2025-06-11-gartner-predicts-that-guardian-agents-will-capture-10-15-percent-of-the-agentic-ai-market-by-2030) · [Gartner uniform governance fails](https://www.gartner.com/en/newsroom/press-releases/2026-05-26-gartner-says-applying-uniform-governance-across-ai-agents-will-lead-to-enterprise-ai-agent-failure) · [Deloitte guardrails](https://www.deloitte.com/us/en/insights/topics/emerging-technologies/ai-agents-scaling-faster.html) · [Gravitee 2026 report](https://www.gravitee.io/blog/state-of-ai-agent-security-2026-report-when-adoption-outpaces-control) · [Market size](https://www.marketsandmarkets.com/PressReleases/agentic-ai-security.asp)

---

## Red-team correction (READ BEFORE IMPLEMENTING)

**Verdict:** The research is strong and the enforcement wedge is real *today*, but this is the wrong bet *now*: it is a well-funded, consolidating security market being entered by a solo founder with zero traction on the core SaaS, and the doc's own risks (crowded market, services gravity, platform-vs-product) are acknowledged then defused with mitigations that assume resources and time the founder does not have. Do not build. Extract the substrate opportunistically; sell nothing until Aegis-the-SaaS proves the primitives in production.

### Ranked top fixes
1. **Kill the two-product framing; there is only one asset worth testing: the tamper-evident + maker-checker ledger as a feature of your own product.** Prove it on Aegis's own agents in prod before claiming it's sellable. "80% of code exists" is a trap — the missing 20% (multi-tenant packaging, SCIM, IdP-mapping, console, VPC ops, auditor CLI, 24/7 tier-0 support) is 80% of the *company*, not the codebase.
2. **Re-test the "enforcement niche is unoccupied" thesis with a 12-month clock, not a snapshot.** The doc already concedes AgentCore Policy GA'd (Mar 2026) and that the gap "could close within 12–18 months" (Risk 1). Maker-checker + hash-chained audit are *features*, not moats — they are ~1–2 quarters of work for Zenity/Okta/AWS, all of whom have the distribution you lack. Assume it closes and ask what survives. Almost nothing does except accumulated trust, which a solo founder cannot accumulate fast enough.
3. **Do not lead with Policing on the EU AI Act deadline.** A CISO will not put a tier-0, single-point-of-failure data-path gateway from a one-person vendor between their agents and their systems to hit an Aug 2026 deadline — they will buy the checkbox from AWS/Okta/an incumbent, or self-host an OSS gateway. The deadline *accelerates incumbents*, it does not create a solo-founder window.
4. **Confront the IdP-binding claim honestly: it is bespoke per customer, not a product.** "OIDC federation + map their groups/claims into Casbin" is a consulting engagement dressed as a generator. Every enterprise's role model is a snowflake (nested AD groups, custom claims, app-specific RBAC that doesn't live in the IdP at all). This is the core of Agentify's 30–50% services drag and it does not amortize.
5. **Redo pricing against usage-based reality.** AgentCore bills fractions of a cent per request; Composio $29–229/mo. A $2–4K/mo "Team" tier for a governance proxy competes with free OSS below and per-call cloud pricing sideways. Enterprise $80–250K/yr requires an enterprise sales motion a solo founder does not have.
6. **Reframe the "AWS pattern (internal platform → product)" analogy — it's backwards.** AWS productized infra *after* Amazon retail was a giant. You have no giant. Selling the substrate before the core has a single paying customer is not the AWS pattern; it's abandoning the core.

### Key holes (security / feasibility / gaps)
- **Feasibility — solo founder vs. the team estimate.** §7 says "3 engineers + founder." The founder is solo with zero core traction. The entire phased plan is priced in a team that doesn't exist. This gap is not addressed anywhere.
- **Security — the gateway is a tier-0 confused-deputy and credential-honeypot.** It holds every downstream credential (§4.1 Stage 2) and sits in the data path of every agent action. A bug or breach in *your* gateway is a breach of *every customer's* whole system. The doc's "stateless, fail-configurable" mitigation does not address blast radius, credential custody liability, or the reality that you become the highest-value target in each customer's estate.
- **Security — fail-open option (Risk 4) silently defeats the product.** "fail-open for tier-0 reads" means under load/outage the enforcement layer you sold as the control *disappears* — and read-classification is exactly where prompt-injected argument smuggling hides. Fail-open should not exist in an enforcement product; if availability forces it, the product is unsellable to the CISOs who are the buyer.
- **Gap — GDPR erasure vs. immutable ledger is unaddressed.** The whole pitch rests on an append-only hash-chained ledger that captures request args, principal chains, and tool-result digests (PII). EU AI Act Art 12 (retain) directly collides with GDPR Art 17 (erase). This is the platform's known core tension (per the founder mandate) and the doc sells the ledger as pure upside with no erasure story. Selling this to EU enterprises without an answer is a legal liability.
- **Gap — untrusted connector/tool data as prompt-injection vector is not in the threat model.** Agentify ingests customer docs/schemas/tickets into a pgvector "brain" and the orchestrator acts on tool outputs. Poisoned data → the agent proposes an action → the gateway authorizes it because the *principal* is allowed. Authz-at-tool-call does not stop a correctly-authorized-but-manipulated action. The doc's own core principle ("the agent reasons; the governed core acts") means injection steers the reasoning that chooses *which* authorized action to take.
- **Gap — single-human SMB tenant breaks maker-checker, the crown jewel.** SoD (requester ≠ approver) is the differentiator, but it assumes ≥2 humans. The self-serve/SMB segment the pricing implies ("Team, 25 principals") often has one operator. The moat feature is inapplicable to a chunk of the addressed market.
- **Gap — verification independence is asserted, not designed.** "Cryptographically verifiable" proves *the log wasn't altered*, not *that the decision was correct or independently checked*. Determinism ≠ correctness. The doc conflates tamper-evidence with trustworthy verification; an auditor will ask "verified against what ground truth?" and there is no answer.
- **Overclaim — "~80% already exists / net-new is just packaging."** Repeated as fact (§0.5, §5.3, §7). Multi-tenant isolation, per-customer IdP mapping, VPC deploy/upgrade tooling, SCIM, console UX, compliance report generators, and auditor-grade support are net-new and are where the years go.

### Where a human or a different approach is genuinely needed
- **Founder decision (not automatable): don't do this yet.** The honest move is to shelve both products and get the core SaaS to first revenue. Revisit only if (a) the ledger/approvals primitive earns unsolicited "can I buy just that?" pull from real users, and (b) the enforcement gap demonstrably has *not* closed.
- **If validating anyway, do it as a design-partner letter of intent, not a build.** One CISO signing a paid pilot *before* you write the gateway tells you more than Phase 0–1. If you can't get an LOI from your SiteRecon network with a slide, the market read is wrong.
- **Legal counsel required before any ledger sale in the EU** (Art 12 vs GDPR Art 17, and credential-custody liability). This is not an engineering call.
- **A security architect (not the founder) should own the fail-mode and blast-radius design** before any customer routes production traffic — the confused-deputy and fail-open holes are the kind that end a security vendor on day one.
- **Different approach worth more than either product:** ship the hash-chained audit + maker-checker as an *open-source library / MCP middleware* that runs *in the customer's process* (no data-path custody, no tier-0 liability, no VPC ops), and monetize compliance report packs + support. This sidesteps the blast-radius, fail-open, and credential-honeypot holes and matches what a solo founder can actually operate.
