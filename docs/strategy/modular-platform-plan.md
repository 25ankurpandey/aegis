# Aegis → Modular, Multi-Industry Platform — Build Plan & Research

> A plan to evolve Aegis from a fixed 7-service suite into a **governance-native modular platform**:
> tenants enable/buy only the modules they need and pay only for those, across multiple industries.
> Grounded in the Aegis codebase, four reference repos (oe_core, oe-connect-platform, plutus+mint,
> emporio), and market research (Odoo, Frappe, Salesforce, ServiceNow, Shopify, Backstage, Medusa,
> Saleor, Chargebee/Stripe/Orb/Lago/OpenMeter). Verification corrections applied; volatile pricing
> marked APPROX — re-confirm at contract time.
>
> Status: **plan, not yet buildable** until the NOW-phase blockers in §R and the open decisions in §T
> are resolved.

---

## 0. TL;DR

- **The wedge:** *Salesforce's ecosystem model + Odoo's per-module economics, but governance-first — every module is born isolated (Postgres RLS), authorized (runtime Casbin RBAC/ABAC), and audited (append-only ledger), inherited from the platform kernel.* Incumbents built apps first and bolted on isolation/governance later; Aegis already owns the hard substrate and treats modules as the product.
- **Does this exist?** Yes — and we should copy, not invent: Odoo/Frappe for per-tenant module install + data extensibility, Saleor/Shopify for the manifest + install handshake, Backstage/Medusa for the plugin SDK and module isolation, Chargebee+Stripe Entitlements for billing, Lago/OpenMeter for metering. **No one** combines enforced multi-tenant isolation + runtime authz + audit as the *substrate under* a module marketplace. That's the gap.
- **Biggest asset we already have:** the entitlement substrate is 70% built — `tenant_features` flags + a swappable `FeatureFlags` reader + Redis cache + runtime Casbin grants via PAP. "Buy a module" ≈ "flip a flag and project its permissions," which the codebase already does.
- **Biggest thing to lift from your other repos:** Plutus's **dual-ledger mirror** (authoritative local ledger → async, idempotent, fail-open mirror to Chargebee) is the metering/billing crown jewel — but it's untested Java-8 financial code and must be hardened before it becomes the platform's billing source-of-truth.
- **Two contradictions to resolve before building** (§D): (1) in-process first-party modules vs per-tenant module *versioning* — they conflict; (2) marketing "hard isolation" while leaving module authors to write their own RLS — the platform must generate and verify RLS, not lint-and-hope.
- **The decision that sizes everything** (§T): *first-party suite + curated partners* vs *open third-party ecosystem.* Decide this **before** extracting the SDK — it changes the manifest, sandbox, and rev-share scope by an order of magnitude.

---

## A. Vision & positioning

**One sentence:** Aegis becomes the **governance-native application platform** — a modular suite where every capability (approvals, audit, finance controls, connectors, reporting, AI-agent governance) ships as an independently buyable module that inherits hard tenant isolation, runtime RBAC/ABAC, and a tamper-evident audit trail from the kernel, so a company turns on exactly the modules it needs and pays only for those.

**Why this and not "another Odoo":** Aegis already owns the two things hardest to retrofit and that every competitor treats as an afterthought — **Postgres RLS-enforced tenant isolation** (`libs/db/src/rls.ts`, `withTenantTransaction`) and a **runtime, no-deploy policy plane** (Casbin via `apps/user-management/src/services/pap.service.ts` → `applyPolicyGrant` in `libs/access-control/src/pep.ts` → cross-pod reload in `libs/access-control/src/watcher.ts`). Odoo runs third-party module code in full trust in the server process; Salesforce bolts entitlement on via a managed package; Permit.io is *only* authz with no billing, modules, or data plane.

**Who buys:**
- **Now:** mid-market finance/ops teams needing AP/expense/payroll controls with real audit + SoD, who don't want a NetSuite implementation (the existing Aegis + oe_core domain).
- **Next:** field-services/construction (SiteRecon's own world), professional services — anyone needing "workflow + approvals + connectors + audit" on strong multi-tenancy.
- **Later:** ISVs and SiteRecon's own teams who want to ship a capability without forking core — the marketplace.

**How it differs:**

| | Odoo | Salesforce | Permit.io | **Aegis** |
|---|---|---|---|---|
| Tenant isolation | convention / per-DB | OrgID row + governor limits | none (authz only) | **Postgres RLS, enforced, free per module** |
| Authz | record rules | profiles / perm sets | full ABAC/ReBAC | **Casbin RBAC/ABAC/RLS, runtime-mutable** |
| Audit | partial | field history | none | **append-only ledger as a kernel service** |
| Module trust | in-process full trust | Apex sandbox | n/a | **tiered: in-process (1P) → partner-hosted → sandboxed (3P)** |
| Entitlement | per-DB unlock | LMA managed pkg | n/a | **billing-driven, gateway-enforced** |

Market positioning line: **"Salesforce's ecosystem model, Odoo's per-module economics, but governance-first — every module is born isolated, authorized, and audited."**

---

## B. Does this already exist? (market scan — what to copy)

Short answer: the *pieces* all exist and are battle-tested; the *combination* (governance substrate under a module marketplace) does not. Build on the proven pieces; don't reinvent them.

### Modular business-app suites (per-tenant module install + data extensibility)
- **Odoo** — `__manifest__.py` per module with `depends`/`auto_install`; modules installed per database; data extended via `x_`-prefixed custom fields + Studio; **company-dependent JSONB** values. Lesson: **manifest + dependency graph + reserved custom-field namespace**. Caveat: Odoo's "DB-wide installed-module set, per-company *values*" model is **not** ours — we are true multi-tenant (many companies, one fleet), so we want **per-tenant install** (Frappe/NetSuite model), not Odoo's. Pricing APPROX: Custom plan ~$49/user/mo annual.
- **Frappe / ERPNext** — apps → modules → **DocTypes**; custom fields/doctypes per site; per-site app install; Frappe Cloud marketplace with a hosting-revenue split (≈75/25) and free apps allowed. Lesson: **per-site (per-tenant) install granularity** + metadata-driven entities.
- **Zoho One / NetSuite SuiteApps / Dynamics 365 AppSource** — bundle-your-own-suite economics; per-account app entitlement; partner marketplaces. Lesson: **bundle first-party, monetize the long tail.**

### Enterprise platforms with two-sided marketplaces + sandboxed code
- **Salesforce** — custom objects, permission sets/entitlements, **managed packages**, AppExchange. Rev share APPROX ISVforce ~15% / OEM ~25%. **License Management App (LMA)** lets ISVs gate features by license — "install free, gate premium." Lesson: **platform-managed entitlement as a developer perk**; reserved `acme__` namespace.
- **ServiceNow** — scoped applications + Store; strong namespace isolation (`x_acme_`).
- **SAP BTP** — side-by-side extension (out-of-process) as the safe default for third parties.
- **Atlassian** — **Connect (out-of-process) vs Forge (sandboxed, Atlassian-hosted)**; Forge's **egress allowlist / "Runs on Atlassian"** is the single highest-leverage trust feature; rev-share **holiday on first $1M lifetime** for the secure model, higher rate on the legacy model to *steer* developers. Lesson: **use revenue share to steer toward the trust tier you want.**

### Developer plugin platforms (the technical SDK reference)
- **Saleor** — JSON **app manifest**, two-endpoint **install handshake** (Manifest URL + Register URL → scoped token), sync + async **webhooks**, iframe UI. The cleanest portable install protocol to copy.
- **Shopify** — `shopify.extension.toml`, **Functions = WASM** for untrusted compute, **remote-dom in a Web Worker** for untrusted UI, Billing API. The reference for tier-3 sandboxing.
- **Backstage** — typed **extension points / blueprints / `attachTo` / inputs** and first-class **`withOverrides`** so integrators decorate/replace another module's extensions without forking. The reference for SDK contributor ergonomics.
- **Medusa v2** — **modules architecture + module *links* (generated join tables, no FKs)** to relate data across modules without coupling. The reference for cross-module relations under isolation (but see the link-table caveats in §G).
- **Strapi** — explicit `register` (declare) / `bootstrap` (wire) / `destroy` (cleanup) plugin lifecycle. The reference for phase-scoped module loading.

### Billing / entitlement / metering infra
- **Chargebee** — Product Catalog 2.0 (**Item Family → Item {plan/addon/charge} → Item Price**) + **Feature Management** entitlement types (**Switch / Quantity / Range / Custom**) + subscription-level overrides. Maps 1:1 onto modular SaaS. SiteRecon is already migrating onto it (Plutus). Fee APPROX ~0.75% of billing volume.
- **Stripe Billing + Entitlements + Meters** — similar model; Stripe acquired **Metronome** (2025, enterprise metering). Fee APPROX ~0.7%, even on off-platform invoices.
- **Orb / Metronome / m3ter** — dedicated usage metering; **m3ter acquired by Salesforce (2025)**. Enterprise/high-volume; overkill now.
- **Lago (OSS, self-host) / OpenMeter (Apache-2.0, self-host)** — the self-host path if metering volume later outgrows Chargebee.
- **OpenFeature / LaunchDarkly / Flagsmith** — feature-flag/entitlement bridges; wrap the in-app entitlement reader behind **OpenFeature** for portability.

**Net takeaway:** copy Saleor's manifest+handshake, Shopify's sandbox model, Backstage's SDK ergonomics, Frappe's per-tenant install, Odoo's namespacing, Chargebee's catalog/entitlement model. Invent only the thin glue that ties them to the Aegis kernel.

---

## C. Reference architecture

### What a "module" IS — the manifest

A module is a **versioned, declaratively-described unit** the platform can install, entitle, route to, and bill for **without editing core code**. This is the biggest net-new primitive. Aegis today has *no* manifest: gateway `ROUTES` is static (`apps/gateway/src/routes-config.ts`), `ServiceName`/`Permission` are compile-time enums, the RBAC catalog is seeded once. The manifest replaces all of these *as data*, validated **before any code runs** (the Saleor/Shopify lesson).

```jsonc
// aegis.module.json — single source of truth
{
  "id": "aegis.expense",                 // globally unique, namespace-reserved
  "version": "2.3.0",                    // semver
  "requiredKernel": "^4.0.0",            // host-compat pin (Saleor requiredSaleorVersion)
  "trustTier": "first-party",            // first-party | partner-hosted | sandboxed
  "dependsOn": ["aegis.approvals@^1.2"], // dependency graph (Odoo depends)
  "permissions": [
    { "id": "expense.read",    "label": "View expenses" },
    { "id": "expense.approve", "label": "Approve expenses" }
  ],
  "roles": [
    { "id": "expense.manager", "grants": ["expense.read","expense.approve"] }
  ],
  "routes": [
    { "prefix": "expense", "service": "expense-svc", "scope": "expense.read" }
  ],
  "events": {
    "emits":    ["expense.submitted","expense.approved"],
    "consumes": ["approvals.decided"]
  },
  "migrations": "migrations/",           // module-owned, run on activation
  "rls": "platform-generated",           // authors NEVER hand-write RLS (see §H)
  "ui": { "mounts": [{ "surface": "nav.primary", "remote": "expenseRemote/App" }] },
  "entitlement": {
    "sku": "expense",
    "meters": [{ "id": "expense.processed", "unit": "document" }],
    "limits": [{ "type": "quantity", "key": "seats" }]
  },
  "customFields": { "namespace": "x_expense_" }  // reserved prefix (Odoo x_, SF acme__)
}
```

**Decoupling principle:** the manifest declares *what installs and in what order*; a **separate entitlement layer** decides *whether it's unlocked for a tenant*. Engineering and pricing evolve independently.

### Six extension surfaces → existing Aegis seams

This mapping is what makes the build tractable — every surface wraps something that already exists:

| Surface | Net-new wrapper | Existing Aegis seam it wraps |
|---|---|---|
| **DI / services** | module exposes `register(container)` bundle | `createService()` + `registerApprovalProviders()` (`libs/service-core/src/bootstrap/bootstrap.ts`) — proven cross-cutting plug-in |
| **Routes** | manifest `routes[]` → data-driven gateway map | `apps/gateway/src/routes-config.ts` (today static) |
| **Events** | manifest `events` → `EventBus.subscribe` at bootstrap | `libs/events/src/bus.ts` registry + outbox |
| **Permissions** | manifest `permissions[]` → Casbin vocabulary at install | `pap.service.ts` + `applyPolicyGrant` + `watcher.ts` (runtime, no deploy) |
| **Migrations** | module-owned Umzug set, run on activation | `apps/cli` Umzug (today global) — needs per-module namespacing |
| **UI** | manifest `ui.mounts` → Module Federation remote / iframe | net-new (no MF today) |

Loading follows a **phase-scoped lifecycle** (Strapi): `manifest-validate → migrate → register-permissions → register-routes → register-events → activate-entitlement`, with `register` (declare only) / `bootstrap` (wire once peers exist) / `destroy` (cleanup) phases. Forbid hard inter-module resolution before `bootstrap` (peer load order undefined).

### Kernel vs modules

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          AEGIS KERNEL                                     │
│            (Thinnest Viable Platform — never sold, always present)        │
│  ┌────────────────┐ ┌─────────────────┐ ┌──────────────────────────┐     │
│  │ Tenant Isolation│ │ Access-Control  │ │ Module Registry &        │     │
│  │ libs/db RLS,    │ │ PEP/PAP/PDP     │ │ Entitlement Service ★NEW │     │
│  │ withTenantTxn   │ │ libs/access-ctl │ │ catalog→subscription→    │     │
│  └────────────────┘ └─────────────────┘ │ per-tenant activation    │     │
│  ┌────────────────┐ ┌─────────────────┐ └──────────────────────────┘     │
│  │ Event Bus+Outbox│ │ Connector       │ ┌──────────────────────────┐     │
│  │ libs/events     │ │ Runtime         │ │ Audit Ledger ★promote to │     │
│  └────────────────┘ │ libs/connectors │ │ kernel (lift plutus)     │     │
│  ┌────────────────┐ └─────────────────┘ └──────────────────────────┘     │
│  │ DI Bootstrap    │ ┌─────────────────┐ ┌──────────────────────────┐     │
│  │ service-core    │ │ Entitlement     │ │ Module SDK + Manifest    │     │
│  │                 │ │ Reader (cache)  │ │ Loader ★NEW              │     │
│  └────────────────┘ └─────────────────┘ └──────────────────────────┘     │
└───────────────────────────────┬───────────────────────────────────────────┘
                                 │ stable, versioned host contract
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
┌───────────────┐        ┌───────────────┐        ┌───────────────┐
│ MODULE expense│        │ MODULE        │        │ MODULE ap-recon│
│ (first-party) │        │ approvals     │        │ (3P, sandboxed/│
│ DI + migrations│       │ (lifted from  │        │ partner-hosted)│
│ + events+perms │       │ oe_core)      │        │                │
└───────────────┘        └───────────────┘        └───────────────┘
     │ owns its own schema; cross-module ONLY via events / API / link-tables
     └──────────────── never shares a DB table with another module ──────────
```

### Request path with entitlement enforcement

```
Client shell ─ loads module remotes (Module Federation) gated by entitlements
   ▼
GATEWAY (apps/gateway)
  1. authenticate() (JWT)                          ── libs/access-control
  2. resolve ROUTE from MODULE REGISTRY (data-driven ★ not static)
  3. ENTITLEMENT CHECK ★NEW: module enabled for tenant T?
        ─ reads materialized entitlement via Redis read-through cache
        ─ not entitled → 402/403 AT THE EDGE  (fail-closed; see §F grace rules)
  4. propagate tenant_id + correlation headers
   ▼
MODULE SERVICE (e.g. expense-svc)
  • authorize(Permission) re-enforced ── PEP, fail-closed
  • boot-time pep-assertion: every route has a guard
  • withTenantTransaction → RLS sets app.current_tenant
  • emits domain events → outbox → bus
  • meters usage → local sub-ledger → async mirror to billing ★ (fail-open)
   ▼
EVENT BUS ──▶ AUDIT LEDGER (kernel, append-only, signed)
   │   module.enabled / entitlement.changed ★NEW
   ▼
ENTITLEMENT SERVICE ◀── webhook ── Chargebee
   catalog · subscription · activation · materialized per-tenant entitlement
   flips Casbin perms via PAP on purchase ★ / revokes on churn (§F)
```

### How existing libs become the module runtime
- **`libs/access-control` (PEP/PAP/watcher)** → authorization runtime for modules; on purchase, `applyPolicyGrant()` projects manifest perms/roles into live Casbin and `watcher.ts` fans out a reload — instant, no deploy. **lift-as-is** (most valuable existing asset).
- **`libs/db` (RLS, withTenantTransaction)** → every module inherits hard tenant isolation. **lift-as-is.**
- **`libs/events` (bus + outbox + topics)** → inter-module decoupling channel + entitlement event spine (`module.enabled`/`disabled`/`entitlement.changed` — net-new topics). **lift-as-is.**
- **`libs/connectors` (registry + config-store + `connector_configs.active`)** → template for the module registry; "registered globally, enabled/configured per tenant, `active` boolean" (migration 0026) generalizes to `tenant_modules`. **inspiration-only.**
- **`tenant_features` + `FeatureFlags` reader + `flag-cache`** → the entitlement substrate; swap the reader (`libs/db/src/feature-flags-reader.ts`) to resolve against the Entitlement Service and most gating works unchanged. **adapt.**
- **`apps/gateway` ROUTES + proxy** → the PEP for module entitlement (the edge gate). **adapt.**
- **`createService()` + DI loader** → the module packaging mechanism (the `@aegis/approvals` pattern proves it). **lift-as-is.**

---

## D. Two contradictions to resolve before building

The red-team flagged two internal contradictions that make the naïve plan unbuildable. Both have clean resolutions, but they must be **decided up front**.

### D.1 In-process first-party modules **vs** per-tenant module versioning
In-process (tier-1) modules share the host's memory, connection pool, and crash domain. That makes it **impossible to run `expense@2.3` for tenant A and `expense@2.1` for tenant B in the same pod**, and a bad first-party module can take down every tenant on that pod. You cannot market both "in-process first-party modules" and "per-tenant module versions" — they conflict.

**Resolution (recommended):** first-party modules **upgrade fleet-wide in lockstep** (drop per-tenant *versioning* for tier 1; keep per-tenant *enablement*). Per-tenant *version pinning* is a property of **out-of-process** (partner-hosted / sandboxed) modules only. Document this explicitly. If per-tenant first-party versioning ever becomes a real requirement, the answer is to move that module out-of-process — not to fake it in-process.

### D.2 "Hard isolation" **vs** module authors writing their own RLS
The headline differentiator is *enforced* isolation. If a module author forgets the tenant predicate or omits `FORCE ROW LEVEL SECURITY` on one table, the entire value prop silently breaks. "Lint for it" is not enough.

**Resolution:** **the platform generates RLS policies for module-owned tables; authors never write RLS by hand.** A module declares its tenant-scoped tables in the manifest/migration metadata; the kernel emits the `FORCE`/`RESTRICTIVE` policy keyed on `app.current_tenant` (reuse `libs/db/src/rls.ts` `rlsPolicyStatements`). **Install is gated by an automated cross-tenant leakage test** (§H) — a release gate, not a later nicety.

---

## E. Module isolation & extensibility

### Trust tiers (pick the trust model *before* designing the API)
1. **First-party (in-process, full trust)** — Aegis-built modules as DI bundles; full DB/event/Casbin access (Odoo/Frappe/Strapi model). Acceptable because code is vetted. **Fleet-wide lockstep versioning** (§D.1).
2. **Partner-hosted (out-of-process, their infra)** — partner runs their own service; integrates via gateway + signed webhooks (sync + async) + a scoped token minted from the manifest's declared permissions (Saleor / Atlassian Connect / SAP BTP side-by-side). Per-tenant version pinning possible. **Partner UI must be iframe-isolated, never loaded into the shell origin** (§K risk).
3. **Sandboxed (Aegis-hosted untrusted code)** — marketplace long-tail: compute as **WASM/WASI**, deny-by-default capabilities, typed JSON in/out (Shopify Functions); UI via **remote-dom in a Web Worker** or **iframe** (Saleor); **mandatory egress proxy** enforcing a manifest allowlist (Atlassian Forge).

**Recommendation:** ship tiers 1+2 first (covers SiteRecon's near-term needs + a curated partner program). Build tier 3 only when third-party volume justifies the multi-year sandbox investment — and **buy the sandbox substrate** (Wasmtime/Wasmer), build only the egress proxy + host ABI + capability grants.

### Data-model extensibility — recommendation: tiered, JSONB-default
- **Default — JSONB custom fields** on tenant-scoped, RLS-protected tables, GIN-indexed, **namespaced `x_<module>_`** (reserved day one). Production consensus (Citus, AWS, Odoo company-dependent JSONB, Saleor metadata). In-repo precedent: `tenant_config` stores arbitrary per-tenant JSON; emporio `template_schema`/`template_data` is a working schema-driven extensible model.
- **Structured custom entities → per-module tables**, owned by the module (module-owned migrations). Cross-module relations via **link tables** — but with explicit ownership and RLS (§G caveat), not "no FKs and hope."
- **EAV → avoid** unless custom fields must be heavily queried relationally and JSONB operators genuinely fall short.
- **Schema-per-tenant / DB-per-tenant → premium/regulated tenants only** (AWS silo/pool/bridge, applied *per module*: a finance module could be silo for a regulated tenant while everything else stays pooled). Pooled RLS is the right default.

**Install granularity = per-tenant** (`tenant_modules.active`), matching Frappe/NetSuite and Aegis's pooled-RLS reality. **Commit to this now** — mixing Odoo's DB-wide model in later is painful.

### Inter-module contracts
- **Default: async domain events** (loosest coupling, best for marketplace extensibility). Use `libs/events`. emporio's `TopicManager.register` + react-and-republish is the in-repo choreography proof.
- **Sync API only when data is needed to finish the current request** (Saleor sync webhooks: payment/tax/validation) — strict timeouts, fallbacks, retries, idempotency keys, signature verification.
- **Multi-module transactions → Saga** (orchestration/compensation), not distributed locks. oe-connect-platform's step state machine (`job_external_integration_steps`, `CreateBillBase.next_step`) + advisory-lock idempotency (`database_utils.py`) is a lift-able saga primitive.
- **Cross-module queries → CQRS read views fed by events**; never a shared DB table.
- **Standardize the envelope:** lift emporio's CloudEvents spec (`cloudeventspec.py`) as the platform-wide event contract — **plus payload-version rules** (§E.versioning), since the envelope alone doesn't solve schema evolution.

### Versioning / compatibility
- **Semver every contract** (manifest schema, event schemas, SDK, routes). `requiredKernel: "^4.0.0"` pins host compat.
- **Additive evolution only** — new optional fields with defaults; new event types rather than mutating existing. Breaking iff a previously-conforming module can now fail.
- **Event schema evolution:** payload versioning + **consumer tolerance (Postel)** + a **schema registry** + a runtime contract test for mixed-version emitter/consumer pairs. Tie to the §D.1 version-skew decision.
- **Run multiple API versions concurrently** with documented sunset windows; oe_core's `app/v1` + `external/v1` + `external/v2` is the in-repo precedent.
- **Consumer-driven contract tests (Pact)** so a kernel change can't silently break an installed module; publish a kernel/SDK **compatibility matrix**.
- **Module dependency model** (net-new): manifest `dependsOn` with semver ranges; resolve+activate dependencies first (Odoo `depends`). Today coupling (expense→approvals) is hand-wired per loader — make it declarative.

---

## F. Entitlement state machine — grant **and** revoke (NOW-phase blocker)

The naïve plan only models *purchase → grant*. Revocation, downgrade, and churn are first-class and harder. Define the full state machine before building.

**States per `(tenant, module)`:** `none → provisioning → active → past_due (grace) → suspended → deprovisioning → uninstalled`. Plus `active → upgrading/downgrading → active`.

**On grant (purchase):** order matters — **migrate → register RLS → register permissions/roles via PAP → mark entitlement active → fan out reload → open routes.** Grant permissions **only after** migrations finish (a grant that races an incomplete migration is a correctness incident). Make each step **idempotent** and resumable.

**On revoke (churn/downgrade):** the inverse is *not* symmetric:
- **Casbin grants** projected via PAP must be **revoked** (net-new — today PAP grants are effectively one-directional). Define `revokePolicyGrant()` + reload.
- **Gateway entitlement check** flips to deny **after a bounded grace period** (don't lock out a customer mid-request on a transient revoke).
- **Per-module data + RLS policies** are **retained, not dropped**, on suspend (see §G uninstall semantics); dropped only on explicit uninstall + retention-window expiry.
- **In-flight sagas** must be allowed to complete or be compensated — define per-saga drain behavior.
- **Caches** (`flag-cache`) invalidated on every transition.

**Race safety:** grant/revoke are serialized per `(tenant, module)` (advisory lock — lift oe-connect's `database_utils.py` pattern); the gateway reads a **monotonic entitlement version** so a stale cache can't re-open a revoked module.

**Freshness:** **both** webhook-driven transitions **and** periodic **pull reconciliation** against Chargebee (webhooks are best-effort; stale entitlements are a top failure mode). Define a reconciliation SLA.

**Fail modes (resolve the tension explicitly):**
- **Metering mirror → fail-open** (a Chargebee outage must not block product usage — plutus pattern) **but bounded**: cap unbilled accrual and alert, or you have an unbounded revenue leak.
- **Gateway entitlement check → fail-closed for unpurchased modules**, **fail-open within grace for already-active modules** (a cache/webhook glitch must not 402 a paying customer). Per-module grace period + circuit breaker, specified in the manifest entitlement block.

---

## G. Module data lifecycle — activation, rollback, uninstall, deletion (NOW-phase blocker)

The single most operationally dangerous omission in the naïve plan. Specify all of it.

- **Failed activation mid-migration on a shared fleet:** module migrations run in a transaction per tenant where possible; on failure, **roll back to `none`** and leave no partial schema. Migrations must be **idempotent + resumable**; a half-applied module is quarantined, not left live.
- **Down-migrations / uninstall:** uninstall **tombstones** (disables + retains data for a retention window) by default; **hard drop** of module-owned tables only after explicit confirmation + window expiry. Buying-then-churning must not leave orphan tables forever, nor silently destroy data a customer may re-subscribe to.
- **Data export on offboarding:** every module must implement a manifest-declared `export(tenant)` so a tenant can take their data on uninstall/churn.
- **Cross-module GDPR/CCPA deletion:** a tenant/user deletion request fans out (via an event) to every installed module's `deleteSubject(subjectId)`; the kernel tracks completion across module-owned schemas. This is why modules **must** own their schema and register deletion handlers.
- **Module version upgrade on a shared fleet:** version upgrade ships a forward migration that runs per active tenant; for tier-1 (lockstep) this is a fleet rollout with a kill switch; data-shape changes follow expand/contract (add column → backfill → switch reads → drop) so a rollback is always possible.

### Link tables (the Medusa caveat the red-team flagged)
"Generated join tables, no FKs" is underspecified and **in tension with the isolation claim**. Pin it down:
- A link table **belongs to the kernel** (or to the higher-trust of the two modules), carries `tenant_id`, and gets a **platform-generated RLS policy** like any other tenant table.
- No FKs means **no DB cascade** → the owning side must handle referential drift (orphan-link cleanup) via deletion-handler events, not DB constraints.
- Cross-module queries through links **stay tenant-scoped** because the link table is itself RLS-protected; never join across tenants.

---

## H. Isolation assurance gate (NOW-phase, release-blocking)

Because enforced isolation is the headline differentiator, it must be a **gate**, not a hope:
- **Platform-generated RLS** on every module-owned, tenant-scoped table (`FORCE ROW LEVEL SECURITY`, `RESTRICTIVE`, keyed on `app.current_tenant`). Authors declare tables; the kernel writes policy.
- **Automated cross-tenant leakage test** that runs in CI **per module at install/build**: seed two tenants, exercise the module's routes/queries as tenant A, assert zero rows/effects bleed to/from tenant B. Reuse the existing "Tenant B" RLS-isolation harness pattern. **No module ships without passing.**
- **Warm-process cache lint:** all in-process caches (and future WASM runtimes) must be tenant-keyed; lint for non-tenant-keyed caches aggressively (documented Forge cross-tenant warm-process leak). Never trust authors to remember.
- **Build-time architecture/dependency tests** (Nx module-boundary lint **enabled** — *not* the `'*'→'*'` escape hatch oe_core fell into) so "no module shares a table" and "modules talk only via events/API/links" are enforced, not documented.

---

## I. Entitlement + metering + billing

### Three-layer model
1. **Catalog + billing (what was bought)** → **Chargebee** (already in flight; Plutus is the WIP home, Mint deprecated). Item Family → Item (plan/addon/charge) → Item Price; a *module* = a Plan or Addon; *usage* = metered items; Feature Management types (Switch/Quantity/Range/Custom) + subscription overrides for bespoke enterprise deals. Plutus already maps `Chargebee customer.id = workspace_id`, so tenant identity is uniform across DB and biller — a head start.
2. **Entitlement source-of-truth (what is currently allowed)** → a **thin internal Entitlement Service** (net-new kernel service) consuming Chargebee webhooks + periodic pull reconciliation, writing the canonical per-tenant `tenant_modules` record (`module_id → {enabled, plan, expiry, quota, billing_status, version}`). This is the promotion of `tenant_features` from a flat boolean to an entitlement row — the repo's strongest seam, and the fix for the "fragmented entitlements, no unified API" gap the plutus migration doc itself calls out.
3. **Runtime enforcement** → in-app via the **swapped FeatureFlags reader** reading the materialized record through the existing Redis read-through cache, and at the **gateway PEP** (edge 402/403). On purchase the Entitlement Service flips Casbin perms via PAP so module roles appear instantly.

### Metering pipeline — lift the plutus dual-ledger (but harden it first)
Plutus's `UserAndWorkspaceCreditMgr.java` writes the **authoritative local Postgres ledger first**, then mirrors to the biller **asynchronously, idempotently** (`endToEndId` as operation id), **fail-open**. For Aegis:
- Each metered module writes usage to a **per-module sub-ledger** (append-only, signed — lift `CreditsMovementLog` + `SimpleCreditsMovementLogger`). This fixes plutus's "credit pool shared across all sources" gap — per-module metering needs per-module meters.
- Async mirror to Chargebee via the transparent proxy (`ChargebeeProxyController`, lift-as-is) + signed webhook ingress (`CbWebhookController`, adapt).
- oe-connect's `integration_step_transactions` + `@track_transaction` is a ready usage-event source if you meter connector invocations.

> **⚠ Hardening is a scoped prerequisite, not a caveat.** Per plutus `TECH_DEBT.md`: **zero test coverage on financial calculations**, secrets-in-VCS, Java 8 / Spring Boot 2.6, god classes, `<version>LATEST</version>` deps. Mis-metering = mischarging customers = legal/trust blast radius. Before this ledger becomes the platform's billing source-of-truth, budget a de-risking work item: **characterization tests around credit math, secrets rotation, dependency/runtime upgrade.** Treat as multi-quarter, not an "L" line.

### Build-vs-buy verdict (specific to SiteRecon)
**Reuse Plutus + Chargebee; do NOT add Stripe Entitlements / Lago / OpenMeter / Orb now.**
- **Catalog + collection + invoicing + dunning + tax → Chargebee (BUY, in flight).** Never build.
- **Entitlement source-of-truth → BUILD the thin materialization service** on Chargebee Feature Management (buy-then-build) so you're insulated from vendor specifics.
- **Runtime enforcement → BUILD in-app** (swap the reader; reuse cache); optionally wrap behind **OpenFeature** for portability. Permit.io only if you later need per-resource ReBAC beyond Casbin (you likely don't).
- **Metering → reuse the plutus dual-ledger.** Add a point tool (**Orb** fastest, or **OpenMeter** Apache-2.0 self-host) **only if/when** Chargebee metering can't handle high-volume or rapidly-evolving metrics (e.g. AI-agent token billing). Prefer raw-event over pre-aggregated for retroactive repricing. **Avoid Metronome/m3ter** (now Stripe/Salesforce; enterprise/overkill).
- **Cost watch-out:** Chargebee ~0.75% / Stripe ~0.7% on billing *volume* is the pressure point that later justifies moving *metering* (not collection) to Orb/OpenMeter while keeping Chargebee for money movement.

---

## J. Security & compliance track (NOW-phase — product-defining, not a detail)

You cannot sell "governance-first / audit + SoD" to mid-market finance without proof, or name a healthcare pack without a BAA path.
- **Certifications roadmap:** SOC 2 Type II (table stakes for the finance buyer) → ISO 27001 → (healthcare) HIPAA with a signed **BAA**; PCI scope minimized by never touching card data (Chargebee/Stripe hold it).
- **Audit-ledger spec (make it real):** hash-chaining scheme, **signing key management** (rotation, HSM/KMS), WORM/retention policy, and a documented **auditor verification procedure** (how a third party independently verifies the chain). "Tamper-evident" must be a spec, not an adjective.
- **Data residency:** per-tenant residency answered via the silo-isolation SKU (schema/DB-per-tenant) for regulated modules/tenants.
- **Pen-testing + third-party module security review** as a release gate for tiers 2/3.

---

## K. Modular-fleet operability (NOW/NEXT — dominates operational cost)

With N modules × M tenants × trust tiers, operational cost is dominated by debuggability:
- **Distributed tracing** across gateway → module → event → saga (correlation id already exists in `service-core`; extend to event/saga hops). Put basic tracing in the **NOW** phase.
- **Per-module SLOs + error budgets**; "which module broke this tenant" triage tooling.
- **Support workflow to reproduce a tenant issue without cross-tenant data access** (scoped impersonation via token exchange + audit of every support access).
- **Per-module health** surfaced to the existing dashboard.

**UI trust mapping (hard-enforce):** Module Federation is **not a security boundary** — only trusted (1P) code rides the shell origin. **Partner/untrusted UI must be iframe-isolated** (separate origin); loading partner JS into the shell origin is an XSS/token-theft path to the whole tenant session.

---

## L. Casbin scale validation (NOW-phase task — don't defer)

The plan bets everything on Casbin but never load-tests it. Projecting every module's perms/roles per tenant into live Casbin, fanned out cross-pod via `watcher.ts` on every purchase, has unknown scaling behavior.
- **Benchmark enforcement latency + watcher reload behavior** at target counts (e.g. 10k tenants × dozens of modules × roles). Define the **policy-count ceiling**.
- **Document a fallback** if it doesn't hold: sharded/scoped Casbin models per tenant, decision-cache tuning, or an alternative PDP. Do this **before** GA, not after.

---

## M. Marketplace & ecosystem — and the decision gate

> **★ Decision gate (START of NEXT phase, before SDK extraction):** *first-party suite + curated partners* **vs** *open third-party ecosystem.* This single decision sizes the manifest, SDK, sandbox, and rev-share by an order of magnitude. The plan must not build the open-ecosystem contract before answering it.

Assuming a phased ecosystem:
- **Phase 1 — first-party catalog ("app switcher").** No rev share, no external devs. Lift oe_core's `AppListDB` + app-switcher as the catalog/UI skeleton. Validates install→entitle→bill→activate end to end with zero ecosystem risk.
- **Phase 2 — curated partner program (tier-2).** Hand-picked ISVs build out-of-process modules against the manifest + signed-webhook contract; manual onboarding/review. Copy Saleor's two-endpoint install handshake.
- **Phase 3 — open developer platform.** Self-serve SDK, public manifest, **mandatory security review** (automated manifest/permission/egress lint + human gate), tier-3 sandboxing, revenue share.

**Revenue share as a steering lever, not a flat tax:** index take-rate to the trust tier you want — low/zero for sandboxed Aegis-hosted (your preferred tier), higher for partner-hosted (Atlassian Forge 0% on first $1M lifetime vs Connect's higher rate is the model). Offer **platform-managed entitlement + freemium** ("install free, gate premium by license") as a dev perk (Salesforce LMA model). Borrow Backstage's `withOverrides` so integrators can decorate/replace extensions without forking.

---

## N. Multi-industry module catalog

### Horizontal modules (cross-industry)

| Module | Status | Source to lift |
|---|---|---|
| **Identity & AuthZ** (RBAC/ABAC/RLS, PAP, SCIM) | **EXISTS — becomes kernel** | `libs/access-control`, `apps/user-management`, `pap.service.ts` (always-on, not sold) |
| **Approvals / workflow** | **EXISTS (partial) + LIFT** | `@aegis/approvals` + oe_core `approval-policy/` (multi-step, reassignment, hierarchy, currency-scoped) — flagship horizontal |
| **Audit / compliance** | **EXISTS (partial) → promote** | plutus `CreditsMovementLog` + mint `audit_log_service` + oe-connect `integration_step_transactions` → kernel ledger + sold "compliance/SoD reporting" module |
| **Finance controls** (expense, invoice, payroll, AP recon, GL coding) | **EXISTS** | Aegis `apps/expense\|invoice\|payroll`; oe_core invoice/PO matching, GL coding, dispute/shortpay = **crown-jewel first paid module** |
| **Connectors / integrations** | **EXISTS** | `libs/connectors` + oe-connect adapter factory, encrypted credential store (`credentials_manager.py`, Fernet), retry/refresh decorators, stuck-job reconciliation |
| **Notifications** | **EXISTS** | `apps/notification`; emporio n8n fan-out as a no-code/external bridge |
| **Reporting / analytics** | **EXISTS (partial)** | `apps/reporting`; needs CQRS read-views fed by events for cross-module reporting |
| **Workflow automation** | **PARTIAL → LIFT** | emporio `TopicManager` choreography + n8n bridge; oe-connect step state machine |
| **AI-agent governance** | **NET-NEW** | see §Q — the differentiated bet, but currently a slogan; spec or demote |

### Vertical packs (net-new as a concept)
A pack = curated bundle of horizontals + 1–2 vertical-specific modules, sold as a starter SKU.

| Vertical | Bundle | Status |
|---|---|---|
| **Fintech / AP automation** | finance-controls + AP-recon + approvals + audit + ERP connectors | modules EXIST (Aegis + oe_core + oe-connect); **pack net-new** |
| **Construction / field-services** (SiteRecon's home) | workflow + approvals + connectors + reporting + per-acre/usage metering | metering EXISTS (plutus `SitescopePricingCalculator` per-acre); templating EXISTS (emporio); **pack net-new** |
| **Professional services** | approvals + finance-controls (light) + reporting + notifications | modules EXIST; **pack net-new** |
| **Healthcare** | audit/compliance (silo per tenant) + identity + approvals | identity/audit EXIST; **silo SKU + HIPAA controls net-new** |

**GTM lead:** Fintech/AP pack (deepest existing logic, crown jewel) + Construction pack (SiteRecon dogfoods it). Defer healthcare until silo isolation + BAA are productized.

---

## O. Pricing & packaging (needs a real strategy, not a skeleton)

Open work — sketch to fill in with finance/GTM:
- **Tier boundary:** what's in the always-free **kernel** (identity/authz/isolation/audit-view?) vs the first paid module. Resolve whether identity/audit are free (land) or paid (monetize the differentiator).
- **Pricing axes:** per-seat vs per-module flat vs usage (metered) — most modules are a **per-module base + per-seat + optional usage** blend; pure usage only for AI-agent/connector-call modules.
- **Vertical-pack bundle discount** vs à-la-carte module sum (steer toward packs without cannibalizing module revenue).
- **Cannibalization analysis:** does per-module pricing undercut SiteRecon's *current* bundled offering? Model the migration of existing customers (grandfathering, migration pricing).
- **Competitive anchors:** price the AP/finance pack against NetSuite (high) and Odoo (low) for the named persona; position as "controls without the implementation."

---

## P. Existing-tenant migration (NOW-phase — high blast radius)

Migrating live Aegis tenants onto the manifest/entitlement model is a production access-control migration, with its own runbook:
- **Back-fill** the flat `tenant_features` booleans into entitlement rows (`tenant_modules`) for every existing tenant; today's always-on features become entitlement-gated **without** changing behavior on day one (grant everyone everything they currently have).
- **Dark-launch / shadow mode** for the gateway entitlement check: log "would 402" decisions for weeks **before** it can actually block anyone; diff against expected.
- **Fleet kill-switch** to disable entitlement enforcement instantly if it wrongly 402s a paying customer.
- **Rollback criteria** defined up front; the gateway check ships behind its own flag.

---

## Q. AI-agent governance — spec or demote

Pitched as *the* differentiated bet but currently one table row. Either give it a one-page design or demote it to a research spike. Minimum design surface:
- **Agent identity lifecycle** — agents as first-class Casbin principals with scoped, short-lived credentials; provisioning/rotation/revocation.
- **Mapping non-deterministic actions → discrete authz checks** at every tool/action boundary (the agent's "tool call" is a PEP-guarded request).
- **Prompt-injection privilege-escalation defense** — capability scoping so a hijacked agent can't exceed its grant; human-in-the-loop approval gates (reuse `@aegis/approvals`) for high-risk actions.
- **Metering** — token vs action billing on the dual-ledger; per-agent audit timeline; "why was this agent allowed?" explanations (the audit ledger already captures permissions-at-time-of-action).
- Aligns with market (Stripe/Metronome AI metering, Salesforce Agentforce). The Aegis bones (PEP/PDP, approvals, internal JWT, eventing, audit chain, connector actions) are unusually well-suited.

---

## R. Build plan & roadmap (revised — blockers elevated to NOW)

### NOW (0–3 months) — "entitlement substrate + safety rails"
| Deliverable | Lift from | Effort |
|---|---|---|
| Module catalog + `tenant_modules` activation table | `connectors/registry.ts` + `connector_configs` (0026); oe-connect `integration_options→customer_integrations` | M |
| Promote `tenant_features` → entitlement rows (module_id, plan, expiry, quota, billing_status, version) | `tenant-feature.model.ts`, migration 0010 | M |
| Swap FeatureFlags reader → Entitlement Service reader (most gating unchanged) | `feature-flags-reader.ts`, `flag-cache.ts` | S |
| Gateway entitlement enforcement (data-driven ROUTES + 402/403) **behind a flag, shadow-mode first** | `routes-config.ts`, `proxy.ts` | M |
| **Entitlement state machine: grant + revoke/churn (§F), race-safe, reconciled** | net-new + oe-connect advisory locks | L |
| `module.enabled/disabled` + `entitlement.changed` topics | `libs/events/topics.ts`, outbox | S |
| Runtime permission **grant + revoke** registration | `pap.service.ts`, `applyPolicyGrant` (+ new `revokePolicyGrant`), `watcher.ts` | M |
| Entitlement Service ↔ Chargebee (webhook ingress + reconcile + dual-ledger mirror) | plutus `CbWebhookHandler`, `ChargebeeProxyController`, `UserAndWorkspaceCreditMgr`, `CreditsMovementLog` | L |
| **★ Isolation assurance gate (§H): platform-generated RLS + CI cross-tenant leak test + boundary lint ON** | `libs/db/rls.ts`, Tenant-B harness | M |
| **★ Existing-tenant migration runbook (§P): back-fill, shadow-mode, kill-switch** | net-new | M |
| **★ Casbin scale benchmark + fallback plan (§L)** | net-new | S |
| **Plutus ledger hardening** (characterization tests, secrets, runtime upgrade) — prerequisite to billing GA | plutus | L (multi-qtr) |
| Distributed tracing across gateway→module→event (§K, basic) | `service-core` correlation id | M |
| Security/compliance kickoff: SOC 2 scoping + audit-ledger spec (§J) | net-new | M |

**Milestone — "first paid module":** package `expense` end-to-end (entitlement-gated, metered, Chargebee-billed, RLS-gated, shadow-migrated for existing tenants).

### NEXT (3–9 months) — "extract the SDK + manifest" *(gated by the §M decision)*
| Deliverable | Lift from | Effort |
|---|---|---|
| **★ Decision gate: first-party+partners vs open ecosystem (§M)** | — | — |
| **★ Extract `aegis.module.json` manifest + SDK + module loader** (DI/routes/events/perms/migrations/UI; phase-scoped lifecycle) | `createService()`, `registerApprovalProviders`; Backstage/Saleor | L |
| Per-module migration runner (activation-scoped, namespaced, rollback-safe §G) | `apps/cli` Umzug | M |
| Module data lifecycle: uninstall/tombstone, export, GDPR fan-out, link-table RLS (§G) | net-new | L |
| Module dependency resolution (`dependsOn`, semver, install order) | Odoo `depends`; oe-connect `ERPEntitiesFactory` | M |
| JSONB custom-fields + `x_*` namespacing | `tenant_config.model.ts`, emporio `template_schema`; Medusa links | M |
| CloudEvents envelope + payload-version rules + schema registry (§E) | emporio `cloudeventspec.py` | M |
| First-party catalog UI (app switcher) | oe_core `AppListDB` | M |
| Repackage `approvals` + `audit` as manifest-driven modules | `@aegis/approvals`, oe_core `approval-policy/`, plutus ledger | L |
| Pact contract tests + compatibility matrix | net-new | M |
| Per-module SLOs + tenant-debug support workflow (§K) | net-new | M |

**Milestone:** two modules (`expense`, `approvals`) running purely through the manifest/SDK; adding a third needs no core edits.

### LATER (9–18 months) — "ecosystem + verticals"
| Deliverable | Effort |
|---|---|
| Micro-frontend shell + Module Federation (1P/partner); **iframe path for untrusted** | L |
| Partner program (tier-2) + signed-webhook contract + Saleor install handshake | L |
| Vertical packs (Fintech/AP, Construction) as bundle SKUs | M |
| Sandboxing (tier-3): WASM/WASI + egress proxy + remote-dom UI | XL |
| Public marketplace + revenue share + security-review pipeline | L |
| AI-agent governance module (§Q) | L |
| Silo-isolation enterprise SKU (schema/DB-per-tenant for regulated modules) | L |

---

## S. Build-vs-buy summary

| Capability | Verdict | What to use |
|---|---|---|
| Billing (collection/invoicing/dunning/tax) | **Buy** | Chargebee (in flight). Never build. |
| Entitlement source-of-truth | **Buy-then-build** | Chargebee Feature Mgmt + thin `tenant_modules` materialization service |
| Metering | **Build on existing** (buy point-tool at scale) | plutus dual-ledger; add Orb/OpenMeter only if Chargebee insufficient. Avoid Metronome/m3ter |
| Feature flags / per-tenant activation | **Build (reuse)** + optional OpenFeature wrapper | `FeatureFlags` + reader + cache |
| Identity / authZ | **Build (already built)** | `libs/access-control` Casbin RBAC/ABAC/RLS + PAP. Never outsource — the differentiator |
| Tenant isolation + data model | **Build (already built)** | Postgres RLS + `withTenantTransaction` + JSONB; must be CI-tested for leakage |
| Module manifest + install pipeline | **Build** | the product's differentiator; model on Saleor JSON + Shopify TOML |
| Inter-module event bus | **Buy/managed broker; build contracts** | Kafka (`libs/events`) + outbox; build event contracts + Pact |
| Sandboxing (3P untrusted) | **OSS substrate; build host layer** | Wasmtime/Wasmer + Web Worker remote-dom; build egress proxy + capability grants |
| Micro-frontends | **OSS self-host** | Module Federation / Web Components; iframe for untrusted (not a security boundary) |
| Marketplace storefront + payouts | **Buy-then-build** | simple catalog + Chargebee payments first; transactional storefront only at ISV volume |

---

## T. Open decisions (need owner input — these gate the build)

1. **Ecosystem ambition:** first-party suite + curated partners, **or** open third-party marketplace? *(Sizes the entire NEXT phase. Decide before SDK extraction.)*
2. **Install model for enterprise/silo tenants:** do regulated (schema/DB-per-tenant) tenants get a different install/versioning model than pooled tenants?
3. **Kernel-free boundary:** are identity + audit-view free (land-grab) or part of a paid base? (Drives §O pricing.)
4. **Cannibalization:** does per-module pricing undercut SiteRecon's current bundled offering, and what's the existing-customer migration/grandfathering policy?
5. **AI-agent governance:** strategic wedge to design now (§Q), or a later research spike?
6. **Org model:** is there a dedicated platform team to own the kernel/SDK as an internal product (Team Topologies "Thinnest Viable Platform")? *(The red-team's base-rate failure prediction: without this, boundaries erode exactly as oe_core's did — 709 cross-cutting migrations, disabled boundary lint.)*
7. **Chargebee-migration coupling:** platform GA depends on the in-flight Plutus/Chargebee migration. Acceptable, or do we need a contingency if it slips?

---

## Appendix — reference-repo asset map (what to lift from where)

- **aegis** — kernel: `access-control` (PEP/PAP/watcher), `db` (RLS/withTenantTransaction), `events` (bus/outbox), `connectors` (registry pattern), `service-core` (createService DI), `tenant_features`/`tenant_config`, gateway ROUTES.
- **oe_core (OpenEnvoy)** — Nx modular-monorepo structure; deep `approval-policy/` engine; invoice/PO matching, GL coding, dispute/shortpay (finance crown jewel); `AppListDB`/app-switcher (catalog UI); multi-version API trees (`v1`/`external/v1`/`v2`). *Cautionary:* 709 cross-cutting migrations, 150-model `DatabaseContext`, disabled boundary lint — what to **avoid**.
- **oe-connect-platform** — connector adapter factory; encrypted credential store (`credentials_manager.py`, Fernet); retry/refresh/reconcile decorators; **step state machine + advisory-lock idempotency** (saga primitive); per-step `integration_step_transactions` audit ledger.
- **plutus (current) + mint (deprecated)** — **dual-ledger mirror** (authoritative local → async idempotent fail-open mirror), `CreditsMovementLog` append-only ledger, `CbWebhookController`/`ChargebeeProxyController`, `customer.id=workspace_id` mapping, per-acre `SitescopePricingCalculator`. *Hardening prerequisite per `TECH_DEBT.md`.*
- **emporio** — PubNub listener + subsystem-worker pattern; `TopicManager.register` react-and-republish choreography; **CloudEvents spec** (`cloudeventspec.py`); schema-driven `template_schema`/`template_data` (data extensibility); n8n no-code fan-out bridge.
