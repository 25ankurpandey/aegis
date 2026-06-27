terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 5.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  prefix = "aegis-${var.env}"
  # All Aegis HTTP services (same image, different SERVICE_NAME).
  services = [
    { name = "gateway", port = 4000 },
    { name = "user-management", port = 4001 },
    { name = "expense", port = 4002 },
    { name = "payroll", port = 4003 },
    { name = "reporting", port = 4004 },
    { name = "workflow", port = 4005 },
    { name = "notification", port = 4006 },
    { name = "invoice", port = 4007 },
  ]
  # Cross-service event-bus topics.
  topics = ["expense-approved", "invoice-approved", "approval-requested", "payrun-approved", "notification-requested"]
}

module "network" {
  source = "../../modules/network"
  prefix = local.prefix
  region = var.region
}

module "database" {
  source         = "../../modules/database"
  prefix         = local.prefix
  region         = var.region
  owner_password = var.db_owner_password
  # dev: single-zone, destroyable
  high_availability   = false
  deletion_protection = false
}

module "pubsub" {
  source = "../../modules/pubsub"
  prefix = local.prefix
  topics = local.topics
}

module "services" {
  source        = "../../modules/cloud_run"
  prefix        = local.prefix
  region        = var.region
  env           = var.env
  image         = var.image
  services      = local.services
  min_instances = 0
  max_instances = 10
  common_env = {
    REDIS_URL          = var.redis_url
    INTERNAL_ORIGIN    = "aegis-internal"
    GATEWAY_URL        = "https://${local.prefix}-gateway-${var.region}.run.app"
  }
}

module "monitoring" {
  source       = "../../modules/monitoring"
  prefix       = local.prefix
  gateway_host = "${local.prefix}-gateway-${var.region}.run.app"
}
