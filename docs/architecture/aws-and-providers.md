# AWS SDK & Provider Seams — Decision

**Status:** Decided · **Scope:** dependency / architecture · **Audience:** platform engineers

## TL;DR (the decision)

**No AWS SDK is required to build, run, or test Aegis in the dockerized dev/test environment.**
Every external-infrastructure capability is reached through a **port (interface) or a config seam**,
and each one already has a **concrete dev/test binding** backed by a docker container or environment
variables. The AWS-specific implementation is a **production-only swap behind that seam** — it never
reaches a call site and therefore never needs to be a dependency until we deploy to AWS.

**Recommendation: do NOT add `aws-sdk` (v2) or any `@aws-sdk/*` (v3) package now.** Adding it today
buys nothing for local/CI (the seams are exercised by containers and mocks), while costing install
weight, a large transitive surface, supply-chain exposure, and dead code paths. Wire the AWS bindings
in a dedicated production/infra lane when we cut over to managed services — the seams below tell you
exactly where each one plugs in.

> Why this is a real choice and not an accident: the domain reference ships a broad AWS SDK
> surface — `@aws-sdk/client-ses`, `@aws-sdk/client-sns`, `@aws-sdk/client-sqs`,
> `@aws-sdk/client-secrets-manager`, `@aws-sdk/client-ssm`, `@aws-sdk/lib-storage` (S3), plus the v2
> `aws-sdk` (in the domain reference's `package.json`). Aegis intentionally **did not** inherit any of it. We chose
> Kafka over SQS for the bus, and put a port in front of every other capability so the AWS dependency
> is deferred, not designed-in.

---

## Provider-seam → production-binding matrix

| Capability | Current dev/test impl | Port / interface (the seam) | Production AWS binding | aws-sdk needed now? | When needed |
|---|---|---|---|---|---|
| **Event bus** | `InProcessBus` (single-process dev) and `KafkaBus` (kafkajs → `bitnami/kafka` container) | `EventBus` — `libs/events/src/bus.ts:7`; swapped at composition by `initEventBus()` — `libs/events/src/init-bus.ts:19` | Managed Kafka (MSK) — **stays Kafka**, no SDK. (SQS/SNS would be an *alternative* `EventBus` impl, not a requirement.) | **No** | Only if we ever choose SQS *instead of* Kafka — not currently chosen |
| **Transactional outbox + relay** | `event_outbox` table (Postgres) drained by `OutboxRelay` to the bus — `libs/events/src/outbox.ts:122` | Sits *above* the `EventBus` port; transport-agnostic | Same Postgres table on RDS; publishes via whatever `EventBus` is bound (Kafka/MSK) | **No** | Never (DB + bus port only) |
| **Email** | `EmailProviderService` — **real, dependency-light nodemailer provider** (nodemailer-based provider pattern): no-network `jsonTransport` dev sink by default, real SMTP transport (dev mail catcher) when `SMTP_HOST` is set — `apps/notification/src/services/email-provider.service.ts:1` | `NotificationShape.EmailProvider` port (`.send(EmailMessage)`) — bound in the notification IoC container | **SMTP relay** (Postmark/SendGrid/SES-SMTP endpoint) behind the same port — no SDK; **SES API is an OPTIONAL future binding, not a requirement** (no `aws-sdk` added) | **No** | Dev/test works today; production sets `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` at a relay |
| **SMS** | `SmsProviderService` — credential-free logging stub — `apps/notification/src/services/sms-provider.service.ts:12` | `NotificationShape.SmsProvider` port (`.send(SmsMessage)`) | **SNS** (`@aws-sdk/client-sns`) **or** Twilio adapter behind the same port | **No** | At production, when real SMS must leave the system |
| **Cache** | Redis via `ioredis` against the `redis:7-alpine` container — `libs/service-core/src/cache/cache-adapter.ts:14`; `REDIS_URL` config | `CacheAdapter` (static facade over the Redis client) | **ElastiCache for Redis** — *no code/SDK change*; point `REDIS_URL` at the managed cluster endpoint | **No** | Never (wire-compatible; config-only) |
| **Database** | PostgreSQL 15 container (`postgres:15-alpine`), RLS enforced under a non-owner role; Sequelize + `pg` | `@aegis/db` (`getSequelize()`); `DATABASE_URL`/PG env | **RDS / Aurora PostgreSQL** — *no code/SDK change*; point the connection at the managed endpoint | **No** | Never (wire-compatible; config-only) |
| **Secrets** | `EnvSecretsProvider` → env / committed dummy `.env` — `libs/service-core/src/config/secrets.ts:12` | `SecretsProvider` interface (`get(name): Promise<string>`) | **Secrets Manager / SSM Parameter Store** provider keyed by `/aegis/<env>/...` behind the same interface (`@aws-sdk/client-secrets-manager` / `client-ssm`) | **No** | At production hardening, to stop sourcing secrets from env |
| **ERP connector credentials** | `credentialsRef` resolved through `Secrets` (the seam above); mock connectors self-contained — `libs/connectors/src/connector.ts:9`, `base-connector.ts:31` | Resolved via the `SecretsProvider` seam, not a direct AWS call | Inherits the Secrets Manager/SSM binding above | **No** | Same trigger as Secrets |
| **Object store** | **None yet** — no attachment/blob/upload path exists anywhere in `apps`/`libs` | (no seam built — none needed yet) | **S3** (`@aws-sdk/client-s3` + `@aws-sdk/lib-storage`) behind a new `ObjectStore` port if/when a feature needs binary storage | **No** | Only when a feature first needs file/blob storage — add the port then |
| **Config / typed env** | `Config` over `process.env` — `libs/service-core/src/config/config.ts:4` | `Config.get/require/requireAll` | Unchanged; values flow from Secrets Manager/SSM into env or the secrets provider | **No** | Never |

---

## How the swap happens (so production wiring is mechanical, not a refactor)

- **Bus:** `initEventBus()` already reads `KAFKA_BROKERS` and swaps `InProcessBus → KafkaBus` at
  composition (`libs/events/src/init-bus.ts:19`). Production points `KAFKA_BROKERS` at MSK. No SDK.
- **Email:** the notification IoC container binds `EmailProviderService` to the `EmailProvider` port.
  That provider is now a real nodemailer provider modeled on the email-provider reference's transport (see
  `docs/analysis/EMAIL_alignment.md`): a no-network `jsonTransport` sink when `SMTP_HOST` is unset
  (safe default for dev/test/CI), and a real SMTP transport pointed at a dev mail catcher
  (MailHog/Mailpit at `localhost:1025`) or a production relay when `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`
  are configured. Production needs **no code change and no AWS SDK** — just relay env vars. SES, if ever
  wanted, is reachable via its SMTP endpoint through the same transport (still no `aws-sdk`), or as an
  optional `@aws-sdk/client-ses` adapter behind the unchanged port — neither is required.
- **SMS:** the container binds `SmsProviderService` to the `SmsProvider` port. Production registers an
  SNS (or Twilio) adapter implementing the same port — every call site (`SmsSenderService`,
  `EmailSenderService` at `apps/notification/src/services/email-sender.service.ts:45`) is untouched.
- **Cache & DB:** wire-compatible managed services (ElastiCache, RDS). Only `REDIS_URL` /
  `DATABASE_URL` change. **No SDK, no code change.**
- **Secrets:** replace the `Secrets` export with a Secrets-Manager/SSM-backed `SecretsProvider`
  (`libs/service-core/src/config/secrets.ts:18`). One module changes; all `Secrets.get(...)` /
  `credentialsRef` call sites are untouched.
- **Object store:** introduce an `ObjectStore` port + an S3 adapter *when the first blob feature lands* —
  there is nothing to bind today.

When AWS bindings are added, isolate `@aws-sdk/*` packages in **adapter libraries**
(e.g. `libs/connectors`-style provider libs) so the SDK is a dependency of the binding lib only, never
of the domain services — and so it can be lazy-loaded per process role (an API pod that never sends
mail need not load the SES client).

## Verification (evidence the dependency is genuinely absent today)

- `grep` for `aws-sdk` / `@aws-sdk` / `@smithy` across **every** `package.json` in the repo → **no
  matches** (only false positives inside `package-lock.json` integrity hashes).
- No `AWS_*` / `S3_*` / `SES_*` / `SNS_*` / `SQS_*` env keys are read anywhere in `apps` or `libs`.
- Dev infra is containers only: `postgres:15-alpine`, `redis:7-alpine`, `bitnami/kafka:3.7`
  (`docker-compose.yml`, `docker-compose.all.yml`) — **no LocalStack, no MinIO**, because nothing in
  the test path needs an AWS-compatible service.
