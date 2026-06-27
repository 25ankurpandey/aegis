# Aegis — Cloud IaC (Terraform)

Showcase-grade Terraform that stands the whole platform up on Google Cloud in **one
`terraform apply`**. It provisions:

- **network** — a VPC + private subnet + Cloud NAT (services have no public IPs).
- **database** — Cloud SQL for PostgreSQL 15 (the app connects as a NON-OWNER role so RLS is
  enforced); backups + PITR on.
- **pubsub** — a topic + subscription per cross-service domain event (the event bus).
- **services** — one Cloud Run service per Aegis app, all running the **same image** differentiated
  by `SERVICE_NAME` + `PROCESS_TYPE`, with **autoscaling** (`min_instances`..`max_instances`).
- **monitoring** — a gateway uptime check + an alert policy.

## Usage

```bash
cd environments/dev
cp terraform.tfvars.example terraform.tfvars   # fill in project_id + image
terraform init
terraform apply
```

`terraform output service_uris` lists the deployed service URLs. Production would add an
`environments/prod` (regional HA database, `min_instances >= 1`, deletion protection, tighter IAM)
— a thin override of the same modules.

> The single Aegis container image is the one built by the repo `Dockerfile` (`PROCESS_TYPE`
> switch). Push it to Artifact Registry, then point `var.image` at it.
