resource "google_sql_database_instance" "pg" {
  name             = "${var.prefix}-pg"
  region           = var.region
  database_version = "POSTGRES_15"
  settings {
    tier              = var.tier
    availability_type = var.high_availability ? "REGIONAL" : "ZONAL"
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
    }
    ip_configuration { ipv4_enabled = false }
  }
  deletion_protection = var.deletion_protection
}

resource "google_sql_database" "aegis" {
  name     = "aegis"
  instance = google_sql_database_instance.pg.name
}

# Runtime app role is created by the app's db-init as a NON-OWNER (so RLS is enforced).
resource "google_sql_user" "owner" {
  name     = "aegis_owner"
  instance = google_sql_database_instance.pg.name
  password = var.owner_password
}
