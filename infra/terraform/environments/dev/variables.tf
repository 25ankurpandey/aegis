variable "project_id" { type = string }
variable "env" {
  type    = string
  default = "dev"
}
variable "region" {
  type    = string
  default = "us-central1"
}
variable "image" {
  type        = string
  description = "The single multi-purpose Aegis image (e.g. REGION-docker.pkg.dev/PROJECT/aegis/aegis:SHA)."
}
variable "db_owner_password" {
  type      = string
  sensitive = true
}
variable "redis_url" {
  type    = string
  default = "redis://10.10.0.10:6379"
}
