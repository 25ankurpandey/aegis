# A4 — Cross-Cutting Fidelity Audit (architecture reference → Aegis service-core)

**Track:** A (architecture-reference fidelity)
**Area:** cross-cutting — middleware band, request/response context, error handling/envelope, cache/Redis client, constants/config, secrets, http client.
**Reference:** the architecture reference (+ its vendored shared service-util package)
**Ours:** `libs/service-core/src/**`
**Date:** 2026-06-26

---

## 0. Method note / caveat

The architecture reference's cross-cutting machinery is **not all in the repo**. The reference delegates most of its band to a vendored
shared service-util package (`ContextManager`, `ReqContextManager`, `ReqResMiddleware`, `AuthMiddleware`,
`HttpClient`, `AerospikeAdapter`, `ErrUtils`, `Logger`, `ValidationUtils`, `ConfigProviderFactory`). That
package is **not installed** under `node_modules` in the checkout, so the contract is reconstructed from its
**call sites** (`bootstrap.ts:1-101`, `util.ts:1-205`, controllers, `Constants.ts`). Where I infer behaviour
of an unreadable symbol I say so explicitly. Everything attributed to the *local* reference source is exact file:line.

---

## 1. Middleware ORDER — strong match, one real gap

**Reference band** (architecture reference `src/bootstrap.ts:66-123`, in `server.setConfig`):
```
compression → disable etag → cors → urlencoded(15mb) → swaggerUI
→ ContextManager.init → HttpClient.init → ReqContextManager.registerWithReqContextManager
→ AuthMiddleware.checkAuth → bodyParser.json(15mb) → isTenantEnabled → ReqResMiddleware.reqResLog
→ express-request-audit
→ [setErrorConfig] terminal error handler   (bootstrap.ts:124-161)
```

**Our band** (`service-core/src/bootstrap/bootstrap.ts:20-31`, `applyCoreMiddleware`):
```
disable x-powered-by → helmet → contextMiddleware (opens ALS) → express.json(5mb) → requestLogMiddleware
→ [configure()] service routes/PEP/docs
→ [setErrorConfig] errorMiddleware            (bootstrap.ts:29-31)
```

What matches well, with evidence:

- **Context opens before everything that needs it.** The reference calls `ReqContextManager.registerWithReqContextManager`
  early (`bootstrap.ts:93`); ours runs `contextMiddleware` first in the band (`bootstrap.ts:23`,
  `context.middleware.ts:71` opens the ALS scope via `RequestContext.run`). ✅ Faithful and arguably cleaner.
- **Single terminal error handler via `setErrorConfig`.** The reference `bootstrap.ts:124`; ours `bootstrap.ts:29-31`
  + `attachErrorHandler`. Same InversifyExpressServer idiom. ✅
- **Health excluded from the band.** The reference excludes `/health` + `/api-docs` from req-context and tenant checks
  (`bootstrap.ts:93-96`, `util.ts:43-48` `Urls_To_Exclude`); ours excludes `/health` by default
  (`bootstrap.ts:74-77`, `context.middleware.ts:41-43`). ✅
- **Body limit present** (reference 15mb `bootstrap.ts:99`; ours configurable, default 5mb `bootstrap.ts:24`). ✅ (limit value is a justified product choice.)

**Divergence — auth in the band.** The reference mounts `AuthMiddleware.checkAuth` *inside the shared band*
(`bootstrap.ts:98`), so every service gets authn for free in a fixed slot **before** `bodyParser.json`,
`isTenantEnabled` and logging. Ours deliberately does **not**: `applyCoreMiddleware` ends at `requestLogMiddleware`
and the PEP/authz guards are left to each service's `configure()` (`bootstrap.ts:46-49` doc, and the user-mgmt
root `apps/user-management/src/bootstrap.ts:16` passes no auth). This is **justified** for a per-route Casbin PEP
model (authz is decision-per-resource, not a single gate), **but** it means the *ordering guarantee the reference
enforces centrally is now a per-service convention* — nothing in `service-core` forces the PEP to sit before
routes. See §9 D-1.

---

## 2. Request context (AsyncLocalStorage) — faithful upgrade, mostly justified

The reference uses `ReqContextManager` over a cls-hooked namespace (inferred — `util.ts:26,32,41` read
`ReqContextManager.X_PROJECT / X_TENANT_ID / getTenantId() / getEntryContextId() / getRequestId() / CALLER /
ENTRY_CONTEXT`). Ours replaces it with native `AsyncLocalStorage` (`request-context.ts:1-71`,
`context.types.ts:1-26`). The migration note is explicit (`request-context.ts:5-8`).

Strengths vs reference:

- **Native ALS, no cls-hooked dependency** — `request-context.ts:11`. ✅ Modern, fewer monkeypatch hazards.
- **Fail-closed `get()`** throws outside scope (`request-context.ts:19-24`), `tryGet()` for off-path (logger)
  (`request-context.ts:28-30`). The reference's manager is implicitly fail-soft (callers like `util.ts:41`
  assume a tenant is present). ✅ Stronger.
- **Strict header validation, fail-closed** — reference reconstructs the request-id/tenant from headers inside its
  manager; ours validates `X-Tenant-Id` presence **and** UUID shape (`context.middleware.ts:54-57`) and refuses
  to default to `"UNKNOWN"` (`context.middleware.ts:15-22`). ✅ This is a genuine hardening over the reference idiom.
- **Correlation propagation on outbound calls** — `http-client.ts:44-49` copies `tenantId`/`correlationId`/
  `caller`/`token` onto every internal hop. The reference does the same manually per call (`util.ts:191,219-223`
  set `CALLER`/`ENTRY_CONTEXT`). Ours is centralised → **better**. ✅

Divergences:

- **No `entryContextId`** — the reference's context carries an entry-context id used pervasively for cache keys and
  config resolution (`util.ts:103,150,185`, `generateCacheKey`). Ours drops it intentionally
  (`context.types.ts:3-4` "no entry-context"). **Justified**: entry-context is a reference-specific multi-EC concept
  with no Aegis analogue; tenant is the scoping axis here.
- **No `requestId` distinct from `correlationId`** — reference exposes `getRequestId()` (`bootstrap.ts:370`).
  Ours collapses to a single `correlationId` (`context.types.ts:14-15`). **Justified** and documented
  (`request-context.ts:5-8`, `context.types.ts:4` "no reference request-id header"); arguably cleaner.

---

## 3. Error handling / envelope — faithful, slightly improved, one regression

**Envelope shape — faithful.** The reference terminal handler emits `{ errors: [ { code, code_str, details,
display_message, type, trace_id } ] }` (`bootstrap.ts:136-151`, mirrored in `util.ts:90-99 errorResponse`).
Ours emits `{ errors: [ { code, type, message, details, correlationId } ] }`
(`error.middleware.ts:7-15,28-40`). Same `{ errors: [...] }` array contract. ✅

Mapping of fields:

| reference field          | ours                     | classification |
|----------------------|--------------------------|----------------|
| `code` (numeric)     | `code` (`E_*` string)    | justified (stable string codes, `error-utils.ts:20-29`) |
| `code_str`           | folded into `code`       | justified |
| `type`               | `type` (`ErrorType` enum)| ✅ faithful (`error-utils.ts:4-13`) |
| `details`            | `details`                | ✅ |
| `trace_id`           | `correlationId`          | ✅ renamed, same intent |
| `display_message`    | **(absent)**             | **regression** — see below |

Strengths:

- **One throw type, typed map** — `AppError` + `ERROR_MAP` (`error-utils.ts:20-50`) is cleaner than the reference's
  loosely-typed `err.code/err.status/err.type` strings. ✅
- **Unknown-error normalisation** — `error.middleware.ts:22-24` coerces any thrown value to `system`. The reference
  falls back to status 500 (`bootstrap.ts:153-157`) but logs raw. Ours is tidier. ✅
- **correlationId backfill** from context if the error didn't capture it (`error.middleware.ts:35`). ✅

Regressions / gaps:

- **D-2 (regression): no `display_message`.** The reference *always* returns a user-safe
  `"Sorry! Something went wrong!"` string (`bootstrap.ts:147`, `util.ts:95`) deliberately decoupled from the
  raw `message`. Ours puts the **raw `appErr.message` straight into the envelope** (`error.middleware.ts:32`).
  For unmapped/system errors that message is `err.message` of the original throw (`error.middleware.ts:24`),
  which can **leak internal detail** (DB strings, stack-adjacent text) to API clients. The reference's two-field
  split (internal `message`/`details` logged; safe `display_message` returned) is the better practice we lost.
- **D-3 (regression): reference masks validation `details` to `{message,path}` only** (`bootstrap.ts:140-146`);
  ours returns Joi `details` verbatim (`validation.middleware.ts:29`, passed through `error.middleware.ts:32`).
  Joi details include the offending `context.value`, so **submitted values can echo back** in 400s. Minor but
  real info-shaping regression.

---

## 4. Success/response shaping — MISSING shared helper

The reference has **shared response helpers**: `getFormattedPagingData` returns `{ data, meta:{ total_count, page_size,
page_no } }` (`util.ts:64-78`) and `getPagination` (`util.ts:57-62`). Controllers use a consistent paged shape.

Ours: **no success envelope or pagination helper exists in `service-core`** (the `index.ts:6-21` barrel has no
response module; grep for `ResponseUtils/sendSuccess/successEnvelope` in `service-core` → none). Each controller
hand-rolls `res.json(...)` (e.g. `apps/user-management/src/controllers/health.controller.ts:13-18`). So we have a
**standardised error envelope but no standardised success/pagination envelope** — an asymmetry the reference doesn't
have. **Missing** (low/med). See §9 D-4.

---

## 5. Cache / Redis adapter — works, but thinner than reference

The reference `AerospikeAdapter` (vendored, inferred from `util.ts:130,185-197,229`, `bootstrap.ts:348-352`) exposes:
`init/initLocal` (per-tenant + per-EC config, `bootstrap.ts:348-352`), `getKey(setName,key)` (namespaced key
derivation), `get/set(key,val,TTL)`, `truncateSetbyName`, `isConnected()` (health, `Healthcheck.ts:69`). The
service layers a **key-derivation convention** on top (`util.ts:101-131 generateCacheKey`, set→key mapping
`Constants.ts:144-163`, TTL constants `Constants.ts:151-155`).

Ours `CacheAdapter` (`cache-adapter.ts:1-44`): `init(url)`, `get/set/del`, `ping`. ioredis, lazyConnect,
`maxRetriesPerRequest:2`.

Comparison:

- **`get/set(ttl)/del/ping`** — present and clean (`cache-adapter.ts:19-43`). `ping` maps to the reference's
  `isConnected()` used in health. ✅
- **D-5 (regression-ish / missing): no tenant/scope-aware key helper.** The reference *never* lets call sites build
  raw keys — `generateCacheKey`/`getKey` force a namespaced, EC-scoped key (`util.ts:101-131`). Ours only
  documents the intent in a comment ("Keys should be tenant- and access-scope-aware at call sites",
  `cache-adapter.ts:4`) and provides **no helper to enforce it**. In a multi-tenant RLS platform an unscoped
  cache key is a **cross-tenant data-leak footgun**. The reference's enforced-key pattern is the better practice.
- **D-6 (missing): no TTL/keyspace constants, no bulk invalidation.** The reference has `Cache_Expiration_Config`
  (`Constants.ts:151-155`) and `clearCache`/`truncateSetbyName` for event-driven invalidation
  (`util.ts:133-145`, `Constants.ts:156-163 Event_Cache_Set_Mapping`). Ours has neither — no `clear`/`scan`/
  `mdel`, no TTL policy. Acceptable for now but a real enterprise gap once caching is used widely.

---

## 6. HTTP client (outbound) — good context propagation, MISSING resilience

The reference's HTTP client `init(name)` + `call(host, uri, options)` (`bootstrap.ts:92`, `util.ts:193,225`,
`bootstrap.ts:191`). Inferred to centralise outbound calls with caller headers; resolves host from env-var
*names* (`Constants.ts:21-27` `..._HOST` keys).

Ours `HttpClient` (`http-client.ts:30-83`):

- **Context propagation** — copies tenant/correlation/caller/token + signs an internal token
  (`http-client.ts:37-51`). ✅ Better than the reference's manual per-call header building (`util.ts:191,219-223`).
- **Service-registry URL resolution** via `ServiceName→ENV` map (`http-client.ts:8-17,54`). ✅ Cleaner than
  the reference's stringly host constants.
- **D-7 (regression/missing): no timeout, no retry, no circuit-breaker on outbound.** `http-client.ts:70-74`
  is a bare `fetch` with **no `AbortSignal`/timeout**, no retry/backoff. The reference service ships explicit
  retry strategy config (`Constants.ts:164-167 Retry_Strategies`, `interfaces/Serviceability RetryConfig`),
  and the reference HTTP client is the kind of shared client that normally carries timeouts. A hung downstream will pin a
  request indefinitely. **This is the single most important outbound-resilience gap.**
- **D-8 (missing): the gateway reverse-proxy also has no timeout.** `apps/gateway/src/proxy.ts` (grep: no
  `timeout/AbortController/setTimeout`). The gateway is the front door; an unbounded upstream call there is a
  cascading-failure risk.

---

## 7. Config / secrets — minimal but adequate, with gaps

The reference: `ConfigProviderFactory.init([secretKeys], [])` then `getSecretsProvider().getSecret(key)`
(`bootstrap.ts:45-48,329,350`), with **fail-fast validation** of required env at boot
(`ValidationUtils.validateStringNotEmpty(process.env.ENVIRONMENT,…)` `bootstrap.ts:40-43`), and `process.exit()`
on any infra connect failure (`bootstrap.ts:204,312,337,357`).

Ours: `Config` typed accessors (`config.ts:4-29`: `get/require/int/bool/isLocal`) + `Secrets` seam
(`secrets.ts:8-18`, env-backed locally, doc says swap for param-store).

- **Typed accessors** (`config.ts:15-25`) are an improvement over the reference's ad-hoc `process.env` + JSON.parse
  scattered everywhere (`util.ts:42,152,246`, `bootstrap.ts:172-180`). ✅
- **Secrets seam** with a clean interface to swap in a param store (`secrets.ts:3-7`) mirrors the reference's
  `ConfigProviderFactory` intent. ✅ (Currently env-only — fine for the stated local-first posture.)
- **D-9 (missing): no boot-time required-config validation gate.** The reference validates required env BEFORE
  connecting (`bootstrap.ts:40-48`). Ours validates lazily — `Config.require` only throws **when first read**
  (`config.ts:8-13`). A service can boot and accept traffic with missing critical config, failing on the first
  request that touches it instead of refusing to start. The reference's fail-fast-at-boot is the better practice.
- **D-10 (justified): no `process.exit()` shotgun.** The reference `process.exit()` on every connect error
  (`bootstrap.ts:204,312,337,357`) is crude; ours throws to a single top-level catch
  (`apps/user-management/src/bootstrap.ts:20-25`). Justified improvement.

---

## 8. Operational concerns the reference handles that we miss

| Concern | The reference | Ours | Class |
|---|---|---|---|
| **Health w/ dependency checks** | deep: db `select 1` per tenant + aerospike `isConnected` + suicide-timer (`Healthcheck.ts:30-78`) | `?details=true` → `pingDb()`+`CacheAdapter.ping()`, 503 on degraded (`health.controller.ts:16-18`) | ✅ **match** (good) |
| **Liveness vs readiness split** | single endpoint, details flag | single endpoint, details flag | ✅ parity (neither splits `/livez` vs `/readyz`) |
| **Graceful shutdown (SIGTERM)** | "suicide timer" pauses consumers + flips health to down before restart (`util.ts:325-353`, `Healthcheck.ts:30-33`) — drains in-flight | **NONE.** `closeSequelize` (`libs/db/src/connection.ts:27`) and bus `stop()` (`libs/events/src/kafka-bus.ts:166-181`) **exist but are never wired** — grep `process.on/SIGTERM/SIGINT` across `apps`+`libs` → **zero hits** | **D-11 missing (high)** |
| **Outbound request timeout** | retry config present (`Constants.ts:164-167`) | none (§6 D-7) | missing |
| **Idempotency** | n/a in reference band | header key defined (`http-header-key.enum.ts`) + used in domain services (pay-run/invoice/notification) but **no idempotency middleware** | **D-12 missing (med)** |
| **Request/response audit** | `express-request-audit` middleware → DB `RequestAudit` table, masks `authorization`, excludes `health` (`bootstrap.ts:101-123,360-377`) | only domain "activity" tables; **no cross-cutting HTTP audit middleware** (grep) | **D-13 missing (med)** |
| **Req/Resp logging** | `ReqResMiddleware.reqResLog` (`bootstrap.ts:101`) | `requestLogMiddleware` logs method/path/status/duration on `finish` (`request-log.middleware.ts:5-15`) | ✅ match |
| **Security headers** | only `disable etag` + cors (`bootstrap.ts:68-69`) | `helmet()` + `disable x-powered-by` (`bootstrap.ts:21-22`) | ✅ **better than reference** |
| **CORS** | `cors()` open (`bootstrap.ts:69`) | **not in core band** | D-14 missing (low) — add explicit CORS policy where browser-facing |
| **Structured logger + correlation enrich** | `Logger` vendored, alert() channel (`bootstrap.ts:232,250`) | pino + auto context enrich (`logger.ts:20-33`) | ✅ match; **D-15 (missing, low):** no `Logger.alert()` ops-alert channel like reference (`bootstrap.ts:232-240`) |

---

## 9. Divergence ledger (classified)

- **D-1** PEP/auth ordering left to per-service `configure()` instead of enforced in the band — **justified**
  (per-route Casbin model) but add a guard/lint so it can't be mis-ordered. (high-value, low effort)
- **D-2** Error envelope lacks `display_message`; raw `err.message` returned for system errors → info leak —
  **regression** (high).
- **D-3** Validation `details` returned verbatim (Joi `context.value` echoes input) — **regression** (medium).
- **D-4** No shared success/pagination envelope helper (reference `getFormattedPagingData`) — **missing** (low).
- **D-5** Cache adapter has no enforced tenant/scope-aware key helper (reference `generateCacheKey`/`getKey`) →
  cross-tenant leak risk — **regression** (high).
- **D-6** No cache TTL constants / bulk-invalidation (`clearCache`, `Event_Cache_Set_Mapping`) — **missing** (medium).
- **D-7** Outbound `HttpClient` has no timeout/retry/breaker — **regression** (high).
- **D-8** Gateway reverse-proxy has no upstream timeout — **missing** (high).
- **D-9** No boot-time required-config validation gate (reference validates before connect) — **missing** (medium).
- **D-10** Replacing reference `process.exit()` with top-level throw — **justified** (improvement).
- **D-11** No SIGTERM/graceful-shutdown wiring despite `closeSequelize` + bus `stop()` existing — **missing** (high).
- **D-12** Idempotency is header+domain-level only; no idempotency middleware/replay-guard — **missing** (medium).
- **D-13** No cross-cutting HTTP request/response audit middleware (reference `express-request-audit`→DB) — **missing** (medium).
- **D-14** No CORS policy in core band — **missing** (low).
- **D-15** No `Logger.alert()` ops-alert channel — **missing** (low).

**Justified (kept or improved):** native ALS over cls-hooked (§2); fail-closed context + UUID tenant check
(§2); typed `AppError`/`ErrorType` map (§3); centralised correlation propagation on outbound (§2/§6);
service-registry URL resolution + internal-token signing (§6); typed `Config` + swappable `Secrets` seam (§7);
top-level throw over `process.exit()` shotgun (§7); `helmet` security headers (§8); dropping entry-context /
dual request-id (§2).

---

## 10. Top fixes, in priority order

1. **D-11 graceful shutdown** — wire `process.on('SIGTERM'/'SIGINT')` in `startServer`/`createService`
   (`bootstrap.ts:33-35,71-94`) to stop accepting connections, `await closeSequelize()`
   (`libs/db/src/connection.ts:27`) and bus `stop()` (`libs/events/src/kafka-bus.ts:166`). [high / M]
2. **D-7 + D-8 outbound timeouts** — add `AbortSignal.timeout(ms)` (+ bounded retry for idempotent verbs) to
   `HttpClient.call` (`http-client.ts:70`) and the gateway proxy. [high / M]
3. **D-5 cache key safety** — add `CacheAdapter` tenant-scoped key helper (prefix with
   `RequestContext.tenantId()`), forbid raw keys at review. [high / S]
4. **D-2 + D-3 error info-shaping** — return a safe `display_message`/generic message for `System`/`Database`
   errors and reduce validation `details` to `{message,path}` (`error.middleware.ts:28-40`,
   `validation.middleware.ts:29`). [high / S]
5. **D-9 boot config gate** — validate required env at `init()` before binding the port. [medium / S]
6. **D-12/D-13** idempotency-replay middleware + HTTP audit middleware in the band. [medium / M each]
7. **D-1** add a test/lint asserting the PEP runs before routes in every service's `configure()`. [low / S]
8. **D-4/D-6/D-14/D-15** success/pagination helper, cache TTL+invalidation, CORS policy, alert channel. [low]

**Net:** the *shape* of the reference's band is faithfully reproduced and in several places genuinely improved
(native ALS, fail-closed headers, typed errors, helmet, centralised propagation). The **operational
robustness layer** — graceful shutdown, outbound timeouts, enforced cache scoping, info-safe error/validation
shaping, boot-time config validation — is materially **weaker than the reference**. The owner's doubt is justified
for §3 (D-2/D-3), §5 (D-5), §6 (D-7/D-8) and §8 (D-11) specifically; the context/error-type/logging core is sound.
